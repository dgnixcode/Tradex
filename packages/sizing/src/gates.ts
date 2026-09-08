// The twelve live-state gates — plan/phase-04 T04.4, composing the pure sizing
// core (T03) with the account state a plan must be checked against (08 F3).
//
// `size()` is pure and deliberately state-free: it was told that "deciding WHAT
// is fresh enough is Phase 04's job, not this core's". This file is that job. It
// wraps `size()` in the gates that turn a customer's intent for one account into
// either a concrete, legal, affordable, permitted order or a NAMED skip.
//
// The gates, in the order they run — cheapest first, so the first failure names
// the most fundamental problem and no DB work is done for an order a killed
// platform would refuse anyway:
//
//    1  kill switches      platform kill / read-only mode / tenant paused
//    2  account status     the account is active
//    3  credential status  the credential is active (a key exists and validated)
//    4  market resolution  the asset resolves to a fundable, tradable market
//    5  order type         the market allows the requested type
//   6-9 sizing + legalise  effective minimum, min notional, maximum, sufficiency
//                          — these live INSIDE size()/legalise(), not re-done here
//   9b  slippage guard     a market order will not fill far from the touch (T04.11)
//   10  per-account cap    the notional is within the tenant's per-order cap
//   11  daily cap          today's total plus this order is within the daily cap
//   12  in-flight          no unresolved order already exists for (account, market)
//
// Gates 1-3, 10-12 are checked against VALUES the caller supplies, because the
// live state they need — platform flags, account/credential status, the running
// daily total, whether an order is already in flight — is I/O the service does
// once and hands in. That keeps this function pure and every gate trippable in a
// unit test with no database (the 04-gates check does exactly that).
//
// The caps (10, 11) are compared in the ORDER'S quote currency: the service
// converts the tenant's valuation-currency caps into the quote currency via the
// captured fx snapshot, and the daily total is the sum for THIS quote currency.
// Cross-currency aggregation of the daily cap is deferred to Phase 05, which owns
// caps as real send-time enforcement; nothing sends in this phase.

import { cmp, scaledFromMinor } from '@tradex/money';
import type { MarketRules, OrderBook } from '@tradex/exchange';
import { quoteScaleOf } from './decimal.js';
import type { Intent } from './intents.js';
import { resolveMarket } from './market-resolution.js';
import type { Balance } from '@tradex/exchange';
import { marketOrderSlippage } from './pricing.js';
import type { SlippageVerdict } from './pricing.js';
import { size } from './size.js';
import type { Sized, SizeInput } from './size.js';
import type { Refusal } from './refusals.js';

export type PlatformMode = 'normal' | 'cancel_only' | 'read_only';

/**
 * The live state the gates check against, gathered by the service and passed in
 * as values so the gate function stays pure. Everything money is minor units in
 * the ORDER'S quote currency unless named otherwise.
 */
export interface GateState {
  // gate 1 — kill switches (STUBBED until Phase 05: the service passes the real
  // platform_state and tenant_limit flags, but a killed platform simply refuses;
  // the cancel/read-only nuance becomes meaningful when sending exists).
  readonly platformKillSwitch: boolean;
  readonly platformMode: PlatformMode;
  readonly tenantTradingPaused: boolean;

  // gate 2, 3 — the account and its credential
  readonly accountStatus: string;
  readonly credentialStatus: string | null;

  // gate 4 — resolution inputs: the account's balances and the candidate markets.
  readonly balances: readonly Balance[];
  readonly candidateMarkets: readonly MarketRules[];

  // sizing inputs (gates 6-9 inside size()) — the basis amounts and holdings.
  readonly allocatedCapitalMinor?: string | undefined;
  readonly freeQuoteMinor?: string | undefined;
  readonly equityQuoteMinor?: string | undefined;
  readonly positionQuantity?: string | undefined;

  // gate 9b — the book this leg is priced against, for the slippage guard.
  readonly book: OrderBook;
  readonly slippageToleranceBp?: number | undefined;

  // gates 10, 11 — caps in the quote currency, and today's spend in it.
  readonly perOrderCapMinor: string;
  readonly dailyCapMinor: string;
  readonly dailySpentMinor: string;

