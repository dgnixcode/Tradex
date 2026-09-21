-- 031_position_hide_from_positions.sql
-- Add hide_from_positions flag to futures_position to allow hiding individual trades/positions from platform positions and analytics.

BEGIN;

ALTER TABLE futures_position
  ADD COLUMN IF NOT EXISTS hide_from_positions boolean NOT NULL DEFAULT false;

COMMIT;
