// The CoinDCX futures adapter — plan/phase-15 T15.2.
//
// A sibling of order-client.ts (spot). The load-bearing differences are three,
// and every function in this file is shaped by them:
//
//   1. NO client_order_id on futures (research/03 Verdict). We do not send one,
//      the venue would ignore it if we did. The anti-duplicate spine lives
//      ABOVE this adapter as a per-(account, pair) row lock + read-back via
//      `listRecentFuturesOrders`. This file just signs and sends what it is
//      given — anti-duplicate is not its job.
//
//   2. 10-second signing window (research/03 F4): "Orders with a delay of more
//      than 10 seconds will be rejected". `deadlineMs` is REQUIRED on a place
//      call; if the remaining budget is under `SIGN_GUARD_MS` we refuse to
//      sign at all, so the caller learns before a wasted 401 that the queue
//      pushed the message past the venue's window.
//
//   3. `margin_currency_short_name` must ALWAYS be sent (research/04 G8),
//      otherwise INR-margined rows are invisible on the positions read.

import { classify } from '@tradex/exchange';
import type {
  ClassifiedFailure,
  FuturesMarginCurrency,
  FuturesInstrument,
  FuturesOrderSnapshot,
  FuturesOrderType,
  FuturesPlaceOrderRequest,
  FuturesPositionMarginType,
  FuturesPositionSnapshot,
} from '@tradex/exchange';
import type { HttpResult } from './http.js';
import { DEFAULT_DEADLINE_MS, send, TransportError } from './http.js';
import { DEFAULT_BASE_URL } from './probe.js';
import { signBody, plaintextSigner, signRequest } from './signing.js';
import type { BodySigner } from './signing.js';

const FUTURES_CREATE_PATH = '/exchange/v1/derivatives/futures/orders/create';
const FUTURES_POSITIONS_PATH = '/exchange/v1/derivatives/futures/positions';
const FUTURES_LEVERAGE_PATH = '/exchange/v1/derivatives/futures/positions/update_leverage';

/**
 * The client-side signing guard, in ms. Venue rejects at >10 s (research/03 F4);
 * we refuse to even sign a request whose deadline is within this window, so a
 * failed send is a caller-visible refusal not a venue 400. 500 ms comfortably
 * covers a normal round-trip over pooled keep-alive.
 */
export const SIGN_GUARD_MS = 500;

export interface FuturesCallOptions {
  readonly baseUrl?: string | undefined;
  readonly deadlineMs?: number | undefined;
  /** Injected clock; defaults to Date.now(). Only for tests. */
  readonly nowMs?: (() => number) | undefined;
}

export type FuturesPlaceOutcome =
  | { readonly kind: 'accepted'; readonly order: FuturesOrderSnapshot }
  | { readonly kind: 'refused_deadline'; readonly reason: string }
  | { readonly kind: 'rejected'; readonly failure: ClassifiedFailure };

export type FuturesPositionsOutcome =
  | { readonly ok: true; readonly positions: readonly FuturesPositionSnapshot[] }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

export type FuturesLeverageOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

export function toVenueOrderType(orderType: FuturesOrderType): string {
  if (orderType === 'market') return 'market_order';
  if (orderType === 'limit') return 'limit_order';
  return orderType;
}

export function fromVenueOrderType(venueOrderType: string | null): string {
  if (venueOrderType === 'market_order') return 'market';
  if (venueOrderType === 'limit_order') return 'limit';
  return venueOrderType ?? '';
}

function messageFrom(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      if (Array.isArray(parsed)) {
        return JSON.stringify(parsed);
      }
      const row = parsed as { [key: string]: unknown };
      const msg = row['message'] ?? row['error'] ?? row['msg'] ?? row['description'];
      if (typeof msg === 'string' && msg.trim() !== '') return msg;
      if (Array.isArray(row['errors']) && row['errors'].length > 0) {
        return row['errors'].map(String).join(', ');
      }
      return JSON.stringify(parsed);
    }
  } catch { /* fall through */ }
  return body.slice(0, 200);
}

