// Order status mapping — plan/phase-06 T06.7 (Reconciler Loop A), from 12 F1.
//
// The venue reports an order's status as a free-form string that drifts across
// versions and endpoints: 'cancelled' here, 'canceled' there, 'CANCELLED' and
// 'Cancelled' in the caps of an older cache. The reconciler must fold every one
// into our canonical OrderState so the state machine, the UI and the ledger all
// speak one vocabulary.
//
// R10 is the load-bearing rule: an UNRECOGNISED status becomes 'unknown' — with
// recognized:false so the caller can raise an alarm — and NEVER throws. A
// reconciler that throws on an unexpected string stops reconciling every other
// order behind it, and silence is the failure mode that hides a stuck order. The
// safe default is to surface the unknown and keep going.

import type { OrderState } from './adapter.js';

export interface MappedOrderState {
  /** The canonical state to advance the child order to. */
  readonly state: OrderState;
  /** False when the literal was not recognised — raise an alarm (R10), never throw. */
  readonly recognized: boolean;
}

const CANONICAL = new Set<OrderState>([
  'acked', 'open', 'partially_filled', 'filled', 'cancelled',
  'partially_cancelled', 'rejected', 'unknown',
]);

/** Normalise a literal: trim, lowercase, and collapse spaces to underscores. */
const normalise = (raw: string): string => raw.trim().toLowerCase().replace(/\s+/g, '_');

/**
 * Every recognised normalised literal → canonical state. The alias rows are the
 * documented variations; anything not here is unknown by design, because a
 * brand-new venue string should ALARM loudly, not silently map to a wrong state.
 */
const ALIASES: Readonly<Record<string, OrderState>> = {
  acked: 'acked',
  acknowledged: 'acked',
  accepted: 'acked',
  new: 'acked',
  open: 'open',
  active: 'open',
  partial: 'partially_filled',
  partially_filled: 'partially_filled',
  partially_filled_cancelled: 'partially_cancelled',
  partially_cancelled: 'partially_cancelled',
  filled: 'filled',
  complete: 'filled',
  completed: 'filled',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  cancelled_by_user: 'cancelled',
  cancelled_by_system: 'cancelled',
  rejected: 'rejected',
  failed: 'rejected',
};

/** Map a venue status literal to a canonical state. Never throws (R10). */
export function mapVenueOrderState(raw: string): MappedOrderState {
  const norm = normalise(raw);
  const mapped = ALIASES[norm];
  if (mapped !== undefined && CANONICAL.has(mapped)) return { state: mapped, recognized: true };
  return { state: 'unknown', recognized: false };
}

/** Whether a value is a canonical state at all (for asserting the table is closed). */
export function isCanonicalOrderState(v: string): v is OrderState {
  return CANONICAL.has(v as OrderState);
}
