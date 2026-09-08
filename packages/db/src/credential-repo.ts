// Credential storage — plan/phase-02 T02.2 and T02.7.
//
// This layer moves ciphertext. It never sees a key, a secret, or a DEK: the
// envelope work happens in `packages/crypto` and the only decryption happens in
// `apps/signer`, which is the only place permitted to call `expose()`. Keeping
// storage ignorant of plaintext is what makes "a database dump is worthless" a
// structural claim rather than a hope.
//
// Two things here are deliberately single SQL statements rather than
// read-modify-write:
//
//   - `recordAuthFailure` increments and flips to `failed_auth` in one UPDATE.
//     Three concurrent legs of one group trade can each receive a 401 at the same
//     instant; read-then-write leaves all three seeing count 0 and the credential
//     still active, which is exactly the case the "3 consecutive 401s" rule
//     exists to stop (T02.7).
//   - `revoke` sets the status, nulls the DEK and stamps the time together, so
//     the `exchange_credential_revoked_is_shredded` CHECK can never see a
//     half-revoked row.

import { sql } from 'kysely';
import type { CredentialStatus } from './schema.js';
import type { TenantDb } from './tenant-scope.js';
import { TenancyError } from './tenant-scope.js';

/** Consecutive 401s before the credential is blocked and the customer notified. */
export const AUTH_FAILURE_THRESHOLD = 3;

export class CredentialRepoError extends Error {
  override readonly name = 'CredentialRepoError';
}

/** Exactly the columns needed to insert one sealed credential. No plaintext. */
export interface SealedCredentialRow {
  /**
   * The credential id, chosen by the CALLER, not by the database.
   *
   * This is forced by the envelope: the AAD binds each ciphertext to
   * `tenant|account|credential|keyVersion`, so the id has to exist before
   * `sealCredential` runs. Letting the database default it would mean sealing
   * against an id that does not exist yet and inserting against a seal that
   * cannot be opened — the two operations deadlock on each other.
   */
  readonly id: string;
  readonly accountId: string;
  readonly kmsKeyArn: string;
  readonly keyVersion: number;
  readonly dekWrapped: Uint8Array;
  readonly apiKeyCt: Uint8Array;
  readonly apiKeyNonce: Uint8Array;
  readonly apiKeyTag: Uint8Array;
  readonly apiSecretCt: Uint8Array;
  readonly apiSecretNonce: Uint8Array;
  readonly apiSecretTag: Uint8Array;
  readonly apiKeyLast4: string;
  readonly fingerprint: Uint8Array;
}

/** What the signer needs to open a credential, and nothing more. */
export interface CredentialCiphertext {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly keyVersion: number;
  readonly status: CredentialStatus;
  readonly dekWrapped: Uint8Array | null;
  readonly apiKeyCt: Uint8Array;
  readonly apiKeyNonce: Uint8Array;
  readonly apiKeyTag: Uint8Array;
  readonly apiSecretCt: Uint8Array;
  readonly apiSecretNonce: Uint8Array;
  readonly apiSecretTag: Uint8Array;
}

const CIPHERTEXT_COLUMNS = [
  'id', 'tenant_id', 'account_id', 'key_version', 'status', 'dek_wrapped',
  'api_key_ct', 'api_key_nonce', 'api_key_tag',
  'api_secret_ct', 'api_secret_nonce', 'api_secret_tag',
] as const;

/**
 * Insert a sealed credential as `pending_validation`.
 *
 * Never `active`: the status only advances after a live call to the venue has
 * proved the key works (19 F3). Inserting straight to `active` would let a
 * mistyped key sit in a group and fail per-account mid-fan-out.
 */
