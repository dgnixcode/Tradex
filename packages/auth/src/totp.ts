// TOTP (RFC 6238) — plan/phase-00 T00.9.
//
// This is OUR second factor, gating credential changes, cap changes and large
// group trades. It is never the customer's CoinDCX 2FA: 07 F10 forbids storing
// that, and there would be no use for it.
//
// Implemented from the RFC rather than pulled from a package: it is forty lines,
// it has published test vectors, and a dependency that generates one-time codes
// is a dependency with an unusually direct path to an account takeover.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous and next step, for clock drift. */
export const TOTP_WINDOW = 1;

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export class TotpError extends Error {
  override readonly name = 'TotpError';
}

/** A fresh base32 secret. 20 bytes is the RFC's recommendation for SHA-1. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  if (clean === '' || /[^A-Z2-7]/.test(clean)) throw new TotpError('secret is not valid base32');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * HOTP (RFC 4226) — the counter-based primitive TOTP is built on. Exposed so
 * the RFC 6238 test vectors can be asserted directly.
 */
export function hotp(
  secret: string,
  counter: bigint,
  opts: { digits?: number; algorithm?: 'sha1' | 'sha256' | 'sha512' } = {},
): string {
  const digits = opts.digits ?? TOTP_DIGITS;
  const algorithm = opts.algorithm ?? 'sha1';
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);
  const mac = createHmac(algorithm, key).update(buf).digest();
  // Dynamic truncation, RFC 4226 section 5.4.
  const offset = (mac.at(mac.length - 1) ?? 0) & 0x0f;
  const binary =
    (((mac.at(offset) ?? 0) & 0x7f) << 24) |
    (((mac.at(offset + 1) ?? 0) & 0xff) << 16) |
    (((mac.at(offset + 2) ?? 0) & 0xff) << 8) |
    ((mac.at(offset + 3) ?? 0) & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function totp(
  secret: string,
  atMs: number = Date.now(),
  opts: { digits?: number; stepSeconds?: number; algorithm?: 'sha1' | 'sha256' | 'sha512' } = {},
): string {
  const step = opts.stepSeconds ?? TOTP_STEP_SECONDS;
  const counter = BigInt(Math.floor(atMs / 1000 / step));
  return hotp(secret, counter, {
    ...(opts.digits !== undefined ? { digits: opts.digits } : {}),
    ...(opts.algorithm !== undefined ? { algorithm: opts.algorithm } : {}),
  });
}

/**
 * Verify a submitted code, tolerating one step either side. Comparison is
 * constant-time, and a wrong-length input is rejected before hashing so the
 * timing signal carries no information about the secret.
 */
export function verifyTotp(
  secret: string,
  code: string,
  atMs: number = Date.now(),
  opts: { window?: number; digits?: number; stepSeconds?: number } = {},
): boolean {
  const digits = opts.digits ?? TOTP_DIGITS;
  const window = opts.window ?? TOTP_WINDOW;
  const step = opts.stepSeconds ?? TOTP_STEP_SECONDS;
  const submitted = code.replace(/\s+/g, '');
  if (submitted.length !== digits || !/^\d+$/.test(submitted)) return false;

  const base = Math.floor(atMs / 1000 / step);
  let matched = false;
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = hotp(secret, BigInt(base + offset), { digits });
    // No early exit: every candidate is compared so the loop takes constant time.
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) matched = true;
  }
  return matched;
}

/** The `otpauth://` URI an authenticator app scans. Contains the secret. */
export function totpEnrolmentUri(secret: string, accountLabel: string, issuer = 'Tradex'): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