function toOrderSnapshot(row: Record<string, unknown>, request: FuturesPlaceOrderRequest): FuturesOrderSnapshot {
  const statusRaw = typeof row['status'] === 'string' ? (row['status'] as string) : '';
  const asStr = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : v === null || v === undefined ? fallback : String(v));
  return {
    venueOrderId: asStr(row['id'], ''),
    pair: asStr(row['pair'], request.pair),
    side: request.side,
    orderType: request.orderType,
    quantity: asStr(row['total_quantity'], request.quantity),
    filledQuantity: asStr(row['filled_quantity'], '0'),
    avgFillPrice: typeof row['avg_price'] === 'string' ? (row['avg_price'] as string) : null,
    leverage: request.leverage,
    marginCurrency: request.marginCurrency,
    venueStatusRaw: statusRaw,
    triggerState: null, // create response's status is meaningless (research/03 G6)
  };
}

function toPositionSnapshot(row: Record<string, unknown>, observedAtMs: number): FuturesPositionSnapshot | null {
  const asStr = (v: unknown): string | null => (typeof v === 'string' ? v : v === null || v === undefined ? null : String(v));
  const triggerVal = (v: unknown): string | null => {
    const s = asStr(v);
    return (s === null || s === '0' || s === '0.0' || s === '') ? null : s;
  };
  const settlementPeg = (v: unknown): string | null => {
    const s = asStr(v);
    return (s === null || s === '' || Number(s) <= 0 || !Number.isFinite(Number(s))) ? null : s;
  };
  const toLockedMarginMinor = (v: unknown, marginCurr: string, pegStr: string | null): string | null => {
    if (v === null || v === undefined || v === '') return null;
    const num = Number(v);
    if (!Number.isFinite(num)) return null;
    if (marginCurr === 'INR') {
      const peg = pegStr && Number(pegStr) > 0 ? Number(pegStr) : 100;
      return Math.round(num * peg * 100).toString();
    }
    return Math.round(num * 1e8).toString();
  };
  const pair = asStr(row['pair']);
  const activePos = asStr(row['active_pos']);
  const margin = asStr(row['margin_currency_short_name']);
  const venuePositionId = asStr(row['id']);
  if (pair === null || activePos === null || margin === null || venuePositionId === null) return null;
  if (margin !== 'INR' && margin !== 'USDT') return null;
  const peg = settlementPeg(row['settlement_currency_avg_price']);
  const toUpdatedAtMs = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
      const parsed = Date.parse(v);
      if (!Number.isNaN(parsed) && parsed > 0) return parsed;
    }
    return null;
  };
  return {
    venuePositionId,
    pair,
    marginCurrency: margin as FuturesMarginCurrency,
    activePos,
    avgEntryPrice: asStr(row['avg_price']),
    markPrice: asStr(row['mark_price']),
    liquidationPrice: asStr(row['liquidation_price']),
    leverage: (typeof row['leverage'] === 'number') ? (row['leverage'] as number)
      : (typeof row['leverage'] === 'string' && row['leverage'] !== '') ? Number(row['leverage']) : null,
    lockedMarginMinor: toLockedMarginMinor(row['locked_margin'], margin, peg),
    stopLossTrigger: triggerVal(row['stop_loss_trigger']),
    takeProfitTrigger: triggerVal(row['take_profit_trigger']),
    marginType: (row['margin_type'] === 'isolated' || row['margin_type'] === 'crossed')
      ? (row['margin_type'] as FuturesPositionMarginType) : null,
    fundingRateBp: (typeof row['funding_rate_bp'] === 'number') ? (row['funding_rate_bp'] as number) : null,
    settlementCurrencyAvgPrice: peg,
    observedAtMs,
    updatedAtMs: toUpdatedAtMs(row['updated_at']),
  };
}

/**
 * Place a futures order. Refuses to sign if the caller's deadline is within
 * `SIGN_GUARD_MS` — the venue's 10-second rejection is one line of defence, not
 * the first.
 *
 * THE ANTI-DUPLICATE SPINE IS THE CALLER'S RESPONSIBILITY, and it is weaker here
 * than on spot: this endpoint takes NO `client_order_id`, so the venue cannot
 * reject a duplicate for us. The caller must hold `futures_execution_lock` for
 * the (account, pair) before sending and resolve any ambiguity by reading
 * positions — never by re-sending.
 */
