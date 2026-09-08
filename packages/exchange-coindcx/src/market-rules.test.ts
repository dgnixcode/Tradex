// Market rules mapping. The unit tests pin the behaviour on small rows; the
// 997-market live sweep lives in checks/01-market-rules.check.mjs, because
// "every real market maps" is a different claim from "the mapping is correct".
// Sources: 01 F0 (the base/quote inversion), 09 F6, 10 F1.

import { describe, expect, it } from 'vitest';
import {
  MarketMappingError, indexByAsset, mapMarketsDetails, plainDecimal, toMinorUnits,
} from './market-rules.js';

/** A row shaped like the live response, with the venue's own field names. */
const row = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  symbol: 'BTCINR',
  base_currency_short_name: 'INR', // their "base" is our QUOTE
  target_currency_short_name: 'BTC', // their "target" is our ASSET
  base_currency_precision: 1,
  target_currency_precision: 5,
  min_quantity: 0.00001,
  max_quantity: 2,
  max_quantity_market: 0.0158,
  min_price: 3511201,
  max_price: 31600800,
  min_notional: 100,
  step: 0.00001,
  order_types: ['limit_order', 'market_order'],
  ecode: 'I',
  status: 'active',
  ...over,
});

const mapOne = (over: Record<string, unknown> = {}): ReturnType<typeof mapMarketsDetails>['rules'][number] => {
  const { rules, skipped } = mapMarketsDetails(JSON.stringify([row(over)]), 'v1');
  if (rules[0] === undefined) throw new Error(`expected a mapped row, got skip: ${skipped[0]?.reason}`);
  return rules[0];
};

describe("CoinDCX's base/quote inversion is undone here and nowhere else", () => {
  it('maps their base to our quote and their target to our asset', () => {
    const r = mapOne();
    expect(r.market).toEqual({ asset: 'BTC', quote: 'INR' });
  });

  it('maps their base PRECISION to our price precision', () => {
    // The subtle half of the inversion. Reading base_currency_precision as
    // quantity precision would round BTC quantities to 1 decimal place — a
    // 0.0158 BTC market order would become 0.0, and the venue would reject it.
    const r = mapOne();
    expect(r.pricePrecision).toBe(1);
    expect(r.quantityPrecision).toBe(5);
  });

  it('never leaks a venue field name upward', () => {
    const r = mapOne();
    for (const key of Object.keys(r)) {
      expect(key, `${key} looks like a venue field name`).not.toMatch(/_|base_|target_|ecode|coindcx/);
    }
  });
});

describe('exponent form is expanded, exactly', () => {
  it('expands the live values that would otherwise reach the money layer', () => {
    // Real: ETHINR min_quantity, DEFIINR step, dust-market min_price.
    expect(plainDecimal('1e-7', 'x')).toBe('0.0000001');
    expect(plainDecimal('1e-8', 'x')).toBe('0.00000001');
    expect(plainDecimal('1e-11', 'x')).toBe('0.00000000001');
    expect(plainDecimal('5.34966666667e-7', 'x')).toBe('0.000000534966666667');
    expect(plainDecimal('3.1e-7', 'x')).toBe('0.00000031');
    expect(plainDecimal('2e10', 'x')).toBe('20000000000');
    expect(plainDecimal('1.5E+3', 'x')).toBe('1500');
    expect(plainDecimal('-1e-3', 'x')).toBe('-0.001');
  });

  it('leaves an already-plain literal byte-identical', () => {
    for (const v of ['0.00001', '2', '3511201', '1.50', '0.0']) expect(plainDecimal(v, 'x')).toBe(v);
  });

  it('expands by moving the point, not by arithmetic', () => {
    // Number('0.1e-320') is denormal and lossy; the digits must simply move.
    expect(plainDecimal('1234567890123456789e-9', 'x')).toBe('1234567890.123456789');
    expect(plainDecimal('9.999999999999999999e-5', 'x')).toBe('0.00009999999999999999999');
  });

  it('refuses anything that is not a decimal at all', () => {
    for (const v of ['abc', '1.2.3', 'NaN', 'Infinity', '0x1f', '1,5', '']) {
      expect(() => plainDecimal(v, 'min_price'), v).toThrow(MarketMappingError);
    }
    expect(() => plainDecimal('abc', 'min_price')).toThrow(/min_price is not a decimal/);
  });

  it('reaches the mapped row', () => {
    const r = mapOne({ step: 1e-7, min_quantity: 1e-8, min_price: 1e-11 });
    expect(r.quantityStep).toBe('0.0000001');
    expect(r.minQuantity).toBe('0.00000001');
    expect(r.minPrice).toBe('0.00000000001');
  });
});

