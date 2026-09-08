// packages/exchange-coindcx — signing, verified against golden vectors derived
// from the documented scheme (docs lines 1278-1375).
//
// The vectors below were produced by reproducing the official sample's exact
// code path — `JSON.stringify(body)` then `createHmac('sha256', secret)` — so a
// change in our serialisation or key handling breaks them immediately.

import { describe, expect, it } from 'vitest';
import {
  AUTH_KEY_HEADER, AUTH_SIGNATURE_HEADER, SigningError,
  assertSendable, hmacHex, signRequest,
} from './signing.js';

const SECRET = 'tradex_test_secret_do_not_use_in_production';
const KEY = 'tradex_test_key';

describe('golden HMAC vectors', () => {
  const vectors: ReadonlyArray<[string, string]> = [
    [
      // The documented sample body, verbatim.
      '{"side":"buy","order_type":"limit_order","market":"SNTBTC","price_per_unit":"0.03244","total_quantity":400,"timestamp":1524211224}',
      'fa99436c4c2754f24c6c145e5fb8f235a29d3b590fe859e1fb5ed9db9470623a',
    ],
    [
      // A realistic Tradex spot order: quantity as a string, with a client id.
      '{"side":"buy","order_type":"market_order","market":"BTCINR","total_quantity":"0.00246","client_order_id":"t7k2m9x4qp8rv3nc6ba5wy1ze0h","timestamp":1788442200000}',
      '7235e8735cba3e2134d4a912d0c1b4e8a2645b8fb13a98b90039b2d8f434be68',
    ],
    [
      // The minimal authenticated read, e.g. users/balances.
      '{"timestamp":1788442200000}',
      '655c92b413c3c8cff6efdbf330e08864b39188fe9f0c2a32494b9fbcd05ba23c',
    ],
  ];

  it.each(vectors)('signs %s', (payload, expected) => {
    expect(hmacHex(SECRET, payload)).toBe(expected);
  });

  it('produces a 64-character lowercase hex digest', () => {
    expect(hmacHex(SECRET, '{}')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes completely for a one-character body change', () => {
    const a = hmacHex(SECRET, '{"timestamp":1788442200000}');
    const b = hmacHex(SECRET, '{"timestamp":1788442200001}');
    expect(a).not.toBe(b);
  });

  it('refuses an empty secret rather than signing with one', () => {
    expect(() => hmacHex('', '{}')).toThrow(SigningError);
  });
});

describe('signRequest returns the exact bytes it signed', () => {
  it('signs the body it emits, not a re-serialisation of it', () => {
    const signed = signRequest(KEY, SECRET, { market: 'BTCINR', side: 'buy' }, 1788442200000);
    expect(signed.headers[AUTH_SIGNATURE_HEADER]).toBe(hmacHex(SECRET, signed.body));
    // This is the bug in the official sample: signing a string, sending an
    // object, and hoping the client re-serialises identically.
    expect(hmacHex(SECRET, JSON.stringify(JSON.parse(signed.body)))).toBe(signed.headers[AUTH_SIGNATURE_HEADER]);
  });

  it('appends timestamp in milliseconds, last', () => {
    const signed = signRequest(KEY, SECRET, { market: 'BTCINR' }, 1788442200000);
    expect(signed.body).toBe('{"market":"BTCINR","timestamp":1788442200000}');
    expect(JSON.parse(signed.body).timestamp).toBe(1788442200000);
  });

  it('sets both auth headers and a JSON content type', () => {
    const signed = signRequest(KEY, SECRET, {}, 1788442200000);
    expect(signed.headers[AUTH_KEY_HEADER]).toBe(KEY);
    expect(signed.headers[AUTH_SIGNATURE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(signed.headers['Content-Type']).toBe('application/json');
  });

  it('refuses a caller-supplied timestamp', () => {
    expect(() => signRequest(KEY, SECRET, { timestamp: 1 })).toThrow(/stamps it at signing time/);
  });

  it('refuses an empty api key', () => {
    expect(() => signRequest('', SECRET, {})).toThrow(SigningError);
  });

  it('refuses undefined, which JSON.stringify would silently drop', () => {
    expect(() => signRequest(KEY, SECRET, { market: undefined })).toThrow(/drop it silently/);
  });

  it('refuses a bigint, which cannot be JSON-serialised', () => {
    expect(() => signRequest(KEY, SECRET, { total_quantity: 1n })).toThrow(/serialise money to a string/);
  });

  it('refuses NaN and Infinity, which serialise to null', () => {
    expect(() => signRequest(KEY, SECRET, { price: Number.NaN })).toThrow(/finite/);
    expect(() => signRequest(KEY, SECRET, { price: Number.POSITIVE_INFINITY })).toThrow(/finite/);
  });

  it('keeps money as strings end to end', () => {
    const signed = signRequest(KEY, SECRET, { total_quantity: '0.00246', price_per_unit: '8077476.1' }, 1);
    expect(signed.body).toContain('"total_quantity":"0.00246"');
    expect(signed.body).not.toContain('0.0024600');
  });
});

describe('assertSendable is the pre-flight check', () => {
  const at = 1788442200000;

  it('passes a freshly signed request', () => {
    const signed = signRequest(KEY, SECRET, { market: 'BTCINR' }, at);
    expect(() => assertSendable(SECRET, signed, { nowMs: at + 50 })).not.toThrow();
  });

  it('catches a body mutated after signing', () => {
    const signed = signRequest(KEY, SECRET, { market: 'BTCINR' }, at);
    const tampered = { ...signed, body: signed.body.replace('BTCINR', 'BTCUSDT') };
    expect(() => assertSendable(SECRET, tampered, { nowMs: at + 50 })).toThrow(/mutated after signing/);
  });

  it('catches a stale signature — the queued-payload bug', () => {
    // 03: a futures order is rejected after 10 seconds. Our own limit is 2s.
    const signed = signRequest(KEY, SECRET, { market: 'BTCINR' }, at);
    expect(() => assertSendable(SECRET, signed, { nowMs: at + 3_000 })).toThrow(/sign at send, never at enqueue/);
  });

  it('catches a clock running backwards', () => {
    const signed = signRequest(KEY, SECRET, { market: 'BTCINR' }, at);
    expect(() => assertSendable(SECRET, signed, { nowMs: at - 5_000 })).toThrow(/in the future — check the clock/);
  });

  it('rejects a body that is not valid JSON', () => {
    const body = 'not json';
    expect(() =>
      assertSendable(SECRET, { body, headers: { [AUTH_SIGNATURE_HEADER]: hmacHex(SECRET, body) } }),
    ).toThrow(/not valid JSON/);
  });

  it('rejects a body with no timestamp', () => {
    const body = '{"market":"BTCINR"}';
    expect(() =>
      assertSendable(SECRET, { body, headers: { [AUTH_SIGNATURE_HEADER]: hmacHex(SECRET, body) } }),
    ).toThrow(/no numeric timestamp/);
  });
});
