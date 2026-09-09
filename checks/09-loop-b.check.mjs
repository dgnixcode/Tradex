// 09-loop-b — plan/phase-09 T09.5 (reconciler Loop B).
//
// Loop A is a scheduled resolve-by-coid sweep; an order can settle at the venue
// in the gap between two polls, so Loop B reconciles the OTHER direction: it asks
// the venue for its OWN active_orders on each (account, market) pair that still
// has a leg we believe is live. A leg we think is open but the venue no longer
// lists has left our sweep — resolve it to learn what it became and settle it.
//
// Scenario A (recovery): a leg is placed and open, then the venue settles it to
// `filled` BEHIND Loop A's back (no poll). The venue's active list no longer
// contains it. loopBSweep resolves it → 'filled' ≠ 'open' → settle, recovered 1,
// and the group trade auto-completes.
//
// Scenario B (no spurious settle): a second leg stays genuinely open and IS still
// on the venue's active list → the sweep skips it without resolving → recovered 0,
// the child stays open, the trade stays executing.
//
// The venue's active_orders filter matches a top-level `market` on a stored order,
// so the submit payload carries `market` flat (not only nested in market_order) —
// otherwise the negative case would see an empty list and look "missing" too.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { addExecutionJob } from '../packages/db/dist/index.js';
import { ExecutionWorker } from '../apps/api/dist/index.js';
import { fetchActiveOrders, fetchOrderByClientId, FakeVenue, submitOrder } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'loopb-key-abcdef0123456789';
const SECRET = 'loopb-secret-abcdef0123456789';
const PEPPER = Buffer.from('cb'.repeat(16), 'hex');

export async function run(assert) {
  const ctx = await setup('loopb');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
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
    const listActive = async (accountId, market) => {
      const r = await fetchActiveOrders(KEY, SECRET, market, { baseUrl: base });
      if (!r.ok) return { ok: false };
      return { ok: true, orders: r.orders.map((o) => ({ clientOrderId: o.clientOrderId })) };
    };
    const worker = new ExecutionWorker({ db: ctx.db, pepper: PEPPER, submit, resolve, listActive });

    const newTrade = async (market, token) => {
      const gt = await ctx.pool.query(
        `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
         VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'executing', $4, $5) RETURNING id`,
        [TENANT, groupId, USER, token, new Date(NOW_MS + 60_000)],
      );
      return gt.rows[0].id;
    };
    const addPlannedChild = async (tradeId, accountId, leg, market) => {
      const child = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, 'planned', '0.0001') RETURNING id`,
        [TENANT, tradeId, accountId, leg, market, market === 'BTCUSDT' ? 'USDT' : 'INR'],
      );
      await addExecutionJob(ctx.db, child.rows[0].id, TENANT, 'place', new Date(NOW_MS - 1000));
      return child.rows[0].id;
    };
    const stateOf = async (childId) => ctx.pool.query('SELECT state s FROM child_order WHERE id = $1', [childId]).then((r) => r.rows[0].s);
    const statusOf = async (tradeId) => ctx.pool.query('SELECT status s FROM group_trade WHERE id = $1', [tradeId]).then((r) => r.rows[0].s);

    // ---- Scenario A: an order that settled behind Loop A's back is recovered ----
    const tradeA = await newTrade('BTCINR', 'tok-loopb-a');
    const childA = await addPlannedChild(tradeA, a0, 1, 'BTCINR');
    await worker.runPlaceOnce();
    assert((await stateOf(childA)) === 'open', 'scenario A child must be placed and open');
    const coidA = await ctx.pool.query('SELECT client_order_id c FROM child_order WHERE id = $1', [childA]).then((r) => r.rows[0].c);

    // The venue fills it WITHOUT Loop A ever polling — our DB still believes open.
    venue.settleOrder(coidA, 'filled');
    const recA = await worker.loopBSweep(ctx.tdb, tradeA);
    assert(recA.recovered === 1, `Loop B must recover the order that left active_orders, got ${recA.recovered}`);
    assert((await stateOf(childA)) === 'filled', `the recovered child must be settled to filled, got ${await stateOf(childA)}`);
    assert((await statusOf(tradeA)) === 'completed', `a fully-settled trade must auto-complete, got ${await statusOf(tradeA)}`);

    // ---- Scenario B: a genuinely-open, still-listed leg is left untouched ----
    const tradeB = await newTrade('BTCUSDT', 'tok-loopb-b');
    const childB = await addPlannedChild(tradeB, a1, 1, 'BTCUSDT');
    await worker.runPlaceOnce();
    assert((await stateOf(childB)) === 'open', 'scenario B child must be placed and open');

    // The venue's own active list STILL contains it — the sweep must not resolve
    // or settle it, and must not report it as recovered.
    const recB = await worker.loopBSweep(ctx.tdb, tradeB);
    assert(recB.recovered === 0, `a still-listed open leg must not be recovered, got ${recB.recovered}`);
    assert((await stateOf(childB)) === 'open', `a still-listed child must stay open, got ${await stateOf(childB)}`);
    assert((await statusOf(tradeB)) === 'executing', `a still-working trade must stay executing, got ${await statusOf(tradeB)}`);
  } finally {
    await venue.stop();
    await teardown(ctx);
  }
}