export async function insertCredential(tdb: TenantDb, row: SealedCredentialRow): Promise<string> {
  if (row.dekWrapped.byteLength === 0) {
    throw new CredentialRepoError('refusing to store a credential with an empty wrapped DEK');
  }
  if (typeof row.id !== 'string' || row.id.trim() === '') {
    throw new CredentialRepoError(
      'a credential id must be chosen before sealing — the AAD binds the ciphertext to it',
    );
  }
  const inserted = await tdb
    .insertInto('exchange_credential', {
      id: row.id,
      account_id: row.accountId,
      kms_key_arn: row.kmsKeyArn,
      key_version: row.keyVersion,
      dek_wrapped: Buffer.from(row.dekWrapped),
      api_key_ct: Buffer.from(row.apiKeyCt),
      api_key_nonce: Buffer.from(row.apiKeyNonce),
      api_key_tag: Buffer.from(row.apiKeyTag),
      api_secret_ct: Buffer.from(row.apiSecretCt),
      api_secret_nonce: Buffer.from(row.apiSecretNonce),
      api_secret_tag: Buffer.from(row.apiSecretTag),
      api_key_last4: row.apiKeyLast4,
      fingerprint: Buffer.from(row.fingerprint),
      status: 'pending_validation',
    })
    .returning('id')
    .executeTakeFirst();
  if (inserted === undefined) throw new CredentialRepoError('the credential insert returned no id');
  return (inserted as { id: string }).id;
}

/** Load the ciphertext for one credential. Returns null when it does not exist. */
export async function loadCiphertext(tdb: TenantDb, credentialId: string): Promise<CredentialCiphertext | null> {
  const row = await tdb.byId('exchange_credential', credentialId)
    .select(CIPHERTEXT_COLUMNS as unknown as never)
    .executeTakeFirst();
  if (row === undefined) return null;
  const r = row as unknown as Record<string, unknown>;
  return {
    id: r['id'] as string,
    tenantId: r['tenant_id'] as string,
    accountId: r['account_id'] as string,
    keyVersion: Number(r['key_version']),
    status: r['status'] as CredentialStatus,
    dekWrapped: (r['dek_wrapped'] as Uint8Array | null),
    apiKeyCt: r['api_key_ct'] as Uint8Array,
    apiKeyNonce: r['api_key_nonce'] as Uint8Array,
    apiKeyTag: r['api_key_tag'] as Uint8Array,
    apiSecretCt: r['api_secret_ct'] as Uint8Array,
    apiSecretNonce: r['api_secret_nonce'] as Uint8Array,
    apiSecretTag: r['api_secret_tag'] as Uint8Array,
  };
}

/**
 * Look up a fingerprint within this tenant.
 *
 * Returns the conflicting account's name, because "this key is already
 * connected" is unhelpful on its own — the customer needs to know which of their
 * twenty accounts it is (T02.4).
 */
export async function findByFingerprint(
  tdb: TenantDb,
  fingerprint: Uint8Array,
): Promise<{ credentialId: string; accountId: string; accountName: string; status: CredentialStatus } | null> {
  const row = await tdb.selectFrom('exchange_credential')
    .innerJoin('exchange_account', 'exchange_account.id', 'exchange_credential.account_id')
    .where('exchange_credential.fingerprint' as never, '=', Buffer.from(fingerprint) as never)
    .select([
      'exchange_credential.id as credential_id',
      'exchange_credential.account_id as account_id',
      'exchange_credential.status as status',
      'exchange_account.name as account_name',
    ] as unknown as never)
    .executeTakeFirst();
  if (row === undefined) return null;
  const r = row as unknown as Record<string, unknown>;
  return {
    credentialId: r['credential_id'] as string,
    accountId: r['account_id'] as string,
    accountName: r['account_name'] as string,
    status: r['status'] as CredentialStatus,
  };
}