describe('minor-unit conversion refuses to guess', () => {
  it('converts at the quote currency scale', () => {
    expect(toMinorUnits('100', 2)).toBe('10000');
    expect(toMinorUnits('5', 8)).toBe('500000000');
    expect(toMinorUnits('0.01', 2)).toBe('1');
    expect(toMinorUnits('19870.59', 2)).toBe('1987059');
    expect(toMinorUnits('0', 2)).toBe('0');
    expect(toMinorUnits('0.00000001', 8)).toBe('1');
    expect(toMinorUnits('-1.5', 2)).toBe('-150');
  });

  it('refuses to truncate rather than understate a limit', () => {
    // Truncating a minimum downward produces an order the venue then rejects —
    // and it fails per-account, mid-fan-out, which is the worst place to learn.
    expect(() => toMinorUnits('0.001', 2)).toThrow(/refusing to truncate/);
    expect(() => toMinorUnits('0.000000001', 8)).toThrow(/refusing to truncate/);
  });

  it('accepts trailing zeros beyond the scale, which lose nothing', () => {
    expect(toMinorUnits('1.500', 2)).toBe('150');
    expect(toMinorUnits('1.00000000000', 2)).toBe('100');
  });

  it('rejects a non-decimal outright', () => {
    for (const v of ['1e-7', 'abc', '1.2.3', '']) expect(() => toMinorUnits(v, 2), v).toThrow(MarketMappingError);
  });

  it('maps min_notional through to the row', () => {
    expect(mapOne().minNotionalMinor).toBe('10000');
    expect(mapOne({ symbol: 'BTCUSDT', base_currency_short_name: 'USDT', min_notional: 5 }).minNotionalMinor)
      .toBe('500000000');
  });
});

describe('an absent market minimum stays absent', () => {
  it('maps a missing min_market_orders_qty to null, never 0', () => {
    // Absent from all 997 live rows despite being documented. A 0 here would
    // pass every "is the size above the minimum" check silently (09 F6).
    const r = mapOne();
    expect(r.minMarketQuantity).toBeNull();
    expect(r.maxMarketQuantity).toBe('0.0158');
  });

  it('maps an explicit null the same way', () => {
    expect(mapOne({ min_market_orders_qty: null, max_quantity_market: null }).minMarketQuantity).toBeNull();
    expect(mapOne({ max_quantity_market: null }).maxMarketQuantity).toBeNull();
  });

  it('carries a present value through, normalised', () => {
    expect(mapOne({ min_market_orders_qty: 1e-7 }).minMarketQuantity).toBe('0.0000001');
  });

  it('exposes the market cap that breaks percentage sizing on big accounts', () => {
    // 0.0158 BTC against a max_quantity of 2 — a ~127x gap. A 20% slice of a
    // large account exceeds the market-order cap by arithmetic, not by bug.
    const r = mapOne();
    expect(Number(r.maxMarketQuantity)).toBeLessThan(Number(r.maxQuantity) / 100);
  });
});

describe('order types are filtered to what we support', () => {
  it('maps the two we send', () => {
    expect(mapOne().allowedTypes).toEqual(['limit', 'market']);
  });

  it('drops types we do not support without dropping the market', () => {
    const r = mapOne({ order_types: ['stop_limit', 'market_order', 'take_profit'] });
    expect(r.allowedTypes).toEqual(['market']);
  });

  it('does not duplicate a repeated type', () => {
    expect(mapOne({ order_types: ['limit_order', 'limit_order'] }).allowedTypes).toEqual(['limit']);
  });

  it('skips a market with no supported type rather than defaulting one', () => {
    const { rules, skipped } = mapMarketsDetails(JSON.stringify([row({ order_types: ['stop_limit'] })]), 'v1');
    expect(rules).toHaveLength(0);
    expect(skipped[0]?.reason).toMatch(/no supported order type/);
  });
});

