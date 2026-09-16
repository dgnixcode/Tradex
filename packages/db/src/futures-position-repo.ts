// The futures position mirror — the missing PRODUCER for `futures_position`.
//
// The table had a schema, a reader (`apps/api/src/futures/positions.ts`) and index
// checks, and nothing ever wrote to it, so the Positions page was permanently
// empty. This is that writer.
//
// It is a MIRROR, not a reconciler: the venue is the source of truth and this is a
// cache of its last answer. So
//
//   * every field comes from the venue's own read — nothing is computed here;
//   * a row with `active_pos = '0'` is UPDATED, not deleted, because the view
//     filters flat rows out and keeping the row preserves when we last saw it;
//   * a pair the venue no longer reports is left alone rather than pruned. Pruning
//     would need a full picture of what the venue should have returned, which a
//     single read does not give.
//
// Two unique constraints live on this table —
// `(tenant_id, venue_position_id)` and `(tenant_id, account_id, pair, margin_currency)`
// — and `ON CONFLICT` can only name one. The PAIR is the natural key (a venue
// position id is stable per pair per margin type), so that is the target and the
// venue id is updated from EXCLUDED.

import type { FuturesPositionSnapshot } from '@tradex/exchange';
import type { TenantDb } from './tenant-scope.js';

export class FuturesPositionRepoError extends Error {
  override readonly name = 'FuturesPositionRepoError';
}

/** The margin currencies the venue reports positions for. */
const MARGIN_CURRENCIES: readonly string[] = ['INR', 'USDT'];

/** A numeric field the venue reports as a number, restated as text for `venue_decimal`. */
const dec = (v: string | null): string | null => v;

/**
 * Make our rows for one account match EXACTLY what a full venue read reported.
 *
 * The upsert alone is not enough, and the gap is the one customers notice: a
 * position the venue no longer reports — closed, liquidated, or gone because the
 * venue was rebuilt — kept its row and kept rendering as OPEN. A stale position
 * shown as live is the state someone trades on.
 *
 * Deleting is only sound because the caller's read is COMPLETE: `mirrorAccounts`
 * reads every margin currency the venue supports, so "not in the response" means
 * "not open", not "not in this page of results". A partial read must not come
 * through here.
 */
export async function replaceFuturesPositions(
  tdb: TenantDb,
  accountId: string,
  snapshots: readonly FuturesPositionSnapshot[],
  atMs: number = Date.now(),
): Promise<number> {
  const written = await upsertFuturesPositions(tdb, accountId, snapshots, atMs);

  if (snapshots.length === 0) {
    // The venue reports nothing open for this account. That is a complete answer,
    // so every row of ours for it is stale.
    await tdb.deleteFrom('futures_position')
      .where('account_id' as never, '=', accountId as never)
      .execute();
    return written;
  }

  const keep = [...new Set(snapshots.map((s) => s.venuePositionId))];
  const stale = await tdb.deleteFrom('futures_position')
    .where('account_id' as never, '=', accountId as never)
    .where('venue_position_id' as never, 'not in', keep as never)
    .returning('id' as never)
    .execute();

  return written + stale.length;
}

/**
 * Upsert what the venue reported for one account.
 *
 * Returns how many rows were written, so a caller can tell "the venue reports no
 * positions" (0) from "the read failed" (an exception) — a distinction the
 * Positions page depends on and a silent empty result would destroy.
 */

export async function upsertFuturesPositions(
  tdb: TenantDb,
  accountId: string,
  snapshots: readonly FuturesPositionSnapshot[],
  atMs: number = Date.now(),
): Promise<number> {
  const at = new Date(atMs);
  let written = 0;

  for (const snap of snapshots) {
    if (!MARGIN_CURRENCIES.includes(snap.marginCurrency)) {
      throw new FuturesPositionRepoError(
        `the venue reported a ${snap.marginCurrency} position, which is not a currency we margin in`,
      );
    }
    if (snap.venuePositionId === '' || snap.pair === '') {
      throw new FuturesPositionRepoError('a venue position must carry an id and a pair');
    }

    const values = {
      account_id: accountId,
      pair: snap.pair,
      margin_currency: snap.marginCurrency,
      venue_position_id: snap.venuePositionId,
      // Signed — positive long, negative short. Migration 017 is what makes this
      // storable; before it, the unsigned domain rejected every short outright.
      active_pos: snap.activePos,
      avg_entry_price: dec(snap.avgEntryPrice),
      mark_price: dec(snap.markPrice),
      mark_observed_at: new Date(snap.observedAtMs),
      liquidation_price: dec(snap.liquidationPrice),
      // `venue_decimal` is text; the snapshot carries a number.
      leverage: snap.leverage === null ? null : String(snap.leverage),
      locked_margin_minor: dec(snap.lockedMarginMinor),
      stop_loss_trigger: dec(snap.stopLossTrigger),
      take_profit_trigger: dec(snap.takeProfitTrigger),
      margin_type: snap.marginType,
      funding_rate_bp: snap.fundingRateBp,
      settlement_currency_avg_price: dec(snap.settlementCurrencyAvgPrice ?? null),
      updated_at: at,
    };

    await tdb.insertInto('futures_position', values)
      .onConflict((oc) => oc
        .columns(['tenant_id', 'account_id', 'pair', 'margin_currency'])
        .doUpdateSet({
          venue_position_id: snap.venuePositionId,
          active_pos: snap.activePos,
          avg_entry_price: dec(snap.avgEntryPrice),
          mark_price: dec(snap.markPrice),
          mark_observed_at: new Date(snap.observedAtMs),
          liquidation_price: dec(snap.liquidationPrice),
          leverage: snap.leverage === null ? null : String(snap.leverage),
          locked_margin_minor: dec(snap.lockedMarginMinor),
          stop_loss_trigger: dec(snap.stopLossTrigger),
          take_profit_trigger: dec(snap.takeProfitTrigger),
          margin_type: snap.marginType,
          funding_rate_bp: snap.fundingRateBp,
          settlement_currency_avg_price: dec(snap.settlementCurrencyAvgPrice ?? null),
          updated_at: at,
        } as never) as never)
      .execute();
    written += 1;
  }

  return written;
}
