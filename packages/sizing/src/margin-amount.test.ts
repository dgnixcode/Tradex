import { describe, expect, it } from 'vitest';
import { parseMarginAmount } from './margin-amount.js';
describe('exact margin amounts', () => {
  it('keeps native rupees and eight-place USDT exact', () => {
    expect(parseMarginAmount('00500.00', 'INR')).toEqual({ minor: 50000n, amount: '500' });
    expect(parseMarginAmount('500.01', 'INR')).toEqual({ minor: 50001n, amount: '500.01' });
    expect(parseMarginAmount('0.00000001', 'USDT')).toEqual({ minor: 1n, amount: '0.00000001' });
  });
  it.each(['0', '-500', '+500', '5e2', '500.001', 'NaN', '', '500,00'])('rejects an invalid native INR amount %s', amount => {
    expect(() => parseMarginAmount(amount, 'INR')).toThrow();
  });
});
