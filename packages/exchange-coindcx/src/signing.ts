// CoinDCX request signing — plan/phase-01 T01.2.
//
// Verbatim from the documented scheme (docs lines 1278-1375):
//   payload   = JSON.stringify(body)
//   signature = HMAC-SHA256(apiSecret, payload) as hex
//   headers   = X-AUTH-APIKEY, X-AUTH-SIGNATURE
//   every body carries `timestamp` in milliseconds
//
// The one thing the official sample gets structurally wrong, and we must not:
// it signs `JSON.stringify(body)` and then hands the *object* to the HTTP client
// with `json: true`, trusting the library to re-serialise to byte-identical
// output. That holds only by accident of key insertion order. We build the
// string once, sign that string, and send that exact string — so
// `signRequest` returns the bytes, not an object.
//
// This module takes the secret as a plain string on purpose. The Secret wrapper
// is unwrapped by apps/signer, which is the only place permitted to call
// expose() (SIGNER-ONLY-EXPOSE), so the exchange adapter never handles a Secret
// at all.

import { createHmac } from 'node:crypto';

export const AUTH_KEY_HEADER = 'X-AUTH-APIKEY';
export const AUTH_SIGNATURE_HEADER = 'X-AUTH-SIGNATURE';

export class SigningError extends Error {
  override readonly name = 'SigningError';
}

/** A request ready to send. `body` is the exact string that was signed. */
export interface SignedRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** The HMAC itself, isolated so it can be tested against fixed vectors. */
export function hmacHex(apiSecret: string, payload: string): string {
  if (typeof apiSecret !== 'string' || apiSecret === '') {
    throw new SigningError('api secret must be a non-empty string');
  }
  return createHmac('sha256', apiSecret).update(payload, 'utf8').digest('hex');
}

/**
 * Milliseconds, per the documented sample (`Math.floor(Date.now())`).
 *
 * A futures order is rejected if this is more than 10 seconds old
 * (03-coindcx-futures-orders-rest.md), so the timestamp is stamped here — at
 * signing time, immediately before sending — and never earlier. A signed body
 * that waits in a queue is a rejection.
 */
export const nowMs = (): number => Math.floor(Date.now());

/**
 * Serialise, stamp and sign. Key order in the emitted JSON follows insertion
 * order of the object passed in, with `timestamp` appended last; because we
 * return the string we signed, that order is irrelevant to correctness.
 */
export function signRequest(
  apiKey: string,
  apiSecret: string,
  params: Readonly<Record<string, unknown>>,
  atMs: number = nowMs(),
): SignedRequest {
  if (typeof apiKey !== 'string' || apiKey === '') {
    throw new SigningError('api key must be a non-empty string');
  }
  if (Object.hasOwn(params, 'timestamp')) {
    throw new SigningError(
      'do not set timestamp yourself — signRequest stamps it at signing time so a queued body cannot go stale',
    );
  }
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'number' && !Number.isFinite(v)) {
      throw new SigningError(`${k} is not a finite number`);
    }
    if (typeof v === 'bigint') {
      throw new SigningError(`${k} is a bigint; serialise money to a string before signing`);
    }
    if (v === undefined) {
      throw new SigningError(
        `${k} is undefined — JSON.stringify would drop it silently and the signature would cover a different body`,
      );
    }
  }
  const body = JSON.stringify({ ...params, timestamp: atMs });
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      [AUTH_KEY_HEADER]: apiKey,
      [AUTH_SIGNATURE_HEADER]: hmacHex(apiSecret, body),
    },
  };
}

/**
 * Verify that a request about to go out is internally consistent: the signature
 * covers exactly the bytes being sent, and the timestamp is fresh.
 *
 * Called by the worker immediately before the socket write. It catches the class
 * of bug where a body is mutated after signing — adding a field, reordering
 * keys, or re-serialising — which produces an opaque 401 that looks like a bad
 * credential (12 F7).
 */
export function assertSendable(
  apiSecret: string,
  signed: SignedRequest,
  opts: { maxAgeMs?: number; nowMs?: number } = {},
): void {
  const maxAge = opts.maxAgeMs ?? 2_000;
  const now = opts.nowMs ?? nowMs();
  const expected = hmacHex(apiSecret, signed.body);
  if (signed.headers[AUTH_SIGNATURE_HEADER] !== expected) {
    throw new SigningError('signature does not cover the body being sent — the body was mutated after signing');
  }
  let parsed: { timestamp?: unknown };
  try {
    parsed = JSON.parse(signed.body) as { timestamp?: unknown };
  } catch {
    throw new SigningError('signed body is not valid JSON');
  }
  const ts = parsed.timestamp;
  if (typeof ts !== 'number') throw new SigningError('signed body has no numeric timestamp');
  const age = now - ts;
  if (age > maxAge) {
    throw new SigningError(
      `signed body is ${age}ms old, over the ${maxAge}ms limit — sign at send, never at enqueue`,
    );
  }
  if (age < -maxAge) {
    throw new SigningError(`signed body is timestamped ${-age}ms in the future — check the clock`);
  }
}
