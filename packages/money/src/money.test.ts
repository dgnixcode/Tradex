// packages/money — the worked examples from 09-sizing-allocation-rounding.md F7
// are the real acceptance criteria here. If these eight rows do not reproduce
// exactly, the sizing layer built on top of this cannot be trusted.

import { describe, expect, it } from 'vitest';
import { Money, Price, Qty, Rate } from './money.js';
import { MoneyError, floorToStep, scaledFromString, toPlainString } from './scaled.js';
import { formatBasisPoints, formatQty, groupIndian } from './format.js';

describe('construction refuses anything lossy', () => {
  it('refuses a JS number', () => {
    // @ts-expect-error — the type forbids it; the runtime must too, because the
    // float damage happens before the constructor is reached.
    expect(() => Money.of(19870.61, 'INR')).toThrow(MoneyError);
  });

  it('refuses exponent notation', () => {
    expect(() => Money.of('1.9e4', 'INR')).toThrow(/exponent/);
    expect(() => Qty.of('7.009e-9', 8)).toThrow(/exponent/);
  });

  it('refuses more decimals than the scale can hold, rather than truncating', () => {
    expect(() => Money.of('10.001', 'INR')).toThrow(/refusing to truncate/);
    expect(() => Qty.of('0.000001', 5)).toThrow(/refusing to truncate/);
  });

  it('accepts exact values at the scale boundary', () => {
    expect(Money.of('19870.59', 'INR').toMinor()).toBe('1987059');
    expect(Money.of('196.66082', 'USDT').toMinor()).toBe('19666082000');
  });
});

describe('cross-currency arithmetic is refused', () => {
  it('will not add INR to USDT', () => {
    expect(() => Money.of('100', 'INR').plus(Money.of('1', 'USDT'))).toThrow(/explicit fx snapshot/);
  });
});

describe('rounding is always down', () => {
  it('floors a quantity to step, never up', () => {
    // DOGEINR: step 1, precision 0 — 112.0349 DOGE must become 112, not 113.
    const q = Qty.of('112', 0);
    expect(q.floorToStep(Qty.of('1', 0)).toPlain()).toBe('112');
    // XRPINR: step 0.1 — 68.2385 must become 68.2, not 68.3.
    expect(Qty.of('68.2385', 4).floorToStep(Qty.of('0.1', 1)).toPlain()).toBe('68.2000');
  });

  it('floors negatives toward negative infinity', () => {
    expect(toPlainString(floorToStep(scaledFromString('-1.5', 1), scaledFromString('1', 0)))).toBe('-2.0');
  });
});

