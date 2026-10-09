import { describe, expect, it } from 'vitest';
import { planPositionAddition, planPositionReduction } from './position-addition.ts';

const position = { quantity: '0.01', lockedMarginMinor: '12000000000', markPrice: '60000', leverage: '5', marginCurrency: 'USDT' as const };
describe('position addition decimal safety', () => {
  it.each(['0.000025', '1.234567890123456789', '999.999999999999999999'])('preserves the explicit quantity %s without rounding', (quantityInput) => {
    const plan = planPositionAddition({ mode: 'quantity', quantityInput, percent: 25, freeMinor: '99999999999999999999999999', position });
    expect(plan.quantity).toBe(quantityInput);
  });
  it('floors percentage sizing to 18 decimals without exceeding the selected budget', () => {
    const plan = planPositionAddition({ mode: 'percent', quantityInput: '', percent: 25, freeMinor: '10000000000', position });
    expect(plan.quantity).toBe('0.002083333333333333');
    expect(plan.marginMinor).toBe('2500000000');
    expect(plan.overBudget).toBe(false);
    expect(plan.totalQuantity).toBe('0.012083333333333333');
  });
  it('does not understate a fractional minor-unit margin requirement', () => {
    const plan = planPositionAddition({ mode: 'quantity', quantityInput: '0.000000000000000001', percent: 25, freeMinor: '0', position });
    expect(plan.marginMinor).toBe('1');
    expect(plan.overBudget).toBe(true);
  });
  it('uses an explicit FX rate for INR price-based estimation and refuses missing rates', () => {
    const basis = { ...position, lockedMarginMinor: null, marginCurrency: 'INR' as const, settlementCurrencyAvgPrice: '83.5' };
    expect(planPositionAddition({ mode: 'quantity', quantityInput: '0.01', percent: 25, freeMinor: '2000000', position: basis }).marginMinor).toBe('1002000');
    expect(planPositionAddition({ mode: 'quantity', quantityInput: '0.01', percent: 25, freeMinor: '2000000', position: { ...basis, settlementCurrencyAvgPrice: null } }).valid).toBe(false);
  });
  it.each(['1e-5', '-1', 'NaN', '0.0000000000000000001'])('rejects invalid or unsupported precision %s', (quantityInput) => {
    expect(planPositionAddition({ mode: 'quantity', quantityInput, percent: 25, freeMinor: '10000000000', position }).valid).toBe(false);
  });
});

describe('partial exit decimal safety', () => {
  it('preserves tiny quantities and calculates remaining size without four-decimal rounding', () => {
    const result = planPositionReduction({ mode: 'quantity', quantityInput: '0.000000000000000001', percent: 25, position });
    expect(result.valid).toBe(true);
    expect(result.quantity).toBe('0.000000000000000001');
    expect(result.remainingQuantity).toBe('0.009999999999999999');
    expect(result.marginMinor).toBe('0');
  });
  it.each(['', '-0.001', '1e-3', '0.01', '0.02', '0.0000000000000000001'])('blocks invalid or full/oversized partial exit %s', (quantityInput) => {
    expect(planPositionReduction({ mode: 'quantity', quantityInput, percent: 25, position }).valid).toBe(false);
  });
  it('keeps percentage mode available with an exact preview', () => {
    expect(planPositionReduction({ mode: 'percent', quantityInput: '', percent: 25, position })).toEqual({
      valid: true, quantity: '0.0025', remainingQuantity: '0.0075', marginMinor: '3000000000',
    });
  });
});