  // gate 12 — is there already an unresolved order for this (account, market)?
  readonly hasInFlightForMarket: boolean;
}

/** A gate refusal: a code and a message with numbers where numbers matter. */
export interface GateRefusal {
  readonly code: string;
  readonly message: string;
  readonly offending?: string | undefined;
  readonly limit?: string | undefined;
}

export type GateOutcome =
  | {
      readonly planned: true;
      readonly sized: Sized;
      /** The resolved quote and the reason it was chosen, for the audit record. */
      readonly chosenQuote: string;
      readonly currencyChoiceReason: string;
      readonly alternativeQuotes: readonly string[];
      /** From the slippage guard, for persistence (spread_bp / slippage_bp). */
      readonly spreadBp: string;
      readonly slippageBp: string | null;
      readonly spreadIsWide: boolean;
    }
  | { readonly planned: false; readonly refusal: GateRefusal };

const skip = (code: string, message: string, extra?: { offending?: string; limit?: string }): GateOutcome => ({
  planned: false,
  refusal: { code, message, offending: extra?.offending, limit: extra?.limit },
});

/** Adapt a phase-03 Refusal (from resolveMarket/size) into a gate refusal. */
const fromRefusal = (r: Refusal): GateOutcome => ({
  planned: false,
  refusal: { code: r.code, message: r.message, offending: r.offending, limit: r.limit },
});

export interface PlanAccountInput {
  readonly intent: Intent;
  readonly price: string;
  readonly priceSource: 'ask' | 'bid' | 'limit';
  readonly state: GateState;
}

/**
 * Run all twelve gates for one account. Returns a planned, sized order or the
 * first gate that refused it. Pure: no clock, no I/O, no database.
 */
