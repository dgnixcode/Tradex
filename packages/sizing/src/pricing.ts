// Order-book pricing and the market-order slippage guard — plan/phase-04 T04.10,
// T04.11 (both moved here from the deferred Phase 10).
//
// Two responsibilities, both operating on the venue-neutral OrderBook port type
// so nothing here imports the CoinDCX adapter (the ADAPTER-BOUNDARY rule):
//
//   T04.10  the execution PRICE of a market order comes from the order book, not
//           the ticker. Best ask prices a buy, best bid prices a sell. `01`
//           established the ticker is CDN-cached and stale by an unknown amount,
//           so it must never price an order. This is the only pricing path.
//
//   T04.11  a market order is refused when the visible book would fill it far
//           from the touch — either because the SPREAD is already wide, or
//           because walking the depth for the intended quantity gives a
//           volume-weighted price that DEVIATES past the tolerance (default
//           0.5%). Insufficient visible depth is the extreme case of the latter.
//
// THE READ/DISPLAY BOUNDARY (ARCHITECTURE §6a). We may READ CoinDCX's book to
// DECIDE, but the customer-facing warning is QUALITATIVE — "the spread is wide,
// use a limit order" — and carries no derived number. The basis-point figures
// this module computes are for the child_order row (spread_bp, slippage_bp) and
// the refusal decision, never for a sentence shown to a customer. So the verdict
// separates `message` (qualitative, safe to show) from `spreadBp`/`slippageBp`
// (numeric, for persistence only). T04.7's older mention of showing "measured
// spread and round-trip estimate" is superseded by this boundary.
//
// Everything is exact-decimal arithmetic through @tradex/money. A basis-point
// figure is `div(difference, base, 4).v`: a ratio of 0.0081 held at scale 4 is
// {v: 81, scale: 4}, so `.v` is 81 basis points already, floored — no
// multiply-by-10000, and the flooring makes the guard lenient toward passing,
// which is the safe direction for a tolerance comparison.

import { add, cmp, div, isZero, min, mul, sub } from '@tradex/money';
import type { Scaled } from '@tradex/money';
import type { OrderBook, OrderSide } from '@tradex/exchange';
import { GUARD_SCALE, nat, toStr } from './decimal.js';

/** The default deviation a market order may fill away from the touch: 0.5% = 50 bp. */
export const DEFAULT_SLIPPAGE_TOLERANCE_BP = 50;

const ZERO_GUARD: Scaled = { v: 0n, scale: GUARD_SCALE };

/** Where a market order's price came from. Persisted as child_order.price_source. */
export type PriceSourceTag = 'book_ask' | 'book_bid';

export interface TouchPrice {
  /** Best ask for a buy, best bid for a sell. The plain decimal, as the book had it. */
  readonly price: string;
  readonly source: PriceSourceTag;
  /** The book's own observation time, carried onto the order (T04.5). */
  readonly observedAtMs: number;
}

/**
 * The execution price for a market order on this book. Best ask prices a buy,
 * best bid prices a sell. Returns null when the relevant side is empty — a book
 * with no asks cannot price a buy, and that is a refusal the caller raises, not a
 * guess this function makes.
 *
 * The book is assumed already sorted (asks ascending, bids descending) by the
 * adapter's `mapOrderBook`; this never re-reads index 0 of an unsorted side.
 */
export function touchPrice(book: OrderBook, side: OrderSide): TouchPrice | null {
  if (side === 'buy') {
    const best = book.asks[0];
    return best === undefined ? null : { price: best.price, source: 'book_ask', observedAtMs: book.observedAtMs };
  }
  const best = book.bids[0];
  return best === undefined ? null : { price: best.price, source: 'book_bid', observedAtMs: book.observedAtMs };
}

/**
 * The bid/ask spread in whole basis points, or null if either side is empty.
 *
 * Relative to the mid, the symmetric convention: 2·(ask−bid)/(ask+bid), which
 * avoids computing and re-rounding a mid price. Floored, so a book right on a
 * boundary reads as the lower figure.
 */
export function spreadBp(book: OrderBook): string | null {
  const ask = book.asks[0];
  const bid = book.bids[0];
  if (ask === undefined || bid === undefined) return null;
  const a = nat(ask.price);
  const b = nat(bid.price);
  const diff = sub(a, b);
  if (cmp(diff, { v: 0n, scale: diff.scale }) <= 0) return '0';
  const twiceDiff = mul(diff, nat('2'), GUARD_SCALE);
  const sum = add(a, b);
  return String(div(twiceDiff, sum, 4).v);
}

export type SlippageCode = 'SPREAD_TOO_WIDE' | 'EXCESSIVE_SLIPPAGE' | 'INSUFFICIENT_DEPTH';

