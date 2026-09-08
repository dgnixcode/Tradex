// Envelope encryption — plan/phase-00 T00.6, from 07-api-key-security.md F3.
//
// AES-256-GCM with the AAD bound to the credential's identity, so a ciphertext
// row physically cannot be opened under a different tenant, account, credential
// or key version — even by someone with full write access to the database. A
// relocated row fails authentication rather than decrypting for the wrong
// customer.

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { Secret } from '@tradex/secret';
import type { DekBytes, KmsPort } from './kms.js';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class EnvelopeError extends Error {
  override readonly name = 'EnvelopeError';
}

/** Everything the AAD binds to. All four fields are mandatory. */
export interface CredentialIdentity {
  readonly tenantId: string;
  readonly accountId: string;
  readonly credentialId: string;
  readonly keyVersion: number;
}

export interface Sealed {
  readonly ct: Uint8Array;
  readonly nonce: Uint8Array;
  readonly tag: Uint8Array;
}

/** One credential row's worth of ciphertext, as stored in `exchange_credential`. */
export interface SealedCredential {
  readonly dekWrapped: Uint8Array;
  readonly kmsKeyId: string;
  readonly keyVersion: number;
  readonly apiKey: Sealed;
  readonly apiSecret: Sealed;
  /** Non-secret display value, e.g. '…a91f'. Safe to log and render. */
  readonly apiKeyLast4: string;
}

/**
 * Canonical AAD. Built in exactly one place so it cannot be assembled
 * differently on the seal and open paths — a mismatch there would look like
 * corruption and be very hard to diagnose.
 */
export function aadFor(id: CredentialIdentity): Buffer {
  for (const [k, v] of Object.entries(id)) {
    if (v === undefined || v === null || v === '') {
      throw new EnvelopeError(`AAD field ${k} is empty — refusing to bind a credential to a partial identity`);
    }
  }
  if (!Number.isInteger(id.keyVersion) || id.keyVersion < 1) {
    throw new EnvelopeError(`keyVersion must be a positive integer, received ${String(id.keyVersion)}`);
  }
  return Buffer.from(
    `tradex-cred-v1|tenant=${id.tenantId}|account=${id.accountId}|credential=${id.credentialId}|keyVersion=${id.keyVersion}`,
    'utf8',
  );
}

/** Encrypt one field under a live DEK. */
export function sealWithDek(dek: DekBytes, plaintext: string, id: CredentialIdentity): Sealed {
  if (dek.byteLength !== 32) throw new EnvelopeError('DEK must be 32 bytes');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aadFor(id));
  const buf = Buffer.from(plaintext, 'utf8');
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  buf.fill(0);
  return { ct, nonce, tag: cipher.getAuthTag() };
}

/** Decrypt one field under a live DEK. Returns a Secret, never a bare string. */
export function openWithDek(dek: DekBytes, sealed: Sealed, id: CredentialIdentity): Secret {
  if (dek.byteLength !== 32) throw new EnvelopeError('DEK must be 32 bytes');
  const decipher = createDecipheriv('aes-256-gcm', dek, sealed.nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aadFor(id));
  decipher.setAuthTag(Buffer.from(sealed.tag));
  let out: Buffer;
  try {
    out = Buffer.concat([decipher.update(Buffer.from(sealed.ct)), decipher.final()]);
  } catch {
    throw new EnvelopeError(
      'authentication failed — the ciphertext, the tag, or the identity it was bound to does not match',
    );
  }
  const value = out.toString('utf8');
  out.fill(0);
  return Secret.of(value, 'credential');
}

/**
 * Seal a whole credential: one DEK per credential, wrapped by KMS, with the key
 * and the secret encrypted under it using independent nonces.
 *
 * Takes plain strings because this is the boundary where a value arriving from
 * an HTTP request first becomes ciphertext. Nothing above this layer should
 * handle the plaintext, and nothing below it retains the DEK.
 */
export async function sealCredential(
  kms: KmsPort,
  id: CredentialIdentity,
  apiKeyPlain: string,
  apiSecretPlain: string,
): Promise<SealedCredential> {
  if (apiKeyPlain.length < 8) throw new EnvelopeError('api key looks too short to be real');
  if (apiSecretPlain.length < 8) throw new EnvelopeError('api secret looks too short to be real');
  const { plaintext: dek, wrapped } = await kms.generateDek();
  try {
    return {
      dekWrapped: wrapped,
      kmsKeyId: kms.keyId,
      keyVersion: id.keyVersion,
      apiKey: sealWithDek(dek, apiKeyPlain, id),
      apiSecret: sealWithDek(dek, apiSecretPlain, id),
      apiKeyLast4: apiKeyPlain.slice(-4),
    };
  } finally {
    zero(dek);
  }
}

/** Open a whole credential. The DEK is zeroed before returning, always. */
export async function openCredential(
  kms: KmsPort,
  id: CredentialIdentity,
  sealed: Pick<SealedCredential, 'dekWrapped' | 'apiKey' | 'apiSecret'>,
): Promise<{ apiKey: Secret; apiSecret: Secret }> {
  const dek = await kms.unwrapDek(sealed.dekWrapped);
  try {
    return {
      apiKey: openWithDek(dek, sealed.apiKey, id),
      apiSecret: openWithDek(dek, sealed.apiSecret, id),
    };
  } finally {
    zero(dek);
  }
}

/** Overwrite key material in place. Best-effort: V8 may still hold copies. */
export function zero(bytes: Uint8Array): void {
  bytes.fill(0);
}

/** True when two byte strings are equal, without leaking by timing. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
