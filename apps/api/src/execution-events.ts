// Execution progress events — plan/phase-08 T08.6.
//
// The bridge between the worker settling a child_order and a live client watching
// the group trade. The worker PERSISTS the state first (settle is a committed
// UPDATE) and only then publishes. So every event is a projection of a durable
// row, never the source of truth — a client that connects late gets a snapshot
// re-read from the DB, and an event that races the subscribe is superseded by
// that read. If the bus were to drop everything, the report route still shows
// the truth; the bus only adds liveness. Nothing in the send path depends on a
// subscriber, which is exactly what T08.6's "closing the page does not affect
// execution" rests on: the SSE route subscribes and unsubscribes on close, and
// the worker never knows a watcher existed.
//
// In-process and per-connection on purpose. One SSE connection subscribes to the
// group trade it is watching and unsubscribes when the request closes. There is
// no durable outbox, no cross-process routing — that is Phase 11's socket
// platform. This is enough for one desk watching one fan-out.

export interface ExecutionChildEvent {
  /** The group trade this child belongs to — the bus's routing key. */
  readonly groupTradeId: string;
  /** Which leg changed (its persisted child_order id). */
  readonly childOrderId: string;
  /** One leg per account per group trade, so accountId is a stable UI key. */
  readonly accountId: string;
  /** The canonical child_order state the child just settled into. */
  readonly state: string;
  readonly exchangeOrderId: string | null;
  readonly refusalCode: string | null;
  readonly refusalDetail: string | null;
  /** Epoch ms at settlement — when the UPDATE that reached this state committed. */
  readonly at: number;
}

export interface ExecutionEventBus {
  /** Listen for this group trade's child settlements. Returns the unsubscribe. */
  subscribe(groupTradeId: string, listener: (e: ExecutionChildEvent) => void): () => void;
  publish(e: ExecutionChildEvent): void;
}

export function createExecutionEventBus(): ExecutionEventBus {
  const listeners = new Map<string, Set<(e: ExecutionChildEvent) => void>>();
  return {
    subscribe(groupTradeId, listener) {
      let set = listeners.get(groupTradeId);
      if (set === undefined) {
        set = new Set();
        listeners.set(groupTradeId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(groupTradeId);
      };
    },
    publish(e) {
      const set = listeners.get(e.groupTradeId);
      if (set === undefined) return;
      // Iterate a copy so a subscriber that unsubscribes (or the SSE route
      // finishing and closing) cannot break the loop mid-publish.
      for (const listener of [...set]) {
        try {
          listener(e);
        } catch {
          // A misbehaving watcher must never break the worker — the durable row
          // it would have shown is already written.
        }
      }
    },
  };
}
