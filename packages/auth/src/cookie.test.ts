// Session cookie primitives — the security-critical transforms.
//
// A bug in cookie verification is an auth bypass, so every property is pinned:
// a round-trip recovers the token, a tampered token or MAC is rejected, a wrong
// key is rejected, the DB hash is stable and never equal to the token, and the
// Cookie-header parser survives base64url values that contain no '='.

import { describe, expect, it } from 'vitest';
import {
  buildClearCookie, buildSetCookie, generateSessionToken, hashSessionToken,
  parseCookieHeader, readCookieValue, signCookieValue, SESSION_COOKIE,
} from './cookie.js';

const SECRET = Buffer.alloc(32, 7);
const OTHER = Buffer.alloc(32, 8);

describe('signCookieValue / readCookieValue', () => {
  it('round-trips a token', () => {
    const token = generateSessionToken();
    const value = signCookieValue(token, SECRET);
    expect(readCookieValue(value, SECRET)).toBe(token);
  });

  it('rejects a value signed with a different key', () => {
    const value = signCookieValue(generateSessionToken(), SECRET);
    expect(readCookieValue(value, OTHER)).toBeNull();
  });

  it('rejects a tampered token (MAC no longer matches)', () => {
    const token = generateSessionToken();
    const value = signCookieValue(token, SECRET);
    const tampered = `${token}x.${value.slice(value.lastIndexOf('.') + 1)}`;
    expect(readCookieValue(tampered, SECRET)).toBeNull();
  });

  it('rejects a tampered MAC', () => {
    const token = generateSessionToken();
    const value = signCookieValue(token, SECRET);
    const dot = value.lastIndexOf('.');
    const tampered = `${value.slice(0, dot)}.${'A'.repeat(value.length - dot - 1)}`;
    expect(readCookieValue(tampered, SECRET)).toBeNull();
  });

  it('rejects malformed values', () => {
    expect(readCookieValue('', SECRET)).toBeNull();
    expect(readCookieValue('nodot', SECRET)).toBeNull();
    expect(readCookieValue('.onlymac', SECRET)).toBeNull();
    expect(readCookieValue('onlytoken.', SECRET)).toBeNull();
  });

  it('refuses a too-short signing secret', () => {
    expect(() => signCookieValue('t', Buffer.alloc(16))).toThrow();
  });
});

describe('hashSessionToken', () => {
  it('is 32 bytes, stable, and never equal to the token bytes', () => {
    const token = generateSessionToken();
    const h1 = hashSessionToken(token);
    const h2 = hashSessionToken(token);
    expect(h1.byteLength).toBe(32);
    expect(h1.equals(h2)).toBe(true);
    expect(h1.toString('base64url')).not.toBe(token);
  });

  it('differs for different tokens', () => {
    expect(hashSessionToken('a').equals(hashSessionToken('b'))).toBe(false);
  });
});

describe('parseCookieHeader', () => {
  it('parses multiple cookies and preserves base64url values', () => {
    const token = generateSessionToken();
    const value = signCookieValue(token, SECRET);
    const header = `theme=dark; ${SESSION_COOKIE}=${value}; other=1`;
    const map = parseCookieHeader(header);
    expect(map.get(SESSION_COOKIE)).toBe(value);
    expect(map.get('theme')).toBe('dark');
    // The recovered cookie still verifies — no bytes were lost in parsing.
    expect(readCookieValue(map.get(SESSION_COOKIE) ?? '', SECRET)).toBe(token);
  });

  it('returns empty for an absent header', () => {
    expect(parseCookieHeader(undefined).size).toBe(0);
    expect(parseCookieHeader('').size).toBe(0);
  });
});

describe('buildSetCookie / buildClearCookie', () => {
  it('sets httpOnly, SameSite=Lax, Path, and Secure by default', () => {
    const c = buildSetCookie('v', 3600);
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).toMatch(/Path=\//);
    expect(c).toMatch(/Secure/);
    expect(c).toMatch(/Max-Age=3600/);
  });

  it('omits Secure only when explicitly told (local http dev)', () => {
    expect(buildSetCookie('v', 3600, { secure: false })).not.toMatch(/Secure/);
  });

  it('clears with Max-Age=0', () => {
    expect(buildClearCookie()).toMatch(/Max-Age=0/);
  });
});
