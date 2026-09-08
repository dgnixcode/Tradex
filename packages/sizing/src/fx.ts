// FX snapshots and the venue cross-check — plan/phase-03 T03.8, from 10 F4.
//
// Everything here is pure. A snapshot is a VALUE: the rate, which side of the
// book it came from, and when it was observed. Sampling it needs a ticker read
// and storing it needs a database, and both live outside this package — the
// insert is `packages/db/src/fx-repo.ts`. What lives here is the arithmetic that
// must be identical whether it runs at plan time, in a replay, or in a test.
//
// The rule this module exists to enforce is 10 F4's: a STORED rate is never
// refreshed. Display rates move every few seconds; a rate written into a ledger
// entry or a child order is frozen forever, because re-resolving it makes last
// month's P&L move (11 F5, invariants L9/L10). `convertMinor` therefore takes a
// snapshot, not a rate — there is no way to spend a rate that nobody recorded.
//
// The cross-check is the cheap alarm 10 F4 asks for: BTCUSDT x USDTINR should
// approximate BTCINR, and a persistent gap means a stale ticker or a genuinely
// dislocated venue.

import { cmp, div, mul, scaledFromMinor, sub } from '@tradex/money';
import type { Scaled } from '@tradex/money';
import { GUARD_SCALE, nat, quoteScaleOf, toStr } from './decimal.js';

/** Which figure was sampled. The right side depends on the question (10 F4). */
export type FxSource =
  /** Valuation of a holding. */
  | 'coindcx_ticker_last'
  /** Proceeds of a USDT -> INR conversion. */
  | 'coindcx_ticker_bid'
  /** Cost of an INR -> USDT conversion. */
  | 'coindcx_ticker_ask'
  | 'coindcx_orderbook_mid';

export const FX_SOURCES: readonly FxSource[] = [
  'coindcx_ticker_last', 'coindcx_ticker_bid', 'coindcx_ticker_ask', 'coindcx_orderbook_mid',
];

/**
 * An immutable rate sample. `rate` is units of `quote` per ONE `base`, so
 * USDTINR at 99.11 is `{ base: 'USDT', quote: 'INR', rate: '99.11' }`.
 */
export interface FxSnapshot {
  readonly base: string;
  readonly quote: string;
  /** Plain decimal, exactly as observed. Never exponent notation. */
  readonly rate: string;
  readonly source: FxSource;
  readonly observedAtMs: number;
  /** Present when the venue cross-check was run alongside the sample. */
  readonly crossCheck?: FxCrossCheck | undefined;
}

/**
 * The 10 F4 sanity check, as a value.
 *
 * `driftBp` is SIGNED INTEGER basis points: positive when the C2C route implies a
 * HIGHER price than the INR book quotes. Integer basis points rather than a
 * fraction for the same reason every money figure is minor units — it is exact,
 * it round-trips through `numeric(38,0)`, and the database can therefore check
 * that `alarmed` agrees with the numbers instead of trusting the writer.
 */
export interface FxCrossCheck {
  /** The asset both legs price, e.g. 'BTC'. */
  readonly asset: string;
  /** Price of the asset in the fx BASE currency, e.g. BTCUSDT. */
  readonly baseLegPrice: string;
  /** Price of the asset in the fx QUOTE currency, e.g. BTCINR. */
  readonly quoteLegPrice: string;
  /** baseLegPrice x rate — what the C2C route implies the quote price should be. */
  readonly impliedQuotePrice: string;
  /** Signed integer basis points of deviation from `quoteLegPrice`. */
  readonly driftBp: string;
  readonly thresholdBp: string;
  readonly alarmed: boolean;
}

/**
 * Drift beyond which the cross-check alarms, in basis points.
 *
 * 100bp is deliberately loose, and both bounds matter. The measured gap on
 * 2026-09-04 was 11bp (10 F4), so the threshold sits about nine times above
 * normal. It cannot go much lower: the bid-ask spread on BTCINR alone is 42bp
 * and on DOGEINR 81bp (09 F6), and the two legs are sampled from different books,
 * so a threshold near the spread would alarm continuously on healthy markets. A
 * 100bp persistent gap, by contrast, is either a stale ticker or a dislocated
 * venue, which is exactly what the alarm is for.
 */
export const DEFAULT_FX_DRIFT_THRESHOLD_BP = '100';

export class FxError extends Error {
  override readonly name = 'FxError';
}

const BP = { v: 10000n, scale: 0 } as const;

/**
 * Round a magnitude UP to whole basis points.
 *
 * This is the one figure in the codebase that is not floored, and the exception
 * is deliberate. D17 rounds everything down because rounding a quantity up
 * spends money the customer did not authorise. A drift figure has the opposite
 * asymmetry: rounding it down understates how far apart two venues are, which
 * hides the very condition the alarm exists to catch. Under-reporting risk is
 * the expensive direction here, so the magnitude rounds away from zero.
 */
function ceilMagnitudeToBp(magnitude: Scaled): bigint {
  const unit = 10n ** BigInt(magnitude.scale);
  const whole = magnitude.v / unit;
  return magnitude.v % unit === 0n ? whole : whole + 1n;
}

