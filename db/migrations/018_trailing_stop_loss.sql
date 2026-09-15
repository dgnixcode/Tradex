BEGIN;

CREATE TABLE futures_trailing_sl (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  venue_position_id text NOT NULL,
  pair text NOT NULL,
  
  -- Configuration
  distance_bp numeric(38,0) NOT NULL,
  step_bp numeric(38,0) NOT NULL,
  
  -- State Tracking
  high_water_mark numeric(38,0) NOT NULL,
  current_sl_price numeric(38,0) NOT NULL,
  
  status text NOT NULL CHECK (status IN ('active', 'updating', 'failed', 'closed')),
  last_evaluated_at timestamptz NOT NULL,
  
  -- FK constraints for integrity against the parent position
  FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account(tenant_id, id),
  
  UNIQUE (account_id, venue_position_id)
);

CREATE INDEX idx_futures_trailing_sl_active_pairs ON futures_trailing_sl (status, pair) WHERE status = 'active';

COMMIT;