export async function submitFuturesOrderSigned(
  sign: BodySigner,
  request: FuturesPlaceOrderRequest,
  opts: FuturesCallOptions = {},
): Promise<FuturesPlaceOutcome> {
  const now = (opts.nowMs ?? Date.now)();
  const budget = request.deadlineMs - now;
  if (budget < SIGN_GUARD_MS) {
    return {
      kind: 'refused_deadline',
      reason: `only ${Math.max(0, budget)}ms remain to sign; the venue rejects anything past 10s (SIGN_GUARD_MS=${SIGN_GUARD_MS})`,
    };
  }
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;

  const orderPayload: Record<string, unknown> = {
    pair: request.pair,
    side: request.side,
    order_type: toVenueOrderType(request.orderType),
    total_quantity: typeof request.quantity === 'string' && Number.isFinite(Number(request.quantity))
      ? Number(request.quantity)
      : request.quantity,
    leverage: request.leverage,
    margin_currency_short_name: request.marginCurrency,
    position_margin_type: request.positionMarginType,
    notification: 'no_notification',
    // `reduce_only` is deliberately NOT sent. research/04 F-line 510 and the
    // invariant table both state, VERIFIED by exhaustive grep, that no such flag
    // exists anywhere in the futures API — and research/03's create contract does
    // not list it. Sending a field the venue does not define is one of two things:
    // ignored (so it protects nothing and a reducing order sized above the
    // position CLOSES IT AND OPENS THE OPPOSITE ONE) or rejected outright (so every
    // futures order fails). The guard that actually works is the CLAMP, applied by
    // the caller before the order is built — see `FuturesPlaceOrderRequest`.
  };
  if (request.price !== undefined) orderPayload['price'] = request.price;
  if (request.triggerPrice !== undefined) orderPayload['stop_price'] = request.triggerPrice;

  // The venue contract (coindcx-docs lines 8857, 8917) expects the order parameters
  // nested under the `order` key: {"timestamp": ..., "order": {...}}.
  const payload: Record<string, unknown> = {
    order: orderPayload,
  };

  const signed = await signBody(sign, payload, now);
  const deadlineMs = Math.min(opts.deadlineMs ?? DEFAULT_DEADLINE_MS, budget);

  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(FUTURES_CREATE_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) {
      // Transport failure ⇒ the venue MAY have received it, and there is no
      // client_order_id to ask about. The caller MUST resolve by reading
      // positions; never re-send blindly.
      return { kind: 'rejected', failure: classify({ transport: err.kind }) };
    }
    throw err;
  }
  if (result.status >= 200 && result.status < 300) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(result.body); } catch { /* fall through */ }
    if (parsed === null) {
      return {
        kind: 'rejected',
        failure: classify({ status: 200, message: 'venue returned a 2xx with unparsable body' }),
      };
    }
    // Venue returns an array e.g. [ { id: "...", ... } ] or an object in fake venue
    const row = Array.isArray(parsed) ? parsed[0] : parsed;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return {
        kind: 'rejected',
        failure: classify({ status: 200, message: 'venue returned a 2xx without order object' }),
      };
    }
    return { kind: 'accepted', order: toOrderSnapshot(row as Record<string, unknown>, request) };
  }
  const errMessage = messageFrom(result.body) || `HTTP ${result.status} (empty body)`;
  return { kind: 'rejected', failure: classify({ status: result.status, message: errMessage }) };
}

/** Sign in-process from a plaintext secret. Checks and the sandbox use this. */
export async function submitFuturesOrder(
  apiKey: string,
  apiSecret: string,
  request: FuturesPlaceOrderRequest,
  opts: FuturesCallOptions = {},
): Promise<FuturesPlaceOutcome> {
  return submitFuturesOrderSigned(plaintextSigner(apiKey, apiSecret), request, opts);
}

/**
 * Read the account's futures positions in one margin currency. `research/04
 * G8`: `margin_currency_short_name` must always be sent — omit it, INR rows
 * are invisible. This client sends it every time.
 */
