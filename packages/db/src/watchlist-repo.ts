// Database operations for watchlist coins and historical candle datasets.

import type { Kysely } from 'kysely';
import type { DB } from './schema.js';
import type { TenantDb } from './tenant-scope.js';

export interface WatchlistCoinRecord {
  id: string;
  tenantId: string;
  symbol: string;
  pair: string;
  isActive: boolean;
  addedAt: Date;
  syncStatus: 'pending' | 'syncing' | 'synced' | 'error';
  syncedTimeframes: Record<string, { count: number; syncedAt: string }>;
  earliestCandleAt: Date | null;
  latestCandleAt: Date | null;
  totalCandlesCount: number;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CandleDatasetRecord {
  id: string;
  pair: string;
  symbol: string;
  timeframe: string;
  year: number;
  month: number;
  barCount: number;
  startTime: number;
  endTime: number;
  filePath: string;
  source: string;
  createdAt: Date;
}

export async function upsertWatchlistCoin(
  tdb: TenantDb,
  input: { symbol: string; pair: string; isActive?: boolean },
): Promise<void> {
  const cleanSymbol = input.symbol.toUpperCase().trim();
  const cleanPair = input.pair.toUpperCase().trim();

  await tdb
    .insertInto('watchlist_coin', {
      symbol: cleanSymbol,
      pair: cleanPair,
      is_active: input.isActive ?? true,
      updated_at: new Date(),
    } as never)
    .onConflict((oc) =>
      oc.columns(['tenant_id', 'symbol']).doUpdateSet({
        is_active: input.isActive ?? true,
        updated_at: new Date(),
      }),
    )
    .execute();
}

export async function listWatchlistCoins(tdb: TenantDb): Promise<WatchlistCoinRecord[]> {
  const rows = await tdb
    .selectFrom('watchlist_coin')
    .selectAll()
    .orderBy('added_at', 'desc')
    .execute();

  return rows.map((r) => {
    const raw = r as unknown as Record<string, unknown>;
    return {
      id: String(raw['id']),
      tenantId: String(raw['tenant_id']),
      symbol: String(raw['symbol']),
      pair: String(raw['pair']),
      isActive: Boolean(raw['is_active']),
      addedAt: new Date(String(raw['added_at'])),
      syncStatus: (raw['sync_status'] ?? 'pending') as WatchlistCoinRecord['syncStatus'],
      syncedTimeframes: (raw['synced_timeframes'] ?? {}) as Record<string, { count: number; syncedAt: string }>,
      earliestCandleAt: raw['earliest_candle_at'] ? new Date(String(raw['earliest_candle_at'])) : null,
      latestCandleAt: raw['latest_candle_at'] ? new Date(String(raw['latest_candle_at'])) : null,
      totalCandlesCount: Number(raw['total_candles_count'] ?? 0),
      lastSyncError: raw['last_sync_error'] ? String(raw['last_sync_error']) : null,
      createdAt: new Date(String(raw['created_at'])),
      updatedAt: new Date(String(raw['updated_at'])),
    };
  });
}

export async function updateWatchlistCoinProgress(
  tdb: TenantDb,
  symbol: string,
  updates: {
    syncStatus?: 'pending' | 'syncing' | 'synced' | 'error';
    syncedTimeframes?: Record<string, { count: number; syncedAt: string }>;
    earliestCandleAt?: Date | null;
    latestCandleAt?: Date | null;
    totalCandlesCount?: number;
    lastSyncError?: string | null;
  },
): Promise<void> {
  const setValues: Record<string, unknown> = {
    updated_at: new Date(),
  };

  if (updates.syncStatus !== undefined) setValues['sync_status'] = updates.syncStatus;
  if (updates.syncedTimeframes !== undefined) setValues['synced_timeframes'] = JSON.stringify(updates.syncedTimeframes);
  if (updates.earliestCandleAt !== undefined) setValues['earliest_candle_at'] = updates.earliestCandleAt;
  if (updates.latestCandleAt !== undefined) setValues['latest_candle_at'] = updates.latestCandleAt;
  if (updates.totalCandlesCount !== undefined) setValues['total_candles_count'] = String(updates.totalCandlesCount);
  if (updates.lastSyncError !== undefined) setValues['last_sync_error'] = updates.lastSyncError;

  await tdb
    .updateTable('watchlist_coin')
    .set(setValues as never)
    .where('symbol' as never, '=', symbol.toUpperCase().trim() as never)
    .execute();
}

export async function recordCandleDataset(
  db: Kysely<DB>,
  dataset: {
    id: string;
    pair: string;
    symbol: string;
    timeframe: string;
    year: number;
    month: number;
    barCount: number;
    startTime: number;
    endTime: number;
    filePath: string;
    source?: string;
  },
): Promise<void> {
  await db
    .insertInto('market_candle_dataset')
    .values({
      id: dataset.id,
      pair: dataset.pair,
      symbol: dataset.symbol,
      timeframe: dataset.timeframe,
      year: dataset.year,
      month: dataset.month,
      bar_count: dataset.barCount,
      start_time: String(dataset.startTime),
      end_time: String(dataset.endTime),
      file_path: dataset.filePath,
      source: dataset.source ?? 'binance',
      created_at: new Date(),
    } as never)
    .onConflict((oc) =>
      oc.column('id').doUpdateSet({
        bar_count: dataset.barCount,
        start_time: String(dataset.startTime),
        end_time: String(dataset.endTime),
        file_path: dataset.filePath,
      }),
    )
    .execute();
}

export async function listCandleDatasets(
  db: Kysely<DB>,
  pair: string,
  timeframe: string,
): Promise<CandleDatasetRecord[]> {
  const rows = await db
    .selectFrom('market_candle_dataset')
    .selectAll()
    .where('pair' as never, '=', pair as never)
    .where('timeframe' as never, '=', timeframe as never)
    .orderBy('start_time', 'asc')
    .execute();

  return rows.map((r) => {
    const raw = r as unknown as Record<string, unknown>;
    return {
      id: String(raw['id']),
      pair: String(raw['pair']),
      symbol: String(raw['symbol']),
      timeframe: String(raw['timeframe']),
      year: Number(raw['year']),
      month: Number(raw['month']),
      barCount: Number(raw['bar_count']),
      startTime: Number(raw['start_time']),
      endTime: Number(raw['end_time']),
      filePath: String(raw['file_path']),
      source: String(raw['source'] ?? 'binance'),
      createdAt: new Date(String(raw['created_at'])),
    };
  });
}

export async function listAllCandleDatasets(db: Kysely<DB>): Promise<CandleDatasetRecord[]> {
  const rows = await db
    .selectFrom('market_candle_dataset')
    .selectAll()
    .orderBy('symbol', 'asc')
    .orderBy('timeframe', 'asc')
    .orderBy('start_time', 'asc')
    .execute();

  return rows.map((r) => {
    const raw = r as unknown as Record<string, unknown>;
    return {
      id: String(raw['id']),
      pair: String(raw['pair']),
      symbol: String(raw['symbol']),
      timeframe: String(raw['timeframe']),
      year: Number(raw['year']),
      month: Number(raw['month']),
      barCount: Number(raw['bar_count']),
      startTime: Number(raw['start_time']),
      endTime: Number(raw['end_time']),
      filePath: String(raw['file_path']),
      source: String(raw['source'] ?? 'binance'),
      createdAt: new Date(String(raw['created_at'])),
    };
  });
}
