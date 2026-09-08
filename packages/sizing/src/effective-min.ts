// Effective minimum quantity — plan/phase-03 T03.3, from 09 F6.
//
// The documented minimum for a market is a lie of omission. The real floor is
// the MAXIMUM of four things, because a quantity must clear every one of them:
//
//   effective_min = max( min_quantity,
//                        10^-quantity_precision,   // precision itself is a floor
//                        step,                     // and so is the step
//                        min_market_orders_qty? )  // market orders only, if present
//
// The case that proves it: DOGEINR reports `min_quantity` 0.001, but its step is
// 1 and its precision is 0, so the smallest tradable quantity is 1 whole DOGE —
// a thousand times the documented minimum. Reading `min_quantity` alone would
// size an order the venue then rejects, per account, mid-fan-out.

import { cmp, max, scaledFromString } from '@tradex/money';
import type { Scaled } from '@tradex/money';
import type { MarketRules } from '@tradex/exchange';
import { nat, scaleAtLeast } from './decimal.js';

/**
 * 10^-precision as a Scaled, e.g. precision 5 -> 0.00001.
 *
 * The scale is widened to the nearest one money supports, because a precision of
 * 11 has no scale of its own; 10^-11 held at scale 12 is the same number.
 */
export function precisionFloor(precision: number): Scaled {
  if (precision === 0) return scaledFromString('1', 0);
  const scale = scaleAtLeast(precision);
  return { v: 10n ** BigInt(scale - precision), scale };
}

/**
 * The largest of the four minimums, at the market's quantity precision.
 *
 * `orderType` matters: `min_market_orders_qty` only binds a market order, and it
 * is absent from every live market anyway (09 F6), so it is folded in only when
 * present and only for a market order.
 */
export function effectiveMinQty(rules: MarketRules, orderType: 'market' | 'limit'): Scaled {
  const step = nat(rules.quantityStep);
  const minQty = nat(rules.minQuantity);
  let floor = max(max(minQty, precisionFloor(rules.quantityPrecision)), step);
  if (orderType === 'market' && rules.minMarketQuantity !== null) {
    floor = max(floor, nat(rules.minMarketQuantity));
  }
  return floor;
}

/** True when `qty` is at or above the effective minimum. */
export const meetsEffectiveMin = (qty: Scaled, min: Scaled): boolean => cmp(qty, min) >= 0;
