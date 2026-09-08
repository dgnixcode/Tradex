// Money and Qty — the only representations of value in Tradex.
//
// Money holds an amount in MINOR units of a currency (INR paise, USDT at
// scale 8). Qty holds a quantity at a market's own precision. Both are
// constructed from strings and only from strings: `Money.inr(1234.56)` is a
// compile error and a runtime error, because the float damage happens before
// the constructor ever sees the value.
//
// Source: 09-sizing-allocation-rounding.md, DECISIONS.md D01/D17.

import type { Scale, Scaled } from './scaled.js';
import {
  MoneyError, add, cmp, div, floorToStep, isNegative, isZero, max, min, mul,
  rescale, scaledFromMinor, scaledFromString, sub, toMinorString, toPlainString,
} from './scaled.js';
import { formatInr, formatInrHeadline, formatQty, formatUsdt } from './format.js';

export type Currency = 'INR' | 'USDT';

/** Minor-unit scale per currency. INR is paise; USDT is 8 places. */
export const CURRENCY_SCALE: Readonly<Record<Currency, Scale>> = { INR: 2, USDT: 8 };

export class Money {
  private constructor(
    readonly currency: Currency,
    readonly raw: Scaled,
  ) {}

  /** From a human decimal string in MAJOR units: `Money.of('19870.61','INR')`. */
  static of(major: string, currency: Currency): Money {
    return new Money(currency, scaledFromString(major, CURRENCY_SCALE[currency]));
  }

  /** From the integer minor-unit value we store — paise, or USDT*1e8. */
  static ofMinor(minor: bigint | string, currency: Currency): Money {
    return new Money(currency, scaledFromMinor(minor, CURRENCY_SCALE[currency]));
  }

  static zero(currency: Currency): Money {
    return Money.ofMinor(0n, currency);
  }

  private same(other: Money): void {
    if (other.currency !== this.currency) {
      throw new MoneyError(
        `refusing to combine ${this.currency} with ${other.currency} — cross-currency arithmetic needs an explicit fx snapshot`,
      );
    }
  }

  plus(other: Money): Money {
    this.same(other);
    return new Money(this.currency, add(this.raw, other.raw));
  }

  minus(other: Money): Money {
    this.same(other);
    return new Money(this.currency, sub(this.raw, other.raw));
  }

  /** Apply a rate (e.g. a fee or a percentage), flooring the result. */
  timesRate(rate: Rate): Money {
    return new Money(this.currency, mul(this.raw, rate.raw, this.raw.scale));
  }

  /** Money divided by a price gives a quantity, floored to `precision`. */
  dividedByPrice(price: Price, precision: Scale): Qty {
    return Qty.fromScaled(div(this.raw, price.raw, precision));
  }

  compare(other: Money): -1 | 0 | 1 {
    this.same(other);
    return cmp(this.raw, other.raw);
  }

  isZero(): boolean { return isZero(this.raw); }
  isNegative(): boolean { return isNegative(this.raw); }
  lt(other: Money): boolean { return this.compare(other) < 0; }
  lte(other: Money): boolean { return this.compare(other) <= 0; }
  gt(other: Money): boolean { return this.compare(other) > 0; }
  gte(other: Money): boolean { return this.compare(other) >= 0; }

  static max(a: Money, b: Money): Money { a.same(b); return new Money(a.currency, max(a.raw, b.raw)); }
  static min(a: Money, b: Money): Money { a.same(b); return new Money(a.currency, min(a.raw, b.raw)); }

  /** The integer we persist into `numeric(38,0)`. */
  toMinor(): string { return toMinorString(this.raw); }
  /** Exact major-unit decimal, never exponent notation. */
  toPlain(): string { return toPlainString(this.raw); }

  format(): string {
    return this.currency === 'INR' ? formatInr(this.raw) : formatUsdt(this.raw);
  }

  formatHeadline(): string {
    return this.currency === 'INR' ? formatInrHeadline(this.raw) : formatUsdt(this.raw);
  }

  toString(): string { return this.format(); }
  toJSON(): { currency: Currency; minor: string; scale: Scale } {
    return { currency: this.currency, minor: this.toMinor(), scale: this.raw.scale };
  }
}