export async function fetchFuturesPositionsSigned(
  sign: BodySigner,
  marginCurrencies: readonly FuturesMarginCurrency[],
  opts: FuturesCallOptions = {},
): Promise<FuturesPositionsOutcome> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const signed = await signBody(sign, {
    margin_currency_short_name: [...marginCurrencies],
  });
  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(FUTURES_POSITIONS_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) return { ok: false, failure: classify({ transport: err.kind }) };
    throw err;
  }
  if (result.status >= 200 && result.status < 300) {
    let parsed: unknown = null;
    try { parsed = JSON.parse(result.body); } catch { /* fall through */ }
    if (!Array.isArray(parsed)) {
      return { ok: false, failure: classify({ status: 200, message: 'positions response was not an array' }) };
    }
    const observedAtMs = (opts.nowMs ?? Date.now)();
    const positions: FuturesPositionSnapshot[] = [];
    for (const row of parsed) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
      const snap = toPositionSnapshot(row as Record<string, unknown>, observedAtMs);
      if (snap !== null) positions.push(snap);
    }
    return { ok: true, positions };
  }
  return { ok: false, failure: classify({ status: result.status, message: messageFrom(result.body) }) };
}

/** Sign in-process from a plaintext secret. Checks and the sandbox use this. */
export async function fetchFuturesPositions(
  apiKey: string,
  apiSecret: string,
  marginCurrencies: readonly FuturesMarginCurrency[],
  opts: FuturesCallOptions = {},
): Promise<FuturesPositionsOutcome> {
  return fetchFuturesPositionsSigned(plaintextSigner(apiKey, apiSecret), marginCurrencies, opts);
}

/**
 * Set (or change) the leverage for one (pair, marginCurrency). Required before
 * an order whose leverage differs from the current position leverage — the
 * venue rejects with 422 otherwise (research/03 F5).
 */
export async function updateFuturesLeverage(
  apiKey: string,
  apiSecret: string,
  args: { readonly pair: string; readonly marginCurrency: FuturesMarginCurrency; readonly leverage: number },
  opts: FuturesCallOptions = {},
): Promise<FuturesLeverageOutcome> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const signed = signRequest(apiKey, apiSecret, {
    pair: args.pair,
    margin_currency_short_name: args.marginCurrency,
    leverage: args.leverage,
  });
  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(FUTURES_LEVERAGE_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) return { ok: false, failure: classify({ transport: err.kind }) };
    throw err;
  }
  if (result.status >= 200 && result.status < 300) return { ok: true };
  return { ok: false, failure: classify({ status: result.status, message: messageFrom(result.body) }) };
}

const FUTURES_TPSL_PATH = '/exchange/v1/derivatives/futures/positions/create_tpsl';

/**
 * Attach SL and/or TP to an existing position (research/04 F12). The venue can
 * REPORT per-leg partial success at HTTP 200: a body like
 *   {"stop_loss": {...ORDER...}, "take_profit": {"success": false, "error": "TP already exists"}}
 * is normal. So we parse each leg separately.
 */
export type AttachTpSlPerLeg =
  | { readonly ok: true; readonly venueOrderId: string }
  | { readonly ok: false; readonly reason: string };

export type AttachTpSlOutcome =
  | {
      readonly ok: true;
      readonly stopLoss?: AttachTpSlPerLeg | undefined;
      readonly takeProfit?: AttachTpSlPerLeg | undefined;
    }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

export interface AttachTpSlRequest {
  readonly positionId: string;
  readonly stopLoss?: {
    readonly triggerPrice: string;
    readonly orderType: 'stop_market' | 'stop_limit';
    readonly price?: string | undefined;
  } | undefined;
  readonly takeProfit?: {
    readonly triggerPrice: string;
    readonly orderType: 'take_profit_market' | 'take_profit_limit';
    readonly price?: string | undefined;
  } | undefined;
}

