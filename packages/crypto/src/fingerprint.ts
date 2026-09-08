// Credential fingerprints — plan/phase-02 T02.2, from 07-api-key-security.md F4.
//
// A fingerprint answers one question: "is this the same API key the customer
// already connected?" It has to answer it without storing anything that can be
// turned back into the key, because the whole point of the envelope layer is
// that a database dump is worthless.
//
// So it is a keyed HMAC, not a plain hash. A plain SHA-256 of an API key is
// reversible in practice — CoinDCX keys are a fixed-length hex-ish alphabet, and
// an attacker with the dump can hash candidates offline as fast as their GPU
// allows. The pepper is held outside the database, so the same dump gives them
// nothing to brute-force against.
//
// It is deliberately NOT a password hash: no scrypt, no per-row salt. Both would
// defeat the purpose, because the fingerprint has to be a deterministic
// `UNIQUE (tenant_id, fingerprint)` lookup — the constraint is what makes
// "concurrent adds of the same key" a database problem rather than a race.

import { createHmac, timingSafeEqual } from 'node:crypto';

const PEPPER_ENV = 'TRADEX_FINGERPRINT_PEPPER';
/** HMAC-SHA256 output. The `exchange_credential.fingerprint` CHECK enforces it. */
export const FINGERPRINT_BYTES = 32;

export class FingerprintError extends Error {
  override readonly name = 'FingerprintError';
}

/**
 * Read the pepper from the environment.
 *
 * Refuses to default. A generated-on-boot pepper would make every stored
 * fingerprint meaningless after a restart, so the duplicate-key check would
 * silently stop working — the failure mode being that a customer connects the
 * same key twice and two accounts fan out onto one exchange account, doubling
 * every trade they place.
 */
export function resolvePepper(): Buffer {
  const hex = process.env[PEPPER_ENV];
  if (hex === undefined || hex === '') {
    throw new FingerprintError(
      `${PEPPER_ENV} is not set. It must not be defaulted or generated: a pepper that changes `
      + 'invalidates every stored fingerprint, which silently disables the duplicate-key check.',
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new FingerprintError(`${PEPPER_ENV} must be exactly 64 hex characters (32 bytes)`);
  }
  return Buffer.from(hex, 'hex');
}

/**
 * HMAC-SHA256(pepper, apiKey), normalised.
 *
 * Trimmed and case-folded before hashing, because a customer pasting a key from
 * an email picks up whitespace, and "the same key with a trailing space" must
 * collide with the original rather than looking like a new key.
 */
export function fingerprintOf(pepper: Uint8Array, apiKey: string): Buffer {
  if (pepper.byteLength !== FINGERPRINT_BYTES) {
    throw new FingerprintError(`pepper must be ${FINGERPRINT_BYTES} bytes, received ${pepper.byteLength}`);
  }
  const normalised = apiKey.trim().toLowerCase();
  if (normalised.length < 8) {
    throw new FingerprintError('api key looks too short to fingerprint');
  }
  return createHmac('sha256', pepper).update(normalised, 'utf8').digest();
}

/** Constant-time comparison, so a fingerprint lookup cannot be probed by timing. */
export function fingerprintEquals(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * The non-secret display value. Last four characters of the key, which is what
 * CoinDCX itself shows, so a customer can match our row against their dashboard
 * without either of us revealing the key.
 */
export function keyLast4(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length < 8) throw new FingerprintError('api key looks too short to derive a display suffix');
  return trimmed.slice(-4);
}
