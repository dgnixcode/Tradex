// The ledger writer — plan/phase-07 T07.3/T07.7.
//
// The one place a venue fill becomes ledger rows. It decomposes the fill
// (decomposeFill → asset leg, cash leg, fee, optional TDS) and inserts each row
// IDEMPOTENTLY: the unique index on (account_id, exchange_trade_id, kind,
// occurred_at) turns a re-ingested page into zero rows (L4). Only rows that were
// actually NEW this call bump account_market_seen — so a duplicate page cannot
// inflate the novelty counter that the 16 F2 attack shape watches.
//
// `occurredAt` is the venue's own fill time, not the clock — a late page arriving
// tomorrow must land under yesterday's partition, and re-running it must be a
// no-op.

import { sql } from 'kysely';
import { decomposeFill, foldLedger } from '@tradex/ledger';
import type { FillInput } from '@tradex/ledger';
import type { Holding, LedgerRow } from '@tradex/ledger';
import type { TenantDb } from './tenant-scope.js';

export class LedgerWriterError extends Error {
  override readonly name = 'LedgerWriterError';
}

export interface FillToRecord extends Omit<FillInput, 'seq'> {
  readonly accountId: string;
  readonly market: string;
}

export interface RecordFillResult {
  /** True when at least one row was NEW (a first ingest of this fill). */
  readonly inserted: boolean;
  /** How many rows the fill decomposed into (3 or 4). */
  readonly rows: number;
}

/**
 * Record one venue fill. Idempotent: re-recording the same fill inserts nothing
 * and bumps nothing. Returns whether anything was new.
 */
export async function recordFill(tdb: TenantDb, fill: FillToRecord): Promise<RecordFillResult> {
  const at = new Date(fill.occurredAtMs);
  const decomposed = decomposeFill({
    exchangeTradeId: fill.exchangeTradeId,
    side: fill.side,
    asset: fill.asset,
    quote: fill.quote,
    qty: fill.qty,
    price: fill.price,
    feeMinor: fill.feeMinor,
    assetScale: fill.assetScale,
    occurredAtMs: fill.occurredAtMs,
    seq: 0,
  });

  let inserted = false;
  await tdb.transaction(async (tx) => {
    for (let i = 0; i < decomposed.length; i += 1) {
      const r = decomposed[i] as NonNullable<typeof decomposed[number]>;
      const row = await tx.insertInto('ledger_entry', {
        account_id: fill.accountId,
        exchange_trade_id: fill.exchangeTradeId,
        kind: r.kind,
        asset: r.asset,
        quote_asset: r.quoteAsset ?? fill.quote,
        delta_minor: r.deltaMinor,
        scale: r.scale,
        price: r.price ?? null,
        fee_minor: r.feeMinor ?? null,
        tds_minor: r.tdsMinor ?? null,
        estimated: r.estimated ?? false,
        occurred_at: at,
      } as never)
        .onConflict((oc) => oc
          .columns(['account_id', 'exchange_trade_id', 'kind', 'occurred_at'] as never)
          .doNothing() as never)
        .returning('id' as never)
        .executeTakeFirst();
      if (row !== undefined) inserted = true;
    }

    if (inserted) {
      // A genuinely new fill on this (account, market): first ever → insert, else
      // bump last_fill_at + count. Never re-run on a duplicate page.
      await tx.insertInto('account_market_seen', {
        account_id: fill.accountId,
        market: fill.market,
        first_fill_at: at,
        last_fill_at: at,
        fill_count: 1,
      } as never)
        .onConflict((oc) => oc
          .columns(['account_id', 'market'] as never)
          .doUpdateSet({
            last_fill_at: at,
            fill_count: sql`account_market_seen.fill_count + 1`,
          } as never) as never)
        .execute();
    }
  });

  return { inserted, rows: decomposed.length };
}

// ============================================================ Loop D (T07.5)
// Reconcile the account's BOOKS (the fold of its ledger rows) against what the
// venue says it holds (account_balance: free + locked). A difference beyond a
// one-step tolerance is UNEXPLAINED — outside activity (a manual deposit, a
// stray fill) that would corrupt cost basis if folded in silently. The reconcile
// reports it; the account is badged `approximate` until it is explained, and the
// cost basis is never touched.

/** A plain-decimal quantity → integer minor units at `places`, floored. */
function minorOf(qty: string, places: number): bigint {
  const neg = qty.startsWith('-');
  const body = neg ? qty.slice(1) : qty;
  const dot = body.indexOf('.');
  const frac = dot === -1 ? '' : body.slice(dot + 1);
  const int = (dot === -1 ? body : body.slice(0, dot)) || '0';
  const digits = int + frac.padEnd(places, '0');
  const v = BigInt(digits === '' ? '0' : digits);
  return neg ? -v : v;
}

