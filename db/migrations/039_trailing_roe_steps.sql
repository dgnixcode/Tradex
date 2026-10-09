BEGIN;

-- Preserve existing live trails and queued entry intent. New clients explicitly
-- opt into ROE steps; historical price percentages must never be reinterpreted.
ALTER TABLE group_trade ADD COLUMN trailing_step_basis text NOT NULL DEFAULT 'price'
  CHECK (trailing_step_basis IN ('price', 'roe'));
ALTER TABLE futures_trailing_sl ADD COLUMN step_basis text NOT NULL DEFAULT 'price'
  CHECK (step_basis IN ('price', 'roe'));
ALTER TABLE futures_trailing_sl ADD COLUMN step_anchor_price numeric(38,18);
ALTER TABLE futures_trailing_sl ADD COLUMN position_basis_key text;
-- ROE steps on leveraged positions frequently move less than one quote unit.
ALTER TABLE futures_trailing_sl ALTER COLUMN high_water_mark TYPE numeric(38,18);
ALTER TABLE futures_trailing_sl ALTER COLUMN current_sl_price TYPE numeric(38,18);

COMMIT;
