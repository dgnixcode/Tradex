// packages/auth — password hashing, RFC 6238 TOTP against the published test
// vectors, and the full role matrix from 19-accounts-groups-data-model.md F4.

import { describe, expect, it } from 'vitest';
import {
  ACTIONS, AuthorisationError, MATRIX, PasswordError, REAUTH_TTL_MS, ROLES, TotpError,
  actionsFor, assertAuthorised, assertPasswordAcceptable, authorise, base32Decode, base32Encode,
  generateTotpSecret, hashPassword, hotp, needsRehash, totp, totpEnrolmentUri, verifyPassword, verifyTotp,
} from './index.js';
import type { Principal, Role } from './index.js';

describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('produces a different hash each time, so the salt is real', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse battery staple', b)).toBe(true);
  });

  it('stores a self-describing format that reveals nothing', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(stored).not.toContain('correct');
    expect(stored.split('$')).toHaveLength(6);
  });

  it('enforces a length policy rather than composition rules', () => {
    expect(() => assertPasswordAcceptable('short')).toThrow(PasswordError);
    expect(() => assertPasswordAcceptable('a'.repeat(11))).toThrow(/at least 12/);
    expect(() => assertPasswordAcceptable('a'.repeat(12))).not.toThrow();
    expect(() => assertPasswordAcceptable('a'.repeat(1025))).toThrow(/at most 1024/);
  });

  it('detects a hash made with weaker parameters', () => {
    expect(needsRehash('scrypt$16384$8$1$c2FsdA==$aGFzaA==')).toBe(true);
    expect(needsRehash('scrypt$32768$8$1$c2FsdA==$aGFzaA==')).toBe(false);
  });

  it('rejects a malformed stored hash rather than returning false', async () => {
    await expect(verifyPassword('x', 'bcrypt$whatever')).rejects.toThrow(PasswordError);
  });
});