export interface ReconciliationItem {
  readonly asset: string;
  /** Held per the books, in this asset's minor units at the balance's scale. */
  readonly heldMinor: string;
  /** Venue total (free + locked), same minor units. */
  readonly venueMinor: string;
  /** Signed difference, same units. */
  readonly diffMinor: string;
  /** True when outside the tolerance and not explainable from the books. */
  readonly unexplained: boolean;
}

export interface BalanceReconciliation {
  readonly items: readonly ReconciliationItem[];
  /** True when any asset is unexplained — badge the account `approximate`. */
  readonly approximate: boolean;
}

export interface ReconcileOptions {
  /** Tolerance in the asset's minor units (default 1 = one step of a sane market). */
  readonly toleranceMinor?: bigint | undefined;
}

/** Loop D: compare the folded books against the venue's reported balances. */
export async function reconcileBalances(
  tdb: TenantDb,
  accountId: string,
  opts: ReconcileOptions = {},
): Promise<BalanceReconciliation> {
  const tolerance = opts.toleranceMinor ?? 1n;

  const rows = await tdb.selectFrom('ledger_entry')
    .select(['kind', 'asset', 'quote_asset', 'delta_minor', 'scale', 'price', 'fee_minor', 'tds_minor', 'estimated', 'occurred_at', 'id'] as unknown as never)
    .where('account_id' as never, '=', accountId as never)
    .orderBy('occurred_at', 'asc' as never)
    .orderBy('id', 'asc' as never)
    .execute();
  const ledgerRows: LedgerRow[] = (rows as unknown as Array<Record<string, unknown>>).map((r, i) => ({
    exchangeTradeId: null,
    kind: r['kind'] as LedgerRow['kind'],
    asset: r['asset'] as string,
    quoteAsset: (r['quote_asset'] as string | null),
    deltaMinor: String(r['delta_minor']),
    scale: (r['scale'] as number) as unknown as LedgerRow['scale'],
    price: (r['price'] as string | null),
    feeMinor: r['fee_minor'] === null ? null : String(r['fee_minor']),
    tdsMinor: r['tds_minor'] === null ? null : String(r['tds_minor']),
    occurredAtMs: new Date(r['occurred_at'] as string).getTime(),
    seq: i,
  }));

  const holdings = foldLedger(ledgerRows);

  const balances = await tdb.selectFrom('account_balance')
    .select(['currency', 'free_minor', 'locked_minor', 'scale'] as unknown as never)
    .where('account_id' as never, '=', accountId as never)
    .execute() as unknown as ReadonlyArray<{ currency: string; free_minor: string; locked_minor: string; scale: number }>;

  const balanceOf = new Map(balances.map((b) => [b.currency, b]));
  const items: ReconciliationItem[] = [];
  const funding = new Set(['INR', 'USDT']);

  // Every held asset: does the venue agree?
  for (const h of holdings) {
    if (h.qty === '0' && funding.has(h.quoteAsset)) continue; // a fully-sold quote asset is nothing to reconcile
    const b = balanceOf.get(h.asset);
    const scale = b?.scale ?? 8;
    const heldMinor = minorOf(h.qty, scale);
    const venueMinor = b === undefined ? 0n : BigInt(b.free_minor) + BigInt(b.locked_minor);
    const diff = venueMinor - heldMinor;
    const unexplained = diff > tolerance || diff < -tolerance;
    items.push({ asset: h.asset, heldMinor: String(heldMinor), venueMinor: String(venueMinor), diffMinor: String(diff), unexplained });
  }

  // Venue assets the books know nothing about (and are not funding cash): a manual
  // deposit — the classic unexplained activity.
  for (const b of balances) {
    if (funding.has(b.currency)) continue;
    if (holdings.some((h) => h.asset === b.currency)) continue;
    const venueMinor = BigInt(b.free_minor) + BigInt(b.locked_minor);
    if (venueMinor === 0n) continue;
    items.push({ asset: b.currency, heldMinor: '0', venueMinor: String(venueMinor), diffMinor: String(venueMinor), unexplained: true });
  }

  return { items, approximate: items.some((i) => i.unexplained) };
}


// ===================================================== periodic invariant (T07.8)
// The `holding` table is a DERIVED projection: the source of truth is always the
// ledger, and the projection is trustworthy only while it equals a fresh fold of
// the ledger. This job REBUILDS it (on demand or on a schedule) and VERIFIES the
// two invariants the phase depends on:
//   L2  the projection equals the fold of the ledger;
//   L6  cost_total is zero exactly when qty is zero.
// A deliberate corruption (a bad row, a half-applied change) must FAIL loudly,
// never be silently trusted.