export type SlippageVerdict =
  | {
      readonly ok: true;
      /** Spread in whole basis points, for persistence. */
      readonly spreadBp: string;
      /** VWAP deviation from the touch in whole basis points, for persistence. */
      readonly slippageBp: string;
      /** True when the spread is wide enough to warrant the qualitative ticket warning. */
      readonly spreadIsWide: boolean;
    }
  | {
      readonly ok: false;
      readonly code: SlippageCode;
      readonly spreadBp: string;
      /** Null only when depth ran out before a VWAP could be computed. */
      readonly slippageBp: string | null;
      /** QUALITATIVE — safe to show a customer, contains no derived number. */
      readonly message: string;
    };

/** The volume-weighted average fill price walking the book, or null if depth is short. */
function vwap(levels: readonly { price: string; quantity: string }[], target: Scaled): Scaled | null {
  let remaining = target;
  let cost = ZERO_GUARD;
  for (const level of levels) {
    if (isZero(remaining)) break;
    const lvlQty = nat(level.quantity);
    const take = min(remaining, lvlQty);
    cost = add(cost, mul(take, nat(level.price), GUARD_SCALE));
    remaining = sub(remaining, take);
  }
  if (!isZero(remaining) && cmp(remaining, { v: 0n, scale: remaining.scale }) > 0) return null;
  return div(cost, target, GUARD_SCALE);
}

/**
 * The market-order slippage guard (T04.11). Applies ONLY to market orders — a
 * limit order has a fixed price and cannot slip — so the planner calls this only
 * for `order_type = 'market'`.
 *
 * Two independent refusal conditions, spread first because it is the cheaper
 * signal and the one the customer can see coming:
 *
 *   1. the spread already exceeds the tolerance — the book is dislocated, and any
 *      market order pays at least half the spread;
 *   2. the volume-weighted fill for the intended quantity deviates past the
 *      tolerance from the touch, which catches a tight top-of-book sitting on
 *      thin depth. Running out of depth entirely is the extreme of this.
 *
 * `spreadIsWide` on a passing verdict drives the qualitative ticket warning; it
 * is true below the refusal threshold too, so the customer is warned before they
 * are refused.
 */
export function marketOrderSlippage(
  book: OrderBook,
  side: OrderSide,
  quantity: string,
  toleranceBp: number = DEFAULT_SLIPPAGE_TOLERANCE_BP,
): SlippageVerdict {
  if (!Number.isInteger(toleranceBp) || toleranceBp <= 0) {
    throw new Error(`slippage tolerance must be a positive whole number of basis points, got ${toleranceBp}`);
  }
  const touch = touchPrice(book, side);
  const spread = spreadBp(book);
  if (touch === null || spread === null) {
    return {
      ok: false,
      code: 'INSUFFICIENT_DEPTH',
      spreadBp: spread ?? '0',
      slippageBp: null,
      message: 'There is not enough visible depth on this market to price a market order safely. Use a limit order.',
    };
  }

  const tolerance = BigInt(toleranceBp);
  const spreadIsWide = BigInt(spread) >= tolerance;

  // 1. spread already too wide.
  if (BigInt(spread) > tolerance) {
    return {
      ok: false,
      code: 'SPREAD_TOO_WIDE',
      spreadBp: spread,
      slippageBp: null,
      message: 'The spread on this market is wide right now; a market order would pay a poor price. '
        + 'Place a limit order instead, or wait for the spread to narrow.',
    };
  }

  // 2. walk the depth for the intended quantity.
  const target = nat(quantity);
  if (cmp(target, { v: 0n, scale: target.scale }) <= 0) {
    // A zero/negative quantity is not this guard's problem — legalise() owns it.
    return { ok: true, spreadBp: spread, slippageBp: '0', spreadIsWide };
  }
  const levels = side === 'buy' ? book.asks : book.bids;
  const fill = vwap(levels, target);
  if (fill === null) {
    return {
      ok: false,
      code: 'INSUFFICIENT_DEPTH',
      spreadBp: spread,
      slippageBp: null,
      message: 'This order is larger than the visible depth on the book; a market order could fill far from the '
        + 'quoted price. Use a limit order, or reduce the size.',
    };
  }

  const touchScaled = nat(touch.price);
  // Deviation is always the adverse direction: a buy fills ABOVE the ask, a sell
  // BELOW the bid. Both are non-negative because the levels are sorted.
  const deviation = side === 'buy' ? sub(fill, touchScaled) : sub(touchScaled, fill);
  const devNonNeg = cmp(deviation, { v: 0n, scale: deviation.scale }) > 0 ? deviation : { v: 0n, scale: deviation.scale };
  const slippage = String(div(devNonNeg, touchScaled, 4).v);

  if (BigInt(slippage) > tolerance) {
    return {
      ok: false,
      code: 'EXCESSIVE_SLIPPAGE',
      spreadBp: spread,
      slippageBp: slippage,
      message: 'A market order this size would fill well away from the quoted price on the current book. '
        + 'Place a limit order to control the price.',
    };
  }

  return { ok: true, spreadBp: spread, slippageBp: slippage, spreadIsWide };
}

/** The touch price as a Scaled, for the caller that feeds it straight into sizing. */
export const touchScaledOf = (touch: TouchPrice): string => toStr(nat(touch.price));
