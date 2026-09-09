// Execution job substrate — plan/phase-06 T06.1.
//
// execution_job has sat empty since migration 007. This repo is the two
// operations that make it a scheduler:
//
//   claimJobs()       — one round trip claims a BATCH with FOR UPDATE SKIP LOCKED.
//                       Two workers can never claim the same job, because a row
//                       already locked by the first is skipped by the second's
//                       subquery — Postgres enforces it, not a flag we hope to set
//                       before the other process reads it.
//   requeueStale()    — the REAPER. A worker can die mid-job (killed, OOM, deploy);
//                       its lock would otherwise pin the job forever. Any job whose
//                       lock is older than the stale threshold is released and
//                       re-queued as kind 'resolve' — NEVER as 'place'. A crashed
//                       'place' worker means the send may or may not have landed, so
//                       the only safe recovery is to ASK the venue, not to send again
//                       (that is the whole anti-duplicate argument, 08 F6). A crashed
//                       'resolve' worker stays 'resolve' for the same reason.
//
// The claim is deliberately CROSS-TENANT on the raw db: the scheduler serves every
// tenant from one queue, exactly as DATA-MODEL's claim query shows, so it does not
// go through TenantDb. Every row still carries its tenant_id and the composite FK
// keeps each job honest against its child order.

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB, ExecutionJobKind } from './schema.js';

export class ExecutionRepoError extends Error {
  override readonly name = 'ExecutionRepoError';
}

export interface ClaimedJob {
  readonly id: string;
  readonly childOrderId: string;
  readonly tenantId: string;
  readonly kind: ExecutionJobKind;
  readonly runAfter: Date;
  readonly attempts: number;
}

const rowToJob = (r: Record<string, unknown>): ClaimedJob => ({
  id: String(r['id']),
  childOrderId: String(r['child_order_id']),
  tenantId: String(r['tenant_id']),
  kind: r['kind'] as ExecutionJobKind,
  runAfter: new Date(r['run_after'] as string),
  attempts: Number(r['attempts']),
});

/**
 * Claim up to `limit` claimable jobs for one worker.
 *
 * A claimable job is unlocked and due (run_after <= now). The claim itself is the
 * UPDATE ... RETURNING under FOR UPDATE SKIP LOCKED, so it is atomic and
 * race-free. `attempts` increments here so a job that keeps failing is visibly
 * retried, and the reaper can tell a fresh lock from a wedged one.
 */
export async function claimJobs(
  db: Kysely<DB>,
  workerId: string,
  opts: { limit?: number; now?: Date } = {},
): Promise<readonly ClaimedJob[]> {
  const limit = opts.limit ?? 10;
  const now = opts.now ?? new Date();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ExecutionRepoError(`limit must be in [1, 100], got ${limit}`);
  }
  if (workerId === '') throw new ExecutionRepoError('a worker needs an id to claim jobs');
  const result = await sql<Record<string, unknown>>`
    UPDATE execution_job j
    SET locked_by = ${workerId}, locked_at = ${now}, attempts = attempts + 1
    WHERE j.id IN (
      SELECT id FROM execution_job
      WHERE locked_by IS NULL AND run_after <= ${now}
      ORDER BY run_after, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id, child_order_id, tenant_id, kind, run_after, attempts
  `.execute(db);
  return result.rows.map(rowToJob);
}

export interface ReapedJob {
  readonly id: string;
  readonly childOrderId: string;
  readonly tenantId: string;
  /** Always 'resolve' after the reaper — never 'place' (T06.1). */
  readonly kind: ExecutionJobKind;
}

/**
 * The reaper: release any lock older than `staleMs` and re-queue the job as
 * 'resolve'. Runs on every process start and on a schedule. A job whose lock is
 * fresh is left alone — its worker may simply be slow.
 */