export async function attachStopAndTakeSigned(
  sign: BodySigner,
  req: AttachTpSlRequest,
  opts: FuturesCallOptions = {},
): Promise<AttachTpSlOutcome> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const payload: Record<string, unknown> = { id: req.positionId };
  if (req.stopLoss !== undefined) {
    const leg: Record<string, unknown> = {
      stop_price: req.stopLoss.triggerPrice,
      order_type: req.stopLoss.orderType,
    };
    if (req.stopLoss.price !== undefined) {
      leg['price'] = req.stopLoss.price;
      leg['limit_price'] = req.stopLoss.price;
    }
    payload['stop_loss'] = leg;
  }
  if (req.takeProfit !== undefined) {
    const leg: Record<string, unknown> = {
      stop_price: req.takeProfit.triggerPrice,
      order_type: req.takeProfit.orderType,
    };
    if (req.takeProfit.price !== undefined) {
      leg['price'] = req.takeProfit.price;
      leg['limit_price'] = req.takeProfit.price;
    }
    payload['take_profit'] = leg;
  }
  const now = (opts.nowMs ?? Date.now)();
  const signed = await signBody(sign, payload, now);
  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(FUTURES_TPSL_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) return { ok: false, failure: classify({ transport: err.kind }) };
    throw err;
  }
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, failure: classify({ status: result.status, message: messageFrom(result.body) }) };
  }
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(result.body) as Record<string, unknown>; } catch { /* fall through */ }
  if (parsed === null) {
    return { ok: false, failure: classify({ status: 200, message: 'venue returned a 2xx with unparsable body' }) };
  }

  const parseLeg = (raw: unknown): AttachTpSlPerLeg | undefined => {
    if (raw === undefined) return undefined;
    if (typeof raw !== 'object' || raw === null) return undefined;
    const row = raw as Record<string, unknown>;
    if (row['success'] === false) {
      const reason = typeof row['error'] === 'string' ? row['error'] as string : 'unspecified';
      return { ok: false, reason };
    }
    const id = row['id'];
    if (typeof id === 'string') return { ok: true, venueOrderId: id };
    return { ok: false, reason: 'venue response did not include an order id' };
  };
  const slLeg = parseLeg(parsed['stop_loss']);
  const tpLeg = parseLeg(parsed['take_profit']);
  return {
    ok: true,
    ...(slLeg !== undefined ? { stopLoss: slLeg } : {}),
    ...(tpLeg !== undefined ? { takeProfit: tpLeg } : {}),
  };
}

/** Sign in-process from a plaintext secret. Checks and the sandbox use this. */
export async function attachStopAndTake(
  apiKey: string,
  apiSecret: string,
  req: AttachTpSlRequest,
  opts: FuturesCallOptions = {},
): Promise<AttachTpSlOutcome> {
  return attachStopAndTakeSigned(plaintextSigner(apiKey, apiSecret), req, opts);
}

const FUTURES_CANCEL_PATH = '/exchange/v1/derivatives/futures/orders/cancel';
const FUTURES_EXIT_PATH = '/exchange/v1/derivatives/futures/positions/exit';
const FUTURES_LIST_PATH = '/exchange/v1/derivatives/futures/orders';

/**
 * The `status` filter values List Orders accepts, lowercase as the request wants
 * them (research/03 F6).
 *
 * There is NO "all" value and all four of `status`, `side`, `page`, `size` are
 * mandatory, so enumerating an account's orders means iterating both sides and
 * every status — **any status you omit is invisible**. This list is therefore the
 * default, and it is deliberately complete: an L4 read-back that silently skipped
 * a status would see "zero matches" and conclude NOT_PLACED for an order that
 * exists, which is the one wrong answer that matters.
 */
export const FUTURES_ORDER_STATUSES = [
  'open', 'filled', 'partially_filled', 'partially_cancelled',
  'cancelled', 'rejected', 'untriggered',
] as const;

/** What a futures order is, canonically — the venue's own vocabulary is not ours. */
export type FuturesOrderState =
  | 'open' | 'filled' | 'partially_filled' | 'partially_cancelled'
  | 'cancelled' | 'rejected' | 'untriggered' | 'initial' | 'unknown';

/**
 * Map a venue status to ours.
 *
 * The venue spells cancellation three ways across its own documents — the request
 * filter is `cancelled` (two L), the response definitions say `CANCELED` (one L),
 * and both casings appear. Case-insensitivity alone does not bridge that, so the
 * aliases are explicit.
 *
 * An unrecognised status returns `'unknown'` rather than throwing: a venue adding
 * a status must not turn a readable order list into an outage. `unknown` is a
 * value the L4 matcher treats as undecidable, which is the honest reading — the
 * caller can see it, alarm on it, and still match on the other four fields.
 */
