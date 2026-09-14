// Sizing a partial close (or an add) against a live futures position.
//
// THE SINGLE MOST DANGEROUS ARITHMETIC IN THE PRODUCT. The futures API has no
// `reduce_only` (research/04, VERIFIED by exhaustive grep), so a reducing order is
// an ordinary opposite-side order — and one sized ABOVE `abs(active_pos)` does not
// fail, it CLOSES THE POSITION AND OPENS THE OPPOSITE ONE. research/04 calls that
// the worst case in the document.
//
// So this module does three things and refuses rather than guesses at every step:
//
//   * rounds DOWN to the instrument's quantity_increment — never up, because up is
//     the direction that flips a position;
//   * refuses below `min_quantity` or `min_notional` rather than nudging the size
//     up to clear them;
//   * clamps to `abs(active_pos)` even though the percentage maths cannot exceed
//     it, because the position can move between the read and the send.
//
// All of it is exact integer arithmetic on BigInt at a fixed scale. A float here
// would be a rounding error away from the wrong side of a position.

export const ADJUST_SCALE = 18n;
const SCALE_N = 18;

export class AdjustError extends Error {
  override readonly name = 'AdjustError';
}

/** A plain non-negative decimal as a BigInt of ADJUST_SCALE decimal places. */
function scaled(value: string, what: string): bigint {
  const v = value.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) {
    throw new AdjustError(`${what} is not a plain non-negative decimal: "${value}"`);
  }
  const [whole = '0', frac = ''] = v.split('.');
  if (frac.length > SCALE_N && /[1-9]/.test(frac.slice(SCALE_N))) {
    throw new AdjustError(`${what} carries more than ${SCALE_N} decimals: "${value}"`);
  }
  return BigInt(whole) * 10n ** ADJUST_SCALE + BigInt(frac.slice(0, SCALE_N).padEnd(SCALE_N, '0') || '0');
}

/** The inverse of `scaled`, with trailing zeros trimmed. */
function unscaled(value: bigint): string {
  const s = value.toString().padStart(SCALE_N + 1, '0');
  const whole = s.slice(0, -SCALE_N);
  const frac = s.slice(-SCALE_N).replace(/0+$/, '');
  return frac === '' ? whole : `${whole}.${frac}`;
}

export type AdjustDirection = 'reduce' | 'increase';

export interface AdjustInput {
  readonly direction: AdjustDirection;
  /** The position as the venue reports it: signed, positive long. */
  readonly activePos: string;
  /** Basis points of the CURRENT position, 1..10000. 2500 = 25%. */
  readonly percentBp: number;
  readonly quantityIncrement: string;
  readonly minQuantity: string;
  readonly minNotional: string;
  /** The price the resulting order will be legalised against. */
  readonly price: string;
}

export type AdjustPlan =
  | {
      readonly ok: true;
      readonly quantity: string;
      readonly side: 'buy' | 'sell';
      /** True when this is the whole position — the caller should use `positions/exit`. */
      readonly isFull: boolean;
    }
  | { readonly ok: false; readonly code: string; readonly detail: string };

/**
 * Size one adjust of a position.
 *
 * A FLAT or absent position is refused outright: there is nothing to reduce, and
 * "increase from flat" is opening a position — a different action with its own
 * leverage and margin decisions, not something to reach by sending 25% of zero.
 */
export function planAdjustment(input: AdjustInput): AdjustPlan {
  if (!Number.isInteger(input.percentBp) || input.percentBp <= 0 || input.percentBp > 10_000) {
    return { ok: false, code: 'bad_percent', detail: `percentBp must be a whole 1..10000, got ${String(input.percentBp)}` };
  }

  const pos = scaled(input.activePos.replace(/^-/, ''), 'active_pos');
  if (pos === 0n) {
    return { ok: false, code: 'no_position', detail: 'this pair has no open position to adjust' };
  }

  // The side is the OPPOSITE of the position when reducing: selling a long closes
  // it, buying a short closes it. Getting this backwards doubles the position
  // instead of halving it, so it is derived from the venue's sign, never from the
  // caller's intent.
  const isLong = !input.activePos.startsWith('-');
  const side = input.direction === 'reduce'
    ? (isLong ? 'sell' : 'buy')
    : (isLong ? 'buy' : 'sell');

  const raw = (pos * BigInt(input.percentBp)) / 10_000n;
  if (raw === 0n) {
    return { ok: false, code: 'too_small', detail: `${input.percentBp / 100}% of this position rounds to nothing` };
  }

  const step = scaled(input.quantityIncrement, 'quantity_increment');
  if (step === 0n) {
    // A zero step means the venue gave us no quantization rule. Rounding against
    // it is impossible and inventing one is how you land off-step or oversized.
    return { ok: false, code: 'no_step', detail: 'the instrument reports a zero quantity_increment; refusing to guess a step' };
  }

  // DOWN. Not a stylistic choice: up is the direction that can exceed the
  // position and flip it.
  let quantity = (raw / step) * step;
  if (quantity > pos) quantity = pos;              // belt-and-braces against a race
  if (quantity === 0n) {
    return {
      ok: false,
      code: 'below_step',
      detail: `${input.percentBp / 100}% is smaller than one quantity step (${input.quantityIncrement})`,
    };
  }

  const minQuantity = scaled(input.minQuantity, 'min_quantity');
  if (quantity < minQuantity) {
    // REFUSED, not rounded up. Nudging a size up to clear a floor is the same
    // mistake as rounding up, one decimal place later.
    return {
      ok: false,
      code: 'below_min_quantity',
      detail: `${unscaled(quantity)} is below the minimum quantity ${input.minQuantity}`,
    };
  }

  const price = scaled(input.price, 'price');
  const notional = (quantity * price) / 10n ** ADJUST_SCALE;
  const minNotional = scaled(input.minNotional, 'min_notional');
  if (minNotional > 0n && notional < minNotional) {
    return {
      ok: false,
      code: 'below_min_notional',
      detail: `that slice is worth ${unscaled(notional)}, below the minimum notional ${input.minNotional}`,
    };
  }

  return {
    ok: true,
    quantity: unscaled(quantity),
    side,
    // The caller promotes a full close to `positions/exit`: one atomic venue call
    // rather than an opposite order racing fills and funding (research/04).
    isFull: quantity === pos,
  };
}
