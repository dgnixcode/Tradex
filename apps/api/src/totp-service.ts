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
    readonly reason: 'already_enabled' | 'no_pending' | 'bad_code',
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
   * (shown once). The sealed envelope is stored with totp_enabled false; a re-begin
   * simply overwrites it — the user can restart until they confirm a code.
   */
  async begin(userId: string): Promise<BeginResult> {
    const row = await getUserTotpRow(this.deps.tdb, userId);
    if (row === null) throw new TotpServiceError('user not found', 'no_pending');
    if (row.totpEnabled) throw new TotpServiceError('2FA is already enabled', 'already_enabled');

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
    }, row.totpSecretCt, code, atMs);
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
}
