// Repository for persisted closed futures trades.
//
// Records accurate realized settlement and fill data retrieved directly from
// exchange history, regardless of whether the position was closed via Tradex,
// the CoinDCX mobile/web app, exchange-side TP/SL, or liquidation.

import type { TenantDb } from './tenant-scope.js';

export interface FuturesClosedTradeInput {
  readonly id?: string | undefined;
  readonly accountId: string;
  readonly pair: string;
  readonly market?: string | undefined;
  readonly side: 'long' | 'short';
  readonly quantity: string;
  readonly avgEntryPrice: string;
  readonly avgExitPrice: string;
  readonly leverage?: string | null | undefined;
  readonly realizedPnlMinor: string;
  readonly marginCurrency: 'INR' | 'USDT';
  readonly feeMinor?: string | null | undefined;
  readonly roePct?: number | null | undefined;
  readonly durationMs?: number | null | undefined;
  readonly openedAt?: Date | null | undefined;
  readonly closedAt: Date;
  readonly venuePositionId?: string | null | undefined;
  readonly venueOrderId?: string | null | undefined;
  readonly exitStage?: string | null | undefined;
  readonly hideFromPositions?: boolean | undefined;
}

export interface FuturesClosedTradeRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly pair: string;
  readonly market: string;
  readonly side: 'long' | 'short';
  readonly quantity: string;
  readonly avgEntryPrice: string;
  readonly avgExitPrice: string;
  readonly leverage: string | null;
  readonly realizedPnlMinor: string;
  readonly marginCurrency: 'INR' | 'USDT';
  readonly feeMinor: string | null;
  readonly roePct: number | null;
  readonly durationMs: number | null;
  readonly openedAt: Date | null;
  readonly closedAt: Date;
  readonly venuePositionId: string | null;
  readonly venueOrderId: string | null;
  readonly exitStage: string | null;
  readonly hideFromPositions: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export async function upsertFuturesClosedTrades(
  tdb: TenantDb,
  trades: readonly FuturesClosedTradeInput[],
  atMs: number = Date.now(),
): Promise<number> {
  if (trades.length === 0) return 0;
  const at = new Date(atMs);
  let written = 0;

  for (const t of trades) {
    const market = t.market ?? t.pair;
    const values = {
      account_id: t.accountId,
      pair: t.pair,
      market,
      side: t.side,
      quantity: t.quantity,
      avg_entry_price: t.avgEntryPrice,
      avg_exit_price: t.avgExitPrice,
      leverage: t.leverage ?? null,
      realized_pnl_minor: t.realizedPnlMinor,
      margin_currency: t.marginCurrency,
      fee_minor: t.feeMinor ?? null,
      roe_pct: t.roePct ?? null,
      duration_ms: t.durationMs ?? null,
      opened_at: t.openedAt ?? null,
      closed_at: t.closedAt,
      venue_position_id: t.venuePositionId ?? null,
      venue_order_id: t.venueOrderId ?? null,
      exit_stage: t.exitStage ?? null,
      hide_from_positions: t.hideFromPositions ?? false,
      updated_at: at,
    };

    // If venue_order_id and venue_position_id are present, check existing row by composite unique key
    if (t.venueOrderId && t.venuePositionId) {
      const existing = await tdb.selectFrom('futures_closed_trade')
        .select('id')
        .where('account_id' as never, '=', t.accountId as never)
        .where('venue_order_id' as never, '=', t.venueOrderId as never)
        .where('venue_position_id' as never, '=', t.venuePositionId as never)
        .executeTakeFirst();

      if (existing) {
        await tdb.updateTable('futures_closed_trade')
          .set({
            ...values,
            updated_at: at,
          } as never)
          .where('id' as never, '=', (existing as { id: string }).id as never)
          .execute();
        written += 1;
        continue;
      }
    }

    await tdb.insertInto('futures_closed_trade', {
      ...values,
      created_at: at,
    } as never).execute();
    written += 1;
  }

  return written;
}

export interface ListFuturesClosedTradesQuery {
  readonly accountIds?: readonly string[] | undefined;
  readonly fromMs?: number | undefined;
  readonly toMs?: number | undefined;
  readonly hideHidden?: boolean | undefined;
}

export async function listFuturesClosedTrades(
  tdb: TenantDb,
  query: ListFuturesClosedTradesQuery = {},
): Promise<readonly FuturesClosedTradeRecord[]> {
  let q = tdb.selectFrom('futures_closed_trade')
    .selectAll()
    .orderBy('closed_at' as never, 'desc' as never);

  if (query.accountIds && query.accountIds.length > 0) {
    q = q.where('account_id' as never, 'in', query.accountIds as never);
  }
  if (query.fromMs !== undefined && query.fromMs > 0) {
    q = q.where('closed_at' as never, '>=', new Date(query.fromMs) as never);
  }
  if (query.toMs !== undefined && query.toMs > 0) {
    q = q.where('closed_at' as never, '<=', new Date(query.toMs) as never);
  }
  if (query.hideHidden === true) {
    q = q.where('hide_from_positions' as never, '=', false as never);
  }

  const rows = await q.execute();
  return rows.map((r: Record<string, unknown>) => ({
    id: String(r['id']),
    tenantId: String(r['tenant_id']),
    accountId: String(r['account_id']),
    pair: String(r['pair']),
    market: String(r['market']),
    side: r['side'] as 'long' | 'short',
    quantity: String(r['quantity']),
    avgEntryPrice: String(r['avg_entry_price']),
    avgExitPrice: String(r['avg_exit_price']),
    leverage: r['leverage'] ? String(r['leverage']) : null,
    realizedPnlMinor: String(r['realized_pnl_minor']),
    marginCurrency: (r['margin_currency'] === 'USDT' ? 'USDT' : 'INR') as 'INR' | 'USDT',
    feeMinor: r['fee_minor'] ? String(r['fee_minor']) : null,
    roePct: r['roe_pct'] !== null && r['roe_pct'] !== undefined ? Number(r['roe_pct']) : null,
    durationMs: r['duration_ms'] !== null && r['duration_ms'] !== undefined ? Number(r['duration_ms']) : null,
    openedAt: r['opened_at'] instanceof Date ? r['opened_at'] : (r['opened_at'] ? new Date(String(r['opened_at'])) : null),
    closedAt: r['closed_at'] instanceof Date ? r['closed_at'] : new Date(String(r['closed_at'])),
    venuePositionId: r['venue_position_id'] ? String(r['venue_position_id']) : null,
    venueOrderId: r['venue_order_id'] ? String(r['venue_order_id']) : null,
    exitStage: r['exit_stage'] ? String(r['exit_stage']) : null,
    hideFromPositions: Boolean(r['hide_from_positions']),
    createdAt: r['created_at'] instanceof Date ? r['created_at'] : new Date(String(r['created_at'])),
    updatedAt: r['updated_at'] instanceof Date ? r['updated_at'] : new Date(String(r['updated_at'])),
  }));
}
