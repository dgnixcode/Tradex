// The exchange port — plan/phase-01 T01.1.
//
// Written entirely in Tradex's vocabulary. Nothing CoinDCX-shaped appears here:
// no `total_quantity`, no `ecode`, no `base_currency` (which on CoinDCX means the
// QUOTE asset — 01), no `market` versus `pair` ambiguity leaking upward.
//
// The boundary exists for a contractual reason rather than an architectural one.
// CoinDCX's API Terms clause 5.2 lets them terminate access "without any notice
// … and without assigning any reason", with all claims waived (15 F1). A CI rule
// forbids importing @tradex/exchange-coindcx above this layer, so that clause
// costs us an adapter rather than a rewrite.

/** Our own market identity. The adapter maps this to whatever the venue calls it. */
export interface MarketRef {
  /** Asset being traded, e.g. 'BTC'. */
  readonly asset: string;
  /** Currency the order is priced and funded in. */
  readonly quote: 'INR' | 'USDT';
}

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';

/** Our canonical order states (12 F1). Venue vocabularies map into these. */
export type OrderState =
  | 'acked'
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'partially_cancelled'
  | 'rejected'
  | 'unknown';

/** Everything needed to legalise an order, in our names not the venue's. */
export interface MarketRules {
  readonly market: MarketRef;
  /** Venue-native identifier, opaque above the adapter. */
  readonly venueSymbol: string;
  readonly tradable: boolean;
  /** Quantity must be an exact multiple of this. */
  readonly quantityStep: string;
  readonly quantityPrecision: number;
  readonly pricePrecision: number;
  readonly minQuantity: string;
  readonly maxQuantity: string;
  /** Market orders have their own bounds, far tighter than the limit bounds (09 F6). */
  readonly minMarketQuantity: string | null;
  readonly maxMarketQuantity: string | null;
  /** Minimum order value, in the quote currency's minor units. */
  readonly minNotionalMinor: string;
  readonly minPrice: string;
  readonly maxPrice: string;
  readonly allowedTypes: readonly OrderType[];
  /** Which venue routes this book. Failures cluster by venue (10 F2). */
  readonly venueCode: string;
  /** Monotonic version of the rules snapshot an order was legalised against. */
  readonly rulesVersion: string;
}

export interface BookLevel {
  readonly price: string;
  readonly quantity: string;
}

export interface OrderBook {
  readonly market: MarketRef;
  readonly bids: readonly BookLevel[];
  readonly asks: readonly BookLevel[];
  readonly observedAtMs: number;
}

export interface Balance {
  readonly currency: string;
  /** Spendable. A sell sizes against this, never against free + locked (11 F1). */
  readonly freeMinor: string;
  readonly lockedMinor: string;
  readonly scale: number;
}

export interface PlaceOrderRequest {
  readonly market: MarketRef;
  readonly side: OrderSide;
  readonly type: OrderType;
  readonly quantity: string;
  /** Required for a limit order, absent for a market order. */
  readonly limitPrice?: string;
  /** Our deterministic idempotency key. Spot only — futures has none (03). */
  readonly clientOrderId: string;
}

export interface OrderSnapshot {
  readonly clientOrderId: string | null;
  readonly venueOrderId: string;
  readonly state: OrderState;
  /** The literal string the venue sent, kept for forensics (12). */
  readonly venueStateRaw: string;
  readonly filledQuantity: string;
  readonly remainingQuantity: string;
  readonly cancelledQuantity: string;
  readonly averageFillPrice: string | null;
  readonly feeMinor: string | null;
  /** Set when the venue split one order into parts (03 G11). */
  readonly venueGroupId: string | null;
  readonly observedAtMs: number;
}

export interface Fill {
  readonly venueTradeId: string;
  readonly venueOrderId: string;
  readonly venueSymbol: string;
  readonly side: OrderSide;
  readonly quantity: string;
  readonly price: string;
  readonly feeMinor: string;
  readonly occurredAtMs: number;
}

/**
 * The credential handle. Deliberately opaque: the adapter receives an id and
 * asks the signer, so no exchange code ever holds key material.
 */
export interface CredentialRef {
  readonly credentialId: string;
}

/**
 * Signing is injected rather than implemented, so the adapter has no path to a
 * plaintext secret. apps/signer is the only implementation.
 */
export interface RequestSigner {
  sign(
    credential: CredentialRef,
    params: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly body: string; readonly headers: Readonly<Record<string, string>> }>;
}

export interface ExchangeAdapter {
  readonly venue: string;

  // --- public, unauthenticated ---
  listMarketRules(): Promise<readonly MarketRules[]>;
  getOrderBook(market: MarketRef, depth: number): Promise<OrderBook>;

  // --- authenticated reads ---
  getBalances(credential: CredentialRef): Promise<readonly Balance[]>;
  /**
   * Resolve an order by OUR id. This is the primitive that makes an ambiguous
   * create recoverable (08 F6), and the reason v1 is spot-only.
   */
  findOrderByClientId(credential: CredentialRef, clientOrderId: string): Promise<OrderSnapshot | null>;
  listOpenOrders(credential: CredentialRef, market: MarketRef): Promise<readonly OrderSnapshot[]>;
  /** Market-agnostic. The only detector of activity we did not cause (12 Loop C). */
  listFillsSince(credential: CredentialRef, sinceMs: number): Promise<readonly Fill[]>;

  // --- authenticated writes ---
  placeOrder(credential: CredentialRef, request: PlaceOrderRequest): Promise<OrderSnapshot>;
  cancelOrder(credential: CredentialRef, clientOrderId: string): Promise<void>;
}

/** Failure classes (08 F2). `retrySafe` is the field that matters. */
export type FailureClass =
  | 'accepted'
  | 'business_rejection'
  | 'auth_failure'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  /** Never reached the venue (DNS, connection refused) — provably no order. */
  | 'connect_failure'
  | 'signature_error'
  | 'not_found'
  | 'unknown';

export interface ClassifiedFailure {
  readonly class: FailureClass;
  /** Whether the order may exist despite the failure. Drives the resolve ladder. */
  readonly orderMayExist: boolean;
  /** Whether re-sending the same request is safe. Never true for a rejection. */
  readonly retrySafe: boolean;
  /** Normalised reason code, safe to show a customer. */
  readonly code: string;
  readonly detail: string;
}

export class ExchangeError extends Error {
  override readonly name = 'ExchangeError';
  constructor(
    readonly failure: ClassifiedFailure,
    message?: string,
  ) {
    super(message ?? `${failure.class}: ${failure.detail}`);
  }
}