export async function requeueStale(
  db: Kysely<DB>,
  opts: { staleMs?: number; now?: Date } = {},
): Promise<readonly ReapedJob[]> {
  const staleMs = opts.staleMs ?? 5 * 60 * 1000;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - staleMs);
  const result = await sql<Record<string, unknown>>`
    UPDATE execution_job
    SET locked_by = NULL, locked_at = NULL, kind = 'resolve', run_after = ${now}
    WHERE locked_by IS NOT NULL AND locked_at IS NOT NULL AND locked_at < ${cutoff}
    RETURNING id, child_order_id, tenant_id, kind
  `.execute(db);
  return result.rows.map((r) => ({
    id: String(r['id']),
    childOrderId: String(r['child_order_id']),
    tenantId: String(r['tenant_id']),
    kind: r['kind'] as ExecutionJobKind,
  }));
}

/** Enqueue one job (e.g. a 'place' per planned child when a group trade starts). */
export async function addExecutionJob(
  db: Kysely<DB>,
  childOrderId: string,
  tenantId: string,
  kind: ExecutionJobKind,
  runAfter: Date = new Date(),
): Promise<void> {
  await db.insertInto('execution_job')
    .values({ child_order_id: childOrderId, tenant_id: tenantId, kind, run_after: runAfter } as never)
    .execute();
}

/** Claim up to `limit` jobs FROM ONE tenant. Used by the fair drainer. */
async function claimFromTenant(
  db: Kysely<DB>,
  workerId: string,
  tenantId: string,
  limit: number,
  now: Date,
): Promise<readonly ClaimedJob[]> {
  const result = await sql<Record<string, unknown>>`
    UPDATE execution_job j
    SET locked_by = ${workerId}, locked_at = ${now}, attempts = attempts + 1
    WHERE j.tenant_id = ${tenantId} AND j.id IN (
      SELECT id FROM execution_job
      WHERE locked_by IS NULL AND run_after <= ${now} AND tenant_id = ${tenantId}
      ORDER BY run_after, id
      FOR UPDATE SKIP LOCKED
      LIMIT ${limit}
    )
    RETURNING id, child_order_id, tenant_id, kind, run_after, attempts
  `.execute(db);
  return result.rows.map(rowToJob);
}

/**
 * Cross-tenant FAIR claim (T08.2): round-robin over tenants so a small tenant's
 * trade is not starved by a large fan-out. Each round takes one tenant's oldest
 * claimable jobs, cycling tenants by their earliest due job; a tenant with fewer
 * than its share simply gets what it has and the cycle moves on.
 */
export async function claimJobsFair(
  db: Kysely<DB>,
  workerId: string,
  opts: { limit?: number; now?: Date } = {},
): Promise<readonly ClaimedJob[]> {
  const limit = opts.limit ?? 10;
  const now = opts.now ?? new Date();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ExecutionRepoError(`limit must be in [1, 100], got ${limit}`);
  }
  if (workerId === '') throw new ExecutionRepoError('a worker needs an id to claim jobs');

  const tenantsResult = await sql<Record<string, unknown>>`
    SELECT tenant_id FROM execution_job
    WHERE locked_by IS NULL AND run_after <= ${now}
    GROUP BY tenant_id
    ORDER BY min(run_after), tenant_id
  `.execute(db);
  const tenants = tenantsResult.rows.map((r) => String(r['tenant_id']));
  if (tenants.length === 0) return [];

  const share = Math.max(1, Math.ceil(limit / tenants.length));
  const claimed: ClaimedJob[] = [];
  const byId = new Set<string>();

  // Round-robin: one share per tenant per cycle until the limit is met or the
  // queue is empty. A starving tenant's oldest job is claimed in its first turn.
  let foundInCycle = true;
  while (claimed.length < limit && foundInCycle) {
    foundInCycle = false;
    for (const tenantId of tenants) {
      if (claimed.length >= limit) break;
      const batch = await claimFromTenant(db, workerId, tenantId, Math.min(share, limit - claimed.length), now);
      for (const job of batch) {
        if (!byId.has(job.id)) { byId.add(job.id); claimed.push(job); }
      }
      if (batch.length > 0) foundInCycle = true;
    }
  }
  return claimed;
}
