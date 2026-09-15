// The execution worker — plan/phase-06 T06.1, T06.3, T06.5, T06.6; phase-09.
//
// This is where a plan becomes a send. It takes the scheduler's jobs and drives
// each child_order to a KNOWN state, never creating a duplicate order:
//
//   runPlaceOnce()   — claim a 'place' job, WRITE-BEFORE-SEND, submit, classify.
//   runResolveOnce() — claim a 'resolve' job, ask the venue by client_order_id.
//
// Phase 09 adds the SELL re-derivation and the two sweep surfaces the plan's
// sell side and completion predicate depend on:
//
//   resize at send (T09.2/3/4) — a sell's quantity is re-derived from a FRESH
//     free-balance read immediately before submit (never from the projection),
//     clamped DOWN to the holding (never up, T09.3), with a dust holding or a
//     fully-locked one becoming a labelled skip (T09.4). All arithmetic lives in
//     @tradex/sizing resizeSellForSend — this file only wires it to the row.
//
//   completion-on-fills (T09.7) — every settle that moves a child out of the
//     working set runs the guarded flip: when NO child of the group trade is
//     still working/resting, the trade is `completed`. The resolve/poll sweeps
//     are what notice a fill; the flip is durable here, not in the SSE view.
//
// WRITE-BEFORE-SEND (T06.3) is the anti-duplicate core: the child is moved to
// 'sending' AND its client_order_id is reserved in ONE atomic UPDATE that only
// matches a child still in 'planned' with no coid. If two workers race the same
// job, exactly one wins the UPDATE; the loser's update returns no row and it
// stands down. Only after that commit does the worker sign and POST — so a crash
// between the commit and the POST leaves a 'sending' row that the reaper
// re-queues as 'resolve', never as a second 'place'.
//
// The venue calls are PORTS, injected — nothing in this .ts may import the
// adapter (ADAPTER-BOUNDARY). The .mjs composition root (or a check) supplies
// submit/resolve/holdings/cancel/listActive backed by the real order client or
// the FakeVenue.

import { clientOrderIdOf } from '@tradex/crypto';
import { futuresPairOf, mapVenueOrderState } from '@tradex/exchange';
import type { Balance } from '@tradex/exchange';
import { scaledFromMinor } from '@tradex/money';
import {
  claimJobsFair, forTenant, completeGroupTradeIfAllSettled,
  latestMarketMetadataVersion, listWorkingChildren, loadMarketRules,
  CANCELLABLE_STATES,
} from '@tradex/db';
import type { DB, TenantDb } from '@tradex/db';
import { notional, nat, quoteScaleOf, resizeSellForSend, toStr } from '@tradex/sizing';
import type { Kysely } from 'kysely';
import { resolveLadder } from './resolve-ladder.js';
import type { ExecutionChildEvent } from './execution-events.js';

/** States that mean an order is still live at the venue (T08.1 in-flight check). */
const UNRESOLVED: readonly string[] = [
  'sending', 'ambiguous', 'acked', 'open', 'partially_filled', 'unknown', 'needs_human',
];

/** States a plain poll may resolve — a send already confirmed, not yet settling. */
const POLLABLE: ReadonlySet<string> = new Set(['acked', 'open', 'partially_filled']);

/**
 * The quote a futures `market` string is denominated in — `BTCUSDT` is USDT,
 * anything else is INR.
 *
 * One definition, two callers: the send path (building the venue pair for the
 * order) and the attach path (finding the position that order opened). Two copies
 * of this rule is how the pair an order was sent with drifts from the pair its
 * protection is attached to — and the venue answers that with "no position".
 */
const quoteOfMarket = (market: string): 'INR' | 'USDT' => (market.endsWith('USDT') ? 'USDT' : 'INR');

/** States that should still appear in the venue's active list for this account. */
const VENUE_LIVE: ReadonlySet<string> = new Set(['acked', 'open', 'partially_filled']);

// ---- ports (injected; the adapter never crosses into this file) --------------

export interface SubmitPortOutcome {
  readonly kind: 'accepted' | 'rejected';
  readonly exchangeOrderId?: string | undefined;
  readonly statusRaw?: string | undefined;
  /** Present on a rejection; drives whether we resolve or mark terminal. */
  readonly orderMayExist?: boolean | undefined;
  readonly code?: string | undefined;
  readonly detail?: string | undefined;
  /**
   * The outcome is genuinely UNDECIDABLE — not "unknown, keep looking".
   *
   * The futures L1-L4 protocol reaches this honestly: the venue has no
   * `client_order_id` and no order-status endpoint, so ambiguity is resolved by
   * reading back the order list and matching on
   * (pair, side, order_type, total_quantity, price). When TWO OR MORE orders match
   * — a customer placed an identical order by hand inside the search window — no
   * amount of further reading can tell them apart, and guessing would attribute
   * someone else's fill to this leg.
   *
   * Settles `needs_human` directly rather than scheduling a resolve that cannot
   * resolve. Distinct from `orderMayExist`, which means "unknown, but more looking
   * may settle it".
   */
  readonly needsHuman?: boolean | undefined;
}

export type SubmitPort = (coid: string, order: OrderToSend) => Promise<SubmitPortOutcome>;
export type ResolvePort = (coid: string) => Promise<
  { readonly ok: true; readonly order: { readonly id: string; readonly statusRaw: string } | null }
  | { readonly ok: false }
>;

/** A fresh free/locked read of one account's holdings (balances.ts maps it). */
export type GetHoldingsPort = (accountId: string) => Promise<readonly Balance[]>;

