// 08-fanout-core — plan/phase-08 T08.1/T08.4/T08.8 (offline core).
//
// The fan-out's engine heart, proven over a real DB + FakeVenue:
//   - enqueue a confirmed group trade → one 'place' job per planned child;
//   - drain under a concurrency cap → every child reaches a KNOWN state;
//   - the report groups partial failures (N identical rejections = one cause);
//   - a group trade that never starts within the window is abandoned
//     (children `platform_busy`), never executed late.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { GroupExecutor, abandonIfStale, ExecutionWorker, buildReport } from '../apps/api/dist/index.js';
import { fetchOrderByClientId, FakeVenue, submitOrder } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'fan-key-abcdef0123456789';
const SECRET = 'fan-secret-abcdef0123456789';
const PEPPER = Buffer.from('ad'.repeat(16), 'hex');

export async function run(assert) {
  const ctx = await setup('fanout');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000', '10000000', '10000000']);
    const acct = (i) => accountIds[i];

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
    const executor = new GroupExecutor({ db: ctx.db, worker });

    // ---- one confirmed trade, three accounts, drained under concurrency 2 ----
    let tradeSeq = 0;
    const mkTrade = async (status) => {
      tradeSeq += 1;
      const gt = await ctx.pool.query(
        `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at, submitted_at)
         VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', $4, $5, $6, now()) RETURNING id`,
        [TENANT, groupId, USER, status, `tok-fan-${tradeSeq}`, new Date(NOW_MS + 60_000)],
      );
      const tradeId = gt.rows[0].id;
      for (let i = 0; i < 3; i += 1) {
        await ctx.pool.query(
          `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
           VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', 'planned', '0.0001')`,
          [TENANT, tradeId, acct(i), i + 1],
        );
      }
      return tradeId;
    };

    const tradeId = await mkTrade('previewed');
    const enq = await executor.enqueue(ctx.tdb, tradeId);
    assert(enq.enqueued === 3, `three planned children must enqueue three 'place' jobs, got ${enq.enqueued}`);
    const drain = await executor.drain(2);
    assert(drain.place.sent === 3, `all three children must be sent, got ${JSON.stringify(drain.place)}`);
    assert(venue.ordersSnapshot().length === 3, 'the venue must hold exactly one order per account');

    const childrenSql = async () => (await ctx.pool.query(
      `SELECT account_id, state, market, final_quantity, notional_minor, refusal_code, refusal_detail, client_order_id, exchange_order_id
       FROM child_order WHERE group_trade_id = $1 ORDER BY account_id`, [tradeId],
    )).rows;
    const states = (await childrenSql()).map((r) => r.state);
    assert(states.every((s) => s === 'open'), `every child must reach 'open', got ${states.join(', ')}`);

    const report = buildReport((await childrenSql()).map((r) => ({
      accountId: r.account_id, state: r.state, market: r.market, finalQuantity: r.final_quantity,
      notionalMinor: r.notional_minor, refusalCode: r.refusal_code, refusalDetail: r.refusal_detail,
      coid: r.client_order_id, exchangeOrderId: r.exchange_order_id,
    })));
    assert(report.placed === 3 && report.allPlaced === true && report.rows.length === 3,
      `a fully-placed fan-out must report 3 placed, got ${JSON.stringify(report)}`);

    // ---- partial-failure grouping: 20 identical skips = ONE grouped cause ----
    const twenty = Array.from({ length: 20 }, (_, i) => ({
      accountId: `acct-${i}`, state: 'skipped', market: 'BTCINR', finalQuantity: null, notionalMinor: null,
      refusalCode: 'BELOW_MIN_NOTIONAL', refusalDetail: 'the order value 50 is below the minimum order value of 100.',
      coid: null, exchangeOrderId: null,
    }));
    const grouped = buildReport(twenty);
    assert(grouped.skipped === 20 && grouped.placed === 0, '20 skips must count as 20 skipped');
    assert(grouped.groupedCauses.length === 1 && grouped.groupedCauses[0].count === 20,
      `twenty identical skips must collapse to one grouped cause with count 20, got ${grouped.groupedCauses.length}`);
    assert(grouped.groupedCauses[0].accounts.length === 20, 'the grouped cause must name all twenty accounts');

    // ---- abandonment: a trade that never starts is abandoned, not run late ----
    const stalled = await mkTrade('executing');
    // Backdate the children so they are older than the abandonment window.
    await ctx.pool.query(
      `UPDATE child_order SET created_at = $1 WHERE group_trade_id = $2`,
      [new Date(NOW_MS - 120_000), stalled],
    );
    const ab = await abandonIfStale(ctx.db, TENANT, stalled, { maxWaitMs: 60_000, now: new Date(NOW_MS + 1000) });
    assert(ab.skipped === 3, `the stalled trade must skip its 3 planned children, got ${ab.skipped}`);
    const stalledRows = await ctx.pool.query('SELECT state, refusal_code FROM child_order WHERE group_trade_id = $1', [stalled]);
    assert(stalledRows.rows.every((r) => r.state === 'skipped' && r.refusal_code === 'platform_busy'),
      'abandoned children must be skipped platform_busy, never executed late');
    const gts = await ctx.pool.query('SELECT status FROM group_trade WHERE id = $1', [stalled]);
    assert(gts.rows[0].status === 'abandoned', 'the group trade itself must be marked abandoned');
  } finally {
    await venue.stop();
    await teardown(ctx);
  }
}
