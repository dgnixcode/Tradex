// 09-clamp-down — plan/phase-09 T09.3 at the WORKER seam.
//
// The sell re-derivation module (packages/sizing, sell-at-send.test.ts) proves the
// arithmetic in isolation. This check proves the worker actually WRITES the clamp
// to the row and sends the clamped size — the "recorded on the child order and
// surfaced in the report" half of the acceptance.
//
// A fixed sell was planned at 0.0005 BTC (base_quantity). Between preview and send
// the venue's fresh free read says the account holds 0.0002 BTC (outside activity
// shrank it). The send must clamp DOWN to 0.0002 — never send the 0.0005 the stale
// projection believed in — and the child row must record that the clamp happened
// (clamped_from_quantity = '0.0005', final_quantity = '0.0002').

import { NOW_MS, TENANT, USER, ingestMarkets, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { addExecutionJob } from '../packages/db/dist/index.js';
import { ExecutionWorker } from '../apps/api/dist/index.js';
import { fetchOrderByClientId, FakeVenue, submitOrder } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'clamp-key-abcdef0123456789';
const SECRET = 'clamp-secret-abcdef0123456789';
const PEPPER = Buffer.from('cc'.repeat(16), 'hex');

export async function run(assert) {
  const ctx = await setup('clampdn');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  await ingestMarkets(ctx.db); // the market rules a sell floors against
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const a0 = accountIds[0];

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
    // The FRESH venue read: this account holds 0.0002 BTC free (0.0002 × 1e8 minor).
    const holdings = async () => [{ currency: 'BTC', freeMinor: '20000', lockedMinor: '0', scale: 8 }];
    const worker = new ExecutionWorker({ db: ctx.db, pepper: PEPPER, submit, resolve, holdings });

    const gt = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
       VALUES ($1, $2, $3, 'BTC', 'sell', 'market', 'base_quantity', '0.0005', 'executing', 'tok-clamp', $4) RETURNING id`,
      [TENANT, groupId, USER, new Date(NOW_MS + 60_000)],
    );
    const tradeId = gt.rows[0].id;
    const child = await ctx.pool.query(
      `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity, price_used, price_source)
       VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', 'planned', '0.0005', '3511202', 'book_bid') RETURNING id`,
      [TENANT, tradeId, a0, 1],
    );
    const childId = child.rows[0].id;
    await addExecutionJob(ctx.db, childId, TENANT, 'place', new Date(NOW_MS - 1000));

    await worker.runPlaceOnce();

    // The clamp is RECORDED on the row — the "surfaced in the report" half.
    const row = await ctx.pool.query(
      `SELECT state s, final_quantity fq, clamped_from_quantity cfq, notional_minor nm
       FROM child_order WHERE id = $1`,
      [childId],
    ).then((r) => r.rows[0]);
    assert(row.s === 'open', `the sell must be sent and open, got ${row.s}`);
    assert(row.fq === '0.0002', `final_quantity must be the clamped fresh holding, got ${row.fq}`);
    assert(row.cfq === '0.0005', `clamped_from_quantity must record what was clamped away, got ${row.cfq}`);
    assert(row.nm !== null, `the notional must be recomputed from the clamped size, got ${String(row.nm)}`);

    // The order that actually reached the venue is the clamped 0.0002, never the
    // planned 0.0005 the stale projection believed in.
    const coid = await ctx.pool.query('SELECT client_order_id c FROM child_order WHERE id = $1', [childId]).then((r) => r.rows[0].c);
    const sent = venue.ordersSnapshot().find((o) => o['client_order_id'] === coid);
    assert(sent !== undefined, 'the clamped sell must exist at the venue');
    assert(sent?.['market_order']?.['total_quantity'] === '0.0002',
      `the venue must have received 0.0002 (clamped), got ${String(sent?.['market_order']?.['total_quantity'])}`);
  } finally {
    await venue.stop();
    await teardown(ctx);
  }
}