export function planAccount(input: PlanAccountInput): GateOutcome {
  const { intent, state } = input;

  // 1 — kill switches. A globally killed or read-only platform, or a customer
  // who has hit their own pause, refuses before anything is computed.
  if (state.platformKillSwitch) {
    return skip('PLATFORM_KILLED', 'Trading is halted platform-wide right now. No orders can be placed.');
  }
  if (state.platformMode === 'read_only' || state.platformMode === 'cancel_only') {
    return skip('PLATFORM_READ_ONLY', `The platform is in ${state.platformMode} mode; new orders are not being accepted.`);
  }
  if (state.tenantTradingPaused) {
    return skip('TENANT_PAUSED', 'Trading is paused for this account owner. Resume trading to place orders.');
  }

  // 2 — the account must be active.
  if (state.accountStatus !== 'active') {
    return skip('ACCOUNT_NOT_ACTIVE', `This account is ${state.accountStatus}, not active, so it cannot trade.`);
  }

  // 3 — the credential must be active: a validated key that has not been revoked
  // or locked out. Without it there is nothing to sign a future send with.
  if (state.credentialStatus !== 'active') {
    const detail = state.credentialStatus ?? 'missing';
    return skip('CREDENTIAL_NOT_ACTIVE', `This account's API credential is ${detail}, not active.`);
  }

  // 4 — resolve the asset to a concrete market for this account's balances. This
  // is where INR-vs-USDT and "listed but not fundable" are decided (10 F3).
  const resolved = resolveMarket(intent.asset, state.balances, state.candidateMarkets);
  if ('code' in resolved) return fromRefusal(resolved);

  // 5 — the resolved market must allow the requested order type. legalise()
  // checks this too, but doing it here names the type before sizing runs.
  if (!resolved.rules.allowedTypes.includes(intent.orderType)) {
    return skip('ORDER_TYPE_NOT_ALLOWED', `A ${intent.orderType} order is not allowed on ${resolved.rules.venueSymbol}.`);
  }

  // 6-9 — sizing and legalisation. size() applies the effective minimum, the
  // min-notional floor, the by-order-type maximum and the balance/holding
  // sufficiency check, returning the first failure with its numbers.
  const sizeInput: SizeInput = {
    intent,
    rules: resolved.rules,
    price: input.price,
    priceSource: input.priceSource,
    ...(state.allocatedCapitalMinor !== undefined ? { allocatedCapitalMinor: state.allocatedCapitalMinor } : {}),
    ...(state.freeQuoteMinor !== undefined ? { freeQuoteMinor: state.freeQuoteMinor } : {}),
    ...(state.equityQuoteMinor !== undefined ? { equityQuoteMinor: state.equityQuoteMinor } : {}),
    ...(state.positionQuantity !== undefined ? { positionQuantity: state.positionQuantity } : {}),
    // The buy sufficiency basis: the free quote balance the account can spend.
    ...(intent.side === 'buy' && state.freeQuoteMinor !== undefined
      ? { availableQuoteMinor: state.freeQuoteMinor }
      : {}),
  };
  const sized = size(sizeInput);
  if ('code' in sized) return fromRefusal(sized);

  // 9b — the slippage guard, market orders only. A limit order has a fixed price
  // and cannot slip. Refuses a wide spread or an excessive walked-depth deviation.
  let spreadBp = '0';
  let slippageBp: string | null = '0';
  let spreadIsWide = false;
  if (intent.orderType === 'market') {
    const verdict: SlippageVerdict = marketOrderSlippage(
      state.book,
      intent.side,
      sized.finalQuantity,
      state.slippageToleranceBp,
    );
    if (!verdict.ok) {
      return skip(verdict.code, verdict.message);
    }
    spreadBp = verdict.spreadBp;
    slippageBp = verdict.slippageBp;
    spreadIsWide = verdict.spreadIsWide;
  }

  // 10 — per-order cap. Compared in the quote currency; the service converted the
  // tenant's valuation-currency cap into it.
  const quoteScale = quoteScaleOf(resolved.rules.market.quote);
  const notional = scaledFromMinor(sized.notionalMinor, quoteScale);
  const perOrderCap = scaledFromMinor(state.perOrderCapMinor, quoteScale);
  if (cmp(notional, perOrderCap) > 0) {
    return skip('ABOVE_ORDER_CAP',
      `The order value ${sized.notionalMinor} exceeds this account owner's per-order cap of ${state.perOrderCapMinor} `
      + '(minor units). Reduce the size or ask to raise the cap.',
      { offending: sized.notionalMinor, limit: state.perOrderCapMinor });
  }

  // 11 — daily cap. today's spend in this quote currency plus this order.
  const dailyAfter = BigInt(state.dailySpentMinor) + BigInt(sized.notionalMinor);
  if (dailyAfter > BigInt(state.dailyCapMinor)) {
    return skip('ABOVE_DAILY_CAP',
      `This order would take today's total to ${dailyAfter} against a daily cap of ${state.dailyCapMinor} `
      + '(minor units). It has been held back.',
      { offending: String(dailyAfter), limit: state.dailyCapMinor });
  }

  // 12 — no in-flight order for this (account, market). Placing a second while the
  // first is unresolved is how a double-fill happens (X1 protects the row, this
  // protects the intent).
  if (state.hasInFlightForMarket) {
    return skip('ORDER_IN_FLIGHT',
      `This account already has an unresolved order on ${resolved.rules.venueSymbol}. `
      + 'Wait for it to settle before placing another.');
  }

  return {
    planned: true,
    sized,
    chosenQuote: resolved.chosenQuote,
    currencyChoiceReason: resolved.currencyChoiceReason,
    alternativeQuotes: resolved.alternativeQuotes,
    spreadBp,
    slippageBp,
    spreadIsWide,
  };
}

/** The gate codes this module can emit, for the 04-gates check to enumerate. */
export const GATE_CODES = [
  'PLATFORM_KILLED', 'PLATFORM_READ_ONLY', 'TENANT_PAUSED',
  'ACCOUNT_NOT_ACTIVE', 'CREDENTIAL_NOT_ACTIVE',
  'ORDER_TYPE_NOT_ALLOWED',
  'SPREAD_TOO_WIDE', 'EXCESSIVE_SLIPPAGE', 'INSUFFICIENT_DEPTH',
  'ABOVE_ORDER_CAP', 'ABOVE_DAILY_CAP', 'ORDER_IN_FLIGHT',
] as const;
