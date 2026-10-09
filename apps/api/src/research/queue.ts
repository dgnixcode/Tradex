import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Kysely, Selectable } from 'kysely';
import type { DB, ResearchJobTable } from '@tradex/db';
import type { ResearchEngine, ResearchReport } from './contracts.js';

// Only the separate worker may claim across tenants. Request handlers exclusively
// use TenantDb. Row locks serialize claims across worker replicas; the random lease
// token fences every subsequent write from a stale or cancelled process.
export async function claimResearchJob(db: Kysely<DB>, engine: ResearchEngine, timeoutMs: number): Promise<Selectable<ResearchJobTable> | undefined> {
  const token = randomUUID();
  const out = await sql<Selectable<ResearchJobTable>>`
    WITH candidate AS (
      SELECT j.id FROM research_job j JOIN tenant t ON t.id = j.tenant_id
      WHERE j.status = 'queued' AND j.engine = ${engine} AND t.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM research_job busy WHERE busy.tenant_id = j.tenant_id AND busy.status = 'running')
      ORDER BY j.created_at, j.id FOR UPDATE OF t, j SKIP LOCKED LIMIT 1
    )
    UPDATE research_job j SET status = 'running', stage = 'Collecting market evidence',
      started_at = now(), lease_token = ${token}::uuid,
      lease_expires_at = now() + interval '45 seconds', deadline_at = now() + ${timeoutMs} * interval '1 millisecond'
    FROM candidate WHERE j.id = candidate.id RETURNING j.*`.execute(db);
  return out.rows[0];
}

export async function renewResearchLease(db: Kysely<DB>, id: string, token: string, stage: string): Promise<boolean> {
  const out = await sql`
    UPDATE research_job SET lease_expires_at = now() + interval '45 seconds', stage = ${stage}
    WHERE id = ${id}::uuid AND lease_token = ${token}::uuid AND status = 'running'
      AND lease_expires_at > now() AND deadline_at > now()`.execute(db);
  return Number(out.numAffectedRows) === 1;
}

export async function finishResearchJob(db: Kysely<DB>, id: string, token: string, result: { report: ResearchReport } | { errorCode: string }): Promise<boolean> {
  const success = 'report' in result;
  const out = await sql`
    UPDATE research_job SET status = ${success ? 'completed' : 'failed'}, stage = ${success ? 'Report ready' : 'Research failed'},
      report = ${success ? JSON.stringify(result.report) : null}::jsonb,
      error_code = ${success ? null : result.errorCode}, finished_at = now(),
      lease_token = NULL, lease_expires_at = NULL, deadline_at = NULL
    WHERE id = ${id}::uuid AND lease_token = ${token}::uuid AND status = 'running'
      AND lease_expires_at > now() AND deadline_at > now()`.execute(db);
  return Number(out.numAffectedRows) === 1;
}

export async function expireResearchJobs(db: Kysely<DB>): Promise<void> {
  // Never automatically repeat a paid LLM run after losing its worker.
  await sql`UPDATE research_job SET status = 'failed', stage = 'Worker interrupted; start a new report',
      error_code = 'WORKER_INTERRUPTED', finished_at = now(), lease_token = NULL, lease_expires_at = NULL, deadline_at = NULL
    WHERE status = 'running' AND (lease_expires_at <= now() OR deadline_at <= now())`.execute(db);
  await sql`UPDATE research_job SET status = 'failed', stage = 'Queue wait expired', error_code = 'QUEUE_EXPIRED', finished_at = now()
    WHERE status = 'queued' AND created_at < now() - interval '24 hours'`.execute(db);
  await db.deleteFrom('research_worker').where('heartbeat_at', '<', new Date(Date.now() - 86_400_000)).execute();
}
