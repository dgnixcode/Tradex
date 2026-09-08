// Session cookie primitives — the signed-token half of the auth model.
//
// A session is protected by TWO independent secrets, and this file owns both
// transforms. Neither alone is sufficient, which is the point:
//
//   - a RANDOM token proves possession. It is signed into the cookie with an
//     HMAC key so the server can reject a forged or tampered cookie WITHOUT a
//     database hit — cheap rejection of garbage before any query runs.
//   - the database stores only sha256(token), never the token. A database leak
//     therefore discloses no usable session: the attacker has the hash, but the
//     cookie needs the pre-image.
//
// Everything here is pure node:crypto — no I/O, no clock — so it is unit-testable
// against fixed vectors, and the session SERVICE (which does the DB work) builds
// on it. All comparisons are constant-time and length-guarded.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export class CookieError extends Error {
  override readonly name = 'CookieError';
}

/** A fresh session token: 32 random bytes, base64url so it carries no '.'. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** sha256(token) — the only form of the token that touches the database. */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * Sign a token into a cookie value of the form `token.mac`, where mac is
 * HMAC-SHA256(secret, token) base64url-encoded. Both halves are base64url and so
 * contain no '.', which makes the split on read unambiguous.
 */
export function signCookieValue(token: string, secret: Uint8Array): string {
  if (secret.byteLength < 32) {
    throw new CookieError('the cookie-signing secret must be at least 32 bytes');
  }
  const mac = createHmac('sha256', Buffer.from(secret)).update(token, 'utf8').digest('base64url');
  return `${token}.${mac}`;
}

/**
 * Verify a cookie value and return its token, or null if the signature does not
 * match. The MAC is recomputed and compared in constant time; a malformed value
 * or a length mismatch returns null without leaking which it was.
 */
export function readCookieValue(value: string, secret: Uint8Array): string | null {
  const dot = value.lastIndexOf('.');
  if (dot <= 0 || dot === value.length - 1) return null;
  const token = value.slice(0, dot);
  const presentedMac = value.slice(dot + 1);

  let presented: Buffer;
  try {
    presented = Buffer.from(presentedMac, 'base64url');
  } catch {
    return null;
  }
  const expected = createHmac('sha256', Buffer.from(secret)).update(token, 'utf8').digest();
  if (presented.byteLength !== expected.byteLength) return null;
  return timingSafeEqual(presented, expected) ? token : null;
}

/**
 * Parse a Cookie header into a map. Deliberately minimal: splits on ';', trims,
 * and takes the first '=' as the name/value boundary so a base64url value
 * (which may contain no '=') round-trips.
 */
export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (header === undefined || header === '') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    if (name !== '' && !out.has(name)) out.set(name, val);
  }
  return out;
}

/** The cookie name the session travels under. Host-only, httpOnly, SameSite=Lax. */
export const SESSION_COOKIE = 'tradex_session';

/**
 * Build a Set-Cookie header for a session value. httpOnly (no script access),
 * SameSite=Lax (sent on top-level navigation, not cross-site POSTs), Path=/, and
 * Secure unless explicitly told this is plain-HTTP local dev. maxAgeSeconds ties
 * the cookie's browser lifetime to the session's server expiry.
 */
export function buildSetCookie(
  value: string,
  maxAgeSeconds: number,
  opts: { secure?: boolean } = {},
): string {
  const secure = opts.secure ?? true;
  const attrs = [
    `${SESSION_COOKIE}=${value}`,
    'HttpOnly',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** A Set-Cookie header that clears the session cookie (logout). */
export function buildClearCookie(opts: { secure?: boolean } = {}): string {
  const secure = opts.secure ?? true;
  const attrs = [`${SESSION_COOKIE}=`, 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
