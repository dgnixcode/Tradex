// Sell re-derivation at send time — plan/phase-09 T09.2/T09.3/T09.4.
//
// The venue is the only truth about what an account holds. Our projected balances
// (account_balance rows) can be stale the moment an outside deposit, withdrawal or
// manual trade lands, so a sell that sizes against our projection can over- or
// under-sell (invariant S2). The plan therefore re-derives the sell quantity from
// a FRESH free-balance read immediately before the order is sent. This module is
// that re-derivation, kept PURE so it can be unit-proven in isolation: it takes
// the planned quantity and the fresh holding as plain decimals and returns either
// the quantity to send (with the clamp record) or a skip reason.
//
// The rules it lives by:
//
//   - A sell sizes against FREE only, never free + locked (11 F1): locked is what
//     an open order is holding and cannot be sold.
//   - A holding below the market's EFFECTIVE minimum (the max of min_quantity,
//     the step and the precision floor — effective-min.ts) is DUST: unsellable,
//     and excluded from a sell-all without failing the trade.
//   - A holding that is fully locked (free 0, locked > 0) is skipped as
//     HOLDING_LOCKED with an offer to cancel the open order first.
//   - The quantity is CLAMPED DOWN to the fresh holding, never up. Every
//     down-adjustment from the planned quantity is recorded in
//     `clampedFromQuantity` so the child_order row (and the report) can show that
//     a clamp happened. There is no code path that increases a quantity: the
//     intended size is always min(what was asked, the fresh holding).
//
// `sell_all` is the one deliberate exception to "never exceed the plan": its whole
// meaning is "sell the CURRENT holding", so a holding that GREW between preview and
// send is sold at the larger size (that is the T09.2 acceptance — the sent
// quantity reflects the fresh read, both directions). The never-clamp-up rule is
// about never sending MORE than the holding, which is structurally impossible here.

import type { MarketRules } from '@tradex/exchange';
import { cmp, mul, scaledFromString } from '@tradex/money';
import type { Scaled } from '@tradex/money';
import { effectiveMinQty } from './effective-min.js';
import { floorQuantity } from './rounding.js';
import { nat, toStr, GUARD_SCALE } from './decimal.js';

export type SellResizeMode = 'sell_all' | 'pct_position' | 'fixed';

export interface SellResizeInput {
  readonly mode: SellResizeMode;
  /** pct_position basis points (e.g. 5000 = 50%). Ignored in the other modes. */
  readonly percentBp?: number | undefined;
  /** The quantity the plan produced (plain decimal). The clamp ceiling for `fixed`. */
  readonly plannedQuantity: string;
  /** Fresh FREE holding of the base asset, plain decimal (the sell's basis). */
  readonly free: string;
  /** Fresh LOCKED holding of the base asset, plain decimal (reserved by open orders). */
  readonly locked: string;
  readonly orderType: 'market' | 'limit';
  /** The market rules the quantity must stay legal against (step/precision/min). */
  readonly rules: MarketRules;
}

export type SellResizeSkipCode = 'HOLDING_LOCKED' | 'NO_HOLDING' | 'DUST';

export type SellResizeOutcome =
  | {
      readonly kind: 'send';
      /** The quantity to send, already floored to the market step + precision. */
      readonly quantity: string;
      /** The planned quantity that was clamped away — null when nothing shrank. */
      readonly clampedFromQuantity: string | null;
    }
  | {
      readonly kind: 'skip';
      readonly code: SellResizeSkipCode;
      /** The reason a human (or the report) can act on. */
      readonly detail: string;
    };

const ZERO: Scaled = scaledFromString('0', 0);

/** A percentage in basis points at scale 4, so 5000bp = 0.5000. */
function asRate(basisPoints: number): Scaled {
  return { v: BigInt(basisPoints), scale: 4 };
}

/**
 * Re-derive a sell's quantity from the fresh holding. Pure: no clock, no I/O.
 *
 * Returns a skip when the holding cannot legally be sold at all (dust, fully
 * locked, or absent). Otherwise returns the floored quantity with the clamp
 * record, where the quantity is never more than the fresh free holding and a
 * down-adjustment from the plan is always recorded.
 */
export function resizeSellForSend(input: SellResizeInput): SellResizeOutcome {
  const { rules, orderType } = input;
  const free = nat(input.free);
  const locked = nat(input.locked);
  const min = effectiveMinQty(rules, orderType);

  // The holding the sell can reach: FREE only. Zero free is either fully locked
  // by an open order (offer to cancel first) or simply absent.
  if (cmp(free, ZERO) === 0) {
    if (cmp(locked, ZERO) > 0) {
      return {
        kind: 'skip', code: 'HOLDING_LOCKED',
        detail: `the holding is fully locked by an open order — cancel it first to free ${toStr(locked)}`,
      };
    }
    return { kind: 'skip', code: 'NO_HOLDING', detail: 'the account holds none of this asset free to sell' };
  }

  // The intended size: what the mode asks for, never exceeding the fresh holding.
  let intended: Scaled;
  if (input.mode === 'sell_all') {
    intended = free; // sell-all means sell the CURRENT free holding, whatever it is
  } else if (input.mode === 'pct_position') {
    const bp = input.percentBp ?? 0;
    intended = mul(free, asRate(bp), GUARD_SCALE); // a fraction of free can never exceed free
  } else {
    intended = nat(input.plannedQuantity);
    if (cmp(intended, free) > 0) intended = free; // the only clamp-up guard that can fire
  }

  // A holding that is itself below the effective minimum is DUST — it cannot be
  // sold in any legal size, and a sell-all across accounts must exclude it rather
  // than fail the whole trade.
  if (cmp(free, min) < 0) {
    return {
      kind: 'skip', code: 'DUST',
      detail: `the account holds only ${toStr(free)} of ${rules.market.asset}, below this market's effective minimum of ${toStr(min)} — dust is not sellable`,
    };
  }

  // Floor to the market's step and precision (always down), then re-check the
  // minimum: flooring a holding that is barely above the minimum can drop it below.
  const floored = floorQuantity(intended, rules);
  if (floored.v === 0n || cmp(floored, min) < 0) {
    return {
      kind: 'skip', code: 'DUST',
      detail: `the sellable quantity ${toStr(free)} floors below this market's effective minimum of ${toStr(min)}`,
    };
  }

  const quantity = toStr(floored);
  // Record every down-adjustment from the plan; never a no-op. (sell_all/pct may
  // legitimately send MORE than a stale plan when the holding grew — that is the
  // fresh read working, not a clamp up.)
  const planned = nat(input.plannedQuantity);
  const clampedFromQuantity = cmp(planned, floored) > 0 ? input.plannedQuantity : null;
  return { kind: 'send', quantity, clampedFromQuantity };
}
