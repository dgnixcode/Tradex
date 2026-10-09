import { describe, expect, it } from 'vitest';
import { maxInstrumentLeverage } from './leverage.js';

describe('exchange leverage limits', () => {
  const tiers = [{ upToNotional: '50000', maxLeverage: 25 }, { upToNotional: '100000', maxLeverage: 20 }, { upToNotional: '500000', maxLeverage: 15 }];
  it('selects the size tier, including exact decimal boundaries', () => {
    expect(maxInstrumentLeverage(tiers)).toBe(25);
    expect(maxInstrumentLeverage(tiers, '50000')).toBe(25);
    expect(maxInstrumentLeverage(tiers, '50000.000000000000000001')).toBe(20);
    expect(maxInstrumentLeverage(tiers, '120000')).toBe(15);
    expect(maxInstrumentLeverage(tiers, '500001')).toBe(0);
  });
  it('does not invent a maximum for missing or invalid metadata', () => {
    expect(maxInstrumentLeverage(undefined)).toBe(0);
    expect(maxInstrumentLeverage([])).toBe(0);
    expect(maxInstrumentLeverage([{ upToNotional: 'bad', maxLeverage: 100 }])).toBe(0);
    expect(maxInstrumentLeverage([{ upToNotional: '1000', maxLeverage: 2.5 }])).toBe(0);
    expect(maxInstrumentLeverage(tiers, 'NaN')).toBe(0);
  });
});