export type CancelPortOutcome =
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'rejected'; readonly orderMayExist?: boolean | undefined; readonly code?: string | undefined; readonly detail?: string | undefined };
export type CancelPort = (accountId: string, coid: string) => Promise<CancelPortOutcome>;

export interface VenueActiveOrder { readonly clientOrderId: string; }
export type ListActivePort = (accountId: string, market: string) => Promise<
  { readonly ok: true; readonly orders: readonly VenueActiveOrder[] } | { readonly ok: false }
>;

/** Per-leg result the venue reports on an attach (partial success at HTTP 200). */
export interface AttachLegResult { readonly ok: boolean; readonly reason?: string | undefined; }

/**
 * Attach (or replace) a stop-loss and/or take-profit on a live futures position
 * (phase-15 T15.5). The venue attaches to a POSITION, not to an order, so this
 * is called only after an entry leg has filled and the composition root has
 * resolved the venue position id for that (account, pair, marginCurrency).
 *
 * Partial success is normal: one leg can land while the other is refused.
 */
export type AttachTpSlPort = (args: {
  readonly accountId: string;
  readonly pair: string;
  readonly marginCurrency: 'INR' | 'USDT';
  readonly stopLossPrice: string | null;
  readonly takeProfitPrice: string | null;
  readonly trailingStopLoss?: boolean | undefined;
}) => Promise<
  | { readonly ok: true; readonly stopLoss?: AttachLegResult | undefined; readonly takeProfit?: AttachLegResult | undefined }
  | { readonly ok: false; readonly code: string; readonly detail: string; readonly orderMayExist?: boolean | undefined }
>;

/** What a send needs from the row — built by the worker from child_order + its trade. */
export interface OrderToSend {
  /** The account the order belongs to — so a real submit can route its credential. */
  readonly accountId: string;
  readonly tenantId: string;
  readonly side: string;
  readonly market: string;
  readonly quantity: string;
  readonly orderType: string;
  readonly limitPrice: string | null;
  /**
   * The `child_order` row this leg belongs to.
   *
   * Present because the futures L1 lock is keyed by
   * (account, pair, child_order_id): futures has no `client_order_id`, so the lock
   * is the only anti-duplicate mechanism there is, and it has to name the row it
   * is protecting.
   */
  readonly childOrderId: string;
  /**
   * Present only for a FUTURES trade; absent means a spot send.
   *
   * Explicit rather than implied on purpose. A submit implementation must never
   * have to GUESS whether to build a spot market order or a leveraged futures
   * position — the two go to different endpoints with different bodies, and
   * guessing wrong places a real order of the wrong kind. The product is
   * futures-only, so a port that cannot express this can only send the thing we do
   * not sell.
   *
   * `pair` is the venue form (`B-BTC_USDT`), not the orders/form market
   * (`BTCUSDT`) — `futuresPairOf` does the conversion.
   */
  readonly futures?: {
    readonly pair: string;
    readonly marginCurrency: string;
    /** A whole number, 1..the market's maximum. */
    readonly leverage: number;
    readonly positionMarginType: string;
    readonly reduceOnly: boolean;
  } | undefined;
}

export interface ExecutionWorkerDeps {
  readonly db: Kysely<DB>;
  /** Pepper for the deterministic client_order_id (must match the reserve/plan side). */
  readonly pepper: Uint8Array;
  readonly submit: SubmitPort;
  readonly resolve: ResolvePort;
  /** Phase-09 sell side. When absent, a sell is sent at its planned size (the
   *  dry-run / pre-Phase-09 build); when present, every sell re-derives from a
   *  fresh read first (T09.2). */
  readonly holdings?: GetHoldingsPort | undefined;
  /** Phase-09 cancel fan-out. When absent, the cancel route is unavailable. */
  readonly cancel?: CancelPort | undefined;
  /** Phase-09 Loop B (active_orders sweep). When absent, loopBSweep is a no-op. */
  readonly listActive?: ListActivePort | undefined;
  /** Phase-15 SL/TP fan-out. When absent, a filled futures entry settles
   *  without attaching protection and its conditional legs are skipped with a
   *  labelled reason — never silently left 'planned'. */
  readonly attachTpSl?: AttachTpSlPort | undefined;
  /** Resolve-ladder schedule gaps (12 F3). Injected so a test runs it sleep-free. */
  readonly resolveScheduleGapsMs?: readonly number[] | undefined;
  /** Fired after each settle commits (T08.6). Nothing in the send path depends on
   *  a subscriber — this is a liveness projection of already-durable state. */
  readonly onChildState?: ((e: ExecutionChildEvent) => void) | undefined;
}

export interface WorkerRunSummary {
  handled: number;
  sent: number;
  ambiguous: number;
  rejected: number;
  terminal: number;
}

export interface CancelRowResult {
  readonly childOrderId: string;
  readonly accountId: string;
  readonly market: string | null;
  readonly fromState: string;
  readonly toState: string;
  /** 'cancelled' = the order is no longer working; 'refused' = it could not be
   *  (precondition or the venue settled it first). The toState says what it is. */
  readonly outcome: 'cancelled' | 'refused';
  readonly detail: string | null;
}

const nowDate = (): Date => new Date();

function enqueueJob(db: Kysely<DB>, childOrderId: string, tenantId: string, kind: 'place' | 'resolve', at: Date): Promise<void> {
  return db.insertInto('execution_job')
    .values({ child_order_id: childOrderId, tenant_id: tenantId, kind, run_after: at } as never)
    .execute().then(() => undefined);
}

