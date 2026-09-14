// The futures place protocol — L1-L4, from research/03-coindcx-futures-orders-rest.md.
//
// Spot gets duplicate-safety for free: `client_order_id` is a real idempotency
// primitive, so a retry cannot double-place and an ambiguous outcome is resolved by
// asking the venue about that key. Futures has NEITHER — the create endpoint takes
// no client_order_id, and there is no order-status endpoint. The research calls
// this "the single largest correctness risk in the whole product", and the
// substitutes below are weaker than a key by construction. They are what we have.
//
//   L1  single-flight per (account, pair)          — blocks a concurrent second send
//   L2  durable write-before-send                  — the worker already does this
//                                                    (state='sending' + coid, committed
//                                                    before the socket write)
//   L3  sign now, POST orders/create               — 10s venue window, so signing
//                                                    happens here, not at enqueue
//   L4  on ambiguity, resolve by READING BACK:
//        a. list orders, BOTH sides, every status
//        b. match on (pair, side, order_type, total_quantity, price)
//        c. one match -> adopt; none -> position delta; two+ -> NEEDS_HUMAN
//
// Port-driven on purpose: a `.ts` outside the adapter may not import CoinDCX
// (ADAPTER-BOUNDARY), so the composition root supplies the venue calls and this
// file supplies the protocol.
//
// WHERE THIS IS WEAK, plainly: if the customer places an identical order by hand
// inside the search window, the matcher cannot tell it from ours and NEEDS_HUMAN is
// the only honest outcome. That is exactly why L1 exists — it makes two identical
// orders impossible *from our side*, leaving only the customer's own.

import type { Kysely } from 'kysely';
import { acquireFuturesLock, releaseFuturesLock } from '@tradex/db';
import type { DB } from '@tradex/db';
import type { SubmitPortOutcome } from '../execution-worker.js';

/** How far either side of the send instant an order may have been created. */
export const SEARCH_WINDOW_MS = 5_000;

/** L1's ceiling on waiting for the per-(account, pair) lock. */
export const LOCK_WAIT_MS = 2_000;

/** One order as the read-back reports it — the four fields the matcher uses. */
export interface ListedOrder {
  readonly venueOrderId: string;
  readonly pair: string;
  readonly side: string;
  readonly orderType: string;
  readonly totalQuantity: string | null;
  readonly price: string | null;
  readonly createdAtMs: number | null;
  /**
   * The venue's own status word, passed through untouched. It is what the worker
   * folds into a canonical child state, so mapping it here would mean mapping it
   * twice — and the second mapping is the one that would drift.
   */
  readonly statusRaw: string;
}

export interface FuturesIntent {
  readonly accountId: string;
  readonly pair: string;
  readonly marginCurrency: 'INR' | 'USDT';
  readonly side: 'buy' | 'sell';
  readonly orderType: string;
  readonly quantity: string;
  readonly price: string | null;
  /** When the create was attempted — the centre of L4's search window. */
  readonly sentAtMs: number;
  /** The child_order row this send belongs to; the lock is keyed by it. */
  readonly childOrderId: string;
}

export interface PlaceProtocolPorts {
  /** L3. Ordered to sign at call time: the venue rejects a body older than 10s. */
  readonly create: (intent: FuturesIntent) => Promise<
    | { readonly kind: 'accepted'; readonly venueOrderId: string; readonly statusRaw: string }
    | { readonly kind: 'rejected'; readonly orderMayExist: boolean; readonly code: string; readonly detail: string }
  >;
  /** L4a. One side at a time — the endpoint takes a single `side`. */
  readonly listOrders: (args: { readonly pair: string; readonly side: 'buy' | 'sell' }) => Promise<
    | { readonly ok: true; readonly orders: readonly ListedOrder[] }
    | { readonly ok: false; readonly detail: string }
  >;
  /** L4c. Open positions for one margin currency. */
  readonly readPositions: (marginCurrency: 'INR' | 'USDT') => Promise<
    | { readonly ok: true; readonly positions: readonly { readonly pair: string; readonly activePos: string }[] }
    | { readonly ok: false; readonly detail: string }
  >;
  readonly workerId: string;
  readonly nowMs?: (() => number) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Injected so a check can run the protocol without waiting. Defaults to LOCK_WAIT_MS. */
  readonly waitMs?: number | undefined;
  readonly searchWindowMs?: number | undefined;
}