export function canonicalFuturesOrderState(raw: string): FuturesOrderState {
  const s = raw.trim().toLowerCase().replace(/-/g, '_');
  switch (s) {
    case 'open': return 'open';
    case 'filled': return 'filled';
    case 'partially_filled': return 'partially_filled';
    case 'partially_cancelled':
    case 'partially_canceled': return 'partially_cancelled';
    case 'cancelled':
    case 'canceled': return 'cancelled';
    case 'rejected': return 'rejected';
    case 'untriggered': return 'untriggered';
    // Present on a create response and in neither list (research/03 F5).
    case 'initial': return 'initial';
    default: return 'unknown';
  }
}

/** One order as List Orders reports it. Only the fields L4 matches on, plus the id. */
export interface FuturesListedOrder {
  readonly venueOrderId: string;
  readonly pair: string;
  readonly side: string;
  readonly orderType: string;
  readonly totalQuantity: string | null;
  readonly price: string | null;
  readonly statusRaw: string;
  readonly status: FuturesOrderState;
  readonly createdAtMs: number | null;
}

export type FuturesListOrdersOutcome =
  | { readonly ok: true; readonly orders: readonly FuturesListedOrder[] }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

export interface FuturesListOrdersRequest {
  readonly pair?: string | undefined;
  readonly side?: 'buy' | 'sell' | undefined;
  /** CSV. Defaults to every status — see `FUTURES_ORDER_STATUSES`. */
  readonly status?: string | undefined;
  readonly marginCurrency?: FuturesMarginCurrency | undefined;
  readonly page?: number | undefined;
  readonly size?: number | undefined;
}

/** A string field, or null. The venue mixes types freely across endpoints. */
const strOrNull = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
};

function toListedOrder(row: Record<string, unknown>): FuturesListedOrder | null {
  const id = strOrNull(row['id']);
  const pair = strOrNull(row['pair']);
  // Without an id the row cannot be adopted, and without a pair it cannot be
  // matched. A row we cannot use is dropped rather than half-read.
  if (id === null || pair === null) return null;
  const statusRaw = strOrNull(row['status']) ?? '';
  const createdRaw = strOrNull(row['created_at']);
  const created = createdRaw === null ? NaN : Date.parse(createdRaw);
  return {
    venueOrderId: id,
    pair,
    side: strOrNull(row['side']) ?? '',
    orderType: fromVenueOrderType(strOrNull(row['order_type'])),
    totalQuantity: strOrNull(row['total_quantity']),
    price: strOrNull(row['price']),
    statusRaw,
    status: canonicalFuturesOrderState(statusRaw),
    createdAtMs: Number.isNaN(created) ? null : created,
  };
}

/**
 * List orders for one (pair, side) — or across both sides if side is omitted.
 * The L4a read-back.
 *
 * The venue's envelope here is UNVERIFIED: every other futures read returns a bare
 * array, but a paginated endpoint commonly wraps its rows. Both shapes are
 * accepted rather than guessing one and turning the other into an outage — and the
 * caller treats an unparsable body as a FAILED read, never as "no orders", because
 * "no orders" is the answer that concludes NOT_PLACED.
 *
 * NOTE: Real CoinDCX does not filter orders by pair on its server side. We strictly
 * filter returned orders by req.pair if specified so other instruments never leak.
 */
