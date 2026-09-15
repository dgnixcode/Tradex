BEGIN;
ALTER TABLE group_trade ADD COLUMN trailing_distance_bp numeric(38,0);
ALTER TABLE group_trade ADD COLUMN trailing_step_bp numeric(38,0);
COMMIT;