import { describe, expect, it } from 'vitest';
import { canReplaceRoeStop, roePositionBasis, roeTrailingTarget } from './roe-trailing.js';

const position = { activePos: '1', lockedMarginMinor: '1000000000', marginCurrency: 'USDT',
  pair: 'B-BTC_USDT', settlementCurrencyAvgPrice: null, avgEntryPrice: '100' };
const basis = roePositionBasis(position); // 10 USDT collateral: 0.10 price = 1% ROE.
const config = { live: '100', extreme: '100', current: '95', anchor: '100', short: false, stepBp: '100', tick: '0.01', basis };

describe('margin-based ROE trailing', () => {
  it('uses percentage points of position return rather than coin movement', () => {
    expect(roeTrailingTarget({ ...config, live: '100.099' }).stop).toBeNull();
    expect(roeTrailingTarget({ ...config, live: '100.1' })).toEqual({ extreme: '100.1', anchor: '100.1', stop: '95.1' });
  });
  it('trails different accounts independently at their actual leverage', () => {
    const unleveraged = roePositionBasis({ ...position, lockedMarginMinor: '10000000000' });
    expect(roeTrailingTarget({ ...config, live: '100.1', basis: unleveraged }).stop).toBeNull();
    expect(roeTrailingTarget({ ...config, live: '101', basis: unleveraged }).stop).toBe('96');
    expect(roeTrailingTarget({ ...config, live: '100.1' }).stop).toBe('95.1');
  });
  it('preserves the selected stop gap and consumes full steps only', () => {
    const first = roeTrailingTarget({ ...config, live: '100.35' });
    expect(first).toEqual({ extreme: '100.35', anchor: '100.3', stop: '95.3' });
    expect(roeTrailingTarget({ ...config, live: '100.399', extreme: first.extreme, current: first.stop!, anchor: first.anchor }).stop).toBeNull();
    expect(roeTrailingTarget({ ...config, live: '100.4', extreme: first.extreme, current: first.stop!, anchor: first.anchor }).stop).toBe('95.4');
  });
  it('starts relative to enablement even when the position is already profitable', () => {
    expect(roeTrailingTarget({ ...config, live: '110.1', extreme: '110', anchor: '110', current: '105' }).stop).toBe('105.1');
  });
  it('tightens shorts downward without multiplying leverage twice', () => {
    expect(roeTrailingTarget({ ...config, short: true, live: '99.7', current: '105' }))
      .toEqual({ extreme: '99.7', anchor: '99.7', stop: '104.7' });
  });
  it('never loosens on a reversal or moves across the live price', () => {
    expect(roeTrailingTarget({ ...config, live: '99', extreme: '100.1', current: '95.1', anchor: '100.1' }).stop).toBeNull();
    expect(roeTrailingTarget({ ...config, live: '94', extreme: '101' }).stop).toBeNull();
    expect(roeTrailingTarget({ ...config, short: true, live: '106', extreme: '99', current: '105' }).stop).toBeNull();
  });
  it('waits for enough improvement to advance a coarse venue tick', () => {
    expect(roeTrailingTarget({ ...config, live: '100.4', tick: '0.5' }).stop).toBeNull();
    expect(roeTrailingTarget({ ...config, live: '100.5', tick: '0.5' }).stop).toBe('95.5');
    expect(roeTrailingTarget({ ...config, short: true, live: '99.6', current: '105', tick: '0.5' }).stop).toBeNull();
  });
  it('does not consume rounded-away movement', () => {
    expect(roeTrailingTarget({ ...config, stepBp: '300', live: '100.6', tick: '0.5' }))
      .toEqual({ extreme: '100.6', anchor: '100.5', stop: '95.5' });
  });
  it('handles tiny coins and large quantities exactly', () => {
    const tiny = roePositionBasis({ ...position, activePos: '1000000000', lockedMarginMinor: '100000000', avgEntryPrice: '0.00000001' });
    expect(roeTrailingTarget({ ...config, basis: tiny, live: '0.00000001001', extreme: '0.00000001', anchor: '0.00000001',
      current: '0.000000009', tick: '0.000000000001' }).stop).toBe('0.00000000901');
  });
  it('uses actual added margin rather than nominal leverage', () => {
    const addedMargin = roePositionBasis({ ...position, lockedMarginMinor: '2000000000' });
    expect(roeTrailingTarget({ ...config, basis: addedMargin, live: '100.1' }).stop).toBeNull();
    expect(roeTrailingTarget({ ...config, basis: addedMargin, live: '100.2' }).stop).toBe('95.2');
  });
  it('converts INR collateral on USDT contracts using its settlement rate', () => {
    const inr = roePositionBasis({ ...position, marginCurrency: 'INR', lockedMarginMinor: '80000', settlementCurrencyAvgPrice: '80' });
    expect(roeTrailingTarget({ ...config, basis: inr, live: '100.1' }).stop).toBe('95.1');
    const inrQuote = roePositionBasis({ ...position, pair: 'B-BTC_INR', marginCurrency: 'INR', lockedMarginMinor: '1000' });
    expect(roeTrailingTarget({ ...config, basis: inrQuote, live: '100.1' }).stop).toBe('95.1');
  });
  it.each([
    { activePos: '0' }, { lockedMarginMinor: null }, { lockedMarginMinor: '-1' }, { avgEntryPrice: null },
    { marginCurrency: 'INR', settlementCurrencyAvgPrice: null }, { pair: 'B-BTC_EUR' },
  ])('refuses unavailable or invalid collateral data: %j', (patch) => {
    expect(() => roePositionBasis({ ...position, ...patch })).toThrow();
  });
  it('requires rebasing after margin, entry, size, direction or FX changes', () => {
    for (const patch of [{ lockedMarginMinor: '1000000001' }, { activePos: '2' }, { activePos: '-1' }, { avgEntryPrice: '101' }]) {
      expect(roePositionBasis({ ...position, ...patch }).key).not.toBe(basis.key);
    }
    expect(roePositionBasis({ ...position, activePos: '1.000', avgEntryPrice: '100.00' }).key).toBe(basis.key);
  });
  it('rechecks the live stop and mark before cancelling protection', () => {
    const fresh = { activePos: '1', stopLossTrigger: '95.00', markPrice: '100.1' };
    expect(canReplaceRoeStop(fresh, '95.1', '95')).toBe(true);
    expect(canReplaceRoeStop({ ...fresh, stopLossTrigger: '96' }, '95.1', '95')).toBe(false);
    expect(canReplaceRoeStop({ ...fresh, stopLossTrigger: null }, '95.1', '95')).toBe(false);
    expect(canReplaceRoeStop({ ...fresh, markPrice: '95' }, '95.1', '95')).toBe(false);
    expect(canReplaceRoeStop(fresh, '94', '95')).toBe(false);
    expect(canReplaceRoeStop({ activePos: '-1', stopLossTrigger: '105', markPrice: '100' }, '104.9', '105')).toBe(true);
  });
});
