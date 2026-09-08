// Rounding and holdback — plan/phase-03 T03.4 and T03.5.
//
// ROUNDING is always down, both sides, no configurable mode (T03.4). Rounding a
// buy quantity UP would spend more than the budget; rounding a sell UP would try
// to sell more than is held. Floor is the only safe direction for both, so the
// direction is not a parameter — a "nearest" mode is a bug waiting for a
// production incident, and the property suite (T03.9) fails if it is introduced.
//
// HOLDBACK reserves fee + TDS + a safety margin out of a balance-derived budget
// before it becomes quantity, so notional + fee + TDS never exceeds the balance
// (T03.5). The TDS rate is asymmetric and this is the reversal 11 F4 found: an
// INR market attracts NO TDS at order time, a crypto-to-crypto (USDT) market
// attracts 1%. Getting this backwards over-reserves on INR and under-reserves on
// USDT — the second leaves an order the venue rejects for insufficient balance.

import { floorToStep, mul, scaledFromString, sub } from '@tradex/money';
import type { Scaled } from '@tradex/money';
import type { MarketRules } from '@tradex/exchange';
import { floorToPlaces, nat, toStr } from './decimal.js';

/** Assumed taker fee until a real fill replaces it in Phase 07 (23, D-). */
export const ASSUMED_TAKER_FEE = '0.005';
/** Safety margin on top of fee + TDS, so a tick of slippage does not overspend. */
export const SAFETY_MARGIN = '0.001';
/** TDS is 1% on a crypto-to-crypto market and 0 on an INR market (11 F4). */
export const TDS_RATE_C2C = '0.01';
export const TDS_RATE_INR = '0';

/** The holdback rates that apply to a buy on this market's quote currency. */
export function holdbackRates(quote: string): { feeRate: string; tdsRate: string; safety: string } {
  return {
    feeRate: ASSUMED_TAKER_FEE,
    tdsRate: quote === 'INR' ? TDS_RATE_INR : TDS_RATE_C2C,
    safety: SAFETY_MARGIN,
  };
}

/**
 * Reduce a quote budget by the total holdback, flooring the result to the quote
 * scale. Rounding the *reserve* down would under-reserve, so the spendable
 * figure is floored — the reserved side keeps the spare sub-unit.
 */
export function applyHoldback(budgetMinor: Scaled, quote: string): { spendableMinor: Scaled; totalRate: string } {
  const { feeRate, tdsRate, safety } = holdbackRates(quote);
  // keep = 1 - fee - tds - safety, at a rate scale wide enough to be exact.
  const rateScale = 6;
  const one = scaledFromString('1', rateScale);
  const keep = sub(sub(sub(one, scaledFromString(feeRate, rateScale)),
    scaledFromString(tdsRate, rateScale)), scaledFromString(safety, rateScale));
  const totalRate = toStr(sub(one, keep));
  return { spendableMinor: mul(budgetMinor, keep, budgetMinor.scale), totalRate };
}

/**
 * Floor a raw quantity to the market's step AND its precision, in that order.
 *
 * Both are needed, because three live INR markets carry contradictory metadata:
 * BRETTINR has step 0.1 with quantity_precision 0, SAPIENINR step 0.001 with
 * precision 1, NIBIINR step 0.0001 with precision 0 (found by the 999-market
 * property sweep, 2026-09-06). A quantity cannot be simultaneously a multiple
 * of 0.1 and an integer, so the venue's own precision is the binding constraint
 * and the step floor must come first — flooring to precision first could land on
 * a non-step multiple, and flooring to step alone can leave sub-precision digits.
 * DOGEINR (step 1, precision 0) is unaffected: both floors agree.
 */
export function floorQuantity(rawQty: Scaled, rules: MarketRules): Scaled {
  const stepped = floorToStep(rawQty, nat(rules.quantityStep));
  return floorToPlaces(stepped, rules.quantityPrecision);
}
