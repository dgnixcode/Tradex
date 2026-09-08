// The probe is the one onboarding step that touches the network, so it is tested
// against the signature-verifying fake venue rather than a stub: a probe that
// "works" against something that never checks the signature would pass every key.
//
// The load-bearing cases: a correct key returns mapped balances; a wrong secret
// is a classified auth failure, NOT a throw (onboarding must branch on it); and
// a connection that never lands is marked never-sent, so the customer is told to
// retry rather than that their key is bad.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeVenue } from './fake-venue.js';
import { destroyAllAgents } from './http.js';
import { isAuthFailure, probeCredential } from './probe.js';

const KEY = 'fake-api-key';
const SECRET = 'fake-api-secret-0123456789abcdef';

let venue: FakeVenue;
let baseUrl: string;

beforeEach(async () => {
  venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  baseUrl = (await venue.start()).toString();
});

afterEach(async () => {
  destroyAllAgents();
  await venue.stop();
});

describe('a valid key validates and returns its balances', () => {
  it('signs with the in-memory secret, not the DB signer, and maps the response', async () => {
    const probe = await probeCredential(KEY, SECRET, { baseUrl });
    expect(probe.ok).toBe(true);
    expect(probe.failure).toBeUndefined();

    const byCcy = Object.fromEntries((probe.balances ?? []).map((b) => [b.currency, b]));
    // INR at scale 2, the crypto dust at scale 8 — the values a double would lose.
    expect(byCcy['INR']).toEqual({ currency: 'INR', freeMinor: '24875034', lockedMinor: '1987059', scale: 2 });
    expect(byCcy['BTC']?.lockedMinor).toBe('1'); // one satoshi, intact
    // ETH is 0/0 in the fixture and must be dropped.
    expect(byCcy['ETH']).toBeUndefined();
  });

  it('proves the signature was actually checked — the venue recorded it valid', async () => {
    await probeCredential(KEY, SECRET, { baseUrl });
    expect(venue.requests.at(-1)?.signatureValid).toBe(true);
    expect(venue.requests.at(-1)?.path).toBe('/exchange/v1/users/balances');
  });
});

describe('a bad credential is a classified failure, never a throw', () => {
  it('classifies a wrong secret as an auth failure', async () => {
    const probe = await probeCredential(KEY, 'wrong-secret-entirely', { baseUrl });
    expect(probe.ok).toBe(false);
    expect(isAuthFailure(probe)).toBe(true);
    // The venue saw a signature that did not verify.
    expect(venue.requests.at(-1)?.signatureValid).toBe(false);
  });

  it('classifies an unknown key as an auth failure too', async () => {
    const probe = await probeCredential('someone-elses-key', SECRET, { baseUrl });
    expect(probe.ok).toBe(false);
    expect(isAuthFailure(probe)).toBe(true);
  });

  it('surfaces a venue rate-limit as retry-safe, not as a bad key', async () => {
    venue.injectFault({ path: '/users/balances', status: 429, body: '{"code":429,"message":"Too Many Requests"}' });
    const probe = await probeCredential(KEY, SECRET, { baseUrl });
    expect(probe.ok).toBe(false);
    expect(probe.failure?.class).toBe('rate_limited');
    expect(isAuthFailure(probe)).toBe(false);
    expect(probe.failure?.retrySafe).toBe(true);
  });

  it('does not treat a 200 with an unparseable body as success', async () => {
    // Returning ok here would activate a credential we never really validated.
    venue.injectFault({ path: '/users/balances', status: 200, body: 'not json at all' });
    const probe = await probeCredential(KEY, SECRET, { baseUrl });
    expect(probe.ok).toBe(false);
    expect(probe.failure).toBeDefined();
  });
});

describe('a request that never reached the venue is marked never-sent', () => {
  it('reports neverSent on a refused connection, so the customer retries', async () => {
    await venue.stop(); // nothing is listening now
    const probe = await probeCredential(KEY, SECRET, { baseUrl, deadlineMs: 2_000 });
    expect(probe.ok).toBe(false);
    expect(probe.neverSent).toBe(true);
    // A never-sent failure is not the venue rejecting the key.
    expect(isAuthFailure(probe)).toBe(false);
  });

  it('reports the timeout case as ambiguous, not never-sent', async () => {
    venue.injectFault({ path: '/users/balances', blackhole: true });
    const probe = await probeCredential(KEY, SECRET, { baseUrl, deadlineMs: 200 });
    expect(probe.ok).toBe(false);
    expect(probe.neverSent).toBe(false); // the request may have been read
    expect(probe.failure?.orderMayExist).toBe(true);
  });
});
