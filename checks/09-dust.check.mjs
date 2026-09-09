// 09-dust — plan/phase-09 T09.4 at the WORKER seam.
//
// The module (sell-at-send.test.ts) proves a dust holding returns a DUST skip in
// isolation. This check proves a sell-all ACROSS accounts where one account holds
// dust still completes as sells + one labelled skip — dust is excluded from the
// fan-out without failing the trade (the acceptance verbatim).
//
// Two accounts, both planned as sell_all of BTC:
//   - account a0 holds 0.0005 BTC free  → sells (and the FRESH read wins: it grew
//     past the stale 0.0004 plan, the T09.2 upward direction);
//   - account a1 holds 0.000004 BTC free → below BTCINR's effective minimum of
//     0.00001 → DUST, a labelled skip, never a failure and never a send.

import { NOW_MS, TENANT, USER, ingestMarkets, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { addExecutionJob } from '../packages/db/dist/index.js';
import { ExecutionWorker } from '../apps/api/dist/index.js';
import { fetchOrderByClientId, FakeVenue, submitOrder } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'dust-key-abcdef0123456789';
const SECRET = 'dust-secret-abcdef0123456789';
const PEPPER = Buffer.from('cd'.repeat(16), 'hex');

export async function run(assert) {
  const ctx = await setup('dust');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  await ingestMarkets(ctx.db); // the market rules that define the effective minimum
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000', '10000000']);
    const a0 = accountIds[0];
    const a1 = accountIds[1];

    const submit = async (coid, order) => {
      const out = await submitOrder(KEY, SECRET, {
        client_order_id: coid, side: order.side, market: order.market,
        market_order: { market: order.market, side: order.side, order_type: order.orderType, total_quantity: order.quantity, price: 0 },
      }, { baseUrl: base });
      if (out.kind === 'accepted') return { kind: 'accepted', exchangeOrderId: out.order.id, statusRaw: out.order.statusRaw };
      return { kind: 'rejected', orderMayExist: out.failure.orderMayExist, code: out.failure.code, detail: out.failure.detail };
    };
    const resolve = async (coid) => {
      const r = await fetchOrderByClientId(KEY, SECRET, coid, { baseUrl: base });
      if (!r.ok) return { ok: false };
      return { ok: true, order: r.order === null ? null : { id: r.order.id, statusRaw: r.order.statusRaw } };
    };
    // The FRESH venue reads. a0 holds 0.0005 BTC (0.0005 × 1e8 minor); a1 holds
    // 0.000004 BTC (400 minor) — dust below BTCINR's effective minimum.
    const holdings = async (accountId) => {
      const free = accountId === a0 ? '50000' : '400';
      return [{ currency: 'BTC', freeMinor: free, lockedMinor: '0', scale: 8 }];
    };
    const worker = new ExecutionWorker({ db: ctx.db, pepper: PEPPER, submit, resolve, holdings });

    const gt = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
       VALUES ($1, $2, $3, 'BTC', 'sell', 'market', 'sell_all', NULL, 'executing', 'tok-dust', $4) RETURNING id`,
      [TENANT, groupId, USER, new Date(NOW_MS + 60_000)],
    );
    const tradeId = gt.rows[0].id;
    const childIds = [];
    for (const [i, acct] of [a0, a1].entries()) {
      const child = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
         VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', 'planned', '0.0004') RETURNING id`,
        [TENANT, tradeId, acct, i + 1],
      );
      childIds.push(child.rows[0].id);
      await addExecutionJob(ctx.db, child.rows[0].id, TENANT, 'place', new Date(NOW_MS - 1000));
    }

    await worker.runPlaceOnce();

    // The healthy account sells at the FRESH 0.0005 (grown past the 0.0004 plan).
    const rA = await ctx.pool.query('SELECT state s, final_quantity fq FROM child_order WHERE id = $1', [childIds[0]]).then((r) => r.rows[0]);
    assert(rA.s === 'open', `the healthy account must sell, got state ${rA.s}`);
    assert(rA.fq === '0.0005', `sell_all must send the fresh holding even when it grew past the plan, got ${rA.fq}`);
    const coidA = await ctx.pool.query('SELECT client_order_id c FROM child_order WHERE id = $1', [childIds[0]]).then((r) => r.rows[0].c);
    const sentA = venue.ordersSnapshot().find((o) => o['client_order_id'] === coidA);
    assert(sentA?.['market_order']?.['total_quantity'] === '0.0005', `the venue must have received the fresh 0.0005, got ${String(sentA?.['market_order']?.['total_quantity'])}`);

    // The dust account is a LABELLED SKIP — excluded, not a failure, not a send.
    const rB = await ctx.pool.query(
      'SELECT state s, refusal_code rc FROM child_order WHERE id = $1', [childIds[1]],
    ).then((r) => r.rows[0]);
    assert(rB.s === 'skipped', `a dust holding must be a labelled skip, not open/needs_human, got ${rB.s}`);
    assert(rB.rc === 'DUST', `the skip must carry the DUST refusal code, got ${rB.rc}`);
    assert(venue.ordersSnapshot().length === 1, `the dust account must never reach the venue — exactly one order sent, got ${venue.ordersSnapshot().length}`);

    // The fan-out completes once the one live sell fills — dust did not fail it.
    venue.settleOrder(coidA, 'filled');
    await worker.pollTrade(ctx.tdb, tradeId);
    const status = await ctx.pool.query('SELECT status s FROM group_trade WHERE id = $1', [tradeId]).then((r) => r.rows[0].s);
    assert(status === 'completed', `a sell-all over a dust account must still complete, got ${status}`);
  } finally {
    await venue.stop();
    await teardown(ctx);
  }
}
