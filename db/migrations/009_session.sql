-- 009_session.sql
-- plan/phase-04 follow-on (HTTP layer) · the missing half of the auth model
--
-- packages/auth already has authorise(), the role matrix and the Principal type,
-- and packages/auth has password + TOTP verification — but nothing ever ISSUED a
-- session. This table is that missing half: a server-side session a signed cookie
-- points at.
--
-- TWO DELIBERATE DEPARTURES FROM THE HOUSE PATTERN.
--
-- 1. This table is GLOBAL, not tenant-scoped, and it is the one table where that
--    is correct rather than a mistake. Every other lookup happens WITHIN a
--    tenant; a session is what you read to DISCOVER the tenant, so scoping it
--    through the tenant query layer would be chicken-and-egg. It carries user_id,
--    not tenant_id — the tenant is reached through app_user — so no cross-tenant
--    session is even constructable, and checks/00-tenant-isolation (which flags a
--    table CARRYING tenant_id that is not scoped) does not apply.
--
-- 2. The table stores a HASH of the session token, never the token. The cookie
--    carries the raw random token; the row stores sha256(token). A database leak
--    then discloses no live session — the same "prove you hold the secret, do not
--    store it" discipline as the credential fingerprint. token_hash is 32 bytes.

BEGIN;

CREATE TABLE session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The user the session authenticates. The tenant is reached through app_user,
  -- so a session cannot name a tenant its user does not belong to.
  user_id     uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  -- sha256 of the raw token held in the cookie. Never the token itself.
  token_hash  bytea NOT NULL CHECK (length(token_hash) = 32),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- When the second factor was last satisfied, for the reauth-gated actions
  -- (credential.write, limits.write, trade.place.large). NULL until first re-auth.
  reauth_at   timestamptz,
  -- Set on logout or forced revocation; a revoked session authenticates nothing.
  revoked_at  timestamptz,

  CONSTRAINT session_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT session_expires_after_created CHECK (expires_at > created_at)
);

-- The hot path: resolve a presented cookie to its session by token hash.
CREATE INDEX session_token_hash_idx ON session (token_hash);
-- Revoke-all-for-a-user (a password change, an incident) and expiry sweeps.
CREATE INDEX session_user_idx ON session (user_id);
CREATE INDEX session_expires_idx ON session (expires_at) WHERE revoked_at IS NULL;

COMMIT;