function deleteJob(db: Kysely<DB>, jobId: string): Promise<void> {
  return db.deleteFrom('execution_job').where('id' as never, '=', jobId as never).execute().then(() => undefined);
}

interface ChildRow {
  id: string; tenantId: string; groupTradeId: string; accountId: string; legSeq: number;
  state: string; clientOrderId: string | null; market: string | null; finalQuantity: string | null;
  priceUsed: string | null; quoteCurrency: string | null;
  /** phase-15: 'entry' | 'stop_loss' | 'take_profit' — spot rows are always 'entry'. */
  legKind: string;
  /** phase-15: for a conditional leg, the entry it protects. */
  linkedEntryChildOrderId: string | null;
}
interface TradeRow {
  side: string; orderType: string; limitPrice: string | null; asset: string;
  sizingMode: string | null; sizingValue: string | null;
  /** phase-15 futures intent — carried on the parent trade, not the leg. */
  isFutures: boolean;
  marginCurrency: string | null;
  stopLossPrice: string | null;
  takeProfitPrice: string | null;
  trailingStopLoss: boolean;
  leverage: string | null;
  positionMarginType: string | null;
  reduceOnly: boolean;
}

export class ExecutionWorker {
  constructor(private readonly deps: ExecutionWorkerDeps) {}

  /** Drain up to `limit` 'place' jobs: write-before-send, submit, classify. */
  async runPlaceOnce(limit = 10): Promise<WorkerRunSummary> {
    const sum: WorkerRunSummary = { handled: 0, sent: 0, ambiguous: 0, rejected: 0, terminal: 0 };
    const jobs = await claimJobsFair(this.deps.db, `worker-${process.pid}`, { limit });
    for (const job of jobs) {
      if (job.kind !== 'place') continue;
      sum.handled += 1;
      const outcome = await this.placeOne(job.childOrderId, job.tenantId);
      await deleteJob(this.deps.db, job.id);
      if (outcome === 'sent') sum.sent += 1;
      else if (outcome === 'ambiguous') { sum.ambiguous += 1; await enqueueJob(this.deps.db, job.childOrderId, job.tenantId, 'resolve', nowDate()); }
      else if (outcome === 'rejected') sum.rejected += 1;
    }
    return sum;
  }

  /** Drain up to `limit` 'resolve' jobs: ask the venue by coid and settle. */
  async runResolveOnce(limit = 10): Promise<WorkerRunSummary> {
    const sum: WorkerRunSummary = { handled: 0, sent: 0, ambiguous: 0, rejected: 0, terminal: 0 };
    const jobs = await claimJobsFair(this.deps.db, `resolve-${process.pid}`, { limit });
    for (const job of jobs) {
      if (job.kind !== 'resolve') continue;
      sum.handled += 1;
      const state = await this.resolveOne(job.childOrderId, job.tenantId);
      await deleteJob(this.deps.db, job.id);
      if (state === 'not_placed' || state === 'placed' || state === 'needs_human') sum.terminal += 1;
    }
    return sum;
  }

  // ---- phase-09 sweep surfaces ----------------------------------------------

  /**
   * Cancel fan-out over pre-checked children (T09.1). Each child's state is
   * re-checked against CANCELLABLE_STATES locally BEFORE any network call; a
   * settled child is refused with no venue request. Every accepted cancel is
   * followed by a resolve so the observed truth (cancelled, or filled if the
   * fill won the race) is what gets settled — the venue's cancel returns no
   * order (01 F8.10), so the poll is the truth.
   */
  async cancelChildren(tdb: TenantDb, children: readonly { id: string; groupTradeId: string; accountId: string; market: string | null }[]): Promise<readonly CancelRowResult[]> {
    const out: CancelRowResult[] = [];
    for (const child of children) {
      const cur = await tdb.byId('child_order', child.id)
        .select(['state', 'client_order_id as coid'] as never)
        .executeTakeFirst();
      const row = cur as unknown as { state: string; coid: string | null } | undefined;
      const fromState = row?.state ?? 'missing';
      if (row === undefined || !CANCELLABLE_STATES.has(row.state) || row.coid === null) {
        // The per-account precondition, checked locally FIRST: a filled/cancelled/
        // rejected order cannot be cancelled (the venue FAQ). No network call yet.
        out.push({
          childOrderId: child.id, accountId: child.accountId, market: child.market,
          fromState, toState: fromState, outcome: 'refused',
          detail: `cannot cancel an order in state ${fromState}`,
        });
        continue;
      }
      const res = await this.cancelOneAndObserve(tdb, child, row.coid, fromState);
      out.push(res);
    }
    return out;
  }

