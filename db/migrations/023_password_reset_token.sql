-- 023_password_reset_token.sql
-- Single-use password reset tokens for email recovery.
-- Global table (carries user_id, no tenant_id) like session.

BEGIN;

CREATE TABLE password_reset_token (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL CHECK (length(token_hash) = 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,

  CONSTRAINT password_reset_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT password_reset_token_expires_after_created CHECK (expires_at > created_at)
);

CREATE INDEX password_reset_token_hash_idx ON password_reset_token (token_hash);
CREATE INDEX password_reset_token_user_idx ON password_reset_token (user_id);
CREATE INDEX password_reset_token_expires_idx ON password_reset_token (expires_at) WHERE used_at IS NULL;

COMMIT;
