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

  it('maps a futures wallet format with currency_short_name', () => {
    const f = mapBalances('[{"currency_short_name":"INR","balance":"100.50","locked_balance":"0"}]');
    expect(f[0]?.currency).toBe('INR');
    expect(f[0]?.freeMinor).toBe('10050');
  });
});

describe('a balance it cannot represent is refused, never rounded', () => {
  it('widens to hold a value finer than the preferred scale', () => {
    // INR's 2 is a convention about how rupees are written, not a limit on what a
    // wallet holds. The digit is KEPT — the scale widens to hold it exactly.
    const [inr] = mapBalances('[{"currency":"INR","balance":"100.005"}]');
    expect(inr?.scale).toBe(3);
    expect(inr?.freeMinor).toBe('100005');
  });

  it('accepts trailing zeros beyond the scale, which lose nothing', () => {
    expect(mapBalances('[{"currency":"INR","balance":"100.0000"}]')[0]?.freeMinor).toBe('10000');
    expect(mapBalances('[{"currency":"INR","balance":"100.0000"}]')[0]?.scale).toBe(2);
  });

  it('widens a CRYPTO balance to fit the wallet precision the venue reported', () => {
    // A real payload that hard-failed onboarding: a YFI dust balance with 14
    // decimals, against the crypto convention of 8. It is not misread and not
    // truncated — the scale widens to hold it exactly.
    const [yfi] = mapBalances('[{"currency":"YFI","balance":0.00000000534923,"locked_balance":0}]');
    expect(yfi?.currency).toBe('YFI');
    expect(yfi?.scale).toBe(18);
    expect(yfi?.freeMinor).toBe('5349230000');
    // Round-trips: 5349230000 at scale 18 is exactly the venue's 5.34923e-9.
    expect(BigInt(yfi?.freeMinor ?? '0')).toBe(5_349_230_000n);
  });

  it('widens a FIAT balance too — the live INR payload that failed onboarding', () => {
    // `0.00508437692499` INR is what a real account actually returned. An earlier
    // version of this file treated sub-paise INR as a venue bug and refused it,
    // which hard-failed onboarding on real dust. The wallet scale is not the
    // tradable step; storing the exact figure is what the scale widening is for.
    const [inr] = mapBalances('[{"currency":"INR","balance":0.00508437692499,"locked_balance":0}]');
    expect(inr?.currency).toBe('INR');
    expect(inr?.scale).toBe(18);
    expect(BigInt(inr?.freeMinor ?? '0')).toBe(5_084_376_924_990_000n);
  });

  it('refuses a value finer than the widest supported scale', () => {
    // 19 decimals exceeds what the money layer can hold; still an error, never a round.
    expect(() => mapBalances('[{"currency":"BTC","balance":"0.0000000000000000001"}]')).toThrow(BalanceMappingError);
    expect(() => mapBalances('[{"currency":"BTC","balance":"0.0000000000000000001"}]')).toThrow(/without loss/);
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

  it('does NOT let sub-paise INR dust win the derivation over real USDT', () => {
    // The exact shape a live account returned: 0.00508437692499 INR free (no
    // paise at all) alongside a real USDT balance. INR must not be derived —
    // sizing a percentage buy against ₹0.00 would place nothing, and picking INR
    // here would hide the USDT the account can actually trade with.
    const b = mapBalances(
      '[{"currency":"INR","balance":0.00508437692499,"locked_balance":0},{"currency":"USDT","balance":100,"locked_balance":0}]',
    );
    expect(deriveFundingCurrencies(b)).toEqual(['USDT']);
    expect(freeBalanceMinor(b, 'INR')).toBe('0');
    expect(freeBalanceMinor(b, 'USDT')).toBe('10000000000');
  });

  it('projects a wallet-scale balance onto the tradable step, never reading it raw', () => {
    // The load-bearing half of the two-scale model: a scale-18 INR row read as if
    // it were paise would overstate this account by 10^16.
    const b = mapBalances('[{"currency":"INR","balance":1234.5,"locked_balance":0}]');
    expect(b[0]?.scale).toBe(2);
    expect(freeBalanceMinor(b, 'INR')).toBe('123450');
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
