// Order submission and resolve-by-client-order-id — plan/phase-06 T06.5, T06.6.
//
// The two primitives the execution worker needs, and the first place real money
// moves. Both sign the exact request body in-memory with the plaintext secret —
// the same pattern probeCredential uses for onboarding validation — so this whole
// path runs against the FakeVenue with no process boundary. The REAL send path in
// Phase 06 hands the exact body to the separate signer process instead (T06.4);
// everything above these two functions is unchanged by that swap.
//
// Failure classification comes from @tradex/exchange's classify(): the returned
// failure carries `orderMayExist`, and THAT is what decides whether the caller
// resolves or retries. A timeout/5xx after the bytes were written may have placed
// the order (orderMayExist true → resolve by coid); a 4xx business rejection can
// never have placed it (never retry).

import { classify } from '@tradex/exchange';
import type { ClassifiedFailure } from '@tradex/exchange';
import { mapVenueOrderState } from '@tradex/exchange';
import { parseDecimalJson } from './decimal-json.js';
import { TransportError, send } from './http.js';
import type { HttpResult } from './http.js';
import { signRequest } from './signing.js';

// Shared module const, deliberately not exported — probe.ts already owns the
// DEFAULT_BASE_URL export and index.ts re-exports both.
const DEFAULT_BASE_URL = 'https://api.coindcx.com';
const CREATE_PATH = '/exchange/v1/orders/create';
const STATUS_PATH = '/exchange/v1/orders/status';
const CANCEL_PATH = '/exchange/v1/orders/cancel';
const ACTIVE_ORDERS_PATH = '/exchange/v1/orders/active_orders';

export interface VenueOrder {
  readonly id: string;
  readonly clientOrderId: string;
  /** The venue's literal status, verbatim (forensics). */
  readonly statusRaw: string;
  /** The canonical state from Loop A's mapping — never throws. */
  readonly state: ReturnType<typeof mapVenueOrderState>;
}

export type SubmitOutcome =
  | { readonly kind: 'accepted'; readonly order: VenueOrder }
  | { readonly kind: 'rejected'; readonly failure: ClassifiedFailure };

export interface OrderCallOptions {
  readonly baseUrl?: string | undefined;
  readonly deadlineMs?: number | undefined;
}

function messageFrom(body: string): string {
  try {
    const parsed = parseDecimalJson(body);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = parsed as { [key: string]: unknown };
      if (typeof row['message'] === 'string') return row['message'];
    }
  } catch { /* fall through */ }
  return body.slice(0, 200);
}

function toVenueOrder(parsed: Record<string, unknown>, coid: string): VenueOrder {
  const id = parsed['id'];
  const statusRaw = typeof parsed['status'] === 'string' ? parsed['status'] : '';
  return {
    id: typeof id === 'string' ? id : String(id ?? ''),
    clientOrderId: typeof parsed['client_order_id'] === 'string' ? (parsed['client_order_id'] as string) : coid,
    statusRaw,
    state: mapVenueOrderState(statusRaw),
  };
}

/**
 * Place an order. Returns `accepted` with the venue order on a 2xx, or
 * `rejected` with a classified failure otherwise. A transport failure (timeout,
 * reset after the bytes were written) is classified with orderMayExist=true — it
 * is the CALLER's job to resolve by client_order_id, never to re-send blindly.
 */
export async function submitOrder(
  apiKey: string,
  apiSecret: string,
  payload: Record<string, unknown>,
  opts: OrderCallOptions = {},
): Promise<SubmitOutcome> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  // signRequest stamps `timestamp` and returns the exact bytes it signed; that
  // string is what we POST, so the signature can never cover a different body.
  const signed = signRequest(apiKey, apiSecret, payload);

  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(CREATE_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) {
      return { kind: 'rejected', failure: classify({ transport: err.kind }) };
    }
    throw err;
  }

  if (result.status >= 200 && result.status < 300) {
    const parsed = parseDecimalJson(result.body);
    const row = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : {}) as Record<string, unknown>;
    const coid = typeof payload['client_order_id'] === 'string' ? (payload['client_order_id'] as string) : '';
    return { kind: 'accepted', order: toVenueOrder(row, coid) };
  }

  return {
    kind: 'rejected',
    failure: classify({ status: result.status, message: messageFrom(result.body) }),
  };
}

/**
 * Ask the venue whether an order with this client_order_id exists — the resolve
 * primitive. Returns null when the venue has no such order (body was empty), or
 * a classified failure on a non-2xx. Used by the resolve ladder on every
 * ambiguous send, and by the reaper's 'resolve' jobs.
 */
