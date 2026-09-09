// 06-worker-send — plan/phase-06 T06.1/T06.3/T06.5/T06.6, the worker driving a
// real send over a real DB and the FakeVenue.
//
// Write-before-send in action: a 'place' job is claimed, the child is moved to
// 'sending' with its client_order_id reserved atomically, the order is submitted,
// and the child reaches a known state. The three shapes this check proves:
//   - a clean send → child 'open' with an exchange id, venue holds ONE order;
//   - a lost response → child 'ambiguous' + a resolve job, and resolving says it
//     never landed → 'not_placed' (never a second send);
//   - a duplicate coid → child 'rejected' (terminal, never retried) and the venue
//     still holds exactly ONE order.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { clientOrderIdOf } from '../packages/crypto/dist/index.js';
import { ExecutionWorker } from '../apps/api/dist/index.js';
import { fetchOrderByClientId, FakeVenue, submitOrder } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'worker-key-abcdef0123456789';
const SECRET = 'worker-secret-abcdef0123456789';
const PEPPER = Buffer.from('af'.repeat(16), 'hex');

export async function run(assert) {
  const ctx = await setup('workersend');
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

    // A planned child + a 'place' job for it. leg_seq 1..3 gives distinct coids.
    const mkChild = async (leg) => {
      // Distinct markets per scenario: T08.1 forbids two LIVE orders on one pair,
      // and these scenarios test worker mechanics, not pair reuse.
      const market = ['BTCINR', 'BTCUSDT', 'ETHINR'][(leg - 1) % 3] ?? 'BTCINR';
      const quote = market.endsWith('USDT') ? 'USDT' : 'INR';
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

    const coidOf = (childId) => ctx.pool.query('SELECT client_order_id AS c FROM child_order WHERE id = $1', [childId]).then((r) => r.rows[0].c);
    const stateOf = (childId) => ctx.pool.query('SELECT state AS s FROM child_order WHERE id = $1', [childId]).then((r) => r.rows[0].s);

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

    // ------------------------------------------------ clean send reaches 'open'
    const one = await mkChild(1);
    const s1 = await worker.runPlaceOnce();
    assert(s1.sent === 1, `the clean send should be counted, got ${JSON.stringify(s1)}`);
    assert(await stateOf(one.childId) === 'open', `a clean send should leave the child 'open', got ${await stateOf(one.childId)}`);
    assert(await coidOf(one.childId) === one.coid, 'the child must carry the deterministic coid');
    const exId = await ctx.pool.query('SELECT exchange_order_id AS e FROM child_order WHERE id = $1', [one.childId]).then((r) => r.rows[0].e);
    assert(typeof exId === 'string' && exId !== '', 'a clean send must record the exchange order id');
    const venueOrders = venue.ordersSnapshot().filter((o) => o['client_order_id'] === one.coid);
    assert(venueOrders.length === 1, 'the venue must hold exactly one order for the clean send');

    // ------------------------------------------------ ambiguous → resolve → not_placed
    const two = await mkChild(2);
    venue.injectFault({ path: '/orders/create', hangUp: true });
    const s2 = await worker.runPlaceOnce();
    assert(s2.ambiguous === 1, `the lost response should leave an ambiguous child, got ${JSON.stringify(s2)}`);
    assert(await stateOf(two.childId) === 'ambiguous', `the lost response must be 'ambiguous', got ${await stateOf(two.childId)}`);
    const resolveJobs = await ctx.pool.query("SELECT count(*)::int AS n FROM execution_job WHERE child_order_id = $1 AND kind = 'resolve'", [two.childId]);
    assert(resolveJobs.rows[0].n === 1, 'an ambiguous send must enqueue a resolve job');
    await worker.runResolveOnce();
    assert(await stateOf(two.childId) === 'not_placed', `resolving must conclude it never landed ('not_placed'), got ${await stateOf(two.childId)}`);
    assert(venue.ordersSnapshot().filter((o) => o['client_order_id'] === two.coid).length === 0,
      'the venue never received the ambiguous send — no order, no duplicate');

    // ------------------------------------------------ duplicate coid → rejected, never retried
    // Simulate a prior crash that DID land this coid, then the worker tries again.
    const three = await mkChild(3);
    await submitOrder(KEY, SECRET, { client_order_id: three.coid, side: 'buy', market_order: { market: 'BTCINR', side: 'buy' } }, { baseUrl: base });
    const s3 = await worker.runPlaceOnce();
    assert(s3.rejected === 1, `the duplicate-coid send should be a terminal rejection, got ${JSON.stringify(s3)}`);
    assert(await stateOf(three.childId) === 'rejected', `a duplicate coid must leave the child 'rejected', got ${await stateOf(three.childId)}`);
    assert(venue.ordersSnapshot().filter((o) => o['client_order_id'] === three.coid).length === 1,
      'the venue must still hold exactly ONE order for that coid — the rejection was never retried');
  } finally {
    await venue.stop();
    await teardown(ctx);
  }
}
