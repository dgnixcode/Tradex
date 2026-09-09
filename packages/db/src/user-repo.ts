// User auth storage — the TOTP half of app_user (real 2FA for operators).
//
// The 2FA secret is stored KMS-encrypted in app_user.totp_secret_ct (sealed by
// @tradex/crypto's totp-secret envelope) and only decrypts inside packages/crypto
// at verify time. This repo owns the row writes: begin stores a freshly sealed
// envelope with totp_enabled STILL false (the user has not yet proved they can
// produce codes), and confirm flips it true only after a code verifies.

import type { TenantDb } from './tenant-scope.js';

export class UserRepoError extends Error {
  override readonly name = 'UserRepoError';
}

export interface UserTotpRow {
  readonly userId: string;
  readonly tenantId: string;
  readonly email: string;
  readonly totpSecretCt: Uint8Array | null;
  readonly totpEnabled: boolean;
}

/** Read a user's TOTP row (scoped to the caller's tenant, so no cross-tenant read). */
export async function getUserTotpRow(tdb: TenantDb, userId: string): Promise<UserTotpRow | null> {
  const row = await tdb.byId('app_user', userId)
    .select(['id', 'tenant_id', 'email', 'totp_secret_ct', 'totp_enabled'] as unknown as never)
    .executeTakeFirst();
  if (row === undefined) return null;
  const r = row as { id: string; tenant_id: string; email: string; totp_secret_ct: Uint8Array | null; totp_enabled: boolean };
  return { userId: r.id, tenantId: r.tenant_id, email: r.email, totpSecretCt: r.totp_secret_ct, totpEnabled: r.totp_enabled };
}

/**
 * Persist a freshly sealed envelope. `enabled` is normally false from begin and
 * true only after confirm; the caller decides, this repo just writes the pair.
 */
export async function setUserTotp(
  tdb: TenantDb,
  userId: string,
  envelope: Uint8Array | null,
  enabled: boolean,
): Promise<void> {
  const updated = await tdb.updateTable('app_user')
    .set({ totp_secret_ct: envelope, totp_enabled: enabled } as never)
    .where('id' as never, '=', userId as never)
    .returning('id' as unknown as never)
    .executeTakeFirst();
  if (updated === undefined) throw new UserRepoError(`user ${userId} was not found`);
}
