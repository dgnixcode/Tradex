// 06-engine-simulation — plan/phase-06 T06.6 / 18 F5, the four canonical fault
// scenarios driven through the REAL worker + FakeVenue, each asserting ZERO
// duplicate orders at the venue and a known child state.
//
//   A  clean send            → child 'open', venue holds one
//   B  response lost, NOT accepted → child 'not_placed', venue holds none, and the
//      coid was only ever sent ONCE (never re-sent)
//   C  response lost, ACCEPTED  → child 'open', venue holds EXACTLY one — the worker
//      resolved instead of re-sending (the duplicate-order killer)
//   D  duplicate coid from a crash → child 'rejected', venue still holds exactly one
//
// The acceptance for every scenario is the same: never two orders for one coid.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { clientOrderIdOf } from '../packages/crypto/dist/index.js';
import { ExecutionWorker } from '../apps/api/dist/index.js';
import { fetchOrderByClientId, FakeVenue, submitOrder } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'engine-key-abcdef0123456789';
const SECRET = 'engine-secret-abcdef0123456789';
const PEPPER = Buffer.from('ae'.repeat(16), 'hex');

export async function run(assert) {
  const ctx = await setup('enginesim');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();
    const { accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const accountId = accountIds[0];
    const group = await ctx.pool.query('SELECT group_id FROM group_member WHERE tenant_id = $1 LIMIT 1', [TENANT]);
    const { rows: gt } = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001') RETURNING id`,
      [TENANT, group.rows[0].group_id, USER],
    );
    const tradeId = gt[0].id;

    const submit = async (coid, order) => {
      const out = await submitOrder(KEY, SECRET, {
        client_order_id: coid, side: order.side,
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
    const worker = new ExecutionWorker({ db: ctx.db, pepper: PEPPER, submit, resolve });

    const mkChild = async (leg, market, quote) => {
      // The market is EXPLICIT per scenario: T08.1 forbids a send while any other
      // order for this (account, market) is live, so each send must use a pair with
      // no live sibling (A stays 'open' on BTCINR, C stays 'open' on ETHINR; only
      // the terminal pairs are reusable for later sends).
      const c = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, 'planned', '0.0001') RETURNING id`,
        [TENANT, tradeId, accountId, leg, market, quote],
      );
      const childId = c.rows[0].id;
      await ctx.pool.query(
        `INSERT INTO execution_job (child_order_id, tenant_id, kind, run_after) VALUES ($1, $2, 'place', $3)`,
        [childId, TENANT, new Date(NOW_MS - 60_000)],
      );
      return { childId, coid: clientOrderIdOf(PEPPER, tradeId, accountId, leg) };
    };
    const stateOf = (childId) => ctx.pool.query('SELECT state s FROM child_order WHERE id = $1', [childId]).then((r) => r.rows[0].s);
    /** How many orders/create requests carried this coid (every send, ever). */
    const createCount = (coid) => venue.requests.filter((r) => r.path.includes('/orders/create') && r.body.includes(coid)).length;
    const venueCount = (coid) => venue.ordersSnapshot().filter((o) => o['client_order_id'] === coid).length;

    // ------------------------------------------------ A: clean send
    const a = await mkChild(1, 'BTCINR', 'INR');
    await worker.runPlaceOnce();
    assert(await stateOf(a.childId) === 'open', `A: clean send must reach 'open', got ${await stateOf(a.childId)}`);
    assert(createCount(a.coid) === 1 && venueCount(a.coid) === 1, 'A: exactly one send, one order');

    // ------------------------------------------------ B: response lost, NOT accepted
    const b = await mkChild(2, 'BTCUSDT', 'USDT');
    venue.injectFault({ path: '/orders/create', hangUp: true });
    const sb = await worker.runPlaceOnce();
    assert(sb.ambiguous === 1, `B: the lost response must be ambiguous, got ${JSON.stringify(sb)}`);
    await worker.runResolveOnce();
    assert(await stateOf(b.childId) === 'not_placed', `B: resolving must conclude it never landed, got ${await stateOf(b.childId)}`);
    assert(createCount(b.coid) === 1, 'B: the coid must have been sent exactly ONCE — never re-sent');
    assert(venueCount(b.coid) === 0, 'B: the venue holds no order');

    // ------------------------------------------------ C: response lost, ACCEPTED
    // The hardest case: the venue stored the order but the client never heard.
    const c = await mkChild(3, 'ETHINR', 'INR');
    venue.injectFault({ path: '/orders/create', acceptThenDrop: true });
    const sc = await worker.runPlaceOnce();
    assert(sc.ambiguous === 1, `C: a dropped-after-accept response must be ambiguous, got ${JSON.stringify(sc)}`);
    assert(venueCount(c.coid) === 1, 'C: the venue accepted the order (stored) even though the client never heard');
    await worker.runResolveOnce();
    assert(await stateOf(c.childId) === 'open', `C: resolving must discover the accepted order, got ${await stateOf(c.childId)}`);
    assert(venueCount(c.coid) === 1, 'C: STILL exactly one order — the worker resolved instead of re-sending (no duplicate)');
    assert(createCount(c.coid) === 1, 'C: the coid was sent exactly once');

    // ------------------------------------------------ D: duplicate coid from a crash
    // BTCUSDT is free here: B's order on it ended terminal ('not_placed'), so the
    // worker may send on the pair again — and the venue's coid idempotency rejects
    // the duplicate.
    const d = await mkChild(4, 'BTCUSDT', 'USDT');
    // Simulate a prior attempt that DID land: the coid is already at the venue.
    await submitOrder(KEY, SECRET, { client_order_id: d.coid, side: 'buy', market_order: { market: 'BTCINR', side: 'buy' } }, { baseUrl: base });
    const sd = await worker.runPlaceOnce();
    assert(sd.rejected === 1, `D: the duplicate coid must be a terminal rejection, got ${JSON.stringify(sd)}`);
    assert(await stateOf(d.childId) === 'rejected', `D: the child must be 'rejected', got ${await stateOf(d.childId)}`);
    assert(venueCount(d.coid) === 1, 'D: the venue still holds exactly one order — never a second');

    // Every scenario produced zero duplicate orders for its coid.
    const dups = venue.ordersSnapshot().reduce((acc, o) => { acc[o['client_order_id']] = (acc[o['client_order_id']] ?? 0) + 1; return acc; }, {});
    const worst = Math.max(1, ...Object.values(dups));
    assert(worst === 1, `no client_order_id may appear twice at the venue, worst count ${worst}`);
  } finally {
    await venue.stop();
    await teardown(ctx);
  }
}
