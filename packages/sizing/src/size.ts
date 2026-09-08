// The sizing orchestrator — plan/phase-03, composing the pure pieces.
//
// `size()` turns one intent for one account into either a concrete, legal order
// (`Sized`) or a named refusal. It is pure: every input is a value, every output
// is a value, no clock, no I/O. The live state it needs — the resolved market,
// the execution price, the account's basis amounts and holdings — is passed in,
// because deciding WHAT is fresh enough is Phase 04's job, not this core's.
//
// The output carries its whole derivation: the basis it used, the amount of that
// basis, the fee and TDS rates assumed, the price and its source, and the market
// metadata version it was legalised against. That record is what lets a fill
// months later be explained, and what makes the confirmation screen able to show
// why the largest account in a group got a different quantity from the smallest.

import { div, mul, scaledFromMinor } from '@tradex/money';
import type { Scale, Scaled } from '@tradex/money';
import type { MarketRules } from '@tradex/exchange';
import { nat, GUARD_SCALE, quoteScaleOf, toStr } from './decimal.js';
import { basisOf } from './intents.js';
import type { Intent, SizingBasis } from './intents.js';
import { legalise } from './legalise.js';
import { applyHoldback, floorQuantity, holdbackRates } from './rounding.js';
import { refuse } from './refusals.js';
import type { Refusal } from './refusals.js';

export type PriceSource = 'ask' | 'bid' | 'limit';

export interface SizeInput {
  readonly intent: Intent;
  readonly rules: MarketRules;
  /** Execution price: ask for a buy, bid for a sell, or the customer's limit. */
  readonly price: string;
  readonly priceSource: PriceSource;
  /** pct_allocated basis — the capital typed at onboarding, quote minor units. */
  readonly allocatedCapitalMinor?: string | undefined;
  /** pct_free basis — spendable balance in the quote currency, minor units. */
  readonly freeQuoteMinor?: string | undefined;
  /** pct_equity basis — free + holdings value in the quote currency, minor units. */
  readonly equityQuoteMinor?: string | undefined;
  /** Held quantity of the asset — the basis for pct_position and sell_all. */
  readonly positionQuantity?: string | undefined;
  /** The free quote balance available to spend, for the buy sufficiency check. */
  readonly availableQuoteMinor?: string | undefined;
}

export interface Sized {
  readonly ok: true;
  readonly market: string;
  readonly side: 'buy' | 'sell';
  readonly orderType: 'market' | 'limit';
  /** The quantity BEFORE the market's step/precision floor — capture-or-lose (14 F2). */
  readonly rawQuantity: string;
  readonly finalQuantity: string;
  readonly priceUsed: string;
  readonly priceSource: PriceSource;
  readonly notionalMinor: string;
  readonly basisUsed: SizingBasis | null;
  readonly basisAmountMinor: string | null;
  readonly feeRateAssumed: string;
  readonly tdsRateApplied: string;
  readonly marketMetaVersion: string;
}

/** A percentage in basis points as a Scaled at scale 4, so 2000bp = 0.2000. */
const asRate = (basisPoints: number): Scaled => ({ v: BigInt(basisPoints), scale: 4 });

interface BuyBudget {
  readonly budgetMinor: Scaled;
  readonly basis: SizingBasis | null;
  readonly basisAmountMinor: string | null;
}

/**
 * The quote budget a buy starts from, before holdback. `quote_amount` is the
 * amount itself; a percentage mode multiplies its basis by the percentage. A
 * percentage mode whose basis was not supplied refuses with NO_BASIS_AMOUNT
 * rather than sizing against zero.
 */
