-- 015_allocated_capital_from_venue.sql
-- The connect flow stops asking the customer for the funding currency and the
-- allocated capital. Both come from the exchange: the currency from what the
-- account can actually fund with, the capital from the free balance it holds.
--
-- Why the columns must become nullable: the account row is created DURING
-- validation (the sealed credential has a FK to it), which happens before we
-- have read the venue. So at create time neither figure is known yet, and they
-- are filled at confirm from the observed balance. A pending_validation account
-- therefore carries NULL for both, which is honest — it has no basis yet.
--
-- The CHECKs stay: a currency that IS set must still be a supported quote, and a
-- capital that IS set must still be non-negative. Only NOT NULL is dropped.

BEGIN;

ALTER TABLE exchange_account
  ALTER COLUMN allocated_capital_minor DROP NOT NULL,
  ALTER COLUMN allocated_currency      DROP NOT NULL;

-- A basis can only be complete or absent: a currency with no amount, or an
-- amount with no currency, would size a percentage-of-capital order against
-- nothing. They are written together at confirm.
ALTER TABLE exchange_account
  ADD CONSTRAINT exchange_account_basis_pair CHECK (
    (allocated_capital_minor IS NULL) = (allocated_currency IS NULL)
  );

COMMIT;
