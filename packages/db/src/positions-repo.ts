// The positions read — plan/phase-09 T09.6.
//
// The read side of the holdings projection. `holding` is the DERIVED truth (011):
// quantity, weighted-average cost in quote minor, realised P&L, fee drag and TDS,
// rebuilt from ledger_entry by the fold (T07.2, rebuildHoldings). A positions
// screen shows it as-is — never a re-derivation, and never a mark-to-market value
// (the §6a boundary; there is no equity_snapshot for a reason). These two reads
// are deliberately dumb: all shaping (avg price, dust, roll-ups) happens in the
// caller so the projection and its presentation cannot drift.

import type { TenantDb } from './tenant-scope.js';

/** One non-empty `holding` projection row: a current position in one asset. */
export interface HeldPositionRow {
  readonly accountId: string;
  readonly asset: string;
  readonly quoteAsset: 'INR' | 'USDT';
  /** Exact decimal; never '0' (a zero row is not a position). */
  readonly qty: string;
  /** Signed quote minor — what was paid to acquire `qty`. */
  readonly costTotalMinor: string;
  readonly realisedPnlMinor: string;
  readonly feeDragMinor: string;
  readonly tdsWithheldMinor: string;
  readonly rebuiltAt: string;
}

/** A child order still live at the venue — what locks a holding's free balance. */
export interface OpenOrderRow {
  readonly accountId: string;
  readonly asset: string;
  readonly market: string;
  readonly side: string;
  readonly state: string;
  /** The quantity still committed: final, or remaining after a partial fill. */
  readonly quantity: string;
  readonly createdAt: string;
}

/**
 * Every non-empty holding for the given accounts. Only rows that actually hold
 * something (qty ≠ 0) are positions — a fully-sold asset is a flat row, not an
 * open position.
 */
export async function listHeldPositions(tdb: TenantDb, accountIds: readonly string[]): Promise<HeldPositionRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await tdb.selectFrom('holding')
    .select([
      'account_id as accountId', 'asset', 'quote_asset as quoteAsset',
      'qty', 'cost_total_minor as costTotalMinor', 'realised_pnl_minor as realisedPnlMinor',
      'fee_drag_minor as feeDragMinor', 'tds_withheld_minor as tdsWithheldMinor',
      'rebuilt_at as rebuiltAt',
    ] as unknown as never)
    .where('account_id' as never, 'in', accountIds as never)
    .where('qty' as never, '<>', '0' as never)
    .orderBy('account_id' as never)
    .orderBy('asset' as never)
    .execute();
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    accountId: r['accountId'] as string,
    asset: r['asset'] as string,
    quoteAsset: r['quoteAsset'] as 'INR' | 'USDT',
    qty: String(r['qty']),
    costTotalMinor: String(r['costTotalMinor']),
    realisedPnlMinor: String(r['realisedPnlMinor']),
    feeDragMinor: String(r['feeDragMinor']),
    tdsWithheldMinor: String(r['tdsWithheldMinor']),
    rebuiltAt: r['rebuiltAt'] instanceof Date ? (r['rebuiltAt'] as Date).toISOString() : String(r['rebuiltAt']),
  }));
}

/**
 * The orders still live at the venue for the given accounts — each locks part of
 * an account's free holding in `asset`. The asset and side come from the parent
 * group trade (child_order itself carries only the market).
 */
export async function listOpenOrdersForAccounts(tdb: TenantDb, accountIds: readonly string[]): Promise<OpenOrderRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await tdb.selectFrom('child_order')
    .innerJoin('group_trade', 'group_trade.id', 'child_order.group_trade_id')
    .select([
      'child_order.account_id as accountId', 'group_trade.asset as asset', 'child_order.market as market',
      'group_trade.side as side', 'child_order.state as state',
      'child_order.remaining_quantity as remainingQuantity', 'child_order.final_quantity as finalQuantity',
      'child_order.created_at as createdAt',
    ] as unknown as never)
    .where('child_order.account_id' as never, 'in', accountIds as never)
    .where('child_order.state' as never, 'in', ['acked', 'open', 'partially_filled'] as never)
    .orderBy('child_order.created_at' as never)
    .execute();
  return (rows as unknown as Array<Record<string, unknown>>)
    .filter((r) => r['remainingQuantity'] !== null || r['finalQuantity'] !== null)
    .map((r) => ({
      accountId: r['accountId'] as string,
      asset: r['asset'] as string,
      market: r['market'] as string,
      side: r['side'] as string,
      state: r['state'] as string,
      quantity: r['remainingQuantity'] === null ? String(r['finalQuantity']) : String(r['remainingQuantity']),
      createdAt: r['createdAt'] instanceof Date ? (r['createdAt'] as Date).toISOString() : String(r['createdAt']),
    }));
}
