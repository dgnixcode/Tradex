// 13-deploy-safety — plan/phase-13 T13.7 (research/20 F5, R4).
//
// A deploy while any group trade is `executing` is refused (the pre-deploy guard);
// a worker that received SIGTERM drains its in-flight fan-out to completion within
// the grace window instead of dropping it; and the reaper that runs on every start
// releases a stale worker lock as a 'resolve' job — never a second 'place'.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { addExecutionJob, readDeployBlockers, requeueStale } from '../packages/db/dist/index.js';
import { ExecutionWorker, GroupExecutor } from '../apps/api/dist/index.js';
import { FakeVenue, fetchOrderByClientId, submitOrder } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'deploy-key-abcdef0123456789';
const SECRET = 'deploy-secret-abcdef0123456789';
const PEPPER = Buffer.from('d1'.repeat(16), 'hex');

export async function run(assert) {
  const ctx = await setup('deploy');
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

    // ---- deploy guard ----
    const ok = await readDeployBlockers(ctx.db);
    assert(ok.executingTrades === 0, 'a clean world is safe to deploy');
    const execTrade = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at, submitted_at)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'executing', 'tok-deploy', $4, now()) RETURNING id`,
      [TENANT, groupId, USER, new Date(NOW_MS + 60_000)],
    );
    const blocked = await readDeployBlockers(ctx.db);
    assert(blocked.executingTrades === 1 && blocked.oldestExecutingSince !== null,
      `the guard must see the executing trade, got ${blocked.executingTrades}`);
    assert(execTrade.rows[0].id !== undefined, 'the executing trade must exist');

    // ---- graceful SIGTERM drain ----
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

    const trade = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'previewed', 'tok-drain', $4) RETURNING id`,
      [TENANT, groupId, USER, new Date(NOW_MS + 60_000)],
    );
    const tradeId = trade.rows[0].id;
    const childIds = [];
    for (let i = 0; i < 2; i += 1) {
      const child = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
         VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', 'planned', '0.0001') RETURNING id`,
        [TENANT, tradeId, i === 0 ? a0 : a1, i + 1],
      );
      childIds.push(child.rows[0].id);
    }

    await executor.enqueue(ctx.tdb, tradeId); // moves to executing + enqueues place jobs
    const drained = await executor.gracefulDrain(3_000);
    assert(drained.drained === true, 'the fan-out must drain to completion within the grace window');
    assert(drained.place.sent === 2, `both legs must be sent before the worker exits, got ${drained.place.sent}`);
    const states = await ctx.pool.query("SELECT count(*)::int n FROM child_order WHERE group_trade_id = $1 AND state = 'open'", [tradeId]);
    assert(states.rows[0].n === 2, 'both in-flight orders must finish open — nothing dropped on SIGTERM');

    // ---- boot reaper: a stale lock becomes a resolve job ----
    await addExecutionJob(ctx.db, childIds[0], TENANT, 'place', new Date(NOW_MS - 60_000));
    const job = await ctx.pool.query(
      "SELECT id FROM execution_job WHERE child_order_id = $1 AND kind = 'place' ORDER BY id DESC LIMIT 1", [childIds[0]],
    ).then((r) => r.rows[0].id);
    await ctx.pool.query(
      "UPDATE execution_job SET locked_by = 'dead-worker', locked_at = $1 WHERE id = $2",
      [new Date(NOW_MS), job],
    );
    const reaped = await requeueStale(ctx.db, { staleMs: 5 * 60 * 1000, now: new Date(NOW_MS + 6 * 60 * 1000) });
    assert(reaped.length === 1 && reaped[0].id === job, 'the reaper must release the stale lock');
    const after = await ctx.pool.query('SELECT locked_by, kind FROM execution_job WHERE id = $1', [job]).then((r) => r.rows[0]);
    assert(after.locked_by === null && after.kind === 'resolve',
      `a stale lock must be re-queued as resolve, never a second place, got ${after.kind}`);
  } finally {
    await venue.stop();
    await teardown(ctx);
  }
}
