import { expect, it } from 'vitest';
import { futuresRequiredLeveragedMinor, futuresSpendableNotional } from './futures-cost.js';
it.each(['1','4','20','100','200'])('reserves fees on notional, GST and headroom at %s leverage', leverage => {
  const cost = { leverage, takerFeeRate: '0.0006' };
  const free = 10000000000n, budget = free * BigInt(leverage);
  const notional = futuresSpendableNotional(budget,cost);
  expect(futuresRequiredLeveragedMinor(notional,cost)).toBeLessThanOrEqual(budget * 99n / 100n);
  expect(notional).toBeLessThan(budget);
});
it('rejects an explicit all-margin quantity that leaves nothing for entry fees', () => {
  expect(futuresRequiredLeveragedMinor(10000000000n,{ leverage:'100',takerFeeRate:'0.0006' })).toBe(10708000000n);
});
it('rounds fractional fee requirements upward even on huge values', () => {
  const n = 900719925474099312345n;
  const required = futuresRequiredLeveragedMinor(n,{ leverage:'3',takerFeeRate:'0.0006' });
  expect(required).toBe((n * 1002124n + 999999n) / 1000000n);
});
it('retains headroom even for a zero-fee instrument', () => {
  expect(futuresSpendableNotional(10000n,{ leverage:'5',takerFeeRate:'0' })).toBe(9900n);
});
