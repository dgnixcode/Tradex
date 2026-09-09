// TOTP-secret envelope — plan/phase-05 follow-on (real 2FA for operators).
//
// app_user.totp_secret_ct is a single bytea column, so unlike an exchange
// credential (which has per-field ciphertext columns) the whole envelope must
// live in one self-contained buffer. The discipline is otherwise identical to
// envelope.ts: AES-256-GCM under a per-user DEK wrapped by KMS, with the AAD
// bound to the tenant + user + key version, so a ciphertext row physically cannot
// be opened under a different tenant, user or key version — even with full write
// access to the database. The DEK is zeroed before returning, always.
//
// The buffer framing (so it round-trips without a JSON layer):
//   [0]        version (1)
//   [1..3)     keyVersion, uint16 BE
//   [3..15)    nonce (12)
//   [15..31)   GCM tag (16)
//   [31..33)   wrapped-DEK length, uint16 BE
//   [33..)     wrapped DEK, then the ciphertext to the end
//
// Storing a TOTP secret here is WHY the secret never appears in a log or a list:
// redact.ts already treats totp_secret-shaped values as secrets, and the only
// time it is decrypted is at login/step-up, inside the verify port.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Secret } from '@tradex/secret';
import { verifyTotp } from '@tradex/auth';
import { EnvelopeError } from './envelope.js';
import { zero } from './envelope.js';
import type { DekBytes, KmsPort } from './kms.js';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Everything the TOTP AAD binds to. */
export interface TotpIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly keyVersion: number;
}

function totpAad(id: TotpIdentity): Buffer {
  for (const [k, v] of Object.entries(id)) {
    if (v === undefined || v === null || v === '') {
      throw new EnvelopeError(`TOTP AAD field ${k} is empty — refusing to bind a secret to a partial identity`);
    }
  }
  if (!Number.isInteger(id.keyVersion) || id.keyVersion < 1) {
    throw new EnvelopeError(`keyVersion must be a positive integer, received ${String(id.keyVersion)}`);
  }
  return Buffer.from(`tradex-totp-v1|tenant=${id.tenantId}|user=${id.userId}|keyVersion=${id.keyVersion}`, 'utf8');
}

export interface SealedTotp {
  /** The whole thing to store in app_user.totp_secret_ct. */
  readonly buffer: Uint8Array;
  readonly keyId: string;
  readonly keyVersion: number;
}

/**
 * Seal a freshly generated TOTP base32 secret under the user's identity. Takes
 * the plain secret because this is the boundary where a value first becomes
 * ciphertext; nothing above here should hold it and nothing below retains it.
 */
export async function sealTotpSecret(
  kms: KmsPort,
  id: TotpIdentity,
  secretPlain: string,
): Promise<SealedTotp> {
  if (secretPlain === '') throw new EnvelopeError('refusing to seal an empty TOTP secret');
  const { plaintext: dek, wrapped } = await kms.generateDek();
  try {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(dek), nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(totpAad(id));
    const plain = Buffer.from(secretPlain, 'utf8');
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    plain.fill(0);
    const tag = cipher.getAuthTag();

    const buf = Buffer.alloc(33 + wrapped.byteLength + ct.byteLength);
    buf[0] = 1;
    buf.writeUInt16BE(id.keyVersion, 1);
    Buffer.from(nonce).copy(buf, 3);
    Buffer.from(tag).copy(buf, 15);
    buf.writeUInt16BE(wrapped.byteLength, 31);
    Buffer.from(wrapped).copy(buf, 33);
    ct.copy(buf, 33 + wrapped.byteLength);
    return { buffer: buf, keyId: kms.keyId, keyVersion: id.keyVersion };
  } finally {
    zero(dek);
  }
}

/** Open a sealed TOTP secret. Returns a Secret — the caller verifies, never logs it. */
export async function openTotpSecret(kms: KmsPort, id: TotpIdentity, buffer: Uint8Array): Promise<Secret> {
  const buf = Buffer.from(buffer);
  if (buf.byteLength < 33 || buf[0] !== 1) {
    throw new EnvelopeError('the stored TOTP envelope is not in the expected format');
  }
  const keyVersion = buf.readUInt16BE(1);
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(15, 31);
  const lenWrapped = buf.readUInt16BE(31);
  const wrapped = buf.subarray(33, 33 + lenWrapped);
  const ct = buf.subarray(33 + lenWrapped);

  // The envelope was bound to the keyVersion that was current when it was sealed.
  // If that differs from the caller's identity, the secret was sealed under a
  // different generation — refuse rather than guess (a re-encryption pass would
  // migrate it forward explicitly).
  if (keyVersion !== id.keyVersion) {
    throw new EnvelopeError(
      `stored TOTP envelope is keyVersion ${keyVersion}, caller expects ${id.keyVersion} — re-encrypt before opening`,
    );
  }

  const dek: DekBytes = await kms.unwrapDek(wrapped);
  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(dek), nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(totpAad(id));
    decipher.setAuthTag(tag);
    let out: Buffer;
    try {
      out = Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new EnvelopeError('authentication failed — the ciphertext, the tag, or the identity it was bound to does not match');
    }
    const value = out.toString('utf8');
    out.fill(0);
    return Secret.of(value, 'totp');
  } finally {
    zero(dek);
  }
}

/**
 * Verify a TOTP code against a SEALED secret, without ever returning the
 * plaintext. This lives in packages/crypto — one of the directories the
 * SIGNER-ONLY-EXPOSE rule permits to call Secret.expose() — because the API
 * process needs to check a login code but must never hold the secret in a form a
 * log could print. The plaintext exists only inside this call.
 */
export async function verifyTotpFromEnvelope(
  kms: KmsPort,
  id: TotpIdentity,
  buffer: Uint8Array,
  code: string,
  atMs: number = Date.now(),
): Promise<boolean> {
  const secret = await openTotpSecret(kms, id, buffer);
  return verifyTotp(secret.expose(), code, atMs);
}
