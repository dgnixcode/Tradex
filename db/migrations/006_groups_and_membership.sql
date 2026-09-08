-- 006_groups_and_membership.sql
-- plan/phase-04 T04.1, T04.2 · DATA-MODEL.md domain 3 (group / group_member)
--
-- The phase doc calls this "migration 004". It is 006: 004 created accounts and
-- credentials, 005 created market_metadata and fx_snapshot. group_trade,
-- child_order and execution_job follow in 007.
--
-- TWO DEPARTURES FROM DATA-MODEL, both deliberate.
--
-- 1. The table is `account_group`, not `"group"`. DATA-MODEL names it `group`,
--    which is a SQL reserved word requiring double-quotes at every reference.
--    Worse, checks/00-tenant-isolation.check.mjs parses CREATE TABLE with the
--    identifier pattern [a-z_][a-z0-9_]* — a quoted "group" is invisible to it,
--    so the leak-detector would silently skip the one new tenant-scoped table
--    this migration adds. Renaming avoids reserved-word quoting everywhere and
--    keeps the security check honest. `group_member` keeps its name (not
--    reserved) but its FK targets account_group.
--
-- 2. Composite tenant foreign keys, exactly as migration 004 established. A
--    group_member row that named tenant A while pointing at tenant B's group or
--    account would read as valid forever under a plain tenant_id column. The
--    composite FK makes that row unrepresentable. account_group therefore
--    carries the parent UNIQUE (tenant_id, id) that the child references.
--
-- weight_bp and max_notional_minor are created and LEFT UNUSED in v1 (09 F4,
-- DATA-MODEL "schema decisions most likely to be regretted"): a dead column now
-- makes per-account weighting a feature flag later rather than a migration on a
-- live trading table.

BEGIN;

-- --------------------------------------------------------------- account_group
-- A named subset of a tenant's accounts. Membership is many-to-many: an account
-- may belong to several groups, and a group trade fans out across exactly the
-- enabled members of one group.
CREATE TABLE account_group (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  name        text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  created_by  uuid REFERENCES app_user(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,

  -- The parent side of every composite tenant FK that points at a group.
  CONSTRAINT account_group_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT account_group_name_unique UNIQUE (tenant_id, name)
);
CREATE INDEX account_group_tenant_idx ON account_group (tenant_id) WHERE archived_at IS NULL;

-- ---------------------------------------------------------------- group_member
-- PRIMARY KEY (group_id, account_id) is the invariant "an account in a group
-- once" from DATA-MODEL's enforced-by-the-database table: a duplicate membership
-- would double-size that account on every group trade, and two concurrent adds
-- both pass an application check — so the database rejects the second, not the
-- code.
CREATE TABLE group_member (
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  group_id           uuid NOT NULL,
  account_id         uuid NOT NULL,
  -- Presentation order in the trade ticket; not a trading weight.
  display_order      integer NOT NULL DEFAULT 0,
  -- A disabled member stays in the group but is skipped by the fan-out. This is
  -- how a customer excludes one account from a trade without dissolving the group.
  enabled            boolean NOT NULL DEFAULT true,
  -- Created and UNUSED in v1. Present so weighting becomes a flag, not a migration.
  weight_bp          integer CHECK (weight_bp IS NULL OR weight_bp BETWEEN 0 AND 10000),
  max_notional_minor numeric(38,0) CHECK (max_notional_minor IS NULL OR max_notional_minor >= 0),
  added_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (group_id, account_id),
  -- Both composite FKs: the membership, its group and its account are all the
  -- same tenant, enforced by the schema rather than hoped for in the query layer.
  CONSTRAINT group_member_tenant_group_fk
    FOREIGN KEY (tenant_id, group_id) REFERENCES account_group (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT group_member_tenant_account_fk
    FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX group_member_account_idx ON group_member (account_id);
CREATE INDEX group_member_tenant_group_idx ON group_member (tenant_id, group_id);

COMMIT;
