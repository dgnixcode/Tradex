-- 029_account_hide_from_positions.sql
-- Add hide_from_positions flag to exchange_account to allow excluding accounts from the main platform positions screen.

BEGIN;

ALTER TABLE exchange_account
  ADD COLUMN IF NOT EXISTS hide_from_positions boolean NOT NULL DEFAULT false;

COMMIT;