  /** Cancel ONE order at the venue, then poll it and settle the observed truth. */
  private async cancelOneAndObserve(
    tdb: TenantDb,
    child: { id: string; groupTradeId: string; accountId: string; market: string | null },
    coid: string,
    fromState: string,
  ): Promise<CancelRowResult> {
    const { id: childId, accountId, market, groupTradeId } = child;
    const cancel = this.deps.cancel;
    if (cancel === undefined) {
      return {
        childOrderId: childId, accountId, market, fromState, toState: fromState,
        outcome: 'refused', detail: 'no cancel port is wired to this engine',
      };
    }
    const result = await cancel(accountId, coid);
    // The order's truth is whatever the follow-up resolve observes.
    const observed = await this.deps.resolve(coid);
    if (result.kind === 'cancelled' && observed.ok && observed.order !== null) {
      const canonical = mapVenueOrderState(observed.order.statusRaw).state;
      await this.settle(tdb, { id: childId, groupTradeId, accountId }, canonical, { exchangeOrderId: observed.order.id });
      if (canonical === 'cancelled') {
        return { childOrderId: childId, accountId, market, fromState, toState: canonical, outcome: 'cancelled', detail: null };
      }
      return {
        childOrderId: childId, accountId, market, fromState, toState: canonical, outcome: 'refused',
        detail: `the venue settled the order to ${canonical} before the cancel landed`,
      };
    }
    if (observed.ok && observed.order !== null) {
      // The venue refused the cancel because the order already settled — observe
      // what it actually became (typically filled) and settle that truth.
      const canonical = mapVenueOrderState(observed.order.statusRaw).state;
      await this.settle(tdb, { id: childId, groupTradeId, accountId }, canonical, { exchangeOrderId: observed.order.id });
      return {
        childOrderId: childId, accountId, market, fromState, toState: canonical, outcome: 'refused',
        detail: `this order could not be cancelled because it is ${canonical} at the venue`,
      };
    }
    if (observed.ok && observed.order === null) {
      // The cancel succeeded and the order is gone from the venue's books.
      await this.settle(tdb, { id: childId, groupTradeId, accountId }, 'cancelled');
      return { childOrderId: childId, accountId, market, fromState, toState: 'cancelled', outcome: 'cancelled', detail: null };
    }
    // The venue could not be reached to observe truth. Leave the child where it
    // is (still cancellable) — a later cancel sweep or Loop B retries it.
    return {
      childOrderId: childId, accountId, market, fromState, toState: fromState, outcome: 'refused',
      detail: 'the venue did not answer the follow-up check; the order is left as-is to retry',
    };
  }

  /**
   * Poll the working legs of ONE group trade (Loop A for fills, T09.7): resolve
   * each by client_order_id and settle what the venue now says. Returns how many
   * children changed. A child left open stays open — the trade stays executing.
   */
  async pollTrade(tdb: TenantDb, groupTradeId: string): Promise<{ changed: number }> {
    const working = await listWorkingChildren(tdb, groupTradeId);
    let changed = 0;
    for (const child of working) {
      if (child.clientOrderId === null || !POLLABLE.has(child.state) || child.market === null) continue;
      const observed = await this.deps.resolve(child.clientOrderId);
      if (!observed.ok) continue; // venue error; the next cycle retries
      if (observed.order === null) {
        // We believed this order open, but the venue no longer knows it. Honest
        // outcome is a human check — never a guess that it filled or cancelled.
        await this.settle(tdb, { id: child.id, groupTradeId, accountId: child.accountId }, 'needs_human', {
          refusalCode: 'order_not_found_on_poll',
          refusalDetail: `order ${child.clientOrderId} was open but the venue could not find it on a poll`,
        });
        changed += 1;
        continue;
      }
      const canonical = mapVenueOrderState(observed.order.statusRaw).state;
      if (canonical === child.state) continue;
      await this.settle(tdb, { id: child.id, groupTradeId, accountId: child.accountId }, canonical, { exchangeOrderId: observed.order.id });
      changed += 1;
    }
    return { changed };
  }

  /**
   * Reconciler Loop B (T09.5): sweep each (account, market) pair that still has
   * a leg we believe is live at the venue, and compare against the venue's OWN
   * active_orders list. A leg we think is open but the venue no longer lists has
   * fallen out of Loop A — resolve it to learn what it became and settle. One
   * cycle per call; the 30 s cadence is the caller's schedule.
   */
  async loopBSweep(tdb: TenantDb, groupTradeId: string): Promise<{ recovered: number }> {
    const listActive = this.deps.listActive;
    if (listActive === undefined) return { recovered: 0 };
    const working = await listWorkingChildren(tdb, groupTradeId);
    const live = working.filter((c) => c.clientOrderId !== null && c.market !== null && VENUE_LIVE.has(c.state));
    const byPair = new Map<string, typeof live>();
    for (const child of live) {
      const key = child.accountId + "\u001f" + (child.market as string);
      const arr = byPair.get(key);
      if (arr === undefined) byPair.set(key, [child]); else arr.push(child);
    }
    let recovered = 0;
    for (const [key, children] of byPair) {
      const [accountId, market] = key.split("\u001f");
      const active = await listActive(accountId as string, market as string);
      if (!active.ok) continue;
      const activeCoids = new Set(active.orders.map((o) => o.clientOrderId));
      for (const child of children) {
        if (child.clientOrderId === null || activeCoids.has(child.clientOrderId)) continue;
        // We believe it is live; the venue's active list does not. Ask the venue
        // what it actually is now (typically filled/cancelled) and settle it.
        const observed = await this.deps.resolve(child.clientOrderId);
        if (!observed.ok) continue;
        if (observed.order === null) {
          await this.settle(tdb, { id: child.id, groupTradeId, accountId: child.accountId }, 'needs_human', {
            refusalCode: 'order_missing_from_active_sweep',
            refusalDetail: `active_orders omitted ${child.clientOrderId} and the venue could not find it on a resolve`,
          });
          recovered += 1;
          continue;
        }
        const canonical = mapVenueOrderState(observed.order.statusRaw).state;
        if (canonical !== child.state) {
          await this.settle(tdb, { id: child.id, groupTradeId, accountId: child.accountId }, canonical, { exchangeOrderId: observed.order.id });
          recovered += 1;
        }
      }
    }
    return { recovered };
  }

