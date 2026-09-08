// Rendering rules. One place, so a formatting mistake cannot be made locally.
// Source: 21-frontend-ux-spec.md F6.

import type { Scale, Scaled } from './scaled.js';
import { div, mul, scaledFromString, toPlainString, cmp, rescale, isNegative } from './scaled.js';

/** Indian digit grouping: last three digits, then groups of two. */
export function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const groups: string[] = [];
  for (let i = rest.length; i > 0; i -= 2) {
    groups.unshift(rest.slice(Math.max(0, i - 2), i));
  }
  return `${groups.join(',')},${last3}`;
}

/** Western grouping: threes throughout. */
export function groupWestern(digits: string): string {
  const groups: string[] = [];
  for (let i = digits.length; i > 0; i -= 3) {
    groups.unshift(digits.slice(Math.max(0, i - 3), i));
  }
  return groups.join(',');
}

type Grouping = 'indian' | 'western';

function splitPlain(a: Scaled): { neg: boolean; whole: string; frac: string } {
  const plain = toPlainString(a);
  const neg = plain.startsWith('-');
  const body = neg ? plain.slice(1) : plain;
  const dot = body.indexOf('.');
  return dot === -1
    ? { neg, whole: body, frac: '' }
    : { neg, whole: body.slice(0, dot), frac: body.slice(dot + 1) };
}

/**
 * Precise rendering. Fractional digits are shown only when non-zero, and never
 * in exponent notation. `trimFractionTo` caps displayed decimals without
 * changing the stored value.
 */
export function formatDecimal(
  a: Scaled,
  opts: { grouping?: Grouping; trimFractionTo?: Scale } = {},
): string {
  const grouping = opts.grouping ?? 'western';
  const shown = opts.trimFractionTo === undefined ? a : rescale(a, opts.trimFractionTo);
  const { neg, whole, frac } = splitPlain(shown);
  const groupedWhole = grouping === 'indian' ? groupIndian(whole) : groupWestern(whole);
  const trimmed = frac.replace(/0+$/, '');
  const body = trimmed === '' ? groupedWhole : `${groupedWhole}.${trimmed}`;
  return neg ? `-${body}` : body;
}

const LAKH = scaledFromString('100000', 0);
const CRORE = scaledFromString('10000000', 0);

/**
 * Headline rendering with lakh/crore shorthand above one lakh. The precise
 * value belongs on hover — never only here.
 */
export function formatInrHeadline(rupees: Scaled): string {
  const abs = isNegative(rupees) ? { v: -rupees.v, scale: rupees.scale } : rupees;
  const sign = isNegative(rupees) ? '-' : '';
  if (cmp(abs, CRORE) >= 0) {
    return `${sign}₹${formatDecimal(div(abs, CRORE, 2), { grouping: 'indian' })} Cr`;
  }
  if (cmp(abs, LAKH) >= 0) {
    return `${sign}₹${formatDecimal(div(abs, LAKH, 2), { grouping: 'indian' })} L`;
  }
  return `${sign}₹${formatDecimal(abs, { grouping: 'indian' })}`;
}

/** Exact INR, Indian grouping, decimals only when non-zero. */
export const formatInr = (rupees: Scaled): string =>
  `${isNegative(rupees) ? '-' : ''}₹${formatDecimal(
    isNegative(rupees) ? { v: -rupees.v, scale: rupees.scale } : rupees,
    { grouping: 'indian' },
  )}`;

/** USDT and other western-grouped currencies. */
export const formatUsdt = (units: Scaled, trimTo: Scale = 2): string =>
  `${formatDecimal(units, { grouping: 'western', trimFractionTo: trimTo })} USDT`;

/**
 * A crypto quantity renders at exactly the market's precision, trailing zeros
 * kept — `0.00246 BTC`, and `112 DOGE` at precision 0, with no decimal point.
 */
export function formatQty(qty: Scaled, asset: string): string {
  const { neg, whole, frac } = splitPlain(qty);
  const body = qty.scale === 0 ? whole : `${whole}.${frac}`;
  return `${neg ? '-' : ''}${body} ${asset}`;
}

/** Percentages render at two decimals. */
export const formatPercent = (ratio: Scaled): string =>
  `${formatDecimal(rescale(ratio, 4), {})}%`;

/**
 * Slippage and divergence render as integer basis points. One basis point is
 * 0.0001, so a ratio becomes basis points by multiplying by 10,000 and
 * flooring — never by rescaling, which would discard the value entirely.
 */
export const formatBasisPoints = (ratio: Scaled): string => {
  const bp = mul(ratio, scaledFromString('10000', 0), 0);
  const sign = isNegative(bp) ? '' : '+';
  return `${sign}${toPlainString(bp)}bp`;
};
