-- 016_active_account_has_basis.sql
-- An ACTIVE account must carry the sizing basis the exchange reported.
--
-- Migration 015 made `allocated_capital_minor` and `allocated_currency` nullable,
-- because the account row is created during validation, before the venue has been
-- read. That left a new shape possible: an account that is tradeable but has no
-- basis, from which every percentage-of-capital order would be sized against
-- nothing.
--
-- `confirmAllocation` already refuses to activate such a row (it updates only
-- `WHERE allocated_capital_minor IS NOT NULL`), and the sizing gates refuse any
-- non-active account before they read the basis. Those are two code paths. This
-- CHECK makes the invariant a property of the table, so it holds whichever path
-- writes the status next.
--
-- Only `confirmAllocation` sets this column to 'active'; every other transition
-- (suspended, disconnected) is free to leave the basis in place.

BEGIN;

ALTER TABLE exchange_account
  ADD CONSTRAINT exchange_account_active_has_basis CHECK (
    status <> 'active' OR allocated_capital_minor IS NOT NULL
  );

COMMIT;