export async function listFuturesOrdersSigned(
  sign: BodySigner,
  req: FuturesListOrdersRequest,
  opts: FuturesCallOptions = {},
): Promise<FuturesListOrdersOutcome> {
  if (req.side === undefined) {
    const buyResult = await listFuturesOrdersSigned(sign, { ...req, side: 'buy' }, opts);
    if (!buyResult.ok) return buyResult;
    const sellResult = await listFuturesOrdersSigned(sign, { ...req, side: 'sell' }, opts);
    if (!sellResult.ok) return sellResult;
    return { ok: true, orders: [...buyResult.orders, ...sellResult.orders] };
  }

  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const payload: Record<string, unknown> = {
    status: req.status ?? FUTURES_ORDER_STATUSES.join(','),
    page: req.page ?? 1,
    size: req.size ?? 100,
  };
  if (req.pair !== undefined) payload['pair'] = req.pair;
  if (req.side !== undefined) payload['side'] = req.side;
  if (req.marginCurrency !== undefined) payload['margin_currency_short_name'] = [req.marginCurrency];
  else payload['margin_currency_short_name'] = ['INR', 'USDT'];

  const signed = await signBody(sign, payload);
  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(FUTURES_LIST_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) return { ok: false, failure: classify({ transport: err.kind }) };
    throw err;
  }
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, failure: classify({ status: result.status, message: messageFrom(result.body) }) };
  }
  let parsed: unknown = null;
  try { parsed = JSON.parse(result.body); } catch { /* handled below */ }
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['data'])
      ? (parsed as Record<string, unknown>)['data'] as unknown[]
      : null);
  if (rows === null) {
    return {
      ok: false,
      failure: classify({ status: 200, message: 'orders list response was neither an array nor {data: [...]}' }),
    };
  }
  const orders: FuturesListedOrder[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const listed = toListedOrder(row as Record<string, unknown>);
    if (listed !== null && (req.pair === undefined || listed.pair === req.pair)) {
      orders.push(listed);
    }
  }
  return { ok: true, orders };
}

/** Sign in-process from a plaintext secret. Checks and the sandbox use this. */
export async function listFuturesOrders(
  apiKey: string,
  apiSecret: string,
  req: FuturesListOrdersRequest,
  opts: FuturesCallOptions = {},
): Promise<FuturesListOrdersOutcome> {
  return listFuturesOrdersSigned(plaintextSigner(apiKey, apiSecret), req, opts);
}

const FUTURES_INSTRUMENT_PATH = '/exchange/v1/derivatives/futures/data/instrument';

export type FuturesInstrumentOutcome =
  | { readonly ok: true; readonly instrument: FuturesInstrument }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

/**
 * Read one futures instrument's trading rules. PUBLIC — no signature, no body.
 *
 * It exists because the futures catalogue is NOT `market_metadata`: that is the
 * spot catalogue, and a futures instrument is a different thing with a different
 * `pair` form and a `contract_size` spot has no concept of. Until this existed,
 * nothing in the system could tell you a pair's quantity step — so any code that
 * had to round a quantity had to guess, and guessing the step is how a reducing
 * order ends up sized ABOVE the position and flips it.
 *
 * Fetched per call rather than cached: the metadata is versioned and mutable
 * (`exit_only`, price bands and leverage tiers all change), and this is read once
 * before a deliberate user action, not on a hot path.
 */
export async function fetchFuturesInstrument(
  pair: string,
  marginCurrency: FuturesMarginCurrency,
  opts: FuturesCallOptions = {},
): Promise<FuturesInstrumentOutcome> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const url = new URL(FUTURES_INSTRUMENT_PATH, baseUrl);
  url.searchParams.set('pair', pair);
  url.searchParams.set('margin_currency_short_name', marginCurrency);
  let result: HttpResult;
  try {
    result = await send({ method: 'GET', url, deadlineMs: opts.deadlineMs });
  } catch (err) {
    if (err instanceof TransportError) return { ok: false, failure: classify({ transport: err.kind }) };
    throw err;
  }
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, failure: classify({ status: result.status, message: messageFrom(result.body) }) };
  }
  let parsed: unknown = null;
  try { parsed = JSON.parse(result.body); } catch { /* handled below */ }
  // Both envelopes are accepted rather than one being guessed at, the same way the
  // orders list does it: getting this wrong turns a readable instrument into an
  // outage, and the caller cannot round a quantity without it.
  const row = Array.isArray(parsed)
    ? (parsed[0] as unknown)
    : (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>)['data'])
      ? ((parsed as Record<string, unknown>)['data'] as unknown[])[0]
      : (parsed !== null && typeof parsed === 'object' && (parsed as Record<string, unknown>)['instrument'] !== undefined
        ? (parsed as Record<string, unknown>)['instrument']
        : parsed));
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, failure: classify({ status: 200, message: 'instrument response was not an object' }) };
  }
  const r = row as Record<string, unknown>;
  const s = (k: string, fallback = ''): string => strOrNull(r[k]) ?? fallback;
  const instrument: FuturesInstrument = {
    pair: s('pair', pair),
    baseAsset: s('underlying_currency_short_name', s('position_currency_short_name')),
    quoteAsset: s('quote_currency_short_name'),
    marginCurrency: (s('margin_currency_short_name', marginCurrency) === 'INR' ? 'INR' : 'USDT'),
    contractSize: s('contract_size', s('unit_contract_value', '1')),
    priceIncrement: s('price_increment', '0'),
    quantityIncrement: s('quantity_increment', '0'),
    minQuantity: s('min_quantity', s('min_trade_size', '0')),
    maxQuantity: s('max_quantity', '0'),
    minNotional: s('min_notional', '0'),
    maxMarketOrderQuantity: s('max_market_order_quantity', '0'),
    makerFee: s('maker_fee', '0'),
    takerFee: s('taker_fee', '0'),
    fundingFrequencyHours: Number.parseInt(s('funding_frequency', s('funding_frequency_hours', '8')), 10) || 8,
    exitOnly: r['exit_only'] === true,
    leverageTiers: [],
  };
  return { ok: true, instrument };
}

