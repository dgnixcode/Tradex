// Decimal helpers shared across sizing — plan/phase-03.
//
// Market metadata strings do not all fit the market's own precision: DOGEINR
// reports `min_quantity` "0.001" while its `quantity_precision` is 0, so parsing
// min_quantity AT the market precision throws (money refuses to truncate). The
// fix is to parse every venue decimal at its OWN natural scale — the number of
// digits it actually carries — and let the money layer align scales when it
// compares or floors. The effective-minimum maximum then does the right thing:
// max(0.001, step 1) is 1, expressed exactly, with nothing truncated on the way.

import { floorDiv, rescale, scaledFromString } from '@tradex/money';
import type { Scale, Scaled } from '@tradex/money';

/**
 * Intermediate precision for divisions, before the result is floored to a
 * market's step. 12 sits well above any live market's quantity precision (≤6
 * across all 963 mapped markets), and is a member of money's `Scale` union — an
 * arbitrary `precision + n` is not.
 */
export const GUARD_SCALE: Scale = 12;

/**
 * The scales money can represent. Note the gaps: there is no 11, and nothing
 * between 12 and 18. A venue decimal does not respect that union.
 */
export const SUPPORTED_SCALES: readonly Scale[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 18];

/**
 * The narrowest supported scale that can hold `places` decimals exactly.
 *
 * This exists because CoinDCX ships float artefacts in its price bands:
 * `BSVINR.min_price` is 566.6666666666666 (13 places), `SOLVINR.min_price` is
 * 0.11983333333333333 (17), and `BRISE-USDT.min_price` is 1e-11 (11 after
 * expansion). Casting those place-counts straight to `Scale` produces 11, 13,
 * 14, 15, 16 and 17 — none of which money supports — and the 999-market sweep
 * died on `unsupported scale 15` at the first ONDOINR-shaped market it met.
 * Widening to the next supported scale is lossless, so 566.6666666666666 is held
 * exactly at scale 18 with nothing truncated.
 */
export function scaleAtLeast(places: number): Scale {
  if (!Number.isInteger(places) || places < 0) {
    throw new Error(`decimal places must be a non-negative integer, got ${places}`);
  }
  for (const s of SUPPORTED_SCALES) if (s >= places) return s;
  throw new Error(`${places} decimal places is beyond the widest supported scale (18)`);
}

/** Parse a plain decimal at a scale wide enough to hold every digit it carries. */
export function nat(s: string): Scaled {
  const dot = s.indexOf('.');
  const places = dot === -1 ? 0 : s.length - dot - 1;
  return scaledFromString(s, scaleAtLeast(places));
}

/**
 * Floor to exactly `places` decimal places, always down.
 *
 * `rescale(a, places)` cannot be used directly because `places` may not be a
 * supported scale. When it is not, the value is held at the next supported scale
 * with the digits below `places` zeroed — numerically identical, and `toStr`
 * trims the padding away.
 */
export function floorToPlaces(a: Scaled, places: number): Scaled {
  if (places >= a.scale) return a; // already no deeper than `places`
  const target = scaleAtLeast(places);
  if (target === places) return rescale(a, target);
  const wide = rescale(a, target);
  const drop = 10n ** BigInt(target - places);
  return { v: floorDiv(wide.v, drop) * drop, scale: target };
}

/** Exact plain-decimal rendering with trailing zeros trimmed. Never exponent form. */
export function toStr(a: Scaled): string {
  const neg = a.v < 0n;
  const digits = (neg ? -a.v : a.v).toString().padStart(a.scale + 1, '0');
  if (a.scale === 0) return `${neg ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -a.scale);
  const frac = digits.slice(-a.scale).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

/** The minor-unit scale for a quote currency. INR paise (2), everything else 8. */
export const quoteScaleOf = (quote: string): Scale => (quote === 'INR' ? 2 : 8);
