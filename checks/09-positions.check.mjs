// 09-positions — plan/phase-09 T09.6.
//
// The positions screen is the BOOKS, not a valuation: it reads the `holding`
// projection (the fold of ledger_entry) and shows quantity, weighted-average
// cost, realised P&L, fees and TDS. The DoD acceptance is that its numbers match
// the ledger — so this check fills an account's ledger, rebuilds the projection,
// hits GET /api/positions, and asserts every number equals the `holding` row read
// straight from the DB. Plus the two derived flags the screen owns:
//   - avgPriceMinor = cost_total_minor ÷ qty (the fold's own average cost),
//   - dust = a non-zero holding below the market's effective minimum.
// And an open order shows under the holding it locks.

import { NOW_MS, TENANT, USER, bookProvider, ingestMarkets, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { createHttpServer } from '../apps/api/dist/index.js';
import { hashPassword } from '../packages/auth/dist/index.js';
import { LocalKms } from '../packages/crypto/dist/index.js';
import { rebuildHoldings, recordFill } from '../packages/db/dist/index.js';
import { div, scaledFromMinor } from '../packages/money/dist/index.js';
import { nat } from '../packages/sizing/dist/index.js';

const COOKIE_SECRET = Buffer.alloc(32, 0x5b);
const PASSWORD = 'positions-pass-12345678';

function cookieFrom(res) {
  const m = /tradex_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
  return m === null ? null : m[1];
}

const buy = (accountId, id, qty, atMs, price = '8000000') => ({
  accountId, exchangeTradeId: id, side: 'buy', asset: 'BTC', quote: 'INR',
  qty, price, feeMinor: '0', market: 'BTCINR', occurredAtMs: atMs,
});
const sell = (accountId, id, qty, atMs) => ({
  accountId, exchangeTradeId: id, side: 'sell', asset: 'BTC', quote: 'INR',
  qty, price: '9000000', feeMinor: '0', market: 'BTCINR', occurredAtMs: atMs,
});

export async function run(assert) {
  const ctx = await setup('positions');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  let srv = null;
  try {
    await ingestMarkets(ctx.db); // the market rules that define the dust floor
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000', '10000000', '10000000']);
    const [a0, a1, a2] = accountIds;
    await ctx.pool.query('UPDATE app_user SET password_hash = $1 WHERE id = $2', [await hashPassword(PASSWORD), USER]);

    // a0's books: two buys of 0.1 @ ₹8,000,000, then a sell of 0.1 @ ₹9,000,000.
    await recordFill(ctx.tdb, buy(a0, 'p-f1', '0.1', NOW_MS + 1000));
    await recordFill(ctx.tdb, buy(a0, 'p-f2', '0.1', NOW_MS + 2000));
    await recordFill(ctx.tdb, sell(a0, 'p-f3', '0.1', NOW_MS + 3000));
    // a1's books: a dust fill — 0.000004 BTC, below BTCINR's effective min 0.00001.
    await recordFill(ctx.tdb, buy(a1, 'p-f4', '0.000004', NOW_MS + 4000));
    // a2 has no fills at all.
    for (const id of [a0, a1, a2]) await rebuildHoldings(ctx.tdb, id);

    // An order still live on a0 BTCINR — it locks 0.05 BTC of a0's free holding.
    const gt = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.05', 'executing', 'tok-pos', $4) RETURNING id`,
      [TENANT, groupId, USER, new Date(NOW_MS + 60_000)],
    );
    const openChild = await ctx.pool.query(
      `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
       VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', 'open', '0.05') RETURNING id`,
      [TENANT, gt.rows[0].id, a0, 1],
    );
    assert(openChild.rows[0].id !== undefined, 'the locking open order must be inserted');

    // The reference truth: the holding rows, read straight from the DB.
    const rowOf = async (accountId) => {
      const r = await ctx.pool.query(
        `SELECT qty, cost_total_minor, realised_pnl_minor, fee_drag_minor, tds_withheld_minor
         FROM holding WHERE account_id = $1 AND asset = 'BTC'`, [accountId]);
      return r.rows[0];
    };
    const refA0 = await rowOf(a0);
    const refA1 = await rowOf(a1);
    assert(refA0.qty === '0.1' && refA0.cost_total_minor === '80000000',
      `the fold must keep a0 at 0.1 BTC, ₹8,00,000 cost basis, got ${refA0.qty}/${refA0.cost_total_minor}`);
    assert(refA1.qty === '0.000004', `a1 must hold the dust fill, got ${refA1.qty}`);

    // ---- serve /api/positions ----
    const probe = async () => { throw new Error('probe must not be called on a positions read'); };
    const { getOrderBook } = bookProvider();
    const server = createHttpServer({
      db: ctx.db, getOrderBook, cookieSecret: COOKIE_SECRET, verifySecondFactor: async () => false,
      kms: new LocalKms(), pepper: Buffer.from('e7'.repeat(32), 'hex'), probe,
      codeVersion: '09-positions', secureCookies: false,
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}`;
    srv = { stop: () => new Promise((r) => server.close(r)) };

    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'plan@t.example', password: PASSWORD }) });
    assert(login.status === 200, 'owner should log in');
    const cookie = cookieFrom(login);
    assert(cookie !== null, 'login must set a cookie');

    const res = await fetch(`${base}/api/positions?groupId=${groupId}`, { headers: { cookie: `tradex_session=${cookie}` } });
    assert(res.status === 200, `positions must be readable, got ${res.status}`);
    const body = await res.json();

    // ---- per-account numbers equal the ledger projection ----
    const byId = (id) => body.accounts.find((a) => a.accountId === id);
    assert(body.accounts.length === 3, `all three accounts must appear, got ${body.accounts.length}`);

    const a0v = byId(a0);
    assert(a0v.positions.length === 1, `a0 must hold exactly one position (BTC), got ${a0v.positions.length}`);
    const p0 = a0v.positions[0];
    assert(p0.qty === refA0.qty, `qty must equal the holding, got ${p0.qty}`);
    assert(p0.costTotalMinor === refA0.cost_total_minor, `cost basis must equal the holding, got ${p0.costTotalMinor}`);
    assert(p0.realisedPnlMinor === refA0.realised_pnl_minor, `realised must equal the holding, got ${p0.realisedPnlMinor}`);
    assert(p0.feeDragMinor === refA0.fee_drag_minor && p0.tdsWithheldMinor === refA0.tds_withheld_minor,
      `fees/TDS must equal the holding, got ${p0.feeDragMinor}/${p0.tdsWithheldMinor}`);
    assert(p0.dust === false, 'a 0.1 BTC holding is not dust');
    const expectedAvg = div(scaledFromMinor(refA0.cost_total_minor, 0), nat(refA0.qty), 0).v.toString();
    assert(p0.avgPriceMinor === expectedAvg && expectedAvg === '800000000',
      `avg cost must be the fold's WAC ₹8,000,000, got ${p0.avgPriceMinor}`);

    // ---- the open order shows under the holding it locks ----
    assert(a0v.openOrders.length === 1, `a0's live order must be listed, got ${a0v.openOrders.length}`);
    const o = a0v.openOrders[0];
    assert(o.asset === 'BTC' && o.market === 'BTCINR' && o.quantity === '0.05' && o.state === 'open',
      `the order must lock BTCINR 0.05 open, got ${o.asset}/${o.market}/${o.quantity}/${o.state}`);

    // ---- dust is flagged on a1 ----
    const p1 = byId(a1).positions[0];
    assert(p1 !== undefined && p1.dust === true, `a 0.000004 BTC holding must be flagged dust`);
    assert(byId(a2).positions.length === 0, `a2 with no fills must have no positions`);

    // ---- the INR roll-up equals the sum of the holding rows ----
    const sum = await ctx.pool.query(
      `SELECT (sum(cost_total_minor))::text cost, (sum(realised_pnl_minor))::text real,
              (sum(fee_drag_minor))::text fee, (sum(tds_withheld_minor))::text tds
       FROM holding WHERE account_id IN ($1, $2)`, [a0, a1]);
    const rollup = body.rollup.find((r) => r.quoteAsset === 'INR');
    assert(rollup !== undefined, 'the INR roll-up must exist');
    assert(rollup.accountCount === 2, `two accounts hold INR positions, got ${rollup.accountCount}`);
    assert(rollup.dustCount === 1, `exactly one INR position is dust, got ${rollup.dustCount}`);
    assert(rollup.costTotalMinor === sum.rows[0].cost, `roll-up cost must equal the ledger sum, got ${rollup.costTotalMinor}`);
    assert(rollup.realisedPnlMinor === sum.rows[0].real, `roll-up realised must equal the ledger sum, got ${rollup.realisedPnlMinor}`);
    assert(rollup.feeDragMinor === sum.rows[0].fee && rollup.tdsWithheldMinor === sum.rows[0].tds,
      `roll-up fees/TDS must equal the ledger sum, got ${rollup.feeDragMinor}/${rollup.tdsWithheldMinor}`);
  } finally {
    if (srv !== null) await srv.stop();
    await teardown(ctx);
  }
}