  // ---- the per-job steps ----------------------------------------------------

  /** Load a child + its trade; returns null when the child is gone. */
  private async load(jobChildId: string, jobTenantId: string): Promise<{ tdb: TenantDb; child: ChildRow; trade: TradeRow | null } | null> {
    const tdb = forTenant(this.deps.db, jobTenantId);
    const child = await tdb.byId('child_order', jobChildId)
      .select([
        'id', 'group_trade_id as groupTradeId', 'account_id as accountId', 'leg_seq as legSeq',
        'state', 'client_order_id as clientOrderId', 'market', 'final_quantity as finalQuantity',
        'price_used as priceUsed', 'quote_currency as quoteCurrency',
        'leg_kind as legKind', 'linked_entry_child_order_id as linkedEntryChildOrderId',
      ] as unknown as never)
      .executeTakeFirst();
    if (child === undefined) return null;
    const c = child as unknown as ChildRow;
    c.id = String(c.id);
    c.tenantId = jobTenantId;
    const gt = await tdb.byId('group_trade', c.groupTradeId)
      .select(['side', 'order_type as orderType', 'limit_price as limitPrice', 'asset',
        'sizing_mode as sizingMode', 'sizing_value as sizingValue',
        'is_futures as isFutures', 'margin_currency as marginCurrency',
        'stop_loss_price as stopLossPrice', 'take_profit_price as takeProfitPrice',
        'trailing_stop_loss as trailingStopLoss',
        'leverage', 'position_margin_type as positionMarginType', 'reduce_only as reduceOnly',
      ] as unknown as never)
      .executeTakeFirst();
    const t = gt as unknown as TradeRow | null;
    return { tdb, child: c, trade: t };
  }

  private async placeOne(jobChildId: string, jobTenantId: string): Promise<'sent' | 'ambiguous' | 'rejected' | 'skipped'> {
    const loaded = await this.load(jobChildId, jobTenantId);
    if (loaded === null) return 'skipped';
    const { tdb, child, trade } = loaded;

    // Only a 'planned' child with no coid may be sent. If this child is already
    // sending/ambiguous, another worker won the race — stand down.
    if (child.state !== 'planned') return 'skipped';

    const coid = clientOrderIdOf(this.deps.pepper, child.groupTradeId, child.accountId, child.legSeq);
    const reserved = await tdb.updateTable('child_order')
      .set({ state: 'sending', client_order_id: coid } as never)
      .where('id' as never, '=', child.id as never)
      .where('state' as never, '=', 'planned' as never)
      .where('client_order_id' as never, 'is', null as never)
      .returning('id' as unknown as never)
      .executeTakeFirst();
    if (reserved === undefined) return 'skipped'; // lost the write-before-send race

    if (trade === null || child.market === null || child.finalQuantity === null) {
      await this.settle(tdb, child, 'needs_human');
      return 'skipped';
    }

    // T08.1 — never two LIVE orders on one (account, market). Under the same
    // write-before-send race this re-check refuses a second send while any OTHER
    // order for the pair is unresolved (open/acked/…). This is the Phase-04
    // gate-12 intent enforced again at send time, where a plan-time check can
    // already be stale.
    const competing = await tdb.selectFrom('child_order')
      .select('id')
      .where('account_id' as never, '=', child.accountId as never)
      .where('market' as never, '=', child.market as never)
      .where('state' as never, 'in', UNRESOLVED as never)
      .where('id' as never, '<>', child.id as never)
      .limit(1)
      .executeTakeFirst();
    if (competing !== undefined) {
      await this.settle(tdb, child, 'not_placed', {
        refusalCode: 'order_in_flight',
        refusalDetail: `another order on ${child.market} is still open for this account`,
      });
      return 'skipped';
    }

    // T09.2/3/4 — a SELL re-derives its quantity from a FRESH free read right
    // before submit. The venue is the only truth about a holding; our projection
    // can be stale the moment outside activity lands. A holding below the market
    // minimum is dust (excluded, never sent), a fully-locked holding is a
    // HOLDING_LOCKED skip, and the size is clamped DOWN to the holding with the
    // clamp recorded on the row — never clamped up.
    let sendQuantity = child.finalQuantity;
    if (trade.side === 'sell') {
      const resized = await this.resizeSellForSend(tdb, child, trade);
      if (resized !== null) {
        if (resized.kind === 'skip') {
          await this.settle(tdb, child, 'skipped', { refusalCode: resized.code, refusalDetail: resized.detail });
          return 'skipped';
        }
        sendQuantity = resized.quantity;
        if (resized.quantity !== child.finalQuantity) {
          const set: Record<string, unknown> = { final_quantity: resized.quantity, last_observed_at: nowDate() };
          if (resized.clampedFromQuantity !== null) set['clamped_from_quantity'] = resized.clampedFromQuantity;
          if (resized.notionalMinor !== null) set['notional_minor'] = resized.notionalMinor;
          await tdb.updateTable('child_order')
            .set(set as never)
            .where('id' as never, '=', child.id as never)
            .execute();
        }
      }
    }

    // A THROW from the port strands the leg. The `sending` reservation is already
    // committed (write-before-send), so if this rejects — a signer refusal, a
    // transport failure, a bug — and we let it propagate, the child sits `sending`
    // FOREVER: nothing settles it, and it blocks this (account, market) with
    // ORDER_IN_FLIGHT for every future trade. Observed for real: one signer
    // misconfiguration froze an account.
    //
    // AMBIGUOUS, never rejected. We asked the venue and do not know the answer;
    // `rejected` would claim the order does not exist, and that claim is what
    // abandons a live position. Ambiguous enqueues a resolve job, which the
    // server's sweep then re-checks.
    let outcome;
    try {
      outcome = await this.deps.submit(coid, {
      accountId: child.accountId,
      tenantId: jobTenantId,
      side: trade.side,
      market: child.market,
      quantity: sendQuantity,
      orderType: trade.orderType,
      limitPrice: trade.limitPrice,
      childOrderId: child.id,
      // Only a futures trade carries this. The margin currency is NOT NULL in the
      // schema whenever is_futures is set (group_trade_futures_required_fields),
      // so the fallbacks here are for the type system, not for a real state.
      ...(trade.isFutures === true
        ? {
            futures: {
              pair: futuresPairOf({ asset: trade.asset, quote: quoteOfMarket(child.market) },
                (trade.marginCurrency ?? 'INR') as 'INR' | 'USDT'),
              marginCurrency: trade.marginCurrency ?? 'INR',
              leverage: Number.parseInt(trade.leverage ?? '1', 10),
              positionMarginType: trade.positionMarginType ?? 'isolated',
              reduceOnly: trade.reduceOnly === true,
            },
          }
          : {}),
      });
    } catch (e) {
      await this.settle(tdb, child, 'ambiguous', {
        refusalCode: 'submit_threw',
        refusalDetail: e instanceof Error ? e.message : String(e),
      });
      return 'ambiguous';
    }

    if (outcome.kind === 'accepted') {
      const canonical = mapVenueOrderState(outcome.statusRaw ?? '').state;
      await this.settle(tdb, child, canonical,
        outcome.exchangeOrderId !== undefined ? { exchangeOrderId: outcome.exchangeOrderId } : {});
      return 'sent';
    }
    // Undecidable is a STRONGER statement than ambiguous, so it is checked first:
    // there is nothing left to look at, and a scheduled resolve would only delay
    // the human who has to look anyway.
    if (outcome.needsHuman === true) {
      await this.settle(tdb, child, 'needs_human', {
        refusalCode: outcome.code ?? 'undecidable',
        refusalDetail: outcome.detail ?? '',
      });
      return 'rejected';
    }
    // A rejection where the order may still exist (timeout/5xx) is AMBIGUOUS:
    // resolve it, never re-send.
    if (outcome.orderMayExist === true) {
      await this.settle(tdb, child, 'ambiguous');
      return 'ambiguous';
    }
    // A business rejection can never have placed an order — terminal, never retried.
    await this.settle(tdb, child, 'rejected', { refusalCode: outcome.code ?? 'rejected', refusalDetail: outcome.detail ?? '' });
    return 'rejected';
  }

