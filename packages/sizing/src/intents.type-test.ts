// Type-level acceptance for T03.1, part two — the EXHAUSTIVE side of the proof.
//
// `intents.test.ts` proves the two known-bad literals are rejected, one
// `@ts-expect-error` at a time. That catches a regression only if someone
// remembered to write the case. This file closes the other half: it pins the
// reachable mode set on each side to an exact list, so ANY widening of the buy
// union fails the build even though no new bad literal was written for it.
//
// There are no runtime assertions here by design. The assertions are discharged
// by `tsc --build`, which is also how they are enforced in CI (`npm run verify`
// typechecks before it tests). Verified to bite on 2026-09-07 by temporarily
// adding a `sell_all` member to `BuyIntent`: the build failed here at
// `BuyModesAreExactlyTheFive` and `BuyCannotBeSellAll`, and in `size.ts`.

import type { Intent } from './intents.js';

/** Compiles only when `T` is exactly `true`. */
type Expect<T extends true> = T;

/**
 * Invariant type equality. The function-wrapper trick is deliberate: a plain
 * `A extends B ? true : false` would accept a NARROWER `A`, so a buy union that
 * had lost `pct_free` would still pass. This form accepts only exact equality.
 */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

/** The modes reachable on each side, read back off the union itself. */
export type BuySideModes = Extract<Intent, { side: 'buy' }>['mode'];
export type SellSideModes = Extract<Intent, { side: 'sell' }>['mode'];

// The headline assertions. Exact sets, so both widening and narrowing fail.
export type BuyModesAreExactlyTheFive = Expect<Equals<
  BuySideModes,
  'quote_amount' | 'base_quantity' | 'pct_allocated' | 'pct_equity' | 'pct_free'
>>;

export type SellModesAreExactlyTheFour = Expect<Equals<
  SellSideModes,
  'quote_amount' | 'base_quantity' | 'pct_position' | 'sell_all'
>>;

// The two specific exclusions the phase doc names, stated directly so a failure
// reads as the rule that broke rather than as a set mismatch.
export type BuyCannotBePctPosition = Expect<Equals<Extract<BuySideModes, 'pct_position'>, never>>;
export type BuyCannotBeSellAll = Expect<Equals<Extract<BuySideModes, 'sell_all'>, never>>;

// The exclusion is asymmetric, not a mode missing from the whole union: a SELL
// can use both. Without these two, deleting `sell_all` everywhere would pass.
export type SellCanBePctPosition = Expect<Equals<Extract<SellSideModes, 'pct_position'>, 'pct_position'>>;
export type SellCanBeSellAll = Expect<Equals<Extract<SellSideModes, 'sell_all'>, 'sell_all'>>;

/** The sell-side mirror of `intents.test.ts`: buy-only bases are not sellable. */
export function rejectedSellIntents(): readonly unknown[] {
  // @ts-expect-error pct_allocated is a buy-side basis; a sell sizes from the position held.
  const a: Extract<Intent, { side: 'sell' }> = { asset: 'BTC', orderType: 'market', side: 'sell', mode: 'pct_allocated', percent: { basisPoints: 2000 } };
  // @ts-expect-error pct_free is a buy-side basis: free quote balance cannot size a sell of an asset.
  const b: Extract<Intent, { side: 'sell' }> = { asset: 'BTC', orderType: 'market', side: 'sell', mode: 'pct_free', percent: { basisPoints: 2000 } };
  // @ts-expect-error pct_equity is a buy-side basis.
  const c: Extract<Intent, { side: 'sell' }> = { asset: 'BTC', orderType: 'market', side: 'sell', mode: 'pct_equity', percent: { basisPoints: 2000 } };
  return [a, b, c];
}
