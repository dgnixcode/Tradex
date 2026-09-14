// The group executor — plan/phase-08 T08.1/T08.4 (offline core).
//
// The fan-out: a confirmed group trade becomes one 'place' job per PLANNED child,
// and the Phase-06 worker drains them under a concurrency cap. The anti-duplicate
// spine (atomic write-before-send, deterministic coid, the venue's duplicate
// rejection, resolve-don't-resend) is unchanged — this phase only starts more of
// them at once. Bounded parallelism means the worker never has more than
// `concurrency` sends in flight, and every child still reaches a KNOWN state.
//
// This file deliberately does NOT place orders itself: it enqueues and lets the
// ExecutionWorker do the sends, so the whole rung-0→6 guarantee stack applies
// unchanged to a group.

import { getChildOrders } from '@tradex/db';
import type { ChildOrderRow } from '@tradex/db';
import { forTenant, addExecutionJob } from '@tradex/db';
import type { DB, TenantDb } from '@tradex/db';
import type { Kysely } from 'kysely';
import type { ExecutionWorker, WorkerRunSummary } from './execution-worker.js';

export interface GroupExecutorDeps {
  readonly db: Kysely<DB>;
  /** The Phase-06 worker that actually sends + resolves. */
  readonly worker: ExecutionWorker;
}

export interface EnqueueResult {
  readonly enqueued: number;
  readonly alreadyTerminal: number;
  /** Futures only: SL/TP sibling legs materialised for the planned entries. */
  readonly conditionals: number;
}

export interface DrainResult {
  readonly placeRuns: number;
  readonly place: WorkerRunSummary;
  readonly resolve: WorkerRunSummary;
  readonly stillPlanned: string[];
}

export class GroupExecutor {
  constructor(private readonly deps: GroupExecutorDeps) {}

  /**
   * Start a group trade: move it to `executing` and enqueue one 'place' job per
   * child still in `planned`. Children already terminal (they cannot be — a fresh
   * group trade has none) are counted separately.
   */
  async enqueue(tdb: TenantDb, groupTradeId: string): Promise<EnqueueResult> {
    await tdb.updateTable('group_trade')
      .set({ status: 'executing', submitted_at: new Date() } as never)
      .where('id' as never, '=', groupTradeId as never)
      .where('status' as never, 'in', ['previewed', 'draft'] as never)
      .execute();

    const children = await getChildOrders(tdb, groupTradeId);
    let enqueued = 0;
    let alreadyTerminal = 0;
    const planned: ChildOrderRow[] = [];
    for (const child of children) {
      if (child.state === 'planned') {
        await addExecutionJob(this.deps.db, child.id, tdb.tenantId, 'place');
        enqueued += 1;
        planned.push(child);
      } else {
        alreadyTerminal += 1;
      }
    }

    // T15.5 — futures SL/TP fan-out. Each planned entry gets its conditional
    // legs MATERIALISED here, so they are part of the trade (visible in
    // Activity, and holding it `executing`) from the moment it starts — but no
    // job is enqueued for them. The venue attaches protection to a POSITION,
    // not to an order, so the only correct trigger is the entry SETTLING to
    // `filled`; the worker does that from `attachProtection`.
    const conditionals = await this.materialiseConditionals(tdb, groupTradeId, planned);
    return { enqueued, alreadyTerminal, conditionals };
  }

  /**
   * Create the stop-loss / take-profit sibling legs for each planned entry of a
   * futures trade. Returns how many were created (0 for a spot trade, or a
   * futures trade with neither trigger configured).
   *
   * `leg_seq` continues above the highest entry leg so the (group_trade_id,
   * leg_seq) uniqueness holds without a magic offset. `price_used` carries the
   * TRIGGER price for a conditional leg — that is what `attachProtection` reads.
   */
  private async materialiseConditionals(
    tdb: TenantDb,
    groupTradeId: string,
    entries: readonly ChildOrderRow[],
  ): Promise<number> {
    if (entries.length === 0) return 0;
    const trade = await tdb.byId('group_trade', groupTradeId)
      .select([
        'is_futures as isFutures',
        'stop_loss_price as stopLossPrice',
        'take_profit_price as takeProfitPrice',
      ] as unknown as never)
      .executeTakeFirst();
    const t = trade as unknown as
      { isFutures: boolean; stopLossPrice: string | null; takeProfitPrice: string | null } | undefined;
    if (t === undefined || t.isFutures !== true) return 0;

    const legs: Array<{ kind: 'stop_loss' | 'take_profit'; price: string }> = [];
    if (t.stopLossPrice !== null) legs.push({ kind: 'stop_loss', price: t.stopLossPrice });
    if (t.takeProfitPrice !== null) legs.push({ kind: 'take_profit', price: t.takeProfitPrice });
    if (legs.length === 0) return 0;

    let seq = entries.reduce((max, e) => Math.max(max, e.legSeq), 0);
    let made = 0;
    for (const entry of entries) {
      for (const leg of legs) {
        seq += 1;
        await tdb.insertInto('child_order', {
          group_trade_id: groupTradeId,
          account_id: entry.accountId,
          leg_seq: seq,
          state: 'planned',
          market: entry.market,
          quote_currency: entry.quoteCurrency,
          final_quantity: entry.finalQuantity,
          price_used: leg.price,
          leg_kind: leg.kind,
          linked_entry_child_order_id: entry.id,
        } as never).execute();
        made += 1;
      }
    }
    return made;
  }

