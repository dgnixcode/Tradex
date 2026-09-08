// packages/secret — the property under test is an absence: a secret must not
// appear anywhere, through any path. Source: 07-api-key-security.md F6.

import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { REDACTED, Secret, isSecret } from './secret.js';
import { containsSecretShaped, looksSecret, redact, redactStack } from './redact.js';

// A realistic CoinDCX-shaped secret: 64 hex characters.
const SENTINEL = 'f3a91c7d5e2b48069a1d6c8f4e7b2a0d93c5817ef6b4d2a09c7e35814f6b2d90';

describe('Secret cannot be printed by any route', () => {
  const s = Secret.of(SENTINEL, 'api_secret');

  it('redacts under template interpolation', () => {
    expect(`${s}`).toBe(REDACTED);
    expect(`value=${s}`).not.toContain(SENTINEL);
  });

  it('redacts under String() and .toString()', () => {
    expect(String(s)).toBe(REDACTED);
    expect(s.toString()).toBe(REDACTED);
  });

  it('redacts under JSON.stringify, nested at any depth', () => {
    const payload = { credential: { inner: { secret: s } }, list: [s] };
    const json = JSON.stringify(payload);
    expect(json).not.toContain(SENTINEL);
    expect(json).toContain(REDACTED);
  });

  it('redacts under util.inspect, which is what console.log uses', () => {
    expect(inspect(s)).not.toContain(SENTINEL);
    expect(inspect({ deep: { s } }, { depth: 5 })).not.toContain(SENTINEL);
  });

  it('redacts inside an Error message built by interpolation', () => {
    const err = new Error(`signing failed for ${s}`);
    expect(err.message).not.toContain(SENTINEL);
  });

  it('exposes the value only through expose()', () => {
    expect(s.expose()).toBe(SENTINEL);
  });

  it('reports length without revealing content', () => {
    expect(s.length).toBe(64);
  });

  it('compares without early exit', () => {
    expect(s.equals(Secret.of(SENTINEL))).toBe(true);
    // Differ in the final character only — SENTINEL already ends in '0', so the
    // near-miss must end in something else or it is the same string.
    expect(s.equals(Secret.of(`${SENTINEL.slice(0, 63)}f`))).toBe(false);
    expect(s.equals(Secret.of('short'))).toBe(false);
  });

  it('refuses to wrap a non-string', () => {
    // @ts-expect-error — guarding the runtime as well as the type
    expect(() => Secret.of(12345)).toThrow(TypeError);
  });

  it('is identifiable', () => {
    expect(isSecret(s)).toBe(true);
    expect(isSecret(SENTINEL)).toBe(false);
  });
});

describe('the field-name denylist', () => {
  it('masks denied keys regardless of case or separator style', () => {
    const out = redact({
      apiSecret: 'plaintext-would-leak',
      api_secret: 'plaintext-would-leak',
      API_SECRET: 'plaintext-would-leak',
      Signature: 'abc',
      'x-auth-signature': 'abc',
      'X-AUTH-APIKEY': 'abc',
      password_hash: 'abc',
      dekWrapped: 'abc',
    }) as Record<string, unknown>;
    for (const v of Object.values(out)) expect(v).toBe(REDACTED);
  });

  it('leaves non-sensitive fields intact', () => {
    const out = redact({ market: 'BTCINR', quantity: '0.00246', accountName: 'Ravi main' });
    expect(out).toEqual({ market: 'BTCINR', quantity: '0.00246', accountName: 'Ravi main' });
  });
});

describe('the shape heuristic catches a secret in an unexpected field', () => {
  it('masks a 64-char hex value even under an innocent key', () => {
    const out = redact({ note: SENTINEL }) as Record<string, unknown>;
    expect(out['note']).toBe(REDACTED);
  });

  it('does not mask an exchange order id, which is a numeric string', () => {
    // 01-coindcx-spot-rest.md: ids are "a positive numeric string".
    const out = redact({ exchangeOrderId: '284195365' }) as Record<string, unknown>;
    expect(out['exchangeOrderId']).toBe('284195365');
  });

  it('does not mask a client_order_id, which is 27 characters', () => {
    const coid = 't7k2m9x4qp8rv3nc6ba5wy1ze0h';
    expect(looksSecret(coid)).toBe(false);
    expect((redact({ clientOrderId: coid }) as Record<string, unknown>)['clientOrderId']).toBe(coid);
  });

  it('does not mask a short value', () => {
    expect(looksSecret('BTCINR')).toBe(false);
    expect(looksSecret('0.00246')).toBe(false);
  });
});

describe('redact handles the shapes a logger actually sees', () => {
  it('walks arrays, Maps, Sets and Dates', () => {
    const out = redact({
      arr: [Secret.of(SENTINEL)],
      map: new Map([['api_secret', 'x']]),
      set: new Set([SENTINEL]),
      when: new Date('2026-09-05T00:00:00.000Z'),
    }) as Record<string, any>;
    expect(out['arr'][0]).toBe(REDACTED);
    expect(out['map']['api_secret']).toBe(REDACTED);
    expect(out['set'][0]).toBe(REDACTED);
    expect(out['when']).toBe('2026-09-05T00:00:00.000Z');
  });

  it('summarises byte buffers rather than printing them', () => {
    const out = redact({ ct: new Uint8Array([1, 2, 3]) }) as Record<string, unknown>;
    expect(out['ct']).toBe('[bytes:3]');
  });

  it('redacts a stack trace without discarding it', () => {
    const stack = `Error: boom\n    at sign (/app/signer.js:1:1) ${SENTINEL}`;
    const out = redactStack(stack);
    expect(out).not.toContain(SENTINEL);
    expect(out).toContain('at sign (/app/signer.js:1:1)');
  });

  it('never mutates its input', () => {
    const input = { api_secret: 'original' };
    redact(input);
    expect(input.api_secret).toBe('original');
  });

  it('terminates on a cyclic object', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(() => redact(a)).not.toThrow();
  });
});

describe('containsSecretShaped is the last-resort scan', () => {
  it('detects a leaked secret in a rendered line', () => {
    expect(containsSecretShaped(`{"msg":"signing","v":"${SENTINEL}"}`)).toBe(true);
  });

  it('does not fire on ordinary log output', () => {
    expect(containsSecretShaped('{"msg":"order placed","market":"BTCINR","qty":"0.00246"}')).toBe(false);
  });
});
