// The futures adapter port — plan/phase-15 T15.1.
//
// A SIBLING of ExchangeAdapter, not an extension. Futures on CoinDCX are a
// different product with different invariants: no `client_order_id`
// (research/03 Verdict), a 10-second signing window, per-(account, pair)
// leverage, and a `positions/exit` primitive with no idempotency key. Keeping
// this port separate lets a spot-only build compile without dragging the
// futures wiring in, and preserves ADAPTER-BOUNDARY (this file is a .ts port,
// not an implementation).
//
// Every method here maps directly onto a documented CoinDCX endpoint. Nothing
// is hidden or renamed: `positions/exit` is `exitPosition`, `create_tpsl` is
// `attachStopAndTake`. The concrete adapter (packages/exchange-coindcx) will
// implement this port; the FakeVenue will implement it in-process for checks.

import type { CredentialRef, MarketRef } from './adapter.js';

// ------------------------------------------------------------------ order types

/** All order types CoinDCX futures accepts on `orders/create` (research/03 F1). */
export type FuturesOrderType =
  | 'market' | 'limit'
  | 'stop_market' | 'stop_limit'
  | 'take_profit_market' | 'take_profit_limit';

/** Margin currency the account funds the position with (research/04 F19). */
export type FuturesMarginCurrency = 'INR' | 'USDT';

/** How the venue holds margin — cross is USDT-only per research/03 F4. */
export type FuturesPositionMarginType = 'isolated' | 'crossed';

/** The trigger's price reference. Mark is the venue default; last is opt-in. */
export type FuturesTriggerRef = 'mark' | 'last';

// ------------------------------------------------------------------ instruments

/**
 * A perpetual futures instrument. Contract size on CoinDCX is (per research/04)
 * effectively 1 coin per contract; keep the field explicit so a future venue
 * with a real multiplier doesn't force a rewrite.
 */
export interface FuturesInstrument {
  readonly pair: string;
  readonly baseAsset: string;
  readonly quoteAsset: string;
  readonly marginCurrency: FuturesMarginCurrency;
  readonly contractSize: string;
  readonly priceIncrement: string;
  readonly quantityIncrement: string;
  readonly minQuantity: string;
  readonly maxQuantity: string;
  readonly minNotional: string;
  readonly maxMarketOrderQuantity: string;
  /** Fee rates as decimals (0.0005 = 5 bp). */
  readonly makerFee: string;
  readonly takerFee: string;
  /** Funding cadence in hours (e.g. 8 = every 8 hours). */
  readonly fundingFrequencyHours: number;
  /** When true, the venue accepts only reduce-only orders on this instrument. */
  readonly exitOnly: boolean;
  /**
   * Per-notional leverage tiers, ordered by threshold ascending. The tier a
   * position falls into determines its max leverage. Empty = venue default.
   */
  readonly leverageTiers: readonly {
    readonly upToNotional: string;
    readonly maxLeverage: number;
  }[];
}

// ------------------------------------------------------------------ requests

/**
 * The place-order request for futures. Note the deliberate ABSENCE of a
 * `clientOrderId` field: futures does not accept one (research/03 Verdict). The
 * anti-duplicate spine is the per-(account, pair) lock + read-back at a layer
 * above this port; the port itself just sends what it is given.
 */
export interface FuturesPlaceOrderRequest {
  readonly pair: string;
  readonly side: 'buy' | 'sell';
  readonly orderType: FuturesOrderType;
  readonly quantity: string;
  /** Required for limit + stop_limit + take_profit_limit; ignored otherwise. */
  readonly price?: string | undefined;
  /** Required for stop_* and take_profit_*; ignored on plain market/limit. */
  readonly triggerPrice?: string | undefined;
  readonly leverage: number;
  readonly marginCurrency: FuturesMarginCurrency;
  readonly positionMarginType: FuturesPositionMarginType;
  /**
   * NOT TRANSMITTED, AND NOT A GUARD. Kept only so callers compile while the
   * field is retired.
   *
   * The futures API has no `reduce_only` (research/04, VERIFIED by exhaustive
   * grep; research/03's create contract does not list it), so the adapter no
   * longer sends it. It never protected anything anyway: an order that reduces a
   * position is an ordinary opposite-side order, and one sized above
   * `abs(active_pos)` closes the position and OPENS THE OPPOSITE ONE — research/04
   * calls that the worst case in the document.
   *
   * The guard that works is arithmetic, and it belongs to the caller:
   *   qty = min(requested, abs(active_pos)), rounded DOWN to the quantity step,
   *   refused if that lands below min_quantity or min_notional, with 100% promoted
   *   to `positions/exit`, and `sign(active_pos)` asserted unchanged or zero after.
   */
  readonly reduceOnly: boolean;
  /**
   * The client-side deadline in ms since epoch. The adapter refuses to sign if
   * `Date.now() > deadlineMs - guardMs`, so the venue's own 10-second stale
   * rejection is never the first line of defence.
   */
  readonly deadlineMs: number;
}

/** Attach one or both conditional orders to an existing position. */
export interface AttachStopAndTakeRequest {
  readonly positionId: string;
  readonly stopLoss?: {
    readonly triggerPrice: string;
    readonly orderType: 'stop_market' | 'stop_limit';
    readonly price?: string | undefined;
    readonly triggerRef?: FuturesTriggerRef | undefined;
  } | undefined;
  readonly takeProfit?: {
    readonly triggerPrice: string;
    readonly orderType: 'take_profit_market' | 'take_profit_limit';
    readonly price?: string | undefined;
    readonly triggerRef?: FuturesTriggerRef | undefined;
  } | undefined;
}