/** `pending_validation` -> `active`, once a live call has proved the key works. */
export async function activate(tdb: TenantDb, credentialId: string, atMs = Date.now()): Promise<boolean> {
  const result = await tdb.updateTable('exchange_credential')
    .set({ status: 'active', validated_at: new Date(atMs), auth_error_count: 0 } as never)
    .where('id' as never, '=', credentialId as never)
    // Only from pending_validation or active. A revoked credential must never be
    // resurrected by a validation call.
    .where('status' as never, 'in', ['pending_validation', 'active'] as never)
    // RETURNING rather than a row count: the builder's output type is unknown
    // here, and "did a row come back" is the more precise question anyway.
    .returning('id' as unknown as never)
    .executeTakeFirst();
  return result !== undefined;
}

/**
 * Record one 401 and block the credential at the threshold, in one statement.
 *
 * Returns the resulting count and status so the caller knows whether to notify.
 * Never retries and never resets on its own: a blocked credential is unblocked
 * by the customer replacing the key, not by us trying again (T02.7).
 */
export async function recordAuthFailure(
  tdb: TenantDb,
  credentialId: string,
  atMs = Date.now(),
): Promise<{ authErrorCount: number; status: CredentialStatus; blocked: boolean } | null> {
  const row = await tdb.updateTable('exchange_credential')
    .set({
      auth_error_count: sql`auth_error_count + 1`,
      last_auth_error_at: new Date(atMs),
      status: sql`CASE
        WHEN status = 'revoked' THEN status
        WHEN auth_error_count + 1 >= ${AUTH_FAILURE_THRESHOLD} THEN 'failed_auth'
        ELSE status END`,
    } as never)
    .where('id' as never, '=', credentialId as never)
    .returning(['auth_error_count', 'status'] as unknown as never)
    .executeTakeFirst();
  if (row === undefined) return null;
  const r = row as unknown as { auth_error_count: number | string; status: CredentialStatus };
  const count = Number(r.auth_error_count);
  return { authErrorCount: count, status: r.status, blocked: r.status === 'failed_auth' };
}

/**
 * Clear the consecutive-failure counter after a successful call.
 *
 * Without this the count is cumulative rather than consecutive, and a credential
 * that has worked for a year gets blocked by its third unrelated clock skew.
 */
export async function recordAuthSuccess(tdb: TenantDb, credentialId: string): Promise<void> {
  await tdb.updateTable('exchange_credential')
    .set({ auth_error_count: 0 } as never)
    .where('id' as never, '=', credentialId as never)
    .where('auth_error_count' as never, '>', 0 as never)
    .execute();
}

/**
 * Crypto-shred: null the wrapped DEK, so the ciphertext is unrecoverable even by
 * us, while the row survives for audit and retention (15).
 *
 * One statement, because the `exchange_credential_revoked_is_shredded` CHECK
 * refuses a row that is revoked but still decryptable — which is the guarantee,
 * not an inconvenience. Setting the status first and the DEK second would fail
 * the constraint and leave the credential usable.
 */
export async function revoke(
  tdb: TenantDb,
  credentialId: string,
  atMs = Date.now(),
): Promise<boolean> {
  const result = await tdb.updateTable('exchange_credential')
    .set({ status: 'revoked', dek_wrapped: null, revoked_at: new Date(atMs) } as never)
    .where('id' as never, '=', credentialId as never)
    .where('status' as never, '<>', 'revoked' as never)
    .returning('id' as unknown as never)
    .executeTakeFirst();
  return result !== undefined;
}

/**
 * True when this credential may be used to sign.
 *
 * `pending_validation` is excluded on purpose: the only call allowed on an
 * unvalidated credential is the validation call itself, which passes the
 * ciphertext directly rather than going through this gate.
 */
export const isUsable = (row: Pick<CredentialCiphertext, 'status' | 'dekWrapped'>): boolean =>
  row.status === 'active' && row.dekWrapped !== null;

/** Guard for a caller that has a credential id but no tenant context yet. */
export function assertTenantScoped(tdb: TenantDb | undefined): TenantDb {
  if (tdb === undefined) {
    throw new TenancyError('credential access requires a tenant context — refusing to read across tenants');
  }
  return tdb;
}
