-- 030_user_alert_config.sql
-- Persist user position and risk alert settings in the database across devices.

BEGIN;

ALTER TABLE app_user ADD COLUMN IF NOT EXISTS alert_config jsonb;

COMMIT;
