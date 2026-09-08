-- 001_tenancy_and_audit.sql
-- plan/phase-00 T00.5 · DATA-MODEL.md domains 1 and 7
--
-- Forward-only. Never edited after it has run anywhere; corrections are new
-- migrations. A code rollback must never require a schema rollback (20 F5).

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- migrations
CREATE TABLE IF NOT EXISTS schema_migration (
  version    text PRIMARY KEY,
  checksum   text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------- tenant
CREATE TABLE tenant (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  valuation_currency text NOT NULL DEFAULT 'INR'
                       CHECK (valuation_currency IN ('INR','USDT')),
  -- KYC-capable from day one: FIU-IND registration must be a policy change,
  -- not a migration under a takedown notice (15 F5).
  kyc_status         text NOT NULL DEFAULT 'not_collected'
                       CHECK (kyc_status IN ('not_collected','pending','verified','rejected')),
  kyc_verified_at    timestamptz,
  gstin              text,
  status             text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','suspended','closed')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  CONSTRAINT tenant_closed_when_status CHECK (status <> 'closed' OR closed_at IS NOT NULL)
);

-- ------------------------------------------------------------------ app_user
CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  -- OUR 2FA secret, encrypted. Never the exchange's (07 F10).
  totp_secret_ct bytea,
  totp_enabled   boolean NOT NULL DEFAULT false,
  role           text NOT NULL CHECK (role IN ('owner','trader','viewer')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz,
  CONSTRAINT app_user_email_unique UNIQUE (email),
  CONSTRAINT app_user_totp_needs_secret CHECK (totp_enabled = false OR totp_secret_ct IS NOT NULL)
);
CREATE INDEX app_user_tenant_idx ON app_user (tenant_id, role);

-- -------------------------------------------------------------- tenant_limit
-- Defaults from OPEN-QUESTIONS Q9: per-order Rs 2,00,000, per-day Rs 5,00,000.
-- Stored in minor units (paise), so 20000000 = Rs 2,00,000.
CREATE TABLE tenant_limit (
  tenant_id                 uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE RESTRICT,
  max_accounts              integer NOT NULL DEFAULT 100 CHECK (max_accounts > 0),
  max_accounts_per_group    integer NOT NULL DEFAULT 50  CHECK (max_accounts_per_group > 0),
  max_order_notional_minor  numeric(38,0) NOT NULL DEFAULT 20000000 CHECK (max_order_notional_minor > 0),
  max_daily_notional_minor  numeric(38,0) NOT NULL DEFAULT 50000000 CHECK (max_daily_notional_minor > 0),
  typed_confirm_above_minor numeric(38,0) NOT NULL DEFAULT 20000000 CHECK (typed_confirm_above_minor >= 0),
  -- The customer's own kill switch. Reachable in two clicks (21).
  trading_paused            boolean NOT NULL DEFAULT false,
  paused_at                 timestamptz,
  paused_reason             text,
  CONSTRAINT tenant_limit_paused_at CHECK (trading_paused = false OR paused_at IS NOT NULL)
);

-- ------------------------------------------------------------ platform_state
-- One row. The global brake and the degraded-mode marker (22 F7).
CREATE TABLE platform_state (
  id                 text PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  global_kill_switch boolean NOT NULL DEFAULT false,
  mode               text NOT NULL DEFAULT 'normal'
                       CHECK (mode IN ('normal','cancel_only','read_only')),
  mode_reason        text,
  changed_at         timestamptz NOT NULL DEFAULT now(),
  changed_by         uuid REFERENCES app_user(id)
);
INSERT INTO platform_state (id) VALUES ('singleton');

-- --------------------------------------------------------------- audit_event
-- Append-only, partitioned monthly, retained 5 years (CoinDCX clause 6.6 and
-- PMLA — 15). Largest table in the system: ~15 GB/year at 100 customers, so
-- partitioning is created here rather than retrofitted onto a live,
-- legally-retained table (22 F5).
CREATE TABLE audit_event (
  id            bigserial,
  tenant_id     uuid NOT NULL,
  actor_user_id uuid,
  actor_process text NOT NULL,
  action        text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    text NOT NULL,
  before        jsonb,
  after         jsonb,
  ip            inet,
  user_agent    text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX audit_event_tenant_idx  ON audit_event (tenant_id, occurred_at DESC);
CREATE INDEX audit_event_subject_idx ON audit_event (subject_type, subject_id, occurred_at DESC);

-- No foreign key from audit_event to tenant on purpose: the audit trail must
-- outlive whatever it describes, and a partitioned table cannot carry an FK
-- that would block archival detachment.

COMMIT;
