// The header values here are the ones probed live on 2026-09-03 and recorded in
// 06 F6.2, including the two traps: `reset` is seconds remaining rather than a
// timestamp, and a Cloudflare HIT reports someone else's counters.

import { describe, expect, it } from 'vitest';
import { readRateFeedback } from './rate-headers.js';

describe('the undocumented ratelimit headers are read', () => {
  it('parses the live header from GET /exchange/ticker', () => {
    expect(readRateFeedback(200, {
      'ratelimit-policy': '5000;w=60',
      ratelimit: 'limit=5000, remaining=4992, reset=8',
      'cf-cache-status': 'DYNAMIC',
    })).toEqual({ remaining: 4992, resetSeconds: 8 });
  });

  it('reads reset as seconds remaining, not a Unix timestamp', () => {
    // reset=8 means "8 seconds left in this window". Read as a timestamp it is
    // 1970, and the derived wait comes out as about 56 years.
    const f = readRateFeedback(200, { ratelimit: 'limit=5000, remaining=4999, reset=60' });
    expect(f.resetSeconds).toBe(60);
    expect(f.resetSeconds).toBeLessThan(3_600);
  });

  it('falls back to the policy window when only the policy is present', () => {
    expect(readRateFeedback(200, { 'ratelimit-policy': '5000;w=60' })).toEqual({ resetSeconds: 60 });
  });

  it('tolerates whitespace, case and ordering', () => {
    expect(readRateFeedback(200, { RateLimit: 'RESET = 12 ,  Remaining=7, limit=100' }))
      .toEqual({ remaining: 7, resetSeconds: 12 });
  });

  it('reads the conventional X-RateLimit spelling if a proxy ever sends it', () => {
    // Nothing in the docs mentions either spelling; a client that greps only for
    // X-RateLimit-* finds nothing and concludes there is no feedback (06 F6.2).
    expect(readRateFeedback(200, { 'x-ratelimit-remaining': '3', 'ratelimit-policy': '100;w=30' }))
      .toEqual({ remaining: 3, resetSeconds: 30 });
  });
});

describe("a cached response's counters are not ours", () => {
  it.each(['HIT', 'hit', 'STALE', 'UPDATING', 'REVALIDATED'])('flags cf-cache-status %s', (status) => {
    const f = readRateFeedback(200, { ratelimit: 'limit=5000, remaining=1, reset=8', 'cf-cache-status': status });
    expect(f.fromCache).toBe(true);
  });

  it.each(['MISS', 'DYNAMIC', 'EXPIRED', 'BYPASS'])('does not flag %s', (status) => {
    const f = readRateFeedback(200, { ratelimit: 'remaining=1, reset=8', 'cf-cache-status': status });
    expect(f.fromCache).toBeUndefined();
  });

  it('does not flag a response with no cache header at all', () => {
    expect(readRateFeedback(200, { ratelimit: 'remaining=1, reset=8' }).fromCache).toBeUndefined();
  });
});

describe('absence of headers is normal, not an empty budget', () => {
  it('returns nothing for the 401 shape, which carried no headers live', () => {
    expect(readRateFeedback(401, { 'cf-cache-status': 'DYNAMIC' })).toEqual({});
  });

  it('never invents a remaining of 0 from a missing header', () => {
    const f = readRateFeedback(200, {});
    expect(f.remaining).toBeUndefined();
    expect(f.resetSeconds).toBeUndefined();
  });

  it('ignores malformed values instead of parsing them as 0', () => {
    expect(readRateFeedback(200, { ratelimit: 'remaining=abc, reset=-4' })).toEqual({});
    expect(readRateFeedback(200, { ratelimit: 'garbage' })).toEqual({});
    expect(readRateFeedback(200, { 'ratelimit-policy': '5000' })).toEqual({});
  });

  it('accepts a genuine remaining of 0', () => {
    expect(readRateFeedback(200, { ratelimit: 'remaining=0, reset=30' })).toEqual({ remaining: 0, resetSeconds: 30 });
  });
});

describe('429 is a statement in itself', () => {
  it('reports throttled even with no counters, because Retry-After never comes', () => {
    expect(readRateFeedback(429, {})).toEqual({ throttled: true });
  });

  it('carries the window through when the venue does send one', () => {
    expect(readRateFeedback(429, { ratelimit: 'limit=100, remaining=0, reset=17' }))
      .toEqual({ remaining: 0, resetSeconds: 17, throttled: true });
  });

  it('does not mark a 200 as throttled', () => {
    expect(readRateFeedback(200, { ratelimit: 'remaining=0, reset=5' }).throttled).toBeUndefined();
  });
});
