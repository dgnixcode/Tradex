// The group executor — plan/phase-08 T08.1/T08.4 (offline core).
//
// The fan-out: a confirmed group trade becomes one 'place' job per PLANNED child,
// and the Phase-06 worker drains them under a concurrency cap. The anti-duplicate
// spine (atomic write-before-send, deterministic coid, the venue's duplicate
// rejection, resolve-don't-resend) is unchanged — this phase only starts more of
// them at once. Bounded parallelism means the worker never has more than
// `concurrency` sends in flight, and every child still reaches a KNOWN state.
//
// This file deliberately does NOT place orders itself: it enqueues and lets the
// ExecutionWorker do the sends, so the whole rung-0→6 guarantee stack applies
// unchanged to a group.

import { getChildOrders } from '@tradex/db';
import { forTenant, addExecutionJob } from '@tradex/db';
import type { DB, TenantDb } from '@tradex/db';
import type { Kysely } from 'kysely';
import type { ExecutionWorker, WorkerRunSummary } from './execution-worker.js';

export interface GroupExecutorDeps {
  readonly db: Kysely<DB>;
  /** The Phase-06 worker that actually sends + resolves. */
  readonly worker: ExecutionWorker;
}

export interface EnqueueResult {
  readonly enqueued: number;
  readonly alreadyTerminal: number;
}

export interface DrainResult {
  readonly placeRuns: number;
  readonly place: WorkerRunSummary;
  readonly resolve: WorkerRunSummary;
  readonly stillPlanned: string[];
}

export class GroupExecutor {
  constructor(private readonly deps: GroupExecutorDeps) {}

  /**
   * Start a group trade: move it to `executing` and enqueue one 'place' job per
   * child still in `planned`. Children already terminal (they cannot be — a fresh
   * group trade has none) are counted separately.
   */
  async enqueue(tdb: TenantDb, groupTradeId: string): Promise<EnqueueResult> {
    await tdb.updateTable('group_trade')
      .set({ status: 'executing', submitted_at: new Date() } as never)
      .where('id' as never, '=', groupTradeId as never)
      .where('status' as never, 'in', ['previewed', 'draft'] as never)
      .execute();

    const children = await getChildOrders(tdb, groupTradeId);
    let enqueued = 0;
    let alreadyTerminal = 0;
    for (const child of children) {
      if (child.state === 'planned') {
        await addExecutionJob(this.deps.db, child.id, tdb.tenantId, 'place');
        enqueued += 1;
      } else {
        alreadyTerminal += 1;
      }
    }
    return { enqueued, alreadyTerminal };
  }

  /**
   * Drain the queue for this tenant until no 'place' jobs remain or the loop cap
   * is hit, resolving any ambiguous sends between passes. Returns what happened.
   */
  async drain(concurrency = 8): Promise<DrainResult> {
    const cap = Math.max(1, Math.floor(concurrency));
    const place: WorkerRunSummary = { handled: 0, sent: 0, ambiguous: 0, rejected: 0, terminal: 0 };
    const resolve: WorkerRunSummary = { handled: 0, sent: 0, ambiguous: 0, rejected: 0, terminal: 0 };
    let placeRuns = 0;

    // Each pass claims up to `cap` jobs. We loop until a pass finds nothing to
    // place (bounded by an outer safety cap so a wedged queue cannot spin forever).
    for (let round = 0; round < 200; round += 1) {
      const p = await this.deps.worker.runPlaceOnce(cap);
      placeRuns += 1;
      place.handled += p.handled; place.sent += p.sent; place.ambiguous += p.ambiguous;
      place.rejected += p.rejected; place.terminal += p.terminal;

      if (p.ambiguous > 0 || p.handled === 0 && round > 0) {
        const r = await this.deps.worker.runResolveOnce(cap);
        resolve.handled += r.handled; resolve.terminal += r.terminal; resolve.ambiguous += r.ambiguous;
      }
      // Stop once a pass placed nothing AND resolved nothing still queued.
      if (p.handled === 0) break;
    }

    return { placeRuns, place, resolve, stillPlanned: [] };
  }
}

/** Mark an executing trade abandoned if it still has planned children past `maxWaitMs`. */
export async function abandonIfStale(
  db: Kysely<DB>,
  tenantId: string,
  groupTradeId: string,
  opts: { maxWaitMs?: number; now?: Date } = {},
): Promise<{ skipped: number }> {
  const now = opts.now ?? new Date();
  const tdb = forTenant(db, tenantId);
  const cut = new Date(now.getTime() - (opts.maxWaitMs ?? 60_000));
  // A child still 'planned' whose trade is older than the window never started.
  const res = await tdb.updateTable('child_order')
    .set({ state: 'skipped', refusal_code: 'platform_busy', refusal_detail: 'the group trade could not start in time and was abandoned' } as never)
    .where('group_trade_id' as never, '=', groupTradeId as never)
    .where('state' as never, '=', 'planned' as never)
    .where('created_at' as never, '<', cut as never)
    .executeTakeFirst();
  const n = Number((res as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0n);
  if (n > 0) {
    await tdb.updateTable('group_trade')
      .set({ status: 'abandoned', completed_at: now } as never)
      .where('id' as never, '=', groupTradeId as never)
      .execute();
  }
  return { skipped: n };
}