  /**
   * The T09.2/3/4 sell re-derivation at send time, wired to this row. Returns:
   *  - null — not a sale the module covers (no holdings port wired);
   *  - { kind:'skip' } — dust / fully-locked / no holding / no market data;
   *  - { kind:'send', quantity, clampedFromQuantity, notionalMinor } — the size
   *    to actually submit (never above the fresh holding). notionalMinor is
   *    recomputed whenever the quantity changed, so the report's value matches.
   */
  private async resizeSellForSend(
    tdb: TenantDb,
    child: ChildRow,
    trade: TradeRow,
  ): Promise<
    | { kind: 'send'; quantity: string; clampedFromQuantity: string | null; notionalMinor: string | null }
    | { kind: 'skip'; code: string; detail: string }
    | null
  > {
    if (this.deps.holdings === undefined) return null; // dry-run / pre-Phase-09 build
    const market = child.market as string;
    const version = await latestMarketMetadataVersion(this.deps.db);
    if (version === null) {
      return { kind: 'skip', code: 'NO_MARKET_DATA', detail: 'no market metadata to floor a sell against right now' };
    }
    const rules = (await loadMarketRules(this.deps.db, version)).find((r) => r.venueSymbol === market);
    if (rules === undefined) {
      return { kind: 'skip', code: 'NO_MARKET_DATA', detail: `no current market rules for ${market}` };
    }
    const balances = await this.deps.holdings(child.accountId);
    const holding = balances.find((b) => b.currency === trade.asset);
    const free = holding === undefined ? '0' : toStr(scaledFromMinor(holding.freeMinor, holding.scale as never));
    const locked = holding === undefined ? '0' : toStr(scaledFromMinor(holding.lockedMinor, holding.scale as never));

    const mode: 'sell_all' | 'pct_position' | 'fixed' =
      trade.sizingMode === 'sell_all' ? 'sell_all'
      : trade.sizingMode === 'pct_position' ? 'pct_position'
      : 'fixed';
    const percentBp = trade.sizingMode === 'pct_position' ? (trade.sizingValue === null ? 0 : Number.parseInt(trade.sizingValue, 10)) : undefined;

    const out = resizeSellForSend({
      mode,
      ...(percentBp !== undefined ? { percentBp } : {}),
      plannedQuantity: child.finalQuantity as string,
      free,
      locked,
      orderType: trade.orderType === 'limit' ? 'limit' : 'market',
      rules,
    });
    if (out.kind === 'skip') return { kind: 'skip', code: out.code, detail: out.detail };

    // Recompute the notional in minor units when the size changed (a clamp-down or
    // a grown sell-all), using the SAME quantity×price→minor math the planner used.
    let notionalMinor: string | null = null;
    if (out.quantity !== child.finalQuantity && child.priceUsed !== null) {
      const quoteScale = quoteScaleOf(child.quoteCurrency ?? 'INR');
      const value = notional(nat(out.quantity), nat(child.priceUsed), quoteScale);
      notionalMinor = String(value.v);
    }
    return { kind: 'send', quantity: out.quantity, clampedFromQuantity: out.clampedFromQuantity, notionalMinor };
  }

