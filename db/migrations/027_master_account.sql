-- 027_master_account.sql
-- Add is_master flag to app_user for dedicated platform administration.

BEGIN;

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS is_master boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS app_user_is_master_idx ON app_user (is_master) WHERE is_master = true;

COMMIT;
