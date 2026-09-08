// Session storage — the HTTP layer's auth backbone.
//
// A session is GLOBAL (see schema.ts): it is read to discover the tenant, so it
// is looked up on the unscoped db, not through TenantDb. The row stores only
// sha256(token); the raw token lives in the signed cookie. `loadPrincipalByToken`
// joins app_user in one query so a presented cookie resolves straight to
// everything authorise() needs — tenant, role, TOTP status, and the session's own
// reauth timestamp — while rejecting an expired or revoked session at the source.

import type { Kysely } from 'kysely';
import type { DB, UserRole } from './schema.js';

export class SessionRepoError extends Error {
  override readonly name = 'SessionRepoError';
}

export interface NewSession {
  readonly userId: string;
  /** sha256 of the raw token. 32 bytes. */
  readonly tokenHash: Uint8Array;
  readonly expiresAt: Date;
  /** Set when the login itself satisfied the second factor. */
  readonly reauthAt?: Date | undefined;
}

/** Everything a Principal needs, resolved from a live session in one read. */
export interface SessionPrincipal {
  readonly sessionId: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly role: UserRole;
  readonly reauthAt: Date | null;
  readonly totpEnabled: boolean;
  readonly expiresAt: Date;
}

/** Create a session row, returning its id. */
export async function createSession(db: Kysely<DB>, s: NewSession): Promise<string> {
  if (s.tokenHash.byteLength !== 32) {
    throw new SessionRepoError(`a session token hash must be 32 bytes, got ${s.tokenHash.byteLength}`);
  }
  const row = await db.insertInto('session')
    .values({
      user_id: s.userId,
      token_hash: Buffer.from(s.tokenHash),
      expires_at: s.expiresAt,
      reauth_at: s.reauthAt ?? null,
    } as never)
    .returning('id')
    .executeTakeFirst();
  if (row === undefined) throw new SessionRepoError('the session insert returned no id');
  return (row as { id: string }).id;
}

/**
 * Resolve a presented token hash to a live Principal, or null.
 *
 * Returns null for a missing, expired or revoked session — the caller cannot
 * tell which, on purpose, so the 401 leaks nothing. `now` is passed in so the
 * check is deterministic in tests.
 */
export async function loadPrincipalByToken(
  db: Kysely<DB>,
  tokenHash: Uint8Array,
  now: Date = new Date(),
): Promise<SessionPrincipal | null> {
  const row = await db.selectFrom('session')
    .innerJoin('app_user', 'app_user.id', 'session.user_id')
    .select([
      'session.id as sessionId',
      'session.user_id as userId',
      'session.reauth_at as reauthAt',
      'session.expires_at as expiresAt',
      'session.revoked_at as revokedAt',
      'app_user.tenant_id as tenantId',
      'app_user.role as role',
      'app_user.totp_enabled as totpEnabled',
      'app_user.disabled_at as disabledAt',
    ])
    .where('session.token_hash' as never, '=', Buffer.from(tokenHash) as never)
    .executeTakeFirst();
  if (row === undefined) return null;
  const r = row as {
    sessionId: string; userId: string; reauthAt: Date | string | null;
    expiresAt: Date | string; revokedAt: Date | string | null;
    tenantId: string; role: UserRole; totpEnabled: boolean; disabledAt: Date | string | null;
  };

  if (r.revokedAt !== null) return null;
  if (r.disabledAt !== null) return null;
  const expiresAt = r.expiresAt instanceof Date ? r.expiresAt : new Date(r.expiresAt);
  if (expiresAt.getTime() <= now.getTime()) return null;

  return {
    sessionId: r.sessionId,
    userId: r.userId,
    tenantId: r.tenantId,
    role: r.role,
    reauthAt: r.reauthAt === null ? null : (r.reauthAt instanceof Date ? r.reauthAt : new Date(r.reauthAt)),
    totpEnabled: r.totpEnabled,
    expiresAt,
  };
}

/** Record a fresh second factor on a session (the reauth-gated actions). */
export async function touchReauth(db: Kysely<DB>, sessionId: string, at: Date): Promise<void> {
  await db.updateTable('session')
    .set({ reauth_at: at } as never)
    .where('id' as never, '=', sessionId as never)
    .execute();
}

/** Revoke a single session (logout). Idempotent. */
export async function revokeSession(db: Kysely<DB>, sessionId: string, at: Date = new Date()): Promise<void> {
  await db.updateTable('session')
    .set({ revoked_at: at } as never)
    .where('id' as never, '=', sessionId as never)
    .where('revoked_at' as never, 'is', null as never)
    .execute();
}

/** Revoke every session for a user (a password change or an incident). */
export async function revokeAllForUser(db: Kysely<DB>, userId: string, at: Date = new Date()): Promise<number> {
  const result = await db.updateTable('session')
    .set({ revoked_at: at } as never)
    .where('user_id' as never, '=', userId as never)
    .where('revoked_at' as never, 'is', null as never)
    .executeTakeFirst();
  return Number((result as { numUpdatedRows?: bigint }).numUpdatedRows ?? 0n);
}