  private async resolveOne(jobChildId: string, jobTenantId: string): Promise<'placed' | 'not_placed' | 'needs_human' | 'skipped'> {
    const loaded = await this.load(jobChildId, jobTenantId);
    if (loaded === null) return 'skipped';
    const { tdb, child } = loaded;
    const coid = child.clientOrderId;
    if (coid === null) {
      // No id was ever reserved — nothing was sent, so it is not placed.
      await this.settle(tdb, child, 'not_placed');
      return 'not_placed';
    }
    // Walk the ladder: a not-found within the trust delay is retried, never
    // believed; exhaustion (or an erroring venue) ends in needs_human, never a guess.
    const opts = this.deps.resolveScheduleGapsMs !== undefined ? { stepGapsMs: this.deps.resolveScheduleGapsMs } : {};
    const out = await resolveLadder(coid, this.deps.resolve, opts);
    if (out.state === 'placed') {
      const canonical = mapVenueOrderState(out.statusRaw).state;
      await this.settle(tdb, child, canonical, { exchangeOrderId: out.exchangeOrderId });
      return 'placed';
    }
    if (out.state === 'not_found') {
      await this.settle(tdb, child, 'not_placed');
      return 'not_placed';
    }
    await this.settle(tdb, child, 'needs_human');
    return 'needs_human';
  }

  /** Move a child to a terminal-ish canonical state, guarding a valid transition. */
  private async settle(
    tdb: TenantDb,
    child: Pick<ChildRow, 'id' | 'groupTradeId' | 'accountId'>,
    state: string,
    extra: { exchangeOrderId?: string; refusalCode?: string; refusalDetail?: string; triggerState?: string } = {},
  ): Promise<void> {
    const set: Record<string, unknown> = { state, last_observed_at: nowDate() };
    if (extra.exchangeOrderId !== undefined) set['exchange_order_id'] = extra.exchangeOrderId;
    if (extra.refusalCode !== undefined) set['refusal_code'] = extra.refusalCode;
    if (extra.refusalDetail !== undefined) set['refusal_detail'] = extra.refusalDetail;
    if (extra.triggerState !== undefined) set['trigger_state'] = extra.triggerState;
    // A terminal state is stamped; the caller decides legality (12 F1 is app logic).
    if (state === 'not_placed' || state === 'rejected' || state === 'needs_human') set['terminal_at'] = nowDate();
    const updated = await tdb.updateTable('child_order')
      .set(set as never)
      .where('id' as never, '=', child.id as never)
      .returning(['leg_kind as legKind', 'market as market'] as unknown as never)
      .executeTakeFirst();
    const updatedRow = updated as unknown as { legKind: string; market: string | null } | undefined;
    // T08.6: publish AFTER the commit, so a subscriber only ever hears durable truth.
    if (this.deps.onChildState !== undefined) {
      this.deps.onChildState({
        groupTradeId: child.groupTradeId,
        childOrderId: child.id,
        accountId: child.accountId,
        state,
        exchangeOrderId: extra.exchangeOrderId ?? null,
        refusalCode: extra.refusalCode ?? null,
        refusalDetail: extra.refusalDetail ?? null,
        at: Date.now(),
      });
    }
    // T15.5 — a futures ENTRY leg carries conditional siblings (SL/TP) that were
    // created at enqueue and are still 'planned'. The venue attaches protection
    // to a POSITION, so the trigger is the entry SETTLING, not the confirm call:
    // a filled entry owes an attach; a terminal non-fill owes a labelled skip
    // (never a leg left 'planned' forever, which would wedge the trade open).
    if (updatedRow?.legKind === 'entry') {
      if (state === 'filled') {
        await this.attachProtection(tdb, child, updatedRow.market);
      } else if (ENTRY_NO_POSITION.has(state)) {
        await this.skipConditionals(tdb, child, 'entry_' + state);
      }
    }
    // T09.7: once no child of this trade is still working, flip it to completed.
    // Guarded in SQL on `status = 'executing'`, so concurrent settles cannot
    // double-flip. A failure here must not disturb the already-committed settle.
    if (!WORKING_SET.has(state)) {
      try {
        await completeGroupTradeIfAllSettled(tdb, child.groupTradeId, nowDate().getTime());
      } catch (e) {
        console.error('completion flip failed for group trade', child.groupTradeId, e);
      }
    }
  }