describe('TOTP against the RFC 6238 test vectors', () => {
  // RFC 6238 Appendix B: the SHA-1 secret is the ASCII string
  // "12345678901234567890", and the vectors are 8-digit codes.
  const SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

  const vectors: ReadonlyArray<[number, string]> = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it('encodes the RFC secret to the documented base32', () => {
    expect(SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it.each(vectors)('at t=%i produces %s', (seconds, expected) => {
    expect(totp(SECRET, seconds * 1000, { digits: 8 })).toBe(expected);
  });

  it('produces the 6-digit truncation of the same vectors', () => {
    expect(totp(SECRET, 59_000)).toBe('287082');
    expect(totp(SECRET, 1111111109_000)).toBe('081804');
  });

  // RFC 4226 Appendix D — the counter-based primitive TOTP is built on.
  // Testing it separately means a bug in the time-to-counter arithmetic cannot
  // be mistaken for a bug in the HMAC truncation, or the reverse.
  it.each([
    [0n, '755224'], [1n, '287082'], [2n, '359152'], [3n, '969429'], [4n, '338314'],
    [5n, '254676'], [6n, '287922'], [7n, '162583'], [8n, '399871'], [9n, '520489'],
  ] as ReadonlyArray<[bigint, string]>)('HOTP counter %s produces %s', (counter, expected) => {
    expect(hotp(SECRET, counter)).toBe(expected);
  });

  it('round-trips base32', () => {
    const raw = Buffer.from('12345678901234567890', 'ascii');
    expect(base32Decode(base32Encode(raw)).equals(raw)).toBe(true);
  });

  it('rejects a non-base32 secret', () => {
    expect(() => base32Decode('not base32!')).toThrow(TotpError);
    expect(() => base32Decode('')).toThrow(TotpError);
  });

  it('is stable across the same 30-second step and changes across steps', () => {
    // The base must sit on a step boundary or the window straddles two steps:
    // 1_700_000_010 seconds is divisible by 30, 1_000_000_000 is not.
    const stepStart = 1_700_000_010_000;
    const a = totp(SECRET, stepStart);
    const b = totp(SECRET, stepStart + 29_999);
    const c = totp(SECRET, stepStart + 30_000);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('generates a fresh 32-character secret', () => {
    const s = generateTotpSecret();
    expect(s).toHaveLength(32);
    expect(generateTotpSecret()).not.toBe(s);
  });

  it('builds an otpauth URI an authenticator can scan', () => {
    const uri = totpEnrolmentUri('GEZDGNBVGY3TQOJQ', 'anand@example.com');
    expect(uri.startsWith('otpauth://totp/Tradex%3Aanand%40example.com?')).toBe(true);
    expect(uri).toContain('secret=GEZDGNBVGY3TQOJQ');
    expect(uri).toContain('period=30');
  });
});

describe('TOTP verification', () => {
  const SECRET = generateTotpSecret();
  const NOW = 1_700_000_000_000;

  it('accepts the current code', () => {
    expect(verifyTotp(SECRET, totp(SECRET, NOW), NOW)).toBe(true);
  });

  it('tolerates one step of drift either way', () => {
    expect(verifyTotp(SECRET, totp(SECRET, NOW - 30_000), NOW)).toBe(true);
    expect(verifyTotp(SECRET, totp(SECRET, NOW + 30_000), NOW)).toBe(true);
  });

  it('rejects two steps of drift', () => {
    expect(verifyTotp(SECRET, totp(SECRET, NOW - 90_000), NOW)).toBe(false);
    expect(verifyTotp(SECRET, totp(SECRET, NOW + 90_000), NOW)).toBe(false);
  });

  it('rejects a wrong, short, long or non-numeric code without throwing', () => {
    expect(verifyTotp(SECRET, '000000', NOW) && totp(SECRET, NOW) !== '000000').toBe(false);
    expect(verifyTotp(SECRET, '12345', NOW)).toBe(false);
    expect(verifyTotp(SECRET, '1234567', NOW)).toBe(false);
    expect(verifyTotp(SECRET, 'abcdef', NOW)).toBe(false);
    expect(verifyTotp(SECRET, '', NOW)).toBe(false);
  });

  it('ignores whitespace, which authenticator apps often display', () => {
    const code = totp(SECRET, NOW);
    expect(verifyTotp(SECRET, `${code.slice(0, 3)} ${code.slice(3)}`, NOW)).toBe(true);
  });
});

describe('the role matrix from 19 F4', () => {
  const principal = (role: Role, over: Partial<Principal> = {}): Principal => ({
    userId: 'u1', tenantId: 't1', role, totpEnabled: true, reauthAt: new Date(), ...over,
  });

  it('covers every action for every role, with no gaps', () => {
    expect(ACTIONS.length).toBeGreaterThan(10);
    for (const action of ACTIONS) {
      expect(MATRIX[action].roles.length, `${action} has no roles`).toBeGreaterThan(0);
      expect(MATRIX[action].reason.length, `${action} has no reason`).toBeGreaterThan(5);
      for (const role of MATRIX[action].roles) expect(ROLES).toContain(role);
    }
  });

  it('gives viewer read-only access and nothing else', () => {
    expect(actionsFor('viewer')).toEqual(['view.dashboards']);
    for (const action of ACTIONS) {
      if (action === 'view.dashboards') continue;
      expect(authorise(principal('viewer'), action).allowed, `viewer must not ${action}`).toBe(false);
    }
  });

  it('lets a trader trade but not touch credentials, limits or users', () => {
    for (const allowed of ['trade.place', 'trade.cancel', 'group.write', 'view.audit'] as const) {
      expect(authorise(principal('trader'), allowed).allowed, allowed).toBe(true);
    }
    for (const denied of ['credential.write', 'limits.write', 'users.manage', 'account.disconnect', 'account.allocated.write'] as const) {
      const d = authorise(principal('trader'), denied);
      expect(d.allowed, denied).toBe(false);
      expect(d.allowed === false && d.code).toBe('forbidden_role');
    }
  });

  it('lets an owner do everything, given a fresh second factor', () => {
    for (const action of ACTIONS) {
      expect(authorise(principal('owner'), action).allowed, action).toBe(true);
    }
  });
});

describe('the pause/resume asymmetry — stopping is easier than starting', () => {
  const stale = new Date(Date.now() - REAUTH_TTL_MS - 1000);

  it('lets a trader pause with no second factor at all', () => {
    const trader: Principal = { userId: 'u', tenantId: 't', role: 'trader', totpEnabled: false, reauthAt: undefined };
    expect(authorise(trader, 'trading.pause').allowed).toBe(true);
  });

  it('lets an owner pause with a stale second factor', () => {
    const owner: Principal = { userId: 'u', tenantId: 't', role: 'owner', totpEnabled: true, reauthAt: stale };
    expect(authorise(owner, 'trading.pause').allowed).toBe(true);
  });

  it('does not let a trader resume at all', () => {
    const trader: Principal = { userId: 'u', tenantId: 't', role: 'trader', totpEnabled: true, reauthAt: new Date() };
    const d = authorise(trader, 'trading.resume');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.code).toBe('forbidden_role');
  });

  it('makes an owner re-authenticate to resume', () => {
    const owner: Principal = { userId: 'u', tenantId: 't', role: 'owner', totpEnabled: true, reauthAt: stale };
    const d = authorise(owner, 'trading.resume');
    expect(d.allowed).toBe(false);
    expect(d.allowed === false && d.code).toBe('reauth_required');
  });
});

describe('re-authentication', () => {
  const owner = (over: Partial<Principal> = {}): Principal => ({
    userId: 'u', tenantId: 't', role: 'owner', totpEnabled: true, reauthAt: new Date(), ...over,
  });

  it('is required for exactly the sensitive actions', () => {
    const requiring = ACTIONS.filter((a) => MATRIX[a].requiresReauth).sort();
    expect(requiring).toEqual([
      'account.allocated.write',
      'account.disconnect',
      'credential.write',
      'limits.write',
      'trade.place.large',
      'trading.resume',
      'users.manage',
    ]);
  });

  it('expires after the TTL', () => {
    const fresh = new Date('2026-09-05T12:00:00Z');
    const p = owner({ reauthAt: fresh });
    expect(authorise(p, 'credential.write', new Date(fresh.getTime() + REAUTH_TTL_MS - 1)).allowed).toBe(true);
    expect(authorise(p, 'credential.write', new Date(fresh.getTime() + REAUTH_TTL_MS + 1)).allowed).toBe(false);
  });

  it('refuses when the second factor was never enrolled', () => {
    const d = authorise(owner({ totpEnabled: false }), 'credential.write');
    expect(d.allowed === false && d.code).toBe('totp_not_enrolled');
  });

  it('refuses when it never happened', () => {
    const d = authorise(owner({ reauthAt: undefined }), 'credential.write');
    expect(d.allowed === false && d.code).toBe('reauth_required');
  });

  it('throws an explicable error from assertAuthorised', () => {
    try {
      assertAuthorised(owner({ reauthAt: undefined }), 'credential.write');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AuthorisationError);
      expect((e as AuthorisationError).code).toBe('reauth_required');
      expect((e as AuthorisationError).message).toContain('credential.write');
    }
  });
});