describe('status becomes tradable, and an inactive market is still mapped', () => {
  it('reads active as tradable', () => {
    expect(mapOne().tradable).toBe(true);
  });

  it('keeps a suspended market with tradable false, so it can be explained', () => {
    // Dropping it would surface to a customer as "asset not listed", which is a
    // different and wrong answer from "this market is halted right now".
    const r = mapOne({ status: 'suspended' });
    expect(r.tradable).toBe(false);
    expect(r.venueSymbol).toBe('BTCINR');
  });
});

describe('a market we cannot represent is skipped with a reason, never dropped', () => {
  it('skips an unsupported quote and names it', () => {
    const text = JSON.stringify([
      row(),
      row({ symbol: 'ETHBTC', base_currency_short_name: 'BTC', target_currency_short_name: 'ETH' }),
    ]);
    const { rules, skipped } = mapMarketsDetails(text, 'v1');
    expect(rules.map((r) => r.venueSymbol)).toEqual(['BTCINR']);
    expect(skipped).toEqual([{ symbol: 'ETHBTC', reason: 'unsupported quote currency BTC' }]);
  });

  it('accounts for every input row — mapped plus skipped equals the input', () => {
    const text = JSON.stringify([row(), row({ base_currency_short_name: 'BTC' }), 'not an object', null]);
    const { rules, skipped } = mapMarketsDetails(text, 'v1');
    expect(rules.length + skipped.length).toBe(4);
    expect(skipped.filter((s) => s.reason === 'row is not an object')).toHaveLength(2);
  });

  it('skips a malformed row instead of throwing away the whole response', () => {
    // One bad market must not cost us the other 996.
    const text = JSON.stringify([row({ symbol: 'BADINR', min_notional: 'oops' }), row()]);
    const { rules, skipped } = mapMarketsDetails(text, 'v1');
    expect(rules.map((r) => r.venueSymbol)).toEqual(['BTCINR']);
    expect(skipped[0]).toEqual({ symbol: 'BADINR', reason: 'min_notional is not a decimal number: oops' });
  });

  it('names an unidentifiable row rather than reporting undefined', () => {
    const { skipped } = mapMarketsDetails(JSON.stringify([{ base_currency_short_name: 'INR' }]), 'v1');
    expect(skipped[0]?.symbol).toBe('(no symbol)');
  });

  it('throws only when the response is not a list of markets at all', () => {
    expect(() => mapMarketsDetails('{"error":"nope"}', 'v1')).toThrow(/did not return an array/);
  });

  it('stamps the rules version on every row and on the result', () => {
    const out = mapMarketsDetails(JSON.stringify([row()]), '2026-09-06T03:00Z');
    expect(out.rulesVersion).toBe('2026-09-06T03:00Z');
    expect(out.rules[0]?.rulesVersion).toBe('2026-09-06T03:00Z');
  });
});

describe('the asset index is what resolves a group trade to a book', () => {
  it('groups every market that trades an asset', () => {
    const { rules } = mapMarketsDetails(JSON.stringify([
      row(),
      row({ symbol: 'BTCUSDT', base_currency_short_name: 'USDT', ecode: 'B' }),
      row({ symbol: 'ETHINR', target_currency_short_name: 'ETH' }),
    ]), 'v1');
    const index = indexByAsset(rules);
    expect([...index.keys()].sort()).toEqual(['BTC', 'ETH']);
    expect(index.get('BTC')?.map((r) => r.market.quote)).toEqual(['INR', 'USDT']);
    expect(index.get('ETH')).toHaveLength(1);
  });

  it('preserves input order within an asset, so a quote preference can be applied', () => {
    const { rules } = mapMarketsDetails(JSON.stringify([
      row({ symbol: 'BTCUSDT', base_currency_short_name: 'USDT' }),
      row(),
    ]), 'v1');
    expect(indexByAsset(rules).get('BTC')?.map((r) => r.venueSymbol)).toEqual(['BTCUSDT', 'BTCINR']);
  });

  it('is empty for an empty response, without throwing', () => {
    expect(indexByAsset([]).size).toBe(0);
    expect(mapMarketsDetails('[]', 'v1').rules).toEqual([]);
  });
});
