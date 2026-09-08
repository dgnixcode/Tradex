// Type-level proof that the impossible buy modes cannot be written (T03.1).
//
// `@ts-expect-error` is the assertion: if the line below ever COMPILES, the
// comment becomes an unused-directive error and the file fails. That is the
// whole trick — the test fails when the type stops forbidding, not when someone
// remembers to check. A corrupted BuyIntent (a `sell_all` member appearing on
// the buy side, as happened once) turns these into compile failures here.

import { describe, expect, it } from 'vitest';
import type { BuyIntent } from './intents.js';
import { basisOf, needsLiveBasis } from './intents.js';

// These compile ONLY because the modes are legal buys.
const legalBuys: BuyIntent[] = [
  { asset: 'BTC', side: 'buy', orderType: 'market', mode: 'quote_amount', quoteAmountMinor: '10000' },
  { asset: 'BTC', side: 'buy', orderType: 'market', mode: 'base_quantity', baseQuantity: '0.001' },
  { asset: 'BTC', side: 'buy', orderType: 'market', mode: 'pct_allocated', percent: { basisPoints: 2000 } },
  { asset: 'BTC', side: 'buy', orderType: 'market', mode: 'pct_equity', percent: { basisPoints: 2000 } },
  { asset: 'BTC', side: 'buy', orderType: 'market', mode: 'pct_free', percent: { basisPoints: 2000 } },
  { asset: 'BTC', side: 'buy', orderType: 'limit', limitPrice: '100', mode: 'pct_allocated', percent: { basisPoints: 500 } },
];

// @ts-expect-error a buy cannot be sell_all — there is nothing to sell
const buySellAll: BuyIntent = { asset: 'BTC', side: 'buy', orderType: 'market', mode: 'sell_all' };
// @ts-expect-error a buy cannot be pct_position — no position exists yet
const buyPctPosition: BuyIntent = { asset: 'BTC', side: 'buy', orderType: 'market', mode: 'pct_position', percent: { basisPoints: 2000 } };
// @ts-expect-error a buy cannot carry the sell side at all
const wrongSide: BuyIntent = { asset: 'BTC', side: 'sell', orderType: 'market', mode: 'pct_allocated', percent: { basisPoints: 2000 } };
void buySellAll; void buyPctPosition; void wrongSide;

describe('the intent model forbids the impossible combinations', () => {
  it('accepts exactly the six legal buy shapes', () => {
    expect(legalBuys).toHaveLength(6);
    expect(legalBuys.every((i) => i.side === 'buy')).toBe(true);
  });

  it('resolves the basis for every percentage mode', () => {
    expect(basisOf(legalBuys[2] as never)).toBe('allocated');
    expect(basisOf(legalBuys[3] as never)).toBe('equity');
    expect(basisOf(legalBuys[4] as never)).toBe('free');
    expect(basisOf(legalBuys[0] as never)).toBeNull();
  });

  it('marks which intents need live account state', () => {
    expect(needsLiveBasis(legalBuys[0] as never)).toBe(false); // quote_amount: no live basis
    expect(needsLiveBasis(legalBuys[2] as never)).toBe(false); // pct_allocated: stored at onboarding
    expect(needsLiveBasis(legalBuys[3] as never)).toBe(true); // equity: live
    expect(needsLiveBasis(legalBuys[4] as never)).toBe(true); // free: live
  });
});
