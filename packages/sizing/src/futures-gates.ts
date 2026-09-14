// Futures-specific sizing gates — plan/phase-15 T15.6.
//
// Pure. Every input is a scalar the caller assembles from OUR records or an
// injected mark price (§6a: sizing is import-free of any live-price fetch; the
// caller passes the number in). Three gates that the spot gates in gates.ts do
// not model, because they only bind under leverage:
//
//   MAX_LEVERAGE          — venue enforces a per-tier max leverage
//                          (research/03 F3, `dynamic_position_leverage_details`).
//   ABOVE_MARGIN_CAP      — the tenant's per-order cap must apply to MARGIN, not
//                          notional exposure, for a leveraged trade. A 5x order
//                          of ₹1L notional risks ₹20k, and the cap should read
//                          ₹20k not ₹1L. This gate checks margin against the
//                          cap the caller passes in.
//   LIQUIDATION_BUFFER_TOO_TIGHT — planned entry + leverage yields a
//                          liquidation price closer than the configured buffer.
//                          Prevents a trade that a normal spread would liquidate.

import { cmp, mul, scaledFromMinor, sub } from '@tradex/money';
import type { Scaled } from '@tradex/money';
import { nat, toStr } from './decimal.js';

/** A leverage tier: `upToNotional` in quote minor units is the ceiling. */
export interface LeverageTier {
  readonly upToNotionalMinor: string;
  readonly maxLeverage: number;
}

export interface FuturesSizingInput {
  /** The requested leverage. */
  readonly leverage: number;
  /** Ordered tiers, ascending upToNotional. */
  readonly leverageTiers: readonly LeverageTier[];
  /** The order's notional in quote minor units. */
  readonly notionalMinor: string;
  /** The tenant's per-order margin cap in quote minor units, or null when unset. */
  readonly perOrderCapMinor: string | null;
  /**
   * Buffer in basis points (1/10000) between entry price and the theoretical
   * liquidation price. A trade whose entry is within `minLiqBufferBp` of its
   * liquidation is refused. Set to 0 to disable.
   */
  readonly minLiqBufferBp: number;
  /** Trade side. Governs how liquidation is computed from leverage. */
  readonly side: 'buy' | 'sell';
  /** Entry price (venue_decimal, plain decimal string). */
  readonly entryPrice: string;
  /** Optional injected mark price; when absent, the entry price is used as its own baseline. */
  readonly markPrice?: string | undefined;
}

export type FuturesGateCode =
  | 'MAX_LEVERAGE'
  | 'ABOVE_MARGIN_CAP'
  | 'LIQUIDATION_BUFFER_TOO_TIGHT';

export interface FuturesGateRefusal {
  readonly code: FuturesGateCode;
  readonly detail: string;
}

export const FUTURES_GATE_CODES: readonly FuturesGateCode[] = [
  'MAX_LEVERAGE', 'ABOVE_MARGIN_CAP', 'LIQUIDATION_BUFFER_TOO_TIGHT',
];

/** Find the tier a given notional falls into. Returns the first tier whose
 *  `upToNotionalMinor` >= notional. If none match, returns the LAST tier
 *  (venue behaviour: max notional's own max leverage). */
export function tierFor(notionalMinor: string, tiers: readonly LeverageTier[]): LeverageTier | null {
  if (tiers.length === 0) return null;
  const n = BigInt(notionalMinor);
  for (const t of tiers) {
    if (n <= BigInt(t.upToNotionalMinor)) return t;
  }
  return tiers[tiers.length - 1] ?? null;
}

/**
 * The margin a leveraged trade requires, in quote minor. Always uses integer
 * division floored — the venue is the same, and the caller must post at least
 * this much; rounding up here would silently inflate what we tell them to fund.
 */
export function marginMinorFor(notionalMinor: string, leverage: number): string {
  if (leverage <= 0) return notionalMinor;
  return (BigInt(notionalMinor) / BigInt(Math.max(1, Math.floor(leverage)))).toString();
}

/**
 * The theoretical liquidation price on isolated margin, ignoring funding and
 * maintenance-margin cushioning (the venue's number is exact; ours is a
 * planning estimate). For a long: `entry × (1 - 1/leverage)`. For a short:
 * `entry × (1 + 1/leverage)`. Returned at the entry's own scale.
 */
export function liquidationPriceEstimate(entry: string, leverage: number, side: 'buy' | 'sell'): string {
  if (leverage <= 0) return entry;
  const e = nat(entry);
  // Compute 1/leverage as a Scaled at 6 decimals of precision — plenty for a
  // buffer check that compares in basis points.
  const inv: Scaled = { v: BigInt(Math.round(1_000_000 / leverage)), scale: 6 };
  const delta = mul(e, inv, e.scale);
  const liq = side === 'buy' ? sub(e, delta) : { v: e.v + delta.v, scale: e.scale };
  if (liq.v <= 0n) return '0';
  return toStr(liq);
}

/**
 * Distance from `entry` to `liq` in basis points of the entry price. Positive
 * whether long (liq < entry) or short (liq > entry).
 */
export function bufferBp(entry: string, liq: string): number {
  const e = nat(entry);
  const l = nat(liq);
  const diff = e.v > l.v ? sub(e, l) : sub(l, e);
  // bp = 10_000 * diff / entry (integer, floored).
  const eMinor = scaledFromMinor(e.v.toString(), 0);
  const dMinor = scaledFromMinor(diff.v.toString(), 0);
  if (cmp(eMinor, scaledFromMinor('0', 0)) === 0) return 0;
  // bp is a small integer; go through the decimal via toString() to satisfy
  // MONEY-NO-NUMBER-CAST — never widen a money value through Number().
  return Number.parseInt(((dMinor.v * 10_000n) / eMinor.v).toString(), 10);
}

/** Run every futures gate; return every refusal (never short-circuit). */
export function futuresGates(input: FuturesSizingInput): readonly FuturesGateRefusal[] {
  const out: FuturesGateRefusal[] = [];

  // MAX_LEVERAGE — the venue tier caps it.
  const tier = tierFor(input.notionalMinor, input.leverageTiers);
  if (tier !== null && input.leverage > tier.maxLeverage) {
    out.push({
      code: 'MAX_LEVERAGE',
      detail: `requested ${input.leverage}x exceeds the venue's max ${tier.maxLeverage}x for a notional of ${input.notionalMinor} minor`,
    });
  }

  // ABOVE_MARGIN_CAP — cap applies to MARGIN not notional.
  if (input.perOrderCapMinor !== null) {
    const margin = marginMinorFor(input.notionalMinor, input.leverage);
    if (BigInt(margin) > BigInt(input.perOrderCapMinor)) {
      out.push({
        code: 'ABOVE_MARGIN_CAP',
        detail: `margin required ${margin} exceeds the tenant per-order cap ${input.perOrderCapMinor} minor`,
      });
    }
  }

  // LIQUIDATION_BUFFER_TOO_TIGHT — refuse when liquidation is within the buffer.
  if (input.minLiqBufferBp > 0 && input.leverage > 1) {
    const liq = liquidationPriceEstimate(input.entryPrice, input.leverage, input.side);
    const bp = bufferBp(input.entryPrice, liq);
    if (bp < input.minLiqBufferBp) {
      out.push({
        code: 'LIQUIDATION_BUFFER_TOO_TIGHT',
        detail: `liquidation is ~${bp} bp from entry ${input.entryPrice} (min buffer ${input.minLiqBufferBp} bp); reduce leverage`,
      });
    }
  }

  return out;
}
