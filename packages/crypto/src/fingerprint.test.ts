// The duplicate-key check is a security property, not a convenience: the same
// CoinDCX key on two accounts means one exchange account receives two legs of
// every group trade, so the customer's position is double what they authorised.
// These tests are mostly about the ways that check could quietly stop working.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FINGERPRINT_BYTES, FingerprintError, fingerprintEquals, fingerprintOf, keyLast4, resolvePepper,
} from './fingerprint.js';

const PEPPER_ENV = 'TRADEX_FINGERPRINT_PEPPER';
const PEPPER_HEX = 'a1'.repeat(32);
const OTHER_HEX = 'b2'.repeat(32);
const KEY = '9f2c7b41e8d05a6318cc94af2b7e0d5691af3c82';

let saved: string | undefined;
beforeEach(() => { saved = process.env[PEPPER_ENV]; });
afterEach(() => {
  if (saved === undefined) delete process.env[PEPPER_ENV];
  else process.env[PEPPER_ENV] = saved;
});

const pepper = (hex = PEPPER_HEX): Buffer => Buffer.from(hex, 'hex');

describe('the pepper is required, never defaulted', () => {
  it('refuses to run without one', () => {
    delete process.env[PEPPER_ENV];
    expect(() => resolvePepper()).toThrow(FingerprintError);
    // The reason matters more than the throw: a generated pepper would look like
    // it worked and silently break the duplicate check on the next restart.
    expect(() => resolvePepper()).toThrow(/silently disables the duplicate-key check/);
  });

  it('refuses an empty or malformed pepper rather than padding it', () => {
    for (const bad of ['', 'not-hex', 'a1'.repeat(16), 'a1'.repeat(64), `${'a'.repeat(63)}g`]) {
      process.env[PEPPER_ENV] = bad;
      expect(() => resolvePepper(), JSON.stringify(bad)).toThrow(FingerprintError);
    }
  });

  it('accepts 64 hex characters in either case', () => {
    process.env[PEPPER_ENV] = PEPPER_HEX.toUpperCase();
    expect(resolvePepper()).toEqual(Buffer.from(PEPPER_HEX, 'hex'));
  });
});

describe('the fingerprint identifies a key without storing it', () => {
  it('is 32 bytes, matching the column CHECK', () => {
    expect(fingerprintOf(pepper(), KEY)).toHaveLength(FINGERPRINT_BYTES);
  });

  it('is deterministic, which is what makes the UNIQUE constraint work', () => {
    // A per-row salt would be more secretive and completely useless here: the
    // constraint has to be able to collide two rows.
    expect(fingerprintOf(pepper(), KEY)).toEqual(fingerprintOf(pepper(), KEY));
  });

  it('collides for the same key pasted with whitespace or different case', () => {
    // A customer copying a key out of an email brings a trailing space with it.
    const base = fingerprintOf(pepper(), KEY);
    for (const variant of [` ${KEY}`, `${KEY} `, `\t${KEY}\n`, KEY.toUpperCase()]) {
      expect(fingerprintOf(pepper(), variant), JSON.stringify(variant)).toEqual(base);
    }
  });

  it('differs for a different key, and for the same key under a different pepper', () => {
    const base = fingerprintOf(pepper(), KEY);
    expect(fingerprintOf(pepper(), `${KEY}0`)).not.toEqual(base);
    expect(fingerprintOf(pepper(OTHER_HEX), KEY)).not.toEqual(base);
  });

  it('changes completely when one character of the key changes', () => {
    const a = fingerprintOf(pepper(), KEY);
    const b = fingerprintOf(pepper(), `${KEY.slice(0, -1)}0`);
    const differing = [...a].filter((byte, i) => byte !== b[i]).length;
    expect(differing).toBeGreaterThan(24); // an HMAC, not a truncated prefix
  });

  it('rejects a wrong-length pepper rather than stretching it', () => {
    expect(() => fingerprintOf(Buffer.alloc(16), KEY)).toThrow(/must be 32 bytes/);
    expect(() => fingerprintOf(Buffer.alloc(64), KEY)).toThrow(FingerprintError);
  });

  it('rejects a key too short to be real', () => {
    for (const bad of ['', 'abc', '       x       ']) {
      expect(() => fingerprintOf(pepper(), bad), JSON.stringify(bad)).toThrow(/too short/);
    }
  });
});

describe('comparison and display', () => {
  it('compares equal fingerprints and rejects unequal ones', () => {
    const a = fingerprintOf(pepper(), KEY);
    expect(fingerprintEquals(a, fingerprintOf(pepper(), KEY))).toBe(true);
    expect(fingerprintEquals(a, fingerprintOf(pepper(), `${KEY}0`))).toBe(false);
    expect(fingerprintEquals(a, a.subarray(0, 31))).toBe(false);
  });

  it('shows the last four characters, which is what CoinDCX shows', () => {
    expect(keyLast4(KEY)).toBe('3c82');
    expect(keyLast4(`  ${KEY}  `)).toBe('3c82');
    expect(keyLast4(KEY)).toHaveLength(4);
  });

  it('never returns a prefix of the key', () => {
    // A first-4 display would leak the searchable end of the keyspace.
    expect(KEY.startsWith(keyLast4(KEY))).toBe(false);
  });

  it('refuses to derive a suffix from something too short to be a key', () => {
    expect(() => keyLast4('abc')).toThrow(FingerprintError);
  });
});
