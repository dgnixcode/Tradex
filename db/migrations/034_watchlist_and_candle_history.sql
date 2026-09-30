-- 034_watchlist_and_candle_history.sql
-- Historical candlestick data store and watchlist coin download registry.

BEGIN;

CREATE TABLE IF NOT EXISTS watchlist_coin (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  symbol                      text NOT NULL,
  pair                        text NOT NULL,
  is_active                   boolean NOT NULL DEFAULT true,
  added_at                    timestamptz NOT NULL DEFAULT now(),
  sync_status                 text NOT NULL DEFAULT 'pending',
  synced_timeframes           jsonb NOT NULL DEFAULT '{}'::jsonb,
  earliest_candle_at          timestamptz,
  latest_candle_at            timestamptz,
  total_candles_count         bigint NOT NULL DEFAULT 0,
  last_sync_error             text,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT watchlist_coin_tenant_symbol_unique UNIQUE (tenant_id, symbol)
);

CREATE INDEX IF NOT EXISTS watchlist_coin_tenant_active_idx
  ON watchlist_coin(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS market_candle_dataset (
  id                          text PRIMARY KEY,
  pair                        text NOT NULL,
  symbol                      text NOT NULL,
  timeframe                   text NOT NULL,
  year                        integer NOT NULL,
  month                       integer NOT NULL,
  bar_count                   integer NOT NULL,
  start_time                  bigint NOT NULL,
  end_time                    bigint NOT NULL,
  file_path                   text NOT NULL,
  source                      text NOT NULL DEFAULT 'binance',
  created_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_candle_dataset_lookup_idx
  ON market_candle_dataset(pair, timeframe, year, month);

COMMIT;