export type FuturesCancelOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

/**
 * Cancel ONE futures order by venue order id. Futures has no client_order_id
 * (research/03 Verdict), so the caller identifies orders by the id the venue
 * returned on create.
 */
export async function cancelFuturesOrderSigned(
  sign: BodySigner,
  venueOrderId: string,
  opts: FuturesCallOptions = {},
): Promise<FuturesCancelOutcome> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const now = (opts.nowMs ?? Date.now)();
  const signed = await signBody(sign, { id: venueOrderId }, now);
  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(FUTURES_CANCEL_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) return { ok: false, failure: classify({ transport: err.kind }) };
    throw err;
  }
  if (result.status >= 200 && result.status < 300) return { ok: true };
  return { ok: false, failure: classify({ status: result.status, message: messageFrom(result.body) }) };
}

export type FuturesExitOutcome =
  | { readonly ok: true; readonly venueGroupId: string | null }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

/**
 * Close a position at market. NOT idempotent (research/04 F11) — the caller
 * MUST hold the per-(account, pair) lock and cancel outstanding SL/TP FIRST
 * (research/04 Q(a)), else a stale SL after this exit would fire and reverse
 * the position.
 */
export async function exitFuturesPositionSigned(
  sign: BodySigner,
  positionId: string,
  opts: FuturesCallOptions = {},
): Promise<FuturesExitOutcome> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const now = (opts.nowMs ?? Date.now)();
  const signed = await signBody(sign, { id: positionId }, now);
  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(FUTURES_EXIT_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) return { ok: false, failure: classify({ transport: err.kind }) };
    throw err;
  }
  if (result.status < 200 || result.status >= 300) {
    return { ok: false, failure: classify({ status: result.status, message: messageFrom(result.body) }) };
  }
  let parsed: Record<string, unknown> | null = null;
  try { parsed = JSON.parse(result.body) as Record<string, unknown>; } catch { /* fall through */ }
  if (parsed !== null && (
    parsed['status'] === 400 || parsed['status'] === 422 ||
    parsed['code'] === 400 || parsed['code'] === 422 ||
    parsed['success'] === false
  )) {
    return { ok: false, failure: classify({ status: 400, message: messageFrom(result.body) }) };
  }
  const data = parsed?.['data'];
  const groupId = data !== null && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>)['group_id']
    : null;
  return { ok: true, venueGroupId: typeof groupId === 'string' ? groupId : null };
}

/** Sign in-process from a plaintext secret. Checks and the sandbox use this. */
export async function cancelFuturesOrder(
  apiKey: string,
  apiSecret: string,
  venueOrderId: string,
  opts: FuturesCallOptions = {},
): Promise<FuturesCancelOutcome> {
  return cancelFuturesOrderSigned(plaintextSigner(apiKey, apiSecret), venueOrderId, opts);
}

/** Sign in-process from a plaintext secret. Checks and the sandbox use this. */
export async function exitFuturesPosition(
  apiKey: string,
  apiSecret: string,
  positionId: string,
  opts: FuturesCallOptions = {},
): Promise<FuturesExitOutcome> {
  return exitFuturesPositionSigned(plaintextSigner(apiKey, apiSecret), positionId, opts);
}
