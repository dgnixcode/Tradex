BEGIN;

ALTER TABLE futures_position ADD COLUMN IF NOT EXISTS settlement_currency_avg_price venue_decimal;

COMMIT;
