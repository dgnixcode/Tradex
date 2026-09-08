// The signer — plan/phase-02 T02.3, from 07-api-key-security.md F3/F5/F6.
//
// The only place in the system where a customer's API secret exists in
// plaintext, and the only holder of KMS decrypt rights once Phase 06 splits it
// into its own process. Everything above it asks for a signature and receives
// one; nothing above it can ask for a secret, because there is no method that
// returns one.
//
// Three properties this file exists to hold:
//
//   1. THE SECRET NEVER LEAVES. `sign()` returns a hex digest and the public API
//      key. There is no `getSecret`, and the `Secret` wrapper is unwrapped
//      exactly twice, both times into a local that is overwritten before return.
//      The CI rule SIGNER-ONLY-EXPOSE makes `.expose()` a build failure anywhere
//      but here, `packages/secret` and `packages/crypto`.
//
//   2. EVERY DECRYPT IS AUDITED, with actor, process and reason — and the audit
//      row is written BEFORE the signature is returned. A decrypt we cannot
//      account for afterwards is indistinguishable from an exfiltration (07 F3),
//      so `reason` is a required field on the request rather than an option.
//
//   3. IT REFUSES A CREDENTIAL THAT IS NOT ACTIVE. A revoked credential has no
//      DEK to unwrap, and a `pending_validation` one has not yet been proved to
//      work; signing with either produces a venue error that looks like an
//      outage. The refusal is explicit and names the status.
//
// It knows nothing about CoinDCX. See packages/exchange/src/signer-port.ts for
// why that boundary is load-bearing rather than decorative.

import { createHmac } from 'node:crypto';
import { openCredential } from '@tradex/crypto';
import type { KmsPort } from '@tradex/crypto';
import { isUsable, loadCiphertext } from '@tradex/db';
import type { TenantDb } from '@tradex/db';
import { SignerError } from '@tradex/exchange';
import type { SignatureRequest, SignatureResult, SignerPort } from '@tradex/exchange';

/** Written to `audit_event.action` on every decrypt. One value, so it is greppable. */
export const DECRYPT_AUDIT_ACTION = 'credential.decrypt';

export interface SignerDeps {
  readonly tdb: TenantDb;
  readonly kms: KmsPort;
  /** Injected for tests. Production passes nothing. */
  readonly nowMs?: (() => number) | undefined;
}

export class Signer implements SignerPort {
  constructor(private readonly deps: SignerDeps) {}

  async sign(request: SignatureRequest): Promise<SignatureResult> {
    if (request.algorithm !== 'hmac-sha256-hex') {
      throw new SignerError(`unsupported algorithm ${String(request.algorithm)}`);
    }
    if (typeof request.payload !== 'string' || request.payload === '') {
      throw new SignerError('refusing to sign an empty payload');
    }
    if (typeof request.reason !== 'string' || request.reason.trim() === '') {
      throw new SignerError(
        'a decrypt requires a stated reason — an unaccountable decrypt is indistinguishable from exfiltration',
      );
    }

    const { tdb, kms } = this.deps;
    const row = await loadCiphertext(tdb, request.credentialId);
    if (row === null) {
      throw new SignerError(`no credential ${request.credentialId} in this tenant`);
    }
    if (!isUsable(row)) {
      throw new SignerError(
        `credential ${row.id} is ${row.status}${row.dekWrapped === null ? ' and has been crypto-shredded' : ''}`
        + ' — refusing to sign',
      );
    }

    const identity = {
      tenantId: row.tenantId,
      accountId: row.accountId,
      credentialId: row.id,
      keyVersion: row.keyVersion,
    };
    // dekWrapped is non-null here: isUsable() checked it, and the database CHECK
    // exchange_credential_active_has_dek makes an active row without one
    // unrepresentable.
    const opened = await openCredential(kms, identity, {
      dekWrapped: row.dekWrapped as Uint8Array,
      apiKey: { ct: row.apiKeyCt, nonce: row.apiKeyNonce, tag: row.apiKeyTag },
      apiSecret: { ct: row.apiSecretCt, nonce: row.apiSecretNonce, tag: row.apiSecretTag },
    });

    // `expose()` is legal here and nowhere else (SIGNER-ONLY-EXPOSE). Neither
    // local escapes this function: the structural defence is the absence of a
    // return path for the secret, not the erasure of the bytes — a JS string
    // cannot be zeroed, and pretending otherwise would be theatre.
    const apiKey = opened.apiKey.expose();
    const signature = createHmac('sha256', opened.apiSecret.expose())
      .update(request.payload, 'utf8')
      .digest('hex');

    await this.audit(request, row.id, row.accountId);
    return { apiKey, signature, keyVersion: row.keyVersion };
  }

  /**
   * Write the decrypt audit row. Awaited before returning the signature on
   * purpose: a signature handed out before its audit row is committed is a
   * decrypt that can happen with no record if the process dies in between.
   */
  private async audit(request: SignatureRequest, credentialId: string, accountId: string): Promise<void> {
    const at = new Date(this.deps.nowMs?.() ?? Date.now());
    await this.deps.tdb.insertInto('audit_event', {
      actor_user_id: request.actorUserId ?? null,
      actor_process: request.actorProcess,
      action: DECRYPT_AUDIT_ACTION,
      subject_type: 'exchange_credential',
      subject_id: credentialId,
      // The payload is NEVER recorded: a signed body carries order details, and
      // some future body may carry more. Only its length and digest go in, which
      // is enough to correlate a decrypt with a request without storing it.
      after: {
        account_id: accountId,
        reason: request.reason,
        payload_bytes: Buffer.byteLength(request.payload, 'utf8'),
        payload_sha256: createHmac('sha256', 'tradex-audit-correlation')
          .update(request.payload, 'utf8').digest('hex').slice(0, 32),
      },
      occurred_at: at,
    }).execute();
  }
}
