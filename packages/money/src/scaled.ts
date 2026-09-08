// Exact fixed-point arithmetic on bigint, with rounding direction always
// explicit and always DOWN by default.
//
// Why bigint rather than a decimal library: every money value in Tradex is
// already an integer in minor units, and every quantity is an integer at the
// market's own precision. Scaled bigints represent both exactly, need no
// dependency, and make floor division the natural operation — which is what
// DECISIONS.md D17 requires ("always round DOWN, on both sides"). There is no
// code path in this product where rounding up is correct.
//
// Source: 09-sizing-allocation-rounding.md, DECISIONS.md D01 and D17.

/** A decimal value held as `v / 10^scale`, exactly. */
export interface Scaled {
  readonly v: bigint;
  readonly scale: Scale;
}

/** Scales we allow. INR minor = 2, USDT minor = 8, crypto quantity up to 18. */
export type Scale = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 12 | 18;

export class MoneyError extends Error {
  override readonly name = 'MoneyError';
}

const POW10: Record<number, bigint> = {};
for (const s of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 18]) POW10[s] = 10n ** BigInt(s);

const pow10 = (s: Scale): bigint => {
  const p = POW10[s];
  if (p === undefined) throw new MoneyError(`unsupported scale ${s}`);
  return p;
};

/**
 * Parse a plain decimal string. Rejects anything that could hide precision
 * loss: exponent notation, a JS number, NaN, Infinity, or more decimal places
 * than the target scale can hold.
 */
export function scaledFromString(input: string, scale: Scale): Scaled {
  if (typeof input !== 'string') {
    throw new MoneyError(`expected a string, received ${typeof input} — passing a number here is how float error enters`);
  }
  const s = input.trim();
  if (s === '') throw new MoneyError('empty string');
  if (/[eE]/.test(s)) throw new MoneyError(`exponent notation is not accepted: ${s}`);
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new MoneyError(`not a plain decimal: ${s}`);
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = m[2] ?? '0';
  const frac = m[3] ?? '';
  if (frac.length > scale) {
    throw new MoneyError(`${s} has ${frac.length} decimal places, scale ${scale} holds ${scale} — refusing to truncate silently`);
  }
  const padded = frac.padEnd(scale, '0');
  return { v: sign * BigInt(whole + padded), scale };
}

/** Build directly from minor units, e.g. paise. */
export function scaledFromMinor(minor: bigint | string, scale: Scale): Scaled {
  const v = typeof minor === 'bigint' ? minor : BigInt(assertIntegerString(minor));
  return { v, scale };
}

function assertIntegerString(s: string): string {
  if (!/^-?\d+$/.test(s.trim())) throw new MoneyError(`not an integer string: ${s}`);
  return s.trim();
}

/** Exact rescale. Widening is lossless; narrowing floors toward negative infinity. */
export function rescale(a: Scaled, to: Scale): Scaled {
  if (a.scale === to) return a;
  if (to > a.scale) return { v: a.v * (pow10(to) / pow10(a.scale)), scale: to };
  return { v: floorDiv(a.v, pow10(a.scale) / pow10(to)), scale: to };
}

/** Floor division that behaves correctly for negatives (toward -Infinity). */
export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new MoneyError('division by zero');
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

const align = (a: Scaled, b: Scaled): Scale => (a.scale >= b.scale ? a.scale : b.scale);

export function add(a: Scaled, b: Scaled): Scaled {
  const s = align(a, b);
  return { v: rescale(a, s).v + rescale(b, s).v, scale: s };
}

export function sub(a: Scaled, b: Scaled): Scaled {
  const s = align(a, b);
  return { v: rescale(a, s).v - rescale(b, s).v, scale: s };
}

/** Multiply, then floor to `to`. Exact intermediate, explicit output scale. */
export function mul(a: Scaled, b: Scaled, to: Scale): Scaled {
  const raw = a.v * b.v; // scale = a.scale + b.scale
  const fromScale = a.scale + b.scale;
  return { v: shiftFloor(raw, fromScale, to), scale: to };
}

/** Divide, flooring to `to`. This is the money-to-quantity operation. */
export function div(a: Scaled, b: Scaled, to: Scale): Scaled {
  if (b.v === 0n) throw new MoneyError('division by zero');
  // (a.v / 10^a.scale) / (b.v / 10^b.scale) at scale `to`
  //   = a.v * 10^(to + b.scale - a.scale) / b.v
  const shift = to + b.scale - a.scale;
  const num = shift >= 0 ? a.v * 10n ** BigInt(shift) : a.v;
  const den = shift >= 0 ? b.v : b.v * 10n ** BigInt(-shift);
  return { v: floorDiv(num, den), scale: to };
}

function shiftFloor(v: bigint, fromScale: number, to: Scale): bigint {
  if (fromScale === to) return v;
  if (to > fromScale) return v * 10n ** BigInt(to - fromScale);
  return floorDiv(v, 10n ** BigInt(fromScale - to));
}

/** Floor to a multiple of `step`. Both must share a scale. Never rounds up. */
export function floorToStep(a: Scaled, step: Scaled): Scaled {
  const s = align(a, step);
  const av = rescale(a, s).v;
  const sv = rescale(step, s).v;
  if (sv <= 0n) throw new MoneyError('step must be positive');
  return { v: floorDiv(av, sv) * sv, scale: s };
}

/** Multiply by a rate expressed at `rateScale`, flooring the result. */
export function mulRate(a: Scaled, rate: Scaled): Scaled {
  return mul(a, rate, a.scale);
}

export const isZero = (a: Scaled): boolean => a.v === 0n;
export const isNegative = (a: Scaled): boolean => a.v < 0n;
export const cmp = (a: Scaled, b: Scaled): -1 | 0 | 1 => {
  const s = align(a, b);
  const av = rescale(a, s).v;
  const bv = rescale(b, s).v;
  return av < bv ? -1 : av > bv ? 1 : 0;
};
export const max = (a: Scaled, b: Scaled): Scaled => (cmp(a, b) >= 0 ? a : b);
export const min = (a: Scaled, b: Scaled): Scaled => (cmp(a, b) <= 0 ? a : b);

/** Exact plain-decimal rendering. Never exponent notation. */
export function toPlainString(a: Scaled): string {
  const neg = a.v < 0n;
  const digits = (neg ? -a.v : a.v).toString().padStart(a.scale + 1, '0');
  const cut = digits.length - a.scale;
  const whole = digits.slice(0, cut);
  const frac = digits.slice(cut);
  const body = a.scale === 0 ? whole : `${whole}.${frac}`;
  return neg ? `-${body}` : body;
}

/** The raw minor-unit integer, as a string — what goes into numeric(38,0). */
export const toMinorString = (a: Scaled): string => a.v.toString();