export async function fetchOrderByClientId(
  apiKey: string,
  apiSecret: string,
  clientOrderId: string,
  opts: OrderCallOptions = {},
): Promise<{ readonly ok: true; readonly order: VenueOrder | null } | { readonly ok: false; readonly failure: ClassifiedFailure }> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const signed = signRequest(apiKey, apiSecret, { client_order_id: clientOrderId });

  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(STATUS_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) {
      return { ok: false, failure: classify({ transport: err.kind }) };
    }
    throw err;
  }

  if (result.status >= 200 && result.status < 300) {
    const parsed = parseDecimalJson(result.body);
    const row = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null) as Record<string, unknown> | null;
    if (row === null || Object.keys(row).length === 0 || row['id'] === undefined) return { ok: true, order: null };
    return { ok: true, order: toVenueOrder(row, clientOrderId) };
  }
  return { ok: false, failure: classify({ status: result.status, message: messageFrom(result.body) }) };
}

export type CancelOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'rejected'; readonly failure: ClassifiedFailure };

/**
 * Request that the venue cancel an order by OUR id (phase-09 T09.1).
 *
 * The venue's cancel response is `{"message":"success","status":"success",
 * "code":200}` — NO order object, NO echo of which order was cancelled (01 F8.10).
 * A `cancelled` return therefore means only "the venue accepted the cancel
 * request", never "the order is now cancelled": the order could have filled in
 * the gap between our read and the cancel landing, or the venue could refuse a
 * request for an already-settled order. The CALLER must follow every successful
 * cancel with a status poll and act on the outcome it observes — the same
 * resolve-after-send discipline as submitOrder.
 *
 * A business refusal — the FAQ's "This order cannot be cancelled" for an order
 * in `filled`/`cancelled`/`rejected` — arrives as a non-2xx and is classified.
 * `classify()` already maps that literal to `order_not_cancellable`.
 */
export async function cancelOrder(
  apiKey: string,
  apiSecret: string,
  clientOrderId: string,
  opts: OrderCallOptions = {},
): Promise<CancelOutcome> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const signed = signRequest(apiKey, apiSecret, { client_order_id: clientOrderId });

  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(CANCEL_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) {
      return { kind: 'rejected', failure: classify({ transport: err.kind }) };
    }
    throw err;
  }

  if (result.status >= 200 && result.status < 300) return { kind: 'cancelled' };
  return { kind: 'rejected', failure: classify({ status: result.status, message: messageFrom(result.body) }) };
}

export type ActiveOrdersOutcome =
  | { readonly ok: true; readonly orders: readonly VenueOrder[] }
  | { readonly ok: false; readonly failure: ClassifiedFailure };

/**
 * List the venue's currently-active orders on one market (phase-09 T09.5, Loop B).
 *
 * `market` is REQUIRED by the venue — there is no "list all my open orders" call
 * (01 F8.5). The caller must already know which markets to poll. Response is
 * `{ "orders": [...] }`, each row the unified order object carrying `id` and
 * `client_order_id`, so each maps straight through `toVenueOrder` into the same
 * canonical vocabulary the resolve ladder uses.
 *
 * An order the venue returns here but we no longer track is the Loop B signal:
 * something we believe is `cancelled`/`filled` is still open at the venue.
 */
export async function fetchActiveOrders(
  apiKey: string,
  apiSecret: string,
  market: string,
  opts: OrderCallOptions = {},
): Promise<ActiveOrdersOutcome> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const signed = signRequest(apiKey, apiSecret, { market });

  let result: HttpResult;
  try {
    result = await send({
      method: 'POST',
      url: new URL(ACTIVE_ORDERS_PATH, baseUrl),
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs,
    });
  } catch (err) {
    if (err instanceof TransportError) {
      return { ok: false, failure: classify({ transport: err.kind }) };
    }
    throw err;
  }

  if (result.status >= 200 && result.status < 300) {
    const parsed = parseDecimalJson(result.body);
    const envelope = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null) as Record<string, unknown> | null;
    const rows = envelope !== null && Array.isArray(envelope['orders']) ? envelope['orders'] : [];
    const orders: VenueOrder[] = [];
    for (const row of rows) {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
      const obj = row as Record<string, unknown>;
      const coid = typeof obj['client_order_id'] === 'string' ? (obj['client_order_id'] as string) : '';
      orders.push(toVenueOrder(obj, coid));
    }
    return { ok: true, orders };
  }
  return { ok: false, failure: classify({ status: result.status, message: messageFrom(result.body) }) };
}