  /**
   * Attach the group trade's SL/TP to the position this entry opened (T15.5).
   *
   * Called only after an entry leg reports `filled` — the one entry state that
   * guarantees a position exists at the venue. Each conditional sibling is
   * settled by the venue's own per-leg answer: `untriggered` when the leg landed,
   * `rejected` with the venue's reason when it did not. A leg the customer never
   * asked for is settled `skipped` so the trade can still complete.
   *
   * When no attach port is wired (dry-run builds, pre-Phase-14) the conditionals
   * are skipped with a labelled reason — the trade completes honestly rather than
   * hanging on a leg nothing can ever place.
   *
   * Narrow gap, deliberately left: an entry that fills PARTIALLY and is then
   * cancelled (`partially_cancelled`) may have left a position behind, and this
   * path skips its conditionals. The customer can attach protection from the
   * Positions page, and A21 watches for an unprotected position.
   */
  private async attachProtection(
    tdb: TenantDb,
    entry: Pick<ChildRow, 'id' | 'groupTradeId' | 'accountId'>,
    market: string | null,
  ): Promise<void> {
    const conditionals = await tdb.selectFrom('child_order')
      .select(['id', 'leg_kind as legKind', 'price_used as priceUsed'] as unknown as never)
      .where('linked_entry_child_order_id' as never, '=', entry.id as never)
      .where('state' as never, '=', 'planned' as never)
      .execute();
    if (conditionals.length === 0) return;

    const rows = conditionals as unknown as Array<{ id: string; legKind: string; priceUsed: string | null }>;
    const attach = this.deps.attachTpSl;

    const trade = await tdb.byId('group_trade', entry.groupTradeId)
      .select(['asset', 'margin_currency as marginCurrency', 'trailing_stop_loss as trailingStopLoss'] as unknown as never)
      .executeTakeFirst();
    const tradeRow = trade as unknown as { asset: string; marginCurrency: 'INR' | 'USDT' | null; trailingStopLoss: boolean } | undefined;

    // Nothing can be attached: no port, no market, or no margin currency. Skip
    // every leg with a reason the customer can read, so the trade completes.
    if (attach === undefined || market === null || tradeRow === undefined || tradeRow.marginCurrency === null) {
      const why = attach === undefined
        ? 'protection is not attached in this build (no futures engine wired)'
        : 'this leg has no market or margin currency to attach protection against';
      for (const leg of rows) await this.settle(tdb, { id: leg.id, groupTradeId: entry.groupTradeId, accountId: entry.accountId }, 'skipped', { refusalCode: 'TP_SL_NOT_ATTACHED', refusalDetail: why });
      return;
    }

    const quote = quoteOfMarket(market);
    const pair = futuresPairOf({ asset: tradeRow.asset, quote }, tradeRow.marginCurrency);
    const slLeg = rows.find((l) => l.legKind === 'stop_loss');
    const tpLeg = rows.find((l) => l.legKind === 'take_profit');

    const out = await attach({
      accountId: entry.accountId,
      pair,
      marginCurrency: tradeRow.marginCurrency,
      stopLossPrice: slLeg?.priceUsed ?? null,
      takeProfitPrice: tpLeg?.priceUsed ?? null,
      trailingStopLoss: tradeRow.trailingStopLoss,
    });

    if (!out.ok) {
      // Venue refused the whole call (or could not be reached). Every leg is
      // rejected with the same reason; the position is open and unprotected,
      // which A21 surfaces.
      for (const leg of rows) {
        await this.settle(tdb, { id: leg.id, groupTradeId: entry.groupTradeId, accountId: entry.accountId }, 'rejected', {
          refusalCode: out.code,
          refusalDetail: out.detail,
        });
      }
      return;
    }

    const settleLeg = async (leg: { id: string } | undefined, res: AttachLegResult | undefined, label: string): Promise<void> => {
      if (leg === undefined) return;
      if (res === undefined) {
        await this.settle(tdb, { id: leg.id, groupTradeId: entry.groupTradeId, accountId: entry.accountId }, 'skipped', {
          refusalCode: 'TP_SL_NOT_REQUESTED',
          refusalDetail: `no ${label} was configured for this trade`,
        });
        return;
      }
      if (res.ok) {
        await this.settle(tdb, { id: leg.id, groupTradeId: entry.groupTradeId, accountId: entry.accountId }, 'untriggered', {
          triggerState: 'untriggered',
        });
      } else {
        await this.settle(tdb, { id: leg.id, groupTradeId: entry.groupTradeId, accountId: entry.accountId }, 'rejected', {
          refusalCode: 'TP_SL_REFUSED',
          refusalDetail: res.reason ?? `the venue refused the ${label}`,
        });
      }
    };
    await settleLeg(slLeg, out.stopLoss, 'stop-loss');
    await settleLeg(tpLeg, out.takeProfit, 'take-profit');
  }

  /**
   * The entry can never open a position, so its conditional siblings are settled
   * `skipped` with a reason derived from the entry's own outcome. Without this a
   * 'planned' conditional would hold the trade in `executing` forever.
   */
  private async skipConditionals(
    tdb: TenantDb,
    entry: Pick<ChildRow, 'id' | 'groupTradeId' | 'accountId'>,
    reason: string,
  ): Promise<void> {
    await tdb.updateTable('child_order')
      .set({
        state: 'skipped',
        refusal_code: 'ENTRY_DID_NOT_FILL',
        refusal_detail: `protection was not attached because the entry leg did not fill (${reason})`,
      } as never)
      .where('linked_entry_child_order_id' as never, '=', entry.id as never)
      .where('state' as never, '=', 'planned' as never)
      .execute();
  }
}

/** Entry outcomes that prove no position was opened. */
const ENTRY_NO_POSITION: ReadonlySet<string> = new Set([
  'rejected', 'not_placed', 'skipped', 'needs_human', 'cancelled', 'partially_cancelled', 'liquidated',
]);

/** The states that keep a group trade executing (mirrors the DB WORKING set). */
const WORKING_SET: ReadonlySet<string> = new Set(['planned', 'sending', 'ambiguous', 'acked', 'open']);
