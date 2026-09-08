-- 008_tenant_limit_max_groups.sql
-- plan/phase-04 T04.2 · DATA-MODEL.md domain 1 (tenant_limit)
--
-- The per-tenant cap on the NUMBER of groups. tenant_limit already carries
-- max_accounts (100) and max_accounts_per_group (50) from migration 001, but no
-- cap on group count existed because no group table existed until 006.
--
-- WHY THIS IS ITS OWN MIGRATION and not part of 006. 006 was already applied to
-- the development database before this column was conceived, and the migration
-- runner records a checksum per applied file and refuses a changed one — an
-- applied migration is immutable, because in production some servers would hold
-- the old bytes and some the new. The correct fix the runner itself prescribes
-- is "ship a new one". This is also exactly the additive-within-a-release pattern
-- DATA-MODEL calls for: add a column in a later migration, defaulted, touching no
-- data and no existing table's other columns.
--
-- 50 groups per tenant matches the accounts-per-group ceiling; a customer with
-- 100 accounts and 50 groups is already an outlier, and the cap is raiseable per
-- tenant. group-repo.ts enforces it inside the create transaction with the
-- tenant_limit row locked, so a concurrent create cannot slip past the cap.

BEGIN;

ALTER TABLE tenant_limit
  ADD COLUMN max_groups integer NOT NULL DEFAULT 50 CHECK (max_groups > 0);

COMMIT;
