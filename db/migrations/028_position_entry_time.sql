-- 028_position_entry_time.sql
-- Add opened_at (persisted entry time) and exchange_updated_at to futures_position.

BEGIN;

ALTER TABLE futures_position
  ADD COLUMN IF NOT EXISTS opened_at timestamptz DEFAULT now(),
  ADD COLUMN IF NOT EXISTS exchange_updated_at timestamptz;

-- Backfill opened_at with updated_at for existing rows
UPDATE futures_position
  SET opened_at = updated_at
  WHERE opened_at IS NULL;

COMMIT;
