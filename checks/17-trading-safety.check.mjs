import { randomUUID } from 'node:crypto';
import { setup, teardown, seedGroupOfAccounts, TENANT, USER } from './_plan-harness.mjs';
import { beginExecution, claimJobsFair, hasInFlightOrder, recordLoginFailure, reapStaleFuturesLocks, completeGroupTradeIfAllSettled, dailySpentMinor, createPasswordResetToken, consumeResetTokenAndUpdatePassword } from '../packages/db/dist/index.js';
import { GroupExecutor, ExecutionWorker } from '../apps/api/dist/index.js';
import { executePositionMutation } from '../apps/api/dist/futures/mutation.js';
import { reservePositionIncrease } from '../apps/api/dist/futures/risk-reservation.js';

export async function run(assert) {
  const ctx = await setup('safety17');
  if (!ctx) { assert(true, 'database check skipped without DATABASE_URL'); return; }
  try {
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000', '10000000', '10000000']);
    const worker = new ExecutionWorker({ db: ctx.db, pepper: Buffer.alloc(32, 1), submit: async () => ({ kind: 'accepted', exchangeOrderId: 'v', statusRaw: 'open' }), resolve: async () => ({ ok: false }) });
    const executor = new GroupExecutor({ db: ctx.db, worker });
    const trade = await ctx.tdb.insertInto('group_trade', {
      group_id: groupId, created_by: USER, asset: 'BTC', side: 'buy', order_type: 'limit',
      limit_price: '60000', sizing_mode: 'base_quantity', sizing_value: '0.001',
      status: 'previewed', preview_token: 'test-token', preview_expires_at: new Date(Date.now() + 60_000),
      is_futures: true, leverage: '5', margin_currency: 'USDT', position_margin_type: 'isolated',
      stop_loss_price: '59000', take_profit_price: '61000',
    }).returning('id').executeTakeFirstOrThrow();
    await ctx.tdb.insertInto('child_order', accountIds.map((id, i) => ({ group_trade_id: trade.id, account_id: id, leg_seq: i,
      state: 'planned', market: 'BTCUSDT', quote_currency: 'USDT', final_quantity: '0.001' }))).execute();
    const counts = async () => {
      const children = await ctx.tdb.selectFrom('child_order').selectAll().where('group_trade_id', '=', trade.id).execute();
      const jobs = await ctx.tdb.selectFrom('execution_job').selectAll().execute();
      const parent = await ctx.tdb.byId('group_trade', trade.id).select('status').executeTakeFirstOrThrow();
      return { children, jobs, parent };
    };
    try {
      await beginExecution(ctx.tdb, trade.id, 'test-token', undefined, async (tx) => {
        await executor.enqueueWithinTransaction(tx, trade.id);
        throw new Error('simulate crash before commit');
      });
    } catch { /* expected rollback */ }
    const rolledBack = await counts();
    assert(rolledBack.parent.status === 'previewed' && rolledBack.jobs.length === 0 && rolledBack.children.length === 3, 'confirm, jobs and SL/TP must roll back together');
    const confirms = await Promise.allSettled([1, 2].map(() => beginExecution(ctx.tdb, trade.id, 'test-token', undefined,
      (tx) => executor.enqueueWithinTransaction(tx, trade.id).then(() => {}))));
    assert(confirms.filter((r) => r.status === 'fulfilled').length === 1, 'exactly one concurrent confirmation may commit');
    const queued = await counts();
    assert(queued.children.length === 9 && queued.jobs.length === 3, 'entries and protection must exist before any worker can see the committed jobs');
    await executor.enqueue(ctx.tdb, trade.id);
    assert((await counts()).children.length === 9 && (await counts()).jobs.length === 3, 're-enqueue must not duplicate entries or protection');
    await ctx.tdb.insertInto('execution_job', { child_order_id: queued.children[0].id, kind: 'resolve', run_after: new Date(0) }).execute();
    const claimed = await claimJobsFair(ctx.db, 'test-place', { limit: 100, kind: 'place' });
    assert(claimed.length === 3 && claimed.every((j) => j.kind === 'place'), 'place workers may claim only place jobs');
    const resolve = await claimJobsFair(ctx.db, 'test-resolve', { limit: 100, kind: 'resolve' });
    assert(resolve.length === 1, 'resolve jobs must remain claimable independently');
    await ctx.tdb.updateTable('child_order').set({ state: 'filled' }).where('group_trade_id', '=', trade.id).execute();
    const entry = queued.children.find((c) => c.leg_kind === 'entry' && c.account_id === accountIds[0]);
    await ctx.tdb.updateTable('child_order').set({ state: 'partially_filled', created_at: new Date(0) }).where('id', '=', entry.id).execute();
    assert(await hasInFlightOrder(ctx.tdb, entry.account_id, 'BTCUSDT'), 'old partial limits remain in flight even without a local position');
    assert(!await completeGroupTradeIfAllSettled(ctx.tdb, trade.id), 'a partial fill must not complete the group');
    await ctx.tdb.updateTable('child_order').set({ state: 'filled' }).where('id', '=', entry.id).execute();

    const mutation = (over = {}) => executePositionMutation({ db: ctx.db, tenantId: TENANT, accountId: accountIds[0],
      positionId: 'position-test', pair: 'B-ETH_USDT', operation: 'adjust', body: { direction: 'reduce', percentBp: 2500 },
      execute: async () => ({ ok: true }), ...over });
    let sends = 0;
    const key = randomUUID();
    const args = { requestId: key, execute: async () => { sends++; return { ok: true }; } };
    await mutation(args); await mutation(args);
    assert(sends === 1, 'a completed request must replay its receipt without sending again');
    let conflict = false;
    try { await mutation({ requestId: key, body: { direction: 'reduce', percentBp: 5000 } }); } catch (e) { conflict = e.status === 409; }
    assert(conflict, 'reusing a request key with changed sizing must be refused');
    let release, entered;
    const ready = new Promise((r) => { entered = r; });
    const gate = new Promise((r) => { release = r; });
    const first = mutation({ execute: async () => { entered(); await gate; return { ok: true }; } });
    await ready;
    let blocked = false;
    try { await mutation(); } catch (e) { blocked = e.status === 409; }
    release(); await first;
    assert(blocked, 'concurrent mutations of the same account and pair must be excluded');
    let uncertain = false;
    try { await mutation({ execute: async () => ({ ok: false, outcomeUnknown: true }) }); } catch (e) { uncertain = e.status === 409; }
    assert(uncertain, 'an uncertain venue result must not report successful completion');
    const reaped = await reapStaleFuturesLocks(ctx.db, { now: new Date(Date.now() + 86_400_000), staleMs: 1 });
    assert(reaped.length === 0, 'an unresolved position mutation lock must never be expired into a retry');
    try { await mutation({ execute: async () => { sends++; return { ok: true }; } }); } catch { /* must refuse */ }
    assert(sends === 1, 'an unresolved mutation must block further sends');

    // Different pairs must still share the same account's daily margin budget.
    await ctx.tdb.updateTable('tenant_limit').set({ max_order_notional_minor: '1000000', max_daily_notional_minor: '12000' }).execute();
    const increase = (pair) => executePositionMutation({ db: ctx.db, tenantId: TENANT, accountId: accountIds[1], pair,
      positionId: `increase-${pair}`, operation: 'adjust', body: { direction: 'increase' }, execute: async (id) => {
        try {
          await reservePositionIncrease({ db: ctx.db, tdb: ctx.tdb, requestId: id, accountId: accountIds[1], pair,
            quantity: '0.01', price: '1000', leverage: 10, quote: 'USDT', usdtInrMid: '80' });
          return { ok: true };
        } catch (error) { return { ok: false, reason: error.message }; }
      } });
    const adds = await Promise.all(['B-SOL_USDT', 'B-XRP_USDT'].map(increase));
    assert(adds.filter((r) => r.ok).length === 1, 'concurrent increases on different pairs cannot spend the same daily budget');
    const since = Date.now() - 86_400_000;
    assert(await dailySpentMinor(ctx.tdb, accountIds[1], 'INR', since, true, '80') === '8000', 'direct increases must count in daily margin caps');
    await ctx.tdb.updateTable('child_order').set({ notional_minor: '500000000', created_at: new Date() }).where('id', '=', entry.id).execute();
    assert(await dailySpentMinor(ctx.tdb, entry.account_id, 'INR', since, true, '80') === '8000', 'futures spend uses its own leverage and converts quote units into INR');
    assert(await dailySpentMinor(ctx.tdb, entry.account_id, 'USDT', since, true, '80') === '100000000', 'the same margin remains consistent in USDT units');

    const resetId = await createPasswordResetToken(ctx.db, USER, Buffer.alloc(32, 9), new Date(Date.now() + 60_000));
    const resets = await Promise.all(['first-hash', 'second-hash'].map((hash) => consumeResetTokenAndUpdatePassword(ctx.db, resetId, USER, hash, new Date())));
    assert(resets.filter(Boolean).length === 1, 'a password reset token may update the password only once under concurrent requests');
    const resetIds = await Promise.all([10, 11].map((n) => createPasswordResetToken(ctx.db, USER, Buffer.alloc(32, n), new Date(Date.now() + 60_000))));
    const distinctResets = await Promise.all(resetIds.map((id) => consumeResetTokenAndUpdatePassword(ctx.db, id, USER, 'next-hash', new Date())));
    assert(distinctResets.filter(Boolean).length === 1, 'different reset links must serialize without deadlocking or changing the password twice');

    const failures = await Promise.all(Array.from({ length: 12 }, () => recordLoginFailure(ctx.db, '198.51.100.42', null, 100_000)));
    assert(Math.max(...failures.map((r) => r.failedAttempts)) === 12, 'concurrent login failures must increment atomically');
    assert(failures.some((r) => r.failedAttempts === 4 && r.blockedUntil !== null), 'the fourth concurrent failure must activate the block');
    const expired = await recordLoginFailure(ctx.db, '198.51.100.42', null, 100_000 + 86_400_001);
    assert(expired.failedAttempts === 1 && expired.blockedUntil === null, 'an expired IP block must restart the counter');
  } finally { await teardown(ctx); }
}
