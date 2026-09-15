BEGIN;
ALTER TABLE group_trade ADD COLUMN quote_currency text;
COMMIT;