describe('09 F7 worked examples reproduce exactly', () => {
  // BTCINR ask 8,077,476.1 (price precision 1), quantity precision 5.
  const btcInrAsk = Price.of('8077476.1', 1);
  const inrHoldback = Rate.one().minus(Rate.ofFraction('0.006')); // 0.5% fee + 0.1% safety
  const twentyPercent = Rate.ofPercent('20');

  const sizeInr = (allocatedMajor: string, price: Price, precision: 5 | 1 | 0) => {
    const budget = Money.of(allocatedMajor, 'INR').timesRate(twentyPercent).timesRate(inrHoldback);
    const qty = budget.dividedByPrice(price, precision);
    return { budget, qty, notional: qty.timesPrice(price, 'INR') };
  };

  it('row 1 — Rs 1,00,000 allocated at 20% fills 0.00246 BTC', () => {
    const r = sizeInr('100000', btcInrAsk, 5);
    expect(r.budget.toPlain()).toBe('19880.00');
    expect(r.qty.toPlain()).toBe('0.00246');
    expect(r.notional.toPlain()).toBe('19870.59');
  });

  it('row 2 — Rs 5,00,000 allocated fills 0.01230 BTC', () => {
    const r = sizeInr('500000', btcInrAsk, 5);
    expect(r.budget.toPlain()).toBe('99400.00');
    expect(r.qty.toPlain()).toBe('0.01230');
    expect(r.notional.toPlain()).toBe('99352.95');
  });

  it('row 3 — Rs 10,00,000 exceeds max_quantity_market 0.0158 and must be refused', () => {
    const r = sizeInr('1000000', btcInrAsk, 5);
    expect(r.qty.toPlain()).toBe('0.02461');
    expect(r.qty.gt(Qty.of('0.0158', 4))).toBe(true); // the refusal condition
  });

  it('row 4 — Rs 500 allocated falls below the Rs 100 min notional', () => {
    const r = sizeInr('500', btcInrAsk, 5);
    expect(r.qty.toPlain()).toBe('0.00001');
    expect(r.notional.toPlain()).toBe('80.77');
    expect(r.notional.lt(Money.of('100', 'INR'))).toBe(true); // the refusal condition
  });

  it('row 5 — XRPINR at step 0.1 fills 68.2 XRP', () => {
    const ask = Price.of('145.665', 3);
    const budget = Money.of('50000', 'INR').timesRate(twentyPercent).timesRate(inrHoldback);
    expect(budget.toPlain()).toBe('9940.00');
    const qty = budget.dividedByPrice(ask, 1).floorToStep(Qty.of('0.1', 1));
    expect(qty.toPlain()).toBe('68.2');
    expect(qty.timesPrice(ask, 'INR').toPlain()).toBe('9934.35');
  });

  it('row 6 — DOGEINR at precision 0 fills 112 whole DOGE', () => {
    const ask = Price.of('8.8724', 4);
    const budget = Money.of('5000', 'INR').timesRate(twentyPercent).timesRate(inrHoldback);
    expect(budget.toPlain()).toBe('994.00');
    const qty = budget.dividedByPrice(ask, 0).floorToStep(Qty.of('1', 0));
    expect(qty.toPlain()).toBe('112');
    expect(qty.timesPrice(ask, 'INR').toPlain()).toBe('993.70');
  });

  it('row 7 — a USDT market holds back 1.6% because a C2C buy also pays 1% TDS', () => {
    const ask = Price.of('81602.00', 2);
    const c2cHoldback = Rate.one().minus(Rate.ofFraction('0.016')); // 0.5% fee + 1% TDS + 0.1%
    const budget = Money.of('1000', 'USDT').timesRate(twentyPercent).timesRate(c2cHoldback);
    expect(budget.toPlain()).toBe('196.80000000');
    const qty = budget.dividedByPrice(ask, 5);
    expect(qty.toPlain()).toBe('0.00241');
    expect(qty.timesPrice(ask, 'USDT').toPlain()).toBe('196.66082000');
  });

  it('row 8 — selling the row-1 holding at the bid returns less than it cost', () => {
    const bid = Price.of('8043561.6', 1);
    const proceeds = Qty.of('0.00246', 5).timesPrice(bid, 'INR');
    expect(proceeds.toPlain()).toBe('19787.16');
    // 0.42% round-trip loss on a flat market, before fees.
    expect(proceeds.lt(Money.of('19870.59', 'INR'))).toBe(true);
  });
});

describe('formatting', () => {
  it('groups INR the Indian way', () => {
    expect(groupIndian('1234567')).toBe('12,34,567');
    expect(groupIndian('100000')).toBe('1,00,000');
    expect(groupIndian('999')).toBe('999');
    expect(groupIndian('1000')).toBe('1,000');
  });

  it('renders precise INR with decimals only when non-zero', () => {
    expect(Money.of('1234567', 'INR').format()).toBe('₹12,34,567');
    expect(Money.of('19870.59', 'INR').format()).toBe('₹19,870.59');
    expect(Money.of('-1234.50', 'INR').format()).toBe('-₹1,234.5');
  });

  it('uses lakh and crore in headline positions', () => {
    expect(Money.of('4218900', 'INR').formatHeadline()).toBe('₹42.18 L');
    expect(Money.of('18400000', 'INR').formatHeadline()).toBe('₹1.84 Cr');
    expect(Money.of('99999', 'INR').formatHeadline()).toBe('₹99,999');
  });

  it('renders a crypto quantity at the market precision, trailing zeros kept', () => {
    expect(Qty.of('0.00246', 5).format('BTC')).toBe('0.00246 BTC');
    expect(Qty.of('112', 0).format('DOGE')).toBe('112 DOGE');
    expect(Qty.of('68.2', 1).format('XRP')).toBe('68.2 XRP');
  });

  it('never emits exponent notation, even for very small quantities', () => {
    const tiny = Qty.of('0.000000070', 9);
    expect(tiny.toPlain()).toBe('0.000000070');
    expect(formatQty(tiny.raw, 'BTC')).not.toMatch(/[eE]/);
  });

  it('renders slippage as signed basis points', () => {
    expect(formatBasisPoints(scaledFromString('0.0008', 4))).toBe('+8bp');
  });
});

describe('the numeric(38,0) round trip', () => {
  it('survives 24 significant digits and one paisa', () => {
    const big = Money.ofMinor('123456789012345678901234', 'INR');
    expect(big.toMinor()).toBe('123456789012345678901234');
    expect(Money.ofMinor('1', 'INR').toPlain()).toBe('0.01');
  });
});
