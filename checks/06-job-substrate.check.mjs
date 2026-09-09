// 06-job-substrate — plan/phase-06 T06.1.
//
// The scheduler's two operations, proved against a real database:
//   - two workers never claim the same job (FOR UPDATE SKIP LOCKED);
//   - a job whose worker died mid-flight is released by the reaper and re-queued
//     as kind 'resolve' — never 'place' — because a crashed send may have landed
//     and the only safe recovery is to ask the venue, not send again.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { claimJobs, requeueStale } from '../packages/db/dist/index.js';

let legSeq = 0;

/** Insert a planned child under the trade, then a job for it; return both ids. */
async function enqueue(ctx, tradeId, accountId, kind = 'place') {
  legSeq += 1;
  const c = await ctx.pool.query(
    `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, state)
     VALUES ($1, $2, $3, $4, 'BTCINR', 'planned') RETURNING id`,
    [TENANT, tradeId, accountId, legSeq],
  );
  const childOrderId = c.rows[0].id;
  const j = await ctx.pool.query(
    `INSERT INTO execution_job (child_order_id, tenant_id, kind, run_after) VALUES ($1, $2, $3, $4) RETURNING id`,
    [childOrderId, TENANT, kind, new Date(NOW_MS - 60_000)],
  );
  return { jobId: j.rows[0].id, childOrderId };
}

export async function run(assert) {
  const ctx = await setup('jobsub');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    const { accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const accountId = accountIds[0];
    const group = await ctx.pool.query('SELECT group_id FROM group_member WHERE tenant_id = $1 LIMIT 1', [TENANT]);
    const { rows: gt } = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'pct_allocated', '2000') RETURNING id`,
      [TENANT, group.rows[0].group_id, USER],
    );
    const tradeId = gt[0].id;

    // ------------------------------------------------ a claimed job is not re-claimed
    const { jobId } = await enqueue(ctx, tradeId, accountId);
    const a = await claimJobs(ctx.db, 'worker-A', { limit: 10, now: new Date(NOW_MS) });
    assert(a.some((j) => j.id === jobId), 'worker A must claim the job');
    const claimed = a.find((j) => j.id === jobId);
    assert(claimed.attempts === 1, `claim must increment attempts to 1, got ${claimed.attempts}`);

    const b = await claimJobs(ctx.db, 'worker-B', { limit: 10, now: new Date(NOW_MS + 1000) });
    assert(!b.some((j) => j.id === jobId), 'worker B must NOT claim a job worker A already holds');

    // ------------------------------------------------ the reaper requeues as resolve
    // Simulate worker A dying: backdate its lock past the stale threshold, then reap.
    await ctx.pool.query(
      `UPDATE execution_job SET locked_at = $1 WHERE id = $2`,
      [new Date(NOW_MS - 6 * 60 * 1000), jobId],
    );
    const reaped = await requeueStale(ctx.db, { staleMs: 5 * 60 * 1000, now: new Date(NOW_MS) });
    const reap = reaped.find((r) => r.id === jobId);
    assert(reap !== undefined, 'the reaper must release the stale job');
    assert(reap.kind === 'resolve', `a crashed 'place' job must be re-queued as resolve, got ${reap.kind}`);

    // The released job is claimable again — now as a resolve, not a place.
    const c = await claimJobs(ctx.db, 'worker-C', { limit: 10, now: new Date(NOW_MS + 2000) });
    const rec = c.find((j) => j.id === jobId);
    assert(rec !== undefined && rec.kind === 'resolve', 'the requeued job must be claimable as resolve');

    // A FRESH lock is left alone by the reaper.
    const { jobId: freshJob } = await enqueue(ctx, tradeId, accountId);
    const claimFresh = await claimJobs(ctx.db, 'worker-D', { limit: 10, now: new Date(NOW_MS + 3000) });
    assert(claimFresh.some((j) => j.id === freshJob), 'worker D should claim the fresh job');
    const untouched = await requeueStale(ctx.db, { staleMs: 5 * 60 * 1000, now: new Date(NOW_MS + 3000) });
    assert(!untouched.some((r) => r.id === freshJob), 'the reaper must not touch a fresh lock');

    // ------------------------------------------------ two workers never overlap
    const many = [];
    for (let i = 0; i < 25; i += 1) many.push(await enqueue(ctx, tradeId, accountId));
    const jobIds = many.map((m) => m.jobId);
    const [x, y] = await Promise.all([
      claimJobs(ctx.db, 'worker-X', { limit: 100, now: new Date(NOW_MS + 4000) }),
      claimJobs(ctx.db, 'worker-Y', { limit: 100, now: new Date(NOW_MS + 4000) }),
    ]);
    const xIds = new Set(x.map((j) => j.id));
    const overlaps = y.filter((j) => xIds.has(j.id));
    assert(overlaps.length === 0, `two concurrent workers claimed the same job ${overlaps.length} times`);
    const covered = new Set([...x.map((j) => j.id), ...y.map((j) => j.id)]);
    const coveredOfOurs = jobIds.filter((id) => covered.has(id)).length;
    assert(coveredOfOurs === jobIds.length, `only ${coveredOfOurs}/${jobIds.length} of our queued jobs were claimed between the two workers`);
  } finally {
    await teardown(ctx);
  }
}
