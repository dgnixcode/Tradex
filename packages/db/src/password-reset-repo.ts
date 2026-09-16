// Password reset token storage — email password recovery flow.
import type { Kysely } from 'kysely';
import type { DB } from './schema.js';

export class PasswordResetRepoError extends Error {
  override readonly name = 'PasswordResetRepoError';
}

export interface PasswordResetTokenRecord {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
}

/** Look up an active user by email (global across tenants, since login is by email). */
export async function findUserByEmail(
  db: Kysely<DB>,
  email: string,
): Promise<{ id: string; email: string; tenantId: string } | null> {
  const row = await db.selectFrom('app_user')
    .select(['id', 'email', 'tenant_id as tenantId', 'disabled_at as disabledAt'])
    .where('email', '=', email.toLowerCase().trim())
    .executeTakeFirst();
  if (row === undefined || row.disabledAt !== null) return null;
  return { id: row.id, email: row.email, tenantId: row.tenantId };
}

/** Store a hashed reset token for a user. */
export async function createPasswordResetToken(
  db: Kysely<DB>,
  userId: string,
  tokenHash: Uint8Array,
  expiresAt: Date,
): Promise<string> {
  if (tokenHash.byteLength !== 32) {
    throw new PasswordResetRepoError(`token hash must be 32 bytes, got ${tokenHash.byteLength}`);
  }
  const row = await db.insertInto('password_reset_token')
    .values({
      user_id: userId,
      token_hash: Buffer.from(tokenHash),
      expires_at: expiresAt,
      used_at: null,
    } as never)
    .returning('id')
    .executeTakeFirst();
  if (row === undefined) throw new PasswordResetRepoError('failed to insert reset token');
  return (row as { id: string }).id;
}

/** Find a valid, non-expired, non-used reset token by its SHA-256 hash. */
export async function findValidResetToken(
  db: Kysely<DB>,
  tokenHash: Uint8Array,
  now: Date,
): Promise<PasswordResetTokenRecord | null> {
  const row = await db.selectFrom('password_reset_token')
    .select(['id', 'user_id as userId', 'expires_at as expiresAt', 'used_at as usedAt'])
    .where('token_hash', '=', Buffer.from(tokenHash) as never)
    .where('used_at', 'is', null)
    .where('expires_at', '>', now)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt,
    usedAt: row.usedAt,
  };
}

/** Atomically mark the reset token used, update the user password hash, and revoke existing sessions. */
export async function consumeResetTokenAndUpdatePassword(
  db: Kysely<DB>,
  tokenId: string,
  userId: string,
  newPasswordHash: string,
  now: Date,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await trx.updateTable('password_reset_token')
      .set({ used_at: now } as never)
      .where('id', '=', tokenId)
      .where('used_at', 'is', null)
      .execute();

    await trx.updateTable('app_user')
      .set({ password_hash: newPasswordHash } as never)
      .where('id', '=', userId)
      .execute();

    await trx.updateTable('session')
      .set({ revoked_at: now } as never)
      .where('user_id', '=', userId)
      .where('revoked_at', 'is', null)
      .execute();
  });
}