/** How the send ended, for logs and alerts. Not a decision the caller re-makes. */
export type PlaceResolution =
  | 'created' | 'adopted' | 'rejected' | 'not_placed' | 'undecidable' | 'busy';

export interface PlaceProtocolOutcome {
  /** Exactly what the SubmitPort should return — the worker decides from this. */
  readonly submit: SubmitPortOutcome;
  readonly resolution: PlaceResolution;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Does this listed order match what we tried to send?
 *
 * The four fields are the whole identity of an intent. `price` is compared as a
 * string: both sides come from the same decimal-safe path, and a market order is
 * null on both, so normalising numbers here would only invent a difference.
 */
function matchesIntent(order: ListedOrder, intent: FuturesIntent): boolean {
  if (order.pair !== intent.pair) return false;
  if (order.side !== intent.side) return false;
  if (order.orderType !== intent.orderType) return false;
  if (order.totalQuantity !== intent.quantity) return false;
  return (order.price ?? null) === (intent.price ?? null);
}

/**
 * Place one futures order with the full L1-L4 protocol.
 *
 * Always releases the lock, including on a throw: a lock leaked on an exception
 * would freeze this (account, pair) until the stale reaper ran.
 */
export async function placeFuturesOrder(
  db: Kysely<DB>,
  tenantId: string,
  ports: PlaceProtocolPorts,
  intent: FuturesIntent,
): Promise<PlaceProtocolOutcome> {
  const now = ports.nowMs ?? Date.now;
  const sleep = ports.sleep ?? delay;
  const waitMs = ports.waitMs ?? LOCK_WAIT_MS;

  // L1. Without a client_order_id this lock is the ONLY thing standing between us
  // and two identical orders the matcher could never tell apart.
  const deadline = now() + waitMs;
  let acquired = await acquireFuturesLock(db, {
    tenantId,
    accountId: intent.accountId,
    pair: intent.pair,
    childOrderId: intent.childOrderId,
    workerId: ports.workerId,
  });
  while (!acquired && now() < deadline) {
    await sleep(50);
    acquired = await acquireFuturesLock(db, {
      tenantId,
      accountId: intent.accountId,
      pair: intent.pair,
      childOrderId: intent.childOrderId,
      workerId: ports.workerId,
    });
  }
  if (!acquired) {
    return {
      resolution: 'busy',
      submit: {
        kind: 'rejected',
        orderMayExist: false,
        code: 'account_pair_busy',
        detail: `another futures order on ${intent.pair} is in flight for this account`,
      },
    };
  }

  try {
    const created = await ports.create(intent);
    if (created.kind === 'accepted') {
      return {
        resolution: 'created',
        submit: {
          kind: 'accepted',
          exchangeOrderId: created.venueOrderId,
          statusRaw: created.statusRaw,
        },
      };
    }
    // A business rejection can never have placed an order — terminal, never resolved.
    if (created.orderMayExist !== true) {
      return {
        resolution: 'rejected',
        submit: {
          kind: 'rejected', orderMayExist: false, code: created.code, detail: created.detail,
        },
      };
    }
    return await resolveAmbiguity(ports, intent, now);
  } finally {
    await releaseFuturesLock(db, {
      accountId: intent.accountId, pair: intent.pair, childOrderId: intent.childOrderId,
    });
  }
}

/**
 * L4. The send outcome is unknown. Resolve it by reading, still holding the lock.
 */
async function resolveAmbiguity(
  ports: PlaceProtocolPorts,
  intent: FuturesIntent,
  now: () => number,
): Promise<PlaceProtocolOutcome> {
  const window = ports.searchWindowMs ?? SEARCH_WINDOW_MS;
  const from = intent.sentAtMs - window;
  const to = now() + window;

  // L4a. BOTH sides, because we cannot ask "which side was my order" — and the
  // side we think we sent is exactly the thing a bug could have got wrong.
  const seen = new Map<string, ListedOrder>();
  let unreadable = 0;
  for (const side of ['buy', 'sell'] as const) {
    const res = await ports.listOrders({ pair: intent.pair, side });
    if (!res.ok) { unreadable += 1; continue; }
    for (const order of res.orders) {
      // An order with no usable timestamp cannot be placed inside the window, and
      // adopting one would risk picking up an unrelated order from days ago.
      if (order.createdAtMs === null) continue;
      if (order.createdAtMs < from || order.createdAtMs > to) continue;
      seen.set(order.venueOrderId, order);
    }
  }

  // A FAILED read is not "no orders". Concluding NOT_PLACED here would abandon an
  // order that may exist and may fill — so this stays ambiguous and the ladder
  // retries.
  if (unreadable > 0) {
    return {
      resolution: 'undecidable',
      submit: {
        kind: 'rejected',
        orderMayExist: true,
        code: 'list_unavailable',
        detail: `could not read the order list (${unreadable} of 2 sides failed); the order may exist`,
      },
    };
  }

  // L4b.
  const matches = [...seen.values()].filter((order) => matchesIntent(order, intent));

  if (matches.length > 1) {
    // Two indistinguishable orders. No further reading can separate them, and
    // guessing would attribute the customer's own fill to this leg (or ours to
    // theirs). NEEDS_HUMAN, and the caller freezes the account.
    return {
      resolution: 'undecidable',
      submit: {
        kind: 'rejected',
        needsHuman: true,
        code: 'ambiguous_duplicate_orders',
        detail: `${matches.length} orders matched identically on ${intent.pair}; a human must decide which is ours`,
      },
    };
  }

  if (matches.length === 1) {
    const only = matches[0] as ListedOrder;
    return {
      resolution: 'adopted',
      submit: {
        kind: 'accepted',
        exchangeOrderId: only.venueOrderId,
        // The venue's own word for it, exactly as the list reported it.
        statusRaw: only.statusRaw,
      },
    };
  }

  // L4c. Zero matches. Re-check positions for evidence the order filled anyway.
  const positions = await ports.readPositions(intent.marginCurrency);
  if (!positions.ok) {
    return {
      resolution: 'undecidable',
      submit: {
        kind: 'rejected',
        orderMayExist: true,
        code: 'positions_unavailable',
        detail: `no order matched and the position read failed: ${positions.detail}`,
      },
    };
  }

  const open = positions.positions.find((p) => p.pair === intent.pair && p.activePos !== '0');
  if (open !== undefined) {
    // A position exists. It may be ours (the order filled but is still reported
    // `initial`, which no status filter returns) or it may predate this send. We
    // cannot tell — and a fresh order becoming visible is the likelier case, so
    // this stays ambiguous and the ladder re-reads rather than concluding.
    return {
      resolution: 'undecidable',
      submit: {
        kind: 'rejected',
        orderMayExist: true,
        code: 'position_without_order',
        detail: `no matching order, but ${intent.pair} has an open position — cannot attribute it`,
      },
    };
  }

  // No order and no position: it did not land. Safe to conclude, and safe because
  // a market order that reached the venue leaves a position behind.
  return {
    resolution: 'not_placed',
    submit: {
      kind: 'rejected',
      orderMayExist: false,
      code: 'not_placed',
      detail: `no order matched on ${intent.pair} and no position opened`,
    },
  };
}