export interface CrossCheckInput {
  readonly asset: string;
  /** Price of `asset` in the snapshot's BASE currency (e.g. BTCUSDT = '81602'). */
  readonly baseLegPrice: string;
  /** Price of `asset` in the snapshot's QUOTE currency (e.g. BTCINR = '8079092'). */
  readonly quoteLegPrice: string;
  /** Units of quote per one base (e.g. USDTINR = '99.11'). */
  readonly rate: string;
  readonly thresholdBp?: string | undefined;
}

/**
 * Compare the C2C route against the direct book: `baseLegPrice x rate` versus
 * `quoteLegPrice`.
 *
 * Worked example, from the live 2026-09-04 sample: 81,602 x 99.11 = 8,087,594.22
 * against a BTCINR last of 8,079,092. That is 8,502.22 too high on 8,079,092, or
 * 10.52bp, which reports as 11bp and does not alarm.
 */
export function crossCheck(input: CrossCheckInput): FxCrossCheck {
  const baseLeg = nat(input.baseLegPrice);
  const quoteLeg = nat(input.quoteLegPrice);
  const rate = nat(input.rate);
  const thresholdBp = input.thresholdBp ?? DEFAULT_FX_DRIFT_THRESHOLD_BP;

  if (!/^\d+$/.test(thresholdBp) || thresholdBp === '0') {
    throw new FxError(`the drift threshold must be a positive whole number of basis points, got ${thresholdBp}`);
  }
  if (cmp(quoteLeg, { v: 0n, scale: quoteLeg.scale }) <= 0) {
    throw new FxError('the quote-leg price must be positive to measure drift against');
  }

  const implied = mul(baseLeg, rate, GUARD_SCALE);
  const diff = sub(implied, quoteLeg);
  const negative = diff.v < 0n;
  const magnitude: Scaled = { v: negative ? -diff.v : diff.v, scale: diff.scale };

  // |diff| / quoteLeg, expressed in basis points at guard precision.
  const driftAtGuard = div(mul(magnitude, BP, GUARD_SCALE), quoteLeg, GUARD_SCALE);
  const wholeBp = ceilMagnitudeToBp(driftAtGuard);
  const driftBp = negative ? -wholeBp : wholeBp;

  return {
    asset: input.asset,
    baseLegPrice: input.baseLegPrice,
    quoteLegPrice: input.quoteLegPrice,
    impliedQuotePrice: toStr(implied),
    driftBp: driftBp.toString(),
    thresholdBp,
    alarmed: (negative ? -driftBp : driftBp) > BigInt(thresholdBp),
  };
}

/** Build a snapshot, validating the rate is a plain decimal we can hold exactly. */
export function fxSnapshot(input: {
  readonly base: string;
  readonly quote: string;
  readonly rate: string;
  readonly source: FxSource;
  readonly observedAtMs: number;
  readonly crossCheck?: FxCrossCheck | undefined;
}): FxSnapshot {
  if (input.base === input.quote) {
    throw new FxError(`an fx snapshot needs two different currencies, got ${input.base} twice`);
  }
  if (!/^\d+(\.\d+)?$/.test(input.rate)) {
    throw new FxError(
      `the rate ${input.rate} is not a plain positive decimal — an exponent or a sign here is how float error enters`,
    );
  }
  const parsed = nat(input.rate);
  if (parsed.v <= 0n) throw new FxError(`the rate must be positive, got ${input.rate}`);
  if (!FX_SOURCES.includes(input.source)) throw new FxError(`unknown fx source ${input.source}`);
  return {
    base: input.base,
    quote: input.quote,
    rate: input.rate,
    source: input.source,
    observedAtMs: input.observedAtMs,
    ...(input.crossCheck !== undefined ? { crossCheck: input.crossCheck } : {}),
  };
}

/**
 * Convert an amount in minor units between the snapshot's two currencies,
 * flooring the result.
 *
 * Taking a snapshot rather than a rate is the enforcement of X10: a
 * cross-currency figure cannot be produced here without a recorded rate to
 * attribute it to. Direction is inferred from the currencies, so a caller cannot
 * multiply where it should have divided — the 99x error that inversion produces
 * on this pair would otherwise pass review.
 */
export function convertMinor(
  amountMinor: string,
  from: string,
  to: string,
  snapshot: FxSnapshot,
): string {
  const rate = nat(snapshot.rate);
  const fromScale = quoteScaleOf(from);
  const toScale = quoteScaleOf(to);
  const amount = scaledFromMinor(amountMinor, fromScale);

  if (from === snapshot.base && to === snapshot.quote) {
    return mul(amount, rate, toScale).v.toString();
  }
  if (from === snapshot.quote && to === snapshot.base) {
    return div(amount, rate, toScale).v.toString();
  }
  throw new FxError(
    `snapshot ${snapshot.base}/${snapshot.quote} cannot convert ${from} to ${to} — `
    + 'every cross-currency figure must reference a snapshot covering its own pair (X10)',
  );
}
