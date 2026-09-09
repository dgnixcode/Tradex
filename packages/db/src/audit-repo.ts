// Audit storage — plan/phase-05 T05.5.
//
// audit_event has existed since migration 001 but nothing ever wrote to it. Phase
// 05 makes every switch, cap and mode change auditable, which needs a writer and
// a tenant-scoped reader for the customer's own audit view.
//
// The insert is deliberately on the UNSCOPED db: audit_event carries its own
// tenant_id (the insert provides it), and the table is append-only with no update
// or delete path, so there is no tenant-scoping risk in writing it directly —
// every row is immutable the moment it lands. The READ goes through TenantDb, so
// a tenant can only ever see its own rows (the tenant predicate is applied by the
// scoping layer, exactly as with every other scoped table).

import type { Kysely } from 'kysely';
import type { DB } from './schema.js';
import type { TenantDb } from './tenant-scope.js';

export class AuditRepoError extends Error {
  override readonly name = 'AuditRepoError';
}

export interface AuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorUserId: string | null;
  readonly actorProcess: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly occurredAt: Date;
}

export interface NewAuditEvent {
  readonly tenantId: string;
  readonly actorUserId?: string | null | undefined;
  readonly actorProcess: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  /** JSON-serialisable state BEFORE the change. */
  readonly before?: unknown;
  /** JSON-serialisable state AFTER the change. */
  readonly after?: unknown;
  readonly occurredAt?: Date | undefined;
}

/**
 * Append one audit row. `before`/`after` go through the caller as plain values;
 * node-postgres serialises them to jsonb. Never the venue redaction story here —
 * a switch/cap/mode payload contains no secrets — but a caller writing anything
 * else must apply the same redaction the rest of the platform does (07 F6).
 */
export async function insertAuditEvent(db: Kysely<DB>, event: NewAuditEvent): Promise<string> {
  const occurredAt = event.occurredAt ?? new Date();
  const row = await db.insertInto('audit_event')
    .values({
      tenant_id: event.tenantId,
      actor_user_id: event.actorUserId ?? null,
      actor_process: event.actorProcess,
      action: event.action,
      subject_type: event.subjectType,
      subject_id: event.subjectId,
      before: (event.before ?? null) as never,
      after: (event.after ?? null) as never,
      occurred_at: occurredAt,
    } as never)
    .returning('id')
    .executeTakeFirst();
  if (row === undefined) throw new AuditRepoError('the audit insert returned no id');
  return String((row as { id: string }).id);
}

/**
 * A tenant's own audit trail, newest first. Tenant-scoped, so a tenant can never
 * read another's rows. `before` is an optional event id: pass it to page back.
 */
export async function listAuditEvents(
  tdb: TenantDb,
  opts: { limit?: number; before?: string } = {},
): Promise<readonly AuditEvent[]> {
  const limit = opts.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new AuditRepoError(`limit must be an integer in [1, 500], got ${limit}`);
  }
  let q = tdb.selectFrom('audit_event')
    .select([
      'id', 'tenant_id', 'actor_user_id', 'actor_process', 'action',
      'subject_type', 'subject_id', 'before', 'after', 'occurred_at',
    ] as unknown as never)
    .orderBy('occurred_at', 'desc' as never)
    .orderBy('id', 'desc' as never)
    .limit(limit);
  if (opts.before !== undefined) {
    q = q.where('id' as never, '<', opts.before as never);
  }
  const rows = await q.execute();
  return (rows as unknown as ReadonlyArray<Record<string, unknown>>).map((r) => ({
    id: String(r['id']),
    tenantId: String(r['tenant_id']),
    actorUserId: r['actor_user_id'] === null ? null : String(r['actor_user_id']),
    actorProcess: String(r['actor_process']),
    action: String(r['action']),
    subjectType: String(r['subject_type']),
    subjectId: String(r['subject_id']),
    before: r['before'],
    after: r['after'],
    occurredAt: new Date(r['occurred_at'] as string),
  }));
}
