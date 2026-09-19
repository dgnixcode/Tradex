// IP rate limiting and failure tracking storage — brute-force protection.
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from './schema.js';

export interface LoginIpAttemptRecord {
  readonly ip: string;
  readonly failedAttempts: number;
  readonly lastAttemptAt: Date;
  readonly blockedUntil: Date | null;
  readonly createdAt: Date;
}

/** Get the current attempt record for an IP address. */
export async function getLoginIpAttempt(
  db: Kysely<DB>,
  ip: string,
): Promise<LoginIpAttemptRecord | null> {
  const row = await db
    .selectFrom('login_ip_attempt')
    .selectAll()
    .where('ip', '=', ip)
    .executeTakeFirst();

  if (!row) return null;

  return {
    ip: row.ip,
    failedAttempts: Number(row.failed_attempts),
    lastAttemptAt: row.last_attempt_at instanceof Date ? row.last_attempt_at : new Date(String(row.last_attempt_at)),
    blockedUntil: row.blocked_until ? (row.blocked_until instanceof Date ? row.blocked_until : new Date(String(row.blocked_until))) : null,
    createdAt: row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at)),
  };
}

/** Check whether an IP is actively blocked. */
export async function isIpBlocked(
  db: Kysely<DB>,
  ip: string,
  nowMs: number = Date.now(),
): Promise<{ blocked: boolean; blockedUntil: Date | null; failedAttempts: number }> {
  const record = await getLoginIpAttempt(db, ip);
  if (!record) {
    return { blocked: false, blockedUntil: null, failedAttempts: 0 };
  }

  if (record.blockedUntil && record.blockedUntil.getTime() > nowMs) {
    return { blocked: true, blockedUntil: record.blockedUntil, failedAttempts: record.failedAttempts };
  }

  // If previous block expired, treat as not blocked
  return { blocked: false, blockedUntil: null, failedAttempts: record.failedAttempts };
}

/**
 * Record a failed login attempt for an IP.
 * Upserts: increments failed_attempts, updates last_attempt_at, and optionally sets blocked_until.
 */
export async function recordLoginFailure(
  db: Kysely<DB>,
  ip: string,
  blockedUntil: Date | null = null,
  nowMs: number = Date.now(),
): Promise<{ failedAttempts: number; blockedUntil: Date | null }> {
  const nowDate = new Date(nowMs);

  const result = await db
    .insertInto('login_ip_attempt')
    .values({
      ip,
      failed_attempts: 1,
      last_attempt_at: nowDate,
      blocked_until: blockedUntil,
      created_at: nowDate,
    } as never)
    .onConflict((oc) =>
      oc.column('ip').doUpdateSet((eb) => ({
        failed_attempts: sql<number>`login_ip_attempt.failed_attempts + 1`,
        last_attempt_at: nowDate as never,
        blocked_until: blockedUntil !== null ? (blockedUntil as never) : eb.ref('login_ip_attempt.blocked_until'),
      })),
    )
    .returning(['failed_attempts', 'blocked_until'] as never)
    .executeTakeFirst() as { failed_attempts: number | string; blocked_until: Date | string | null } | undefined;

  return {
    failedAttempts: result ? Number(result.failed_attempts) : 1,
    blockedUntil: result?.blocked_until ? (result.blocked_until instanceof Date ? result.blocked_until : new Date(String(result.blocked_until))) : null,
  };
}

/**
 * Reset failed attempts for an IP on successful login.
 */
export async function resetLoginIpAttempt(
  db: Kysely<DB>,
  ip: string,
): Promise<void> {
  await db
    .deleteFrom('login_ip_attempt')
    .where('ip', '=', ip)
    .execute();
}
