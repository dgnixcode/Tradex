// Rate-limit response headers — plan/phase-01 T01.6, from 06 F6.2.
//
// CoinDCX documents no rate-limit headers at all, and sends them anyway. They
// are the IETF-draft lowercase `ratelimit` / `ratelimit-policy` fields, not
// `X-RateLimit-*` — a client that greps for the conventional spelling finds
// nothing and concludes there is no feedback available.
//
// Two live facts from 06 F6.2 shape this:
//   - `reset` is SECONDS REMAINING in the window, not a Unix timestamp. Reading
//     it as a timestamp yields a wait of about 56 years.
//   - On a Cloudflare cache HIT the counters describe whoever missed last, not
//     us. `cf-cache-status` has to be consulted before the numbers mean anything.
//
// Whether authenticated 200s carry these headers at all is still unverified (E3
// needs a real key); the 401 probe carried none. So absence is normal and must
// never be read as "no budget left".

import type { RateFeedback } from '@tradex/exchange';

/** `limit=5000, remaining=4992, reset=8` -> the named numbers. */
function parseRateLimit(value: string): { remaining?: number; reset?: number } {
  const out: { remaining?: number; reset?: number } = {};
  for (const part of value.split(',')) {
    const [rawKey, rawValue] = part.split('=');
    if (rawKey === undefined || rawValue === undefined) continue;
    const key = rawKey.trim().toLowerCase();
    const n = Number.parseInt(rawValue.trim(), 10);
    if (!Number.isFinite(n) || n < 0) continue;
    if (key === 'remaining') out.remaining = n;
    else if (key === 'reset') out.reset = n;
  }
  return out;
}

/** `5000;w=60` -> a window in seconds, when it is stated. */
function parseWindowSeconds(policy: string): number | undefined {
  const m = /[;,]\s*w\s*=\s*(\d+)/i.exec(policy);
  if (m === null) return undefined;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

const header = (headers: Readonly<Record<string, string>>, name: string): string | undefined => {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  // Node lower-cases incoming header names, but a fake exchange or a proxy may not.
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v;
  return undefined;
};

/**
 * Turn one response's headers and status into feedback for the rate budget.
 *
 * Returns `throttled` on 429 even when no counters came with it, because a 429
 * is itself the strongest possible statement that our model is too generous —
 * and CoinDCX never sends `Retry-After`, so there is nothing else to go on.
 */
export function readRateFeedback(
  status: number,
  headers: Readonly<Record<string, string>>,
): RateFeedback {
  const cache = header(headers, 'cf-cache-status');
  const fromCache = cache !== undefined && /^(HIT|STALE|UPDATING|REVALIDATED)$/i.test(cache.trim());

  const raw = header(headers, 'ratelimit') ?? header(headers, 'x-ratelimit');
  const parsed = raw === undefined ? {} : parseRateLimit(raw);

  const legacyRemaining = header(headers, 'x-ratelimit-remaining');
  const remaining = parsed.remaining
    ?? (legacyRemaining === undefined ? undefined : Number.parseInt(legacyRemaining, 10));

  const policy = header(headers, 'ratelimit-policy');
  const resetSeconds = parsed.reset ?? (policy === undefined ? undefined : parseWindowSeconds(policy));

  const feedback: {
    remaining?: number; resetSeconds?: number; fromCache?: boolean; throttled?: boolean;
  } = {};
  if (remaining !== undefined && Number.isFinite(remaining) && remaining >= 0) feedback.remaining = remaining;
  if (resetSeconds !== undefined) feedback.resetSeconds = resetSeconds;
  if (fromCache) feedback.fromCache = true;
  if (status === 429) feedback.throttled = true;
  return feedback;
}
