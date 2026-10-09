BEGIN;
-- Percentages are presentation decimals, stored as text like venue prices.
-- Retain historical precision and remove the last binary floating-point column.
ALTER TABLE futures_closed_trade ALTER COLUMN roe_pct TYPE text USING roe_pct::text;
COMMIT;
