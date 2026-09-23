-- 032_futures_closed_trade.sql
-- Synchronized closed futures trades and realized settlement from exchange history.

BEGIN;

CREATE TABLE IF NOT EXISTS futures_closed_trade (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  account_id                  uuid NOT NULL,
  pair                        text NOT NULL,
  market                      text NOT NULL,
  side                        text NOT NULL CHECK (side IN ('long', 'short')),
  quantity                    venue_decimal NOT NULL,
  avg_entry_price             venue_decimal NOT NULL,
  avg_exit_price              venue_decimal NOT NULL,
  leverage                    venue_decimal,
  realized_pnl_minor          numeric(38,0) NOT NULL,
  margin_currency             text NOT NULL CHECK (margin_currency IN ('INR', 'USDT')),
  fee_minor                   numeric(38,0),
  roe_pct                     double precision,
  duration_ms                 bigint,
  opened_at                   timestamptz,
  closed_at                   timestamptz NOT NULL,
  venue_position_id           text,
  venue_order_id              text,
  exit_stage                  text CHECK (exit_stage IS NULL OR exit_stage IN ('exit', 'tpsl_exit', 'liquidation', 'default')),
  hide_from_positions         boolean NOT NULL DEFAULT false,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT futures_closed_trade_tenant_account_fk
    FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS futures_closed_trade_unique_idx
  ON futures_closed_trade (tenant_id, account_id, venue_order_id, venue_position_id)
  WHERE venue_order_id IS NOT NULL AND venue_position_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS futures_closed_trade_closed_at_idx
  ON futures_closed_trade (tenant_id, closed_at DESC);

CREATE INDEX IF NOT EXISTS futures_closed_trade_account_idx
  ON futures_closed_trade (tenant_id, account_id, closed_at DESC);

CREATE INDEX IF NOT EXISTS futures_closed_trade_pair_idx
  ON futures_closed_trade (tenant_id, pair);

COMMIT;
