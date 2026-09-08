// Pricing and slippage math — plan/phase-04 T04.10, T04.11.
//
// The 04-slippage-guard check asserts the live-shaped acceptance (DOGEINR
// refused, BTCUSDT passes). These unit tests lock the arithmetic itself: touch
// selection by side, the spread formula, the adverse-deviation SIGN, and the
// depth-exhaustion path — a sign error here would silently pass a bad market
// order, which is exactly the failure the phase mandate forbids.

import { describe, expect, it } from 'vitest';
import type { OrderBook } from '@tradex/exchange';
import {
  DEFAULT_SLIPPAGE_TOLERANCE_BP, marketOrderSlippage, spreadBp, touchPrice,
} from './pricing.js';

const book = (
  asks: [string, string][],
  bids: [string, string][],
  observedAtMs = 1_725_000_000_000,
): OrderBook => ({
  market: { asset: 'BTC', quote: 'INR' },
  asks: asks.map(([price, quantity]) => ({ price, quantity })),
  bids: bids.map(([price, quantity]) => ({ price, quantity })),
  observedAtMs,
});

describe('touchPrice', () => {
  it('prices a buy at the best ask and a sell at the best bid', () => {
    const b = book([['100', '5'], ['101', '5']], [['99', '5'], ['98', '5']]);
    expect(touchPrice(b, 'buy')).toEqual({ price: '100', source: 'book_ask', observedAtMs: b.observedAtMs });
    expect(touchPrice(b, 'sell')).toEqual({ price: '99', source: 'book_bid', observedAtMs: b.observedAtMs });
  });

  it('returns null when the relevant side is empty', () => {
    expect(touchPrice(book([], [['99', '5']]), 'buy')).toBeNull();
    expect(touchPrice(book([['100', '5']], []), 'sell')).toBeNull();
  });
});

describe('spreadBp', () => {
  it('is zero on a one-tick-wide book at high price', () => {
    // ask 100, bid 99.99 → 2*0.01/199.99 ≈ 1.0 bp, floored to 1.
    expect(spreadBp(book([['100', '1']], [['99.99', '1']]))).toBe('1');
  });

  it('is ~50 bp when ask is 0.5% above bid', () => {
    // ask 100.25, bid 99.75 → 2*0.5/200 = 50 bp exactly.
    expect(spreadBp(book([['100.25', '1']], [['99.75', '1']]))).toBe('50');
  });

  it('is null when a side is missing', () => {
    expect(spreadBp(book([], [['99', '1']]))).toBeNull();
  });
});

describe('marketOrderSlippage', () => {
  it('passes a tight, deep book and reports the small spread', () => {
    const v = marketOrderSlippage(book([['100', '1000']], [['99.99', '1000']]), 'buy', '10');
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.slippageBp).toBe('0'); // fills entirely at the touch
      expect(v.spreadIsWide).toBe(false);
    }
  });

  it('refuses when the spread alone exceeds the tolerance', () => {
    // ask 101, bid 99 → ~200 bp, well over the 50 bp default.
    const v = marketOrderSlippage(book([['101', '1000']], [['99', '1000']]), 'buy', '1');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('SPREAD_TOO_WIDE');
      // The customer-facing message must carry NO derived number (ARCHITECTURE §6a).
      expect(v.message).not.toMatch(/\d/);
    }
  });

  it('refuses when walking depth deviates past the tolerance (buy fills ABOVE ask)', () => {
    // Tight touch, thin top: 1 @ 100 then a wall at 105. Buying 10 pays a VWAP
    // far above the 100 touch → excessive slippage, not a spread problem.
    const v = marketOrderSlippage(book([['100', '1'], ['105', '1000']], [['99.99', '1000']]), 'buy', '10');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('EXCESSIVE_SLIPPAGE');
      expect(BigInt(v.slippageBp ?? '0')).toBeGreaterThan(BigInt(DEFAULT_SLIPPAGE_TOLERANCE_BP));
      expect(v.message).not.toMatch(/\d/);
    }
  });

  it('refuses when depth runs out before the quantity is filled', () => {
    const v = marketOrderSlippage(book([['100', '1']], [['99.99', '1000']]), 'buy', '10');
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.code).toBe('INSUFFICIENT_DEPTH');
      expect(v.slippageBp).toBeNull();
    }
  });

  it('measures a sell deviation as filling BELOW the bid', () => {
    // Selling into 1 @ 99.99 then a hole down at 95: VWAP well below the 99.99 bid.
    const v = marketOrderSlippage(book([['100', '1000']], [['99.99', '1'], ['95', '1000']]), 'sell', '10');
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.code).toBe('EXCESSIVE_SLIPPAGE');
  });

  it('rejects a non-positive tolerance', () => {
    expect(() => marketOrderSlippage(book([['100', '1']], [['99', '1']]), 'buy', '1', 0)).toThrow();
  });
});
