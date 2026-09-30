-- 033_algo_trading.sql
-- Algorithmic trading strategies, execution scheduler, and execution telemetry.

BEGIN;

CREATE TABLE IF NOT EXISTS algo_strategy (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  name                text NOT NULL,
  description         text,
  target_type         text NOT NULL CHECK (target_type IN ('account', 'group')),
  target_id           uuid NOT NULL,
  pair                text NOT NULL,
  timeframe           text NOT NULL DEFAULT '5m',
  schedule_interval   text NOT NULL DEFAULT '5m' CHECK (schedule_interval IN ('1m', '5m', '15m', '30m', '1h', '4h', '1d', 'manual')),
  script              text NOT NULL,
  params              jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL DEFAULT 'stopped' CHECK (status IN ('active', 'paused', 'stopped')),
  is_dry_run          boolean NOT NULL DEFAULT true,
  last_run_at         timestamptz,
  last_status         text CHECK (last_status IS NULL OR last_status IN ('success', 'error', 'skipped')),
  last_error          text,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS algo_run (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  strategy_id         uuid NOT NULL REFERENCES algo_strategy(id) ON DELETE CASCADE,
  mode                text NOT NULL CHECK (mode IN ('backtest', 'dry_run', 'live')),
  status              text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  triggered_at        timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  logs                jsonb NOT NULL DEFAULT '[]'::jsonb,
  actions_taken       jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics             jsonb NOT NULL DEFAULT '{}'::jsonb,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS algo_strategy_tenant_status_idx
  ON algo_strategy (tenant_id, status);

CREATE INDEX IF NOT EXISTS algo_strategy_tenant_target_idx
  ON algo_strategy (tenant_id, target_id);

CREATE INDEX IF NOT EXISTS algo_strategy_tenant_created_idx
  ON algo_strategy (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS algo_run_strategy_triggered_idx
  ON algo_run (tenant_id, strategy_id, triggered_at DESC);

COMMIT;
