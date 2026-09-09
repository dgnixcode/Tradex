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
import { mapVenueOrderState } from '@tradex/exchange';
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
}
interface TradeRow {
  side: string; orderType: string; limitPrice: string | null; asset: string;
  sizingMode: string | null; sizingValue: string | null;
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
      ] as unknown as never)
      .executeTakeFirst();
    if (child === undefined) return null;
    const c = child as unknown as ChildRow;
    c.id = String(c.id);
    c.tenantId = jobTenantId;
    const gt = await tdb.byId('group_trade', c.groupTradeId)
      .select(['side', 'order_type as orderType', 'limit_price as limitPrice', 'asset',
        'sizing_mode as sizingMode', 'sizing_value as sizingValue'] as unknown as never)
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

    const outcome = await this.deps.submit(coid, {
      accountId: child.accountId,
      tenantId: jobTenantId,
      side: trade.side,
      market: child.market,
      quantity: sendQuantity,
      orderType: trade.orderType,
      limitPrice: trade.limitPrice,
    });

    if (outcome.kind === 'accepted') {
      const canonical = mapVenueOrderState(outcome.statusRaw ?? '').state;
      await this.settle(tdb, child, canonical,
        outcome.exchangeOrderId !== undefined ? { exchangeOrderId: outcome.exchangeOrderId } : {});
      return 'sent';
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
    extra: { exchangeOrderId?: string; refusalCode?: string; refusalDetail?: string } = {},
  ): Promise<void> {
    const set: Record<string, unknown> = { state, last_observed_at: nowDate() };
    if (extra.exchangeOrderId !== undefined) set['exchange_order_id'] = extra.exchangeOrderId;
    if (extra.refusalCode !== undefined) set['refusal_code'] = extra.refusalCode;
    if (extra.refusalDetail !== undefined) set['refusal_detail'] = extra.refusalDetail;
    // A terminal state is stamped; the caller decides legality (12 F1 is app logic).
    if (state === 'not_placed' || state === 'rejected' || state === 'needs_human') set['terminal_at'] = nowDate();
    await tdb.updateTable('child_order')
      .set(set as never)
      .where('id' as never, '=', child.id as never)
      .execute();
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
}

/** The states that keep a group trade executing (mirrors the DB WORKING set). */
const WORKING_SET: ReadonlySet<string> = new Set(['planned', 'sending', 'ambiguous', 'acked', 'open']);