async function projectAccount(tdb: TenantDb, accountId: string): Promise<readonly Holding[]> {
  const rows = await tdb.selectFrom('ledger_entry')
    .select(['kind', 'asset', 'quote_asset', 'delta_minor', 'scale', 'price', 'fee_minor', 'tds_minor', 'estimated', 'occurred_at', 'id'] as unknown as never)
    .where('account_id' as never, '=', accountId as never)
    .orderBy('occurred_at', 'asc' as never)
    .orderBy('id', 'asc' as never)
    .execute();
  const ledgerRows: LedgerRow[] = (rows as unknown as Array<Record<string, unknown>>).map((r, i) => ({
    exchangeTradeId: null,
    kind: r['kind'] as LedgerRow['kind'],
    asset: r['asset'] as string,
    quoteAsset: (r['quote_asset'] as string | null),
    deltaMinor: String(r['delta_minor']),
    scale: (r['scale'] as number) as unknown as LedgerRow['scale'],
    price: (r['price'] as string | null),
    feeMinor: r['fee_minor'] === null ? null : String(r['fee_minor']),
    tdsMinor: r['tds_minor'] === null ? null : String(r['tds_minor']),
    occurredAtMs: new Date(r['occurred_at'] as string).getTime(),
    seq: i,
  }));
  return foldLedger(ledgerRows);
}

/** Recompute the fold and write it into the `holding` projection (upsert). */
export async function rebuildHoldings(tdb: TenantDb, accountId: string, at = new Date()): Promise<readonly Holding[]> {
  const projection = await projectAccount(tdb, accountId);
  await tdb.transaction(async (tx) => {
    for (const h of projection) {
      await tx.insertInto('holding', {
        account_id: accountId,
        asset: h.asset,
        qty: h.qty,
        cost_total_minor: h.costTotalMinor,
        realised_pnl_minor: h.realisedMinor,
        fee_drag_minor: h.feeDragMinor,
        tds_withheld_minor: h.tdsWithheldMinor,
        quote_asset: h.quoteAsset,
        rebuilt_at: at,
      } as never)
        .onConflict((oc) => oc
          .columns(['account_id', 'asset'] as never)
          .doUpdateSet({
            qty: h.qty,
            cost_total_minor: h.costTotalMinor,
            realised_pnl_minor: h.realisedMinor,
            fee_drag_minor: h.feeDragMinor,
            tds_withheld_minor: h.tdsWithheldMinor,
            quote_asset: h.quoteAsset,
            rebuilt_at: at,
          } as never) as never)
        .execute();
    }
  });
  return projection;
}

export interface InvariantViolation {
  readonly asset: string;
  readonly field: string;
  readonly stored: string;
  readonly expected: string;
}

export interface InvariantResult {
  /** True when the stored projection equals a fresh fold of the ledger (L2). */
  readonly ok: boolean;
  readonly violations: readonly InvariantViolation[];
}

/** Verify the stored projection against a fresh fold. Alarms (returns false) on L2/L6 failure. */
export async function verifyHoldings(tdb: TenantDb, accountId: string): Promise<InvariantResult> {
  const expected = await projectAccount(tdb, accountId);
  const expectedByAsset = new Map(expected.map((h) => [h.asset, h]));
  const stored = await tdb.selectFrom('holding')
    .select(['asset', 'qty', 'cost_total_minor', 'realised_pnl_minor', 'fee_drag_minor', 'tds_withheld_minor'] as unknown as never)
    .where('account_id' as never, '=', accountId as never)
    .execute() as unknown as ReadonlyArray<{
      asset: string; qty: string; cost_total_minor: string; realised_pnl_minor: string; fee_drag_minor: string; tds_withheld_minor: string;
    }>;

  const violations: InvariantViolation[] = [];
  const storedSeen = new Set<string>();

  for (const s of stored) {
    storedSeen.add(s.asset);
    const want = expectedByAsset.get(s.asset);
    if (want === undefined) {
      violations.push({ asset: s.asset, field: '(stale row)', stored: `${s.qty} @ cost ${s.cost_total_minor}`, expected: '(none — ledger has no holding)' });
      continue;
    }
    const checks: ReadonlyArray<[string, string, string]> = [
      ['qty', s.qty, want.qty],
      ['cost_total_minor', s.cost_total_minor, want.costTotalMinor],
      ['realised_pnl_minor', s.realised_pnl_minor, want.realisedMinor],
    ];
    for (const [field, st, ex] of checks) {
      if (st !== ex) violations.push({ asset: s.asset, field, stored: st, expected: ex });
    }
  }
  // L2 both ways: a holding the ledger now implies but the projection lacks.
  for (const h of expected) {
    if (!storedSeen.has(h.asset)) {
      violations.push({ asset: h.asset, field: '(missing row)', stored: '(absent)', expected: `${h.qty} @ cost ${h.costTotalMinor}` });
    }
  }
  // L6 within the stored table itself, independent of the fold.
  for (const s of stored) {
    const qtyZero = s.qty === '0';
    const costZero = s.cost_total_minor === '0';
    if (qtyZero !== costZero) {
      violations.push({ asset: s.asset, field: 'L6', stored: `${s.qty} qty / cost ${s.cost_total_minor}`, expected: 'cost zero iff qty zero' });
    }
  }

  return { ok: violations.length === 0, violations };
}
