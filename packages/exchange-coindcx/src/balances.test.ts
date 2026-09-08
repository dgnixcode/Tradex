// The two facts this guards: balances arrive in MAJOR units and must convert to
// minor without loss, and `free` and `locked` are disjoint and never summed
// (a sell sizes against free alone, 11 F1). The awkward values are the point —
// an 8-decimal dust holding and a locked-only currency both appear live.

import { describe, expect, it } from 'vitest';
import { deriveFundingCurrencies, freeBalanceMinor } from '@tradex/exchange';
import { BalanceMappingError, mapBalances, scaleFor } from './balances.js';

// The shape apps/signer's fake venue synthesises, which mirrors 01 F6.1.
const LIVE = JSON.stringify([
  { currency: 'INR', balance: 248750.34, locked_balance: 19870.59 },
  { currency: 'USDT', balance: 1420.88888888, locked_balance: 0 },
  { currency: 'BTC', balance: 0.00031204, locked_balance: 0.00000001 },
  { currency: 'ETH', balance: 0, locked_balance: 0 },
]);

describe('major units convert to minor without loss', () => {
  it('maps INR at scale 2 and crypto at scale 8', () => {
    const balances = mapBalances(LIVE);
    const byCcy = Object.fromEntries(balances.map((b) => [b.currency, b]));
    expect(byCcy['INR']).toEqual({ currency: 'INR', freeMinor: '24875034', lockedMinor: '1987059', scale: 2 });
    expect(byCcy['USDT']).toEqual({ currency: 'USDT', freeMinor: '142088888888', lockedMinor: '0', scale: 8 });
    // The 1-satoshi lock is the value a double would round; it must survive.
    expect(byCcy['BTC']).toEqual({ currency: 'BTC', freeMinor: '31204', lockedMinor: '1', scale: 8 });
  });

  it('drops a currency that is entirely zero', () => {
    // The venue returns a row for every currency ever touched; ETH here is 0/0.
    expect(mapBalances(LIVE).some((b) => b.currency === 'ETH')).toBe(false);
  });

  it('keeps a currency that is only locked', () => {
    // Free 0 but locked > 0 is a real state: everything is in open orders. It is
    // not spendable, but it must not vanish from the balance sheet.
    const b = mapBalances('[{"currency":"INR","balance":0,"locked_balance":500.00}]');
    expect(b).toEqual([{ currency: 'INR', freeMinor: '0', lockedMinor: '50000', scale: 2 }]);
  });

  it('treats an absent locked_balance as zero', () => {
    const b = mapBalances('[{"currency":"USDT","balance":"10"}]');
    expect(b[0]).toEqual({ currency: 'USDT', freeMinor: '1000000000', lockedMinor: '0', scale: 8 });
  });

  it('reads a quoted number identically to a bare one', () => {
    // trade_history quotes, markets_details does not; balances could go either way.
    const quoted = mapBalances('[{"currency":"INR","balance":"100.50","locked_balance":"0"}]');
    const bare = mapBalances('[{"currency":"INR","balance":100.50,"locked_balance":0}]');
    expect(quoted).toEqual(bare);
    expect(quoted[0]?.freeMinor).toBe('10050');
  });

  it('upper-cases the currency code', () => {
    expect(mapBalances('[{"currency":"usdt","balance":"1"}]')[0]?.currency).toBe('USDT');
  });
});

describe('a balance it cannot represent is refused, never rounded', () => {
  it('throws when a value carries more precision than the currency scale', () => {
    // INR has 2 minor digits; a third non-zero one cannot be paise.
    expect(() => mapBalances('[{"currency":"INR","balance":"100.005"}]')).toThrow(BalanceMappingError);
    expect(() => mapBalances('[{"currency":"INR","balance":"100.005"}]')).toThrow(/without loss/);
  });

  it('accepts trailing zeros beyond the scale, which lose nothing', () => {
    expect(mapBalances('[{"currency":"INR","balance":"100.0000"}]')[0]?.freeMinor).toBe('10000');
  });

  it('rejects a malformed envelope or a duplicate currency', () => {
    expect(() => mapBalances('{"error":"nope"}')).toThrow(/did not return an array/);
    expect(() => mapBalances('[1,2]')).toThrow(/not an object/);
    expect(() => mapBalances('[{"currency":"INR","balance":"1"},{"currency":"INR","balance":"2"}]'))
      .toThrow(/appears twice/);
  });

  it('rejects a row with no balance field', () => {
    expect(() => mapBalances('[{"currency":"INR"}]')).toThrow();
  });
});

describe('funding currencies are derived from free balances, never typed', () => {
  it('lists a quote currency only when its free balance is positive', () => {
    expect(deriveFundingCurrencies(mapBalances(LIVE))).toEqual(['INR', 'USDT']);
  });

  it('excludes a quote currency that is present but fully locked', () => {
    // 5 lakh locked, nothing free: cannot fund a new buy, so not a funding ccy.
    const b = mapBalances('[{"currency":"INR","balance":0,"locked_balance":500000}]');
    expect(deriveFundingCurrencies(b)).toEqual([]);
  });

  it('never lists a crypto holding as a funding currency', () => {
    // BTC is what you sell, not what you fund a percentage buy with.
    const b = mapBalances('[{"currency":"BTC","balance":"1.5"}]');
    expect(deriveFundingCurrencies(b)).toEqual([]);
  });

  it('is order-stable: INR before USDT regardless of response order', () => {
    const b = mapBalances('[{"currency":"USDT","balance":"1"},{"currency":"INR","balance":"1"}]');
    expect(deriveFundingCurrencies(b)).toEqual(['INR', 'USDT']);
  });
});

describe('helpers', () => {
  it('reports scale per currency with a crypto default', () => {
    expect(scaleFor('INR')).toBe(2);
    expect(scaleFor('USDT')).toBe(8);
    expect(scaleFor('DOGE')).toBe(8);
  });

  it('returns a free balance or zero for an absent currency', () => {
    const b = mapBalances(LIVE);
    expect(freeBalanceMinor(b, 'INR')).toBe('24875034');
    expect(freeBalanceMinor(b, 'SOL')).toBe('0');
  });
});
