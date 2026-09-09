-- 010_switches_and_caps.sql
-- plan/phase-05 T05.1, T05.2, T05.4 · DATA-MODEL.md domains 1 and 6
--
-- Phase 05 makes every brake real before any engine exists. Two of the four
-- switch scopes and the cap columns they need are added here, all ADDITIVE:
--
--  1. A PER-ACCOUNT order-cap override (exchange_account.max_order_notional_minor)
--     and an ACCOUNT-FROZEN scope (frozen_at + frozen_reason). Phase 04's gate
--     already enforces the tenant per-order cap (tenant_limit) and the per-tenant
--     daily cap; this gives a single account a tighter cap and a hard "this
--     account is frozen" state, each with a reason a customer can read.
--
--  2. A MARKET-scope switch (market_state): one row per market with a mode. This
--     is GLOBAL, like market_metadata — a halted market is halted for every
--     tenant — so it carries no tenant_id and belongs in GLOBAL_TABLES, which is
--     exactly what keeps checks/00-tenant-isolation (a table carrying tenant_id
--     must be scoped) satisfied.
--
-- The GLOBAL platform kill switch, the tenant pause and the platform degraded
-- modes already live in platform_state / tenant_limit from migration 001, so no
-- new table is needed for those scopes — Phase 05 wires them into real routes and
-- audit, which is application code, not schema.

BEGIN;

-- ------------------------------------------------- exchange_account (additive)
-- A per-account ceiling on a single order's notional, in minor units. When NULL
-- the account falls back to the tenant's max_order_notional_minor; when set, it
-- is the tighter bound (Phase 05 gate). Allocated-capital and this cap are
-- different numbers with different purposes — one is a sizing basis, the other a
-- brake.
ALTER TABLE exchange_account
  ADD COLUMN max_order_notional_minor numeric(38,0) CHECK (max_order_notional_minor IS NULL OR max_order_notional_minor >= 0);

-- The account-frozen scope (one of the four switches / the per-account degraded
-- mode). A frozen account refuses NEW orders but is not disconnected: its key
-- stays valid and its history stays readable. `frozen_at` and `frozen_reason`
-- travel together or not at all, so "frozen" can never lack an explanation.
ALTER TABLE exchange_account
  ADD COLUMN frozen_at    timestamptz,
  ADD COLUMN frozen_reason text CHECK (frozen_reason IS NULL OR length(btrim(frozen_reason)) > 0),
  ADD CONSTRAINT exchange_account_frozen_pair
    CHECK ((frozen_at IS NULL) = (frozen_reason IS NULL));

CREATE INDEX exchange_account_frozen_idx ON exchange_account (frozen_at) WHERE frozen_at IS NOT NULL;

-- ------------------------------------------------------------ market_state
-- The market-scope switch. One row per market (venue_symbol), each independently
-- flippable to a degraded mode with a reason. GLOBAL on purpose: the same market
-- is the same instrument for every tenant, so a read_only BTCINR must hold for
-- everyone — the operator halts the market, not one customer's view of it.
--
-- `frozen` is deliberately NOT a market mode: the plan's fourth degraded mode is
-- per-ACCOUNT (the frozen columns above), while a market reaches cancel_only or
-- read_only. read_only permits neither opens nor cancels (Phase 05 table); a
-- market in cancel_only refuses new orders but existing ones may still be
-- cancelled — enforcement lives in the gate, which reads this row's mode.
CREATE TABLE market_state (
  market      text PRIMARY KEY CHECK (length(btrim(market)) > 0),
  mode        text NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal','cancel_only','read_only')),
  -- A mode other than normal must say why; normal may carry an optional note.
  reason      text,
  changed_at  timestamptz NOT NULL DEFAULT now(),
  changed_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  CONSTRAINT market_state_reason_shape
    CHECK (mode = 'normal' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

COMMIT;