/** Per-leg outcome from `create_tpsl` — partial success at HTTP 200 is real. */
export interface AttachStopAndTakeOutcome {
  readonly stopLoss: { readonly ok: true; readonly venueOrderId: string }
    | { readonly ok: false; readonly reason: string }
    | { readonly skipped: true }
    | undefined;
  readonly takeProfit: { readonly ok: true; readonly venueOrderId: string }
    | { readonly ok: false; readonly reason: string }
    | { readonly skipped: true }
    | undefined;
}

// ------------------------------------------------------------------ positions

export interface FuturesPositionSnapshot {
  readonly venuePositionId: string;
  readonly pair: string;
  readonly marginCurrency: FuturesMarginCurrency;
  /** Signed base quantity: positive = long, negative = short, 0 = closed. */
  readonly activePos: string;
  readonly avgEntryPrice: string | null;
  /**
   * Mark price is stale-by-design in the REST payload (research/04 F2 "not
   * real-time and is only for reference"). Real-time updates arrive on the
   * socket; this port returns whatever the REST call last saw.
   */
  readonly markPrice: string | null;
  readonly liquidationPrice: string | null;
  readonly leverage: number | null;
  readonly lockedMarginMinor: string | null;
  readonly stopLossTrigger: string | null;
  readonly takeProfitTrigger: string | null;
  readonly marginType: FuturesPositionMarginType | null;
  readonly fundingRateBp: number | null;
  readonly settlementCurrencyAvgPrice?: string | null;
  readonly observedAtMs: number;
  readonly updatedAtMs?: number | null;
}

/** The response shape of a futures order create — no `clientOrderId` echo. */
export interface FuturesOrderSnapshot {
  readonly venueOrderId: string;
  readonly pair: string;
  readonly side: 'buy' | 'sell';
  readonly orderType: FuturesOrderType;
  readonly quantity: string;
  readonly filledQuantity: string;
  readonly avgFillPrice: string | null;
  readonly leverage: number;
  readonly marginCurrency: FuturesMarginCurrency;
  readonly venueStatusRaw: string;
  readonly triggerState: 'untriggered' | 'triggered' | 'expired' | null;
}

// ------------------------------------------------------------------ the port

export interface FuturesAdapter {
  readonly venue: string;

  // --- public reads ---
  listFuturesInstruments(margin: FuturesMarginCurrency): Promise<readonly FuturesInstrument[]>;

  // --- authenticated reads ---
  getFuturesPositions(credential: CredentialRef, margin: FuturesMarginCurrency): Promise<readonly FuturesPositionSnapshot[]>;
  /**
   * Recent orders for one pair. Substitutes for `findOrderByClientId` in the
   * anti-duplicate spine: after a signed send with no coid, the worker asks the
   * venue what it accepted in the last N seconds for this (account, pair) and
   * matches against its own submitted intent.
   */
  listRecentOrders(credential: CredentialRef, pair: string, marginCurrency: FuturesMarginCurrency, sinceMs: number): Promise<readonly FuturesOrderSnapshot[]>;

  // --- authenticated writes ---
  /**
   * Set (or change) the leverage the account uses for this pair. Required
   * before an order whose leverage differs from the position's — the venue
   * rejects with 422 otherwise (research/03 F5).
   */
  updateLeverage(credential: CredentialRef, pair: string, marginCurrency: FuturesMarginCurrency, leverage: number): Promise<void>;

  placeFuturesOrder(credential: CredentialRef, request: FuturesPlaceOrderRequest): Promise<FuturesOrderSnapshot>;

  /**
   * Attach a stop-loss and/or take-profit to an existing position. Not an
   * upsert — moving a TP is a cancel of the untriggered TP order followed by
   * a fresh call here. Per-leg partial success at HTTP 200 is normal.
   */
  attachStopAndTake(credential: CredentialRef, request: AttachStopAndTakeRequest): Promise<AttachStopAndTakeOutcome>;

  /**
   * Cancel every UNTRIGGERED conditional attached to a position. The mandatory
   * first step of a safe hard-exit (research/04 Q(a)) — a stale SL after an
   * exit will open an opposite position when it triggers.
   */
  cancelAllForPosition(credential: CredentialRef, positionId: string): Promise<void>;

  /**
   * Close a position at market. NOT idempotent (research/04 F11) — the layer
   * above must hold the per-(account, pair) lock and refuse concurrent calls.
   * Returns the venue's `group_id` (an internal split identifier), or null if
   * the venue answered without one.
   */
  exitPosition(credential: CredentialRef, positionId: string): Promise<{ readonly venueGroupId: string | null }>;

  /** Add or remove margin from an isolated position. Amount in margin-currency minor. */
  addPositionMarginMinor(credential: CredentialRef, positionId: string, amountMinor: string): Promise<void>;
  removePositionMarginMinor(credential: CredentialRef, positionId: string, amountMinor: string): Promise<void>;
}

// ------------------------------------------------------------------ helpers

/**
 * The pair form the venue expects on `orders/create` — one of the two shapes
 * that appear across the docs: `B-{ASSET}_{QUOTE}` for USDT-margined,
 * `INR-{ASSET}_INR` for INR-margined. Kept here so both the concrete adapter
 * and the test venue construct pairs the same way.
 */
export function futuresPairOf(market: MarketRef, _marginCurrency: FuturesMarginCurrency): string {
  if (market.quote === 'INR') return `INR-${market.asset}_INR`;
  return `B-${market.asset}_${market.quote}`;
}