/** A quantity of a base asset, at the market's own quantity precision. */
export class Qty {
  private constructor(readonly raw: Scaled) {}

  static of(decimal: string, precision: Scale): Qty {
    return new Qty(scaledFromString(decimal, precision));
  }

  static fromScaled(s: Scaled): Qty { return new Qty(s); }
  static zero(precision: Scale): Qty { return new Qty({ v: 0n, scale: precision }); }

  /** Floor to a multiple of `step`. Never rounds up (D17). */
  floorToStep(step: Qty): Qty { return new Qty(floorToStep(this.raw, step.raw)); }
  /** Floor to `precision` decimal places. Never rounds up. */
  floorToPrecision(precision: Scale): Qty { return new Qty(rescale(this.raw, precision)); }

  /** quantity x price = notional, floored to the currency's minor scale. */
  timesPrice(price: Price, currency: Currency): Money {
    return Money.ofMinor(mul(this.raw, price.raw, CURRENCY_SCALE[currency]).v, currency);
  }

  timesRate(rate: Rate): Qty { return new Qty(mul(this.raw, rate.raw, this.raw.scale)); }

  plus(other: Qty): Qty { return new Qty(add(this.raw, other.raw)); }
  minus(other: Qty): Qty { return new Qty(sub(this.raw, other.raw)); }

  compare(other: Qty): -1 | 0 | 1 { return cmp(this.raw, other.raw); }
  isZero(): boolean { return isZero(this.raw); }
  isNegative(): boolean { return isNegative(this.raw); }
  lt(other: Qty): boolean { return this.compare(other) < 0; }
  lte(other: Qty): boolean { return this.compare(other) <= 0; }
  gt(other: Qty): boolean { return this.compare(other) > 0; }
  gte(other: Qty): boolean { return this.compare(other) >= 0; }

  static max(a: Qty, b: Qty): Qty { return new Qty(max(a.raw, b.raw)); }
  static min(a: Qty, b: Qty): Qty { return new Qty(min(a.raw, b.raw)); }

  toPlain(): string { return toPlainString(this.raw); }
  format(asset: string): string { return formatQty(this.raw, asset); }
  toString(): string { return this.toPlain(); }
  toJSON(): { qty: string; precision: Scale } {
    return { qty: this.toPlain(), precision: this.raw.scale };
  }
}

/** A price, at the market's price precision. */
export class Price {
  private constructor(readonly raw: Scaled) {}
  static of(decimal: string, precision: Scale): Price {
    return new Price(scaledFromString(decimal, precision));
  }
  toPlain(): string { return toPlainString(this.raw); }
  compare(other: Price): -1 | 0 | 1 { return cmp(this.raw, other.raw); }
  toString(): string { return this.toPlain(); }
}

/**
 * A dimensionless rate — a fee, a percentage, a slippage tolerance. Held at
 * scale 8 so 0.5% is `0.00500000` exactly and a basis point is representable.
 */
export class Rate {
  private constructor(readonly raw: Scaled) {}
  /** From a decimal fraction: `Rate.ofFraction('0.005')` is 0.5%. */
  static ofFraction(decimal: string): Rate { return new Rate(scaledFromString(decimal, 8)); }
  /** From a percentage: `Rate.ofPercent('20')` is 0.2 exactly. */
  static ofPercent(percent: string): Rate {
    return new Rate(div(scaledFromString(percent, 8), scaledFromString('100', 0), 8));
  }
  /** From basis points: `Rate.ofBasisPoints('50')` is 0.5%. */
  static ofBasisPoints(bp: string): Rate {
    return new Rate(div(scaledFromString(bp, 8), scaledFromString('10000', 0), 8));
  }
  static one(): Rate { return Rate.ofFraction('1'); }
  minus(other: Rate): Rate { return new Rate(sub(this.raw, other.raw)); }
  plus(other: Rate): Rate { return new Rate(add(this.raw, other.raw)); }
  toPlain(): string { return toPlainString(this.raw); }
  toString(): string { return this.toPlain(); }
}
