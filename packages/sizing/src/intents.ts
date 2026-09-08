// Intent model Ã¢â‚¬â€ plan/phase-03 T03.1.
//
// An intent is what the customer asked for, before it meets a market. The type
// splits buy from sell so the impossible combinations cannot be written:
// `pct_position` and `sell_all` are meaningless for a buy (you cannot buy a
// percentage of a position you do not yet hold), and the type system, not a
// runtime check, is what forbids them Ã¢â‚¬â€ see intents.type-test.ts.
//
// Percentage modes record WHICH basis they resolved against, and that basis
// travels all the way into the `Sized` output, because "20%" is ambiguous until
// you know 20% of what: allocated capital, live equity, or free balance. The
// owner's worked example (09 F7) is `pct_allocated`, and rows 1/2/3 are the same
// 20% producing three different quantities Ã¢â‚¬â€ the basis is the whole story.

import type { OrderType } from '@tradex/exchange';

/** What a percentage is taken of. Part of the audit trail, never inferred later. */
export type SizingBasis =
  | 'allocated' // the capital the customer typed at onboarding (09 F4)
  | 'equity' // live: free + value of holdings in the quote currency
  | 'free' // live: spendable balance in the quote currency
  | 'position'; // live: the quantity currently held of this asset

/** A percentage expressed in basis points, so 20% is 2000 and stays an integer. */
export interface Percent {
  readonly basisPoints: number;
}

interface Common {
  readonly asset: string;
  readonly orderType: OrderType;
  /** Required for a limit order, absent for a market order. */
  readonly limitPrice?: string | undefined;
}

/** Buy intents. No position-relative mode: there is no position to be relative to. */
export type BuyIntent = Common & (
  | { readonly side: 'buy'; readonly mode: 'quote_amount'; readonly quoteAmountMinor: string }
  | { readonly side: 'buy'; readonly mode: 'base_quantity'; readonly baseQuantity: string }
  | { readonly side: 'buy'; readonly mode: 'pct_allocated'; readonly percent: Percent }
  | { readonly side: 'buy'; readonly mode: 'pct_equity'; readonly percent: Percent }
  | { readonly side: 'buy'; readonly mode: 'pct_free'; readonly percent: Percent }
);

/** Sell intents. `sell_all` and `pct_position` are sell-only by construction. */
export type SellIntent = Common & (
  | { readonly side: 'sell'; readonly mode: 'quote_amount'; readonly quoteAmountMinor: string }
  | { readonly side: 'sell'; readonly mode: 'base_quantity'; readonly baseQuantity: string }
  | { readonly side: 'sell'; readonly mode: 'pct_position'; readonly percent: Percent }
  | { readonly side: 'sell'; readonly mode: 'sell_all' }
);

export type Intent = BuyIntent | SellIntent;

/** True when the intent's size depends on live account state (basis or position). */
export function needsLiveBasis(intent: Intent): boolean {
  return intent.mode === 'pct_equity'
    || intent.mode === 'pct_free'
    || intent.mode === 'pct_position'
    || intent.mode === 'sell_all';
}

/** The basis a percentage buy/sell resolves against, for the audit record. */
export function basisOf(intent: Intent): SizingBasis | null {
  switch (intent.mode) {
    case 'pct_allocated': return 'allocated';
    case 'pct_equity': return 'equity';
    case 'pct_free': return 'free';
    case 'pct_position': return 'position';
    default: return null;
  }
}
