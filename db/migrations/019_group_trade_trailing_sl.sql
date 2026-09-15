BEGIN;
ALTER TABLE group_trade ADD COLUMN trailing_stop_loss boolean NOT NULL DEFAULT false;
COMMIT;