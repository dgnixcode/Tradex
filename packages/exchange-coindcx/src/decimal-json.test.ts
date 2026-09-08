// The parser exists because of one fact: by the time a `JSON.parse` reviver is
// called, the damage is already done. These tests assert against literals taken
// from the captured live `markets_details` response, not invented ones.
// Source: 05-coindcx-websockets.md, DATA-MODEL.md, DECISIONS.md D01.

import { describe, expect, it } from 'vitest';
import { JsonParseError, optionalScalar, parseDecimalJson, requireScalar } from './decimal-json.js';

const obj = (text: string): { [k: string]: unknown } =>
  parseDecimalJson(text) as { [k: string]: unknown };

describe('numbers survive as their exact literal text', () => {
  it('keeps a value JSON.parse would round', () => {
    // BTCINR max_quantity_market, live. JSON.parse gives 122.6936997 back as a
    // double whose shortest round-trip happens to match — but the guarantee we
    // need is that we never depended on that.
    expect(obj('{"a":122.6936997}')['a']).toBe('122.6936997');
    expect(obj('{"a":0.00001}')['a']).toBe('0.00001');
  });

  it('keeps exponent form exactly as sent', () => {
    // 90 fields in the live response arrive like this: ETHINR min_quantity is
    // 1e-7, DEFIINR step is 1e-7, dust markets carry min_price 1e-11.
    for (const lit of ['1e-8', '1e-7', '1e-11', '3.1e-7', '7.009e-9', '5.34966666667e-7', '1E+5', '2e10']) {
      expect(obj(`{"v":${lit}}`)['v'], lit).toBe(lit);
    }
  });

  it('does not normalise, canonicalise, or trim', () => {
    expect(obj('{"a":1.50}')['a']).toBe('1.50');
    expect(obj('{"a":0.0}')['a']).toBe('0.0');
    expect(obj('{"a":-0}')['a']).toBe('-0');
    expect(obj('{"a":1000000000000000000000}')['a']).toBe('1000000000000000000000');
  });

  it('produces no JS numbers anywhere in a nested structure', () => {
    const parsed = parseDecimalJson('{"a":[1,{"b":2.5},[3e4]],"c":{"d":{"e":5}}}');
    let numbers = 0;
    const walk = (v: unknown): void => {
      if (typeof v === 'number') numbers += 1;
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(parsed);
    expect(numbers).toBe(0);
  });
});

describe('everything that is not a number behaves like JSON', () => {
  it('parses strings, booleans, null, objects and arrays', () => {
    expect(parseDecimalJson('{"s":"x","t":true,"f":false,"n":null,"a":[],"o":{}}')).toEqual({
      s: 'x', t: true, f: false, n: null, a: [], o: {},
    });
  });

  it('handles escapes, including \\u', () => {
    expect(parseDecimalJson('"a\\"b\\\\c\\/d\\ne\\tf"')).toBe('a"b\\c/d\ne\tf');
    expect(parseDecimalJson('"\\u20b9100"')).toBe('\u20b9100');
  });

  it('does not confuse a numeric string with a number', () => {
    // Both come back as strings — which is the point. Consumers must not care
    // whether the venue quoted the value, and the venue is inconsistent.
    expect(obj('{"a":"1.5","b":1.5}')).toEqual({ a: '1.5', b: '1.5' });
  });

  it('tolerates whitespace between every token', () => {
    expect(parseDecimalJson(' {\n "a" :\t[ 1 , 2 ]\r\n} ')).toEqual({ a: ['1', '2'] });
  });

  it('keeps the last value for a duplicated key, as JSON.parse does', () => {
    expect(obj('{"a":1,"a":2}')['a']).toBe('2');
  });
});

describe('malformed input is rejected, never guessed at', () => {
  const bad: ReadonlyArray<readonly [string, string]> = [
    ['', 'empty'],
    ['{', 'unterminated object'],
    ['[1,', 'unterminated array'],
    ['{"a":}', 'missing value'],
    ['{"a" 1}', 'missing colon'],
    ['{"a":1}{"b":2}', 'two documents'],
    ['{"a":1} trailing', 'trailing content'],
    ['[1 2]', 'missing comma'],
    ['"unterminated', 'unterminated string'],
    ['{"a":tru}', 'truncated literal'],
    ['nope', 'bare word'],
    ['{"a":-}', 'bare minus'],
    ['{"a":"\\q"}', 'unknown escape'],
    ['{"a":"\\uZZZZ"}', 'bad unicode escape'],
    ['{a:1}', 'unquoted key'],
  ];

  it.each(bad)('rejects %s (%s)', (text) => {
    expect(() => parseDecimalJson(text)).toThrow(JsonParseError);
  });

  it('says where it failed, so a bad venue response is diagnosable', () => {
    expect(() => parseDecimalJson('{"a":1,"b":}')).toThrow(/offset \d+ near/);
  });

  it('refuses a non-string input rather than coercing it', () => {
    expect(() => parseDecimalJson(undefined as unknown as string)).toThrow(/must be a string/);
  });
});

describe('field accessors keep the caller honest', () => {
  const row = obj('{"n":1.5,"s":"x","null":null,"arr":[1],"obj":{},"bool":true}');

  it('reads a number or a string identically', () => {
    expect(requireScalar(row as never, 'n')).toBe('1.5');
    expect(requireScalar(row as never, 's')).toBe('x');
  });

  it('names the missing field, and distinguishes missing from wrong-typed', () => {
    expect(() => requireScalar(row as never, 'absent')).toThrow(/field absent is missing/);
    expect(() => requireScalar(row as never, 'null')).toThrow(/field null is object/);
    expect(() => requireScalar(row as never, 'arr')).toThrow(/field arr is object/);
    expect(() => requireScalar(row as never, 'bool')).toThrow(/field bool is boolean/);
  });

  it('treats absent and null alike for an optional field', () => {
    // min_market_orders_qty is documented but absent from all 997 live rows,
    // and a market could start returning an explicit null. Both mean "unknown",
    // and neither may become 0 — a 0 floor would pass every size check (09 F6).
    expect(optionalScalar(row as never, 'null')).toBeNull();
    expect(optionalScalar(row as never, 'absent')).toBeNull();
    expect(optionalScalar(row as never, 'n')).toBe('1.5');
    expect(() => optionalScalar(row as never, 'obj')).toThrow(/expected a scalar or null/);
  });
});
