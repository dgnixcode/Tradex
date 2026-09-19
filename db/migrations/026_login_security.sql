-- 026_login_security.sql
-- IP rate limiting and failure tracking for brute force protection.
-- Global table (carries ip address, no tenant_id) like session.

BEGIN;

CREATE TABLE IF NOT EXISTS login_ip_attempt (
  ip               VARCHAR(64) PRIMARY KEY,
  failed_attempts  INT NOT NULL DEFAULT 0,
  last_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  blocked_until    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_ip_attempt_blocked_idx ON login_ip_attempt (blocked_until) WHERE blocked_until IS NOT NULL;

COMMIT;
