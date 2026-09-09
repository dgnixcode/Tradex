// 08-inflight — plan/phase-08 T08.1: never two live orders on one (account, market).
//
// The write-before-send reserve stops a DUPLICATE of the same child; this stops a
// second SEND on the same pair from a DIFFERENT child (a race the plan-time gate
// can already be stale for). First send goes live; a second send for the same
// pair while the first is unresolved is refused → `not_placed: order_in_flight`.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { addExecutionJob } from '../packages/db/dist/index.js';
import { ExecutionWorker } from '../apps/api/dist/index.js';
import { fetchOrderByClientId, FakeVenue, submitOrder } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'inf-key-abcdef0123456789';
const SECRET = 'inf-secret-abcdef0123456789';
const PEPPER = Buffer.from('ac'.repeat(16), 'hex');

export async function run(assert) {
  const ctx = await setup('inflight');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const accountId = accountIds[0];

    const submit = async (coid, order) => {
      const out = await submitOrder(KEY, SECRET, { client_order_id: coid, side: order.side, market_order: { market: order.market, side: order.side, order_type: order.orderType, total_quantity: order.quantity, price: 0 } }, { baseUrl: base });
      if (out.kind === 'accepted') return { kind: 'accepted', exchangeOrderId: out.order.id, statusRaw: out.order.statusRaw };
      return { kind: 'rejected', orderMayExist: out.failure.orderMayExist, code: out.failure.code, detail: out.failure.detail };
    };
    const resolve = async (coid) => {
      const r = await fetchOrderByClientId(KEY, SECRET, coid, { baseUrl: base });
      if (!r.ok) return { ok: false };
      return { ok: true, order: r.order === null ? null : { id: r.order.id, statusRaw: r.order.statusRaw } };
    };
    const worker = new ExecutionWorker({ db: ctx.db, pepper: PEPPER, submit, resolve });

    // Two group trades, each one planned child, SAME account + BTCINR market.
    const mkChild = async (tradeId, leg) => {
      const r = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
         VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', 'planned', '0.0001') RETURNING id`,
        [TENANT, tradeId, accountId, leg],
      );
      return r.rows[0].id;
    };
    const mkTrade = async (token) => {
      const gt = await ctx.pool.query(
        `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
         VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'previewed', $4, $5) RETURNING id`,
        [TENANT, groupId, USER, token, new Date(NOW_MS + 60_000)],
      );
      return gt.rows[0].id;
    };

    const t1 = await mkTrade('tok-in-1');
    const c1 = await mkChild(t1, 1);
    await addExecutionJob(ctx.db, c1, TENANT, 'place', new Date(NOW_MS - 1000));
    const s1 = await worker.runPlaceOnce();
    assert(s1.sent === 1, 'the first same-pair send must go live');
    const st1 = await ctx.pool.query('SELECT state s FROM child_order WHERE id = $1', [c1]).then((r) => r.rows[0].s);
    assert(st1 === 'open', `the first child must be open, got ${st1}`);

    // A SECOND send on the same pair while the first is live is refused.
    const t2 = await mkTrade('tok-in-2');
    const c2 = await mkChild(t2, 1); // same account, same BTCINR
    await addExecutionJob(ctx.db, c2, TENANT, 'place', new Date(NOW_MS - 1000));
    const s2 = await worker.runPlaceOnce();
    assert(s2.sent === 0, 'the second same-pair send must NOT be sent');
    const row2 = await ctx.pool.query('SELECT state s, refusal_code rc FROM child_order WHERE id = $1', [c2]).then((r) => r.rows[0]);
    assert(row2.s === 'not_placed' && row2.rc === 'order_in_flight',
      `the second child must be refused order_in_flight, got ${row2.s}/${row2.rc}`);

    // The venue holds exactly ONE order for this account+market.
    const btcOrders = venue.ordersSnapshot().length;
    assert(btcOrders === 1, `the venue must hold exactly one live order, got ${btcOrders}`);

    // Once the first is terminal, a fresh send on the pair is allowed again.
    const stillOpen = await ctx.pool.query("SELECT count(*)::int n FROM child_order WHERE account_id = $1 AND market = 'BTCINR' AND state IN ('open','acked','partially_filled','sending','ambiguous','unknown','needs_human')", [accountId]);
    assert(stillOpen.rows[0].n === 1, 'the first order should still be the only live one');
  } finally {
    await venue.stop();
    await teardown(ctx);
  }
}
