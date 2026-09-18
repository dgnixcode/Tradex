// TOTP enrolment — the real second factor for a Tradex login.
//
// A user secures their own login with OUR two-factor authentication (never the
// exchange's — 07 F10). begin() generates a fresh base32 secret, seals it under
// the user's identity (packages/crypto totp-secret), persists it with
// totp_enabled STILL false, and hands back the otpauth URI + secret exactly once
// for the authenticator app to scan or type. confirm() verifies a code against
// the SEALED secret (so the plaintext never lives here) and only then enables it.
//
// Once enabled, login requires the code and the session starts reauth-fresh —
// which is what unlocks the owner+reauth actions (resume, limits changes, large
// trades) that Phase 05 deliberately left hard-403 until this existed.

import { generateTotpSecret, totpEnrolmentUri } from '@tradex/auth';
import { sealTotpSecret, verifyTotpFromEnvelope } from '@tradex/crypto';
import type { KmsPort } from '@tradex/crypto';
import { getUserTotpRow, insertAuditEvent, setUserTotp } from '@tradex/db';
import type { DB, TenantDb } from '@tradex/db';
import type { Kysely } from 'kysely';

const KEY_VERSION = 1;

export class TotpServiceError extends Error {
  override readonly name = 'TotpServiceError';
  constructor(
    message: string,
    readonly reason: 'already_enabled' | 'no_pending' | 'bad_code' | 'current_code_required',
  ) {
    super(message);
  }
}

export interface BeginResult {
  readonly secret: string;
  readonly otpauthUri: string;
}

export interface TotpDeps {
  readonly db: Kysely<DB>;
  readonly tdb: TenantDb;
  readonly kms: KmsPort;
}

export class TotpService {
  constructor(private readonly deps: TotpDeps) {}

  /**
   * Begin enrolment for the CURRENT user. Returns the secret and its otpauth URI
   * (shown once). If 2FA is already enabled, the user must provide their current
   * code to authorize re-enrolment. The freshly sealed envelope is stored with
   * totp_enabled false until confirm() proves a code against the new secret.
   */
  async begin(userId: string, currentCode?: string, atMs?: number): Promise<BeginResult> {
    const row = await getUserTotpRow(this.deps.tdb, userId);
    if (row === null) throw new TotpServiceError('user not found', 'no_pending');

    if (row.totpEnabled) {
      if (currentCode === undefined || currentCode.trim() === '') {
        throw new TotpServiceError('current 2FA code is required to change 2FA authenticator', 'current_code_required');
      }
      if (row.totpSecretCt === null) throw new TotpServiceError('no 2FA secret on record', 'no_pending');
      const nowMs = atMs ?? Date.now();
      const ok = await verifyTotpFromEnvelope(this.deps.kms, {
        tenantId: row.tenantId,
        userId,
        keyVersion: KEY_VERSION,
      }, row.totpSecretCt, currentCode.trim(), nowMs);
      if (!ok) throw new TotpServiceError('current 2FA code is not valid', 'bad_code');
    }

    const secret = generateTotpSecret();
    const sealed = await sealTotpSecret(this.deps.kms, {
      tenantId: row.tenantId,
      userId,
      keyVersion: KEY_VERSION,
    }, secret);

    await setUserTotp(this.deps.tdb, userId, Buffer.from(sealed.buffer), false);
    return {
      secret,
      otpauthUri: totpEnrolmentUri(secret, row.email),
    };
  }

  /**
   * Confirm enrolment by proving the user can produce a valid code against the
   * stored secret. Only then is totp_enabled flipped on.
   */
  async confirm(userId: string, code: string, atMs: number): Promise<void> {
    const row = await getUserTotpRow(this.deps.tdb, userId);
    if (row === null) throw new TotpServiceError('user not found', 'no_pending');
    if (row.totpSecretCt === null) throw new TotpServiceError('no enrolment is pending', 'no_pending');

    const ok = await verifyTotpFromEnvelope(this.deps.kms, {
      tenantId: row.tenantId,
      userId,
      keyVersion: KEY_VERSION,
    }, row.totpSecretCt, code.trim(), atMs);
    if (!ok) throw new TotpServiceError('that code is not valid', 'bad_code');

    await setUserTotp(this.deps.tdb, userId, Buffer.from(row.totpSecretCt), true);
    await insertAuditEvent(this.deps.db, {
      tenantId: row.tenantId,
      actorUserId: userId,
      actorProcess: 'api',
      action: 'account.totp.enable',
      subjectType: 'user',
      subjectId: userId,
      before: { totpEnabled: false },
      after: { totpEnabled: true },
      occurredAt: new Date(atMs),
    });
  }

  /**
   * Disable 2FA for the CURRENT user after verifying their current 6-digit code.
   * Clears the sealed envelope, flips totp_enabled to false, and records an audit event.
   */
  async disable(userId: string, code: string, atMs: number): Promise<void> {
    const row = await getUserTotpRow(this.deps.tdb, userId);
    if (row === null) throw new TotpServiceError('user not found', 'no_pending');
    if (!row.totpEnabled || row.totpSecretCt === null) {
      throw new TotpServiceError('2FA is not enabled on this account', 'no_pending');
    }

    const ok = await verifyTotpFromEnvelope(this.deps.kms, {
      tenantId: row.tenantId,
      userId,
      keyVersion: KEY_VERSION,
    }, row.totpSecretCt, code.trim(), atMs);
    if (!ok) throw new TotpServiceError('that code is not valid', 'bad_code');

    await setUserTotp(this.deps.tdb, userId, null, false);
    await insertAuditEvent(this.deps.db, {
      tenantId: row.tenantId,
      actorUserId: userId,
      actorProcess: 'api',
      action: 'account.totp.disable',
      subjectType: 'user',
      subjectId: userId,
      before: { totpEnabled: true },
      after: { totpEnabled: false },
      occurredAt: new Date(atMs),
    });
  }
}