  /**
   * Drain the queue for this tenant until no 'place' jobs remain or the loop cap
   * is hit, resolving any ambiguous sends between passes. Returns what happened.
   */
  async drain(concurrency = 8): Promise<DrainResult> {
    const cap = Math.max(1, Math.floor(concurrency));
    const place: WorkerRunSummary = { handled: 0, sent: 0, ambiguous: 0, rejected: 0, terminal: 0 };
    const resolve: WorkerRunSummary = { handled: 0, sent: 0, ambiguous: 0, rejected: 0, terminal: 0 };
    let placeRuns = 0;

    // Each pass claims up to `cap` jobs. We loop until a pass finds nothing to
    // place (bounded by an outer safety cap so a wedged queue cannot spin forever).
    for (let round = 0; round < 200; round += 1) {
      const p = await this.deps.worker.runPlaceOnce(cap);
      placeRuns += 1;
      place.handled += p.handled; place.sent += p.sent; place.ambiguous += p.ambiguous;
      place.rejected += p.rejected; place.terminal += p.terminal;

      if (p.ambiguous > 0 || p.handled === 0 && round > 0) {
        const r = await this.deps.worker.runResolveOnce(cap);
        resolve.handled += r.handled; resolve.terminal += r.terminal; resolve.ambiguous += r.ambiguous;
      }
      // Stop once a pass placed nothing AND resolved nothing still queued.
      if (p.handled === 0) break;
    }

    return { placeRuns, place, resolve, stillPlanned: [] };
  }

  /**
   * Drain with a grace deadline (T13.7 / R4): keep placing and resolving until
   * nothing is queued OR the grace window elapses, so a worker that received
   * SIGTERM finishes its in-flight order before the process exits. Returns whether
   * it drained completely within the grace window.
   */
  async gracefulDrain(graceMs = 60_000, concurrency = 8): Promise<{
    readonly drained: boolean;
    readonly placeRuns: number;
    readonly place: WorkerRunSummary;
    readonly resolve: WorkerRunSummary;
  }> {
    const deadline = Date.now() + Math.max(0, graceMs);
    const cap = Math.max(1, Math.floor(concurrency));
    const place: WorkerRunSummary = { handled: 0, sent: 0, ambiguous: 0, rejected: 0, terminal: 0 };
    const resolve: WorkerRunSummary = { handled: 0, sent: 0, ambiguous: 0, rejected: 0, terminal: 0 };
    let placeRuns = 0;
    let lastPlace = 0;
    let lastResolve = 0;

    for (let round = 0; round < 200; round += 1) {
      const p = await this.deps.worker.runPlaceOnce(cap);
      placeRuns += 1;
      lastPlace = p.handled;
      place.handled += p.handled; place.sent += p.sent; place.ambiguous += p.ambiguous;
      place.rejected += p.rejected; place.terminal += p.terminal;

      const r = await this.deps.worker.runResolveOnce(cap);
      lastResolve = r.handled;
      resolve.handled += r.handled; resolve.terminal += r.terminal; resolve.ambiguous += r.ambiguous;

      // Nothing left to place or resolve → the fan-out is done; stop before grace.
      if (lastPlace === 0 && lastResolve === 0) break;
      if (Date.now() >= deadline) break;
    }

    return { drained: lastPlace === 0 && lastResolve === 0, placeRuns, place, resolve };
  }
}

/** Mark an executing trade abandoned if it still has planned children past `maxWaitMs`. */
export async function abandonIfStale(
  db: Kysely<DB>,
  tenantId: string,
  groupTradeId: string,
  opts: { maxWaitMs?: number; now?: Date } = {},
): Promise<{ skipped: number }> {
  const now = opts.now ?? new Date();
  const tdb = forTenant(db, tenantId);
  const cut = new Date(now.getTime() - (opts.maxWaitMs ?? 60_000));
  // A child still 'planned' whose trade is older than the window never started.
  const res = await tdb.updateTable('child_order')
    .set({ state: 'skipped', refusal_code: 'platform_busy', refusal_detail: 'the group trade could not start in time and was abandoned' } as never)
    .where('group_trade_id' as never, '=', groupTradeId as never)
    .where('state' as never, '=', 'planned' as never)
    .where('created_at' as never, '<', cut as never)
    .executeTakeFirst();
  const n = Number((res as { numUpdatedRows?: bigint } | undefined)?.numUpdatedRows ?? 0n);
  if (n > 0) {
    await tdb.updateTable('group_trade')
      .set({ status: 'abandoned', completed_at: now } as never)
      .where('id' as never, '=', groupTradeId as never)
      .execute();
  }
  return { skipped: n };
}