function buyBudget(input: SizeInput, quoteScale: Scale): BuyBudget | Refusal {
  const { intent } = input;
  if (intent.side !== 'buy') throw new Error('buyBudget called for a sell');

  if (intent.mode === 'quote_amount') {
    return {
      budgetMinor: scaledFromMinor(intent.quoteAmountMinor, quoteScale),
      basis: null,
      basisAmountMinor: intent.quoteAmountMinor,
    };
  }

  const sources: Record<'pct_allocated' | 'pct_free' | 'pct_equity', { amount: string | undefined; label: string; basis: SizingBasis }> = {
    pct_allocated: { amount: input.allocatedCapitalMinor, label: 'allocated capital', basis: 'allocated' },
    pct_free: { amount: input.freeQuoteMinor, label: 'free balance', basis: 'free' },
    pct_equity: { amount: input.equityQuoteMinor, label: 'account equity', basis: 'equity' },
  };
  if (intent.mode === 'base_quantity') throw new Error('base_quantity is not budget-sized');
  const src = sources[intent.mode];
  if (src.amount === undefined) return refuse('NO_BASIS_AMOUNT', { detail: src.label });
  const basisMinor = scaledFromMinor(src.amount, quoteScale);
  return {
    budgetMinor: mul(basisMinor, asRate(intent.percent.basisPoints), quoteScale),
    basis: src.basis,
    basisAmountMinor: src.amount,
  };
}

/** The base quantity a sell asks for, before flooring. */
function sellQuantity(input: SizeInput, price: Scaled, quoteScale: Scale): Scaled | Refusal {
  const { intent } = input;
  if (intent.side !== 'sell') throw new Error('sellQuantity called for a buy');
  switch (intent.mode) {
    case 'sell_all':
      if (input.positionQuantity === undefined) return refuse('NO_BASIS_AMOUNT', { detail: 'position' });
      return nat(input.positionQuantity);
    case 'pct_position':
      if (input.positionQuantity === undefined) return refuse('NO_BASIS_AMOUNT', { detail: 'position' });
      return mul(nat(input.positionQuantity), asRate(intent.percent.basisPoints), GUARD_SCALE);
    case 'base_quantity':
      return nat(intent.baseQuantity);
    case 'quote_amount':
      return div(scaledFromMinor(intent.quoteAmountMinor, quoteScale), price, GUARD_SCALE);
    default:
      return refuse('NO_BASIS_AMOUNT', { detail: 'a sell quantity' });
  }
}

export function size(input: SizeInput): Sized | Refusal {
  const { intent, rules } = input;
  const price = nat(input.price);
  const quoteScale = quoteScaleOf(rules.market.quote);
  const rates = holdbackRates(rules.market.quote);

  let rawQty: Scaled;
  let basis: SizingBasis | null = basisOf(intent);
  let basisAmountMinor: string | null = null;
  let feeRate = '0';
  let tdsRate = '0';

  if (intent.side === 'buy') {
    if (intent.mode === 'base_quantity') {
      rawQty = nat(intent.baseQuantity); // an explicit quantity is not holdback-adjusted
    } else {
      const budget = buyBudget(input, quoteScale);
      if ('code' in budget) return budget;
      basis = budget.basis;
      basisAmountMinor = budget.basisAmountMinor;
      const held = applyHoldback(budget.budgetMinor, rules.market.quote);
      feeRate = rates.feeRate;
      tdsRate = rates.tdsRate;
      rawQty = div(held.spendableMinor, price, GUARD_SCALE);
    }
  } else {
    const q = sellQuantity(input, price, quoteScale);
    if ('code' in q) return q;
    rawQty = q;
  }

  const finalQuantity = floorQuantity(rawQty, rules);

  const legal = legalise({
    rules,
    side: intent.side,
    orderType: intent.orderType,
    quantity: finalQuantity,
    price,
    ...(intent.side === 'sell' && input.positionQuantity !== undefined
      ? { availableQuantity: nat(input.positionQuantity) }
      : {}),
    ...(intent.side === 'buy' && input.availableQuoteMinor !== undefined
      ? { availableQuoteMinor: scaledFromMinor(input.availableQuoteMinor, quoteScale) }
      : {}),
  });
  if ('code' in legal) return legal;

  return {
    ok: true,
    market: rules.venueSymbol,
    side: intent.side,
    orderType: intent.orderType,
    rawQuantity: toStr(rawQty),
    finalQuantity: toStr(finalQuantity),
    priceUsed: input.price,
    priceSource: input.priceSource,
    notionalMinor: String(legal.notionalMinor.v),
    basisUsed: basis,
    basisAmountMinor,
    feeRateAssumed: feeRate,
    tdsRateApplied: tdsRate,
    marketMetaVersion: rules.rulesVersion,
  };
}
