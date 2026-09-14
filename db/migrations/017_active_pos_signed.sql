-- 017_active_pos_signed.sql
-- `futures_position.active_pos` must be able to hold a NEGATIVE number.
--
-- The column was declared `venue_decimal`, and that domain is
--     CREATE DOMAIN venue_decimal AS text CHECK (VALUE ~ '^[0-9]+(\.[0-9]+)?$')
-- — a plain NON-NEGATIVE decimal (005_market_metadata_and_fx_snapshot.sql:48).
-- That is right for the many columns it guards: prices, quantities, step sizes.
--
-- It is wrong here. `active_pos` is a SIGNED base quantity — positive long,
-- negative short — by the migration-014 comment, by the `FuturesPositionSnapshot`
-- docstring, and by every consumer: `buildFuturesView` derives `side` from exactly
-- that sign and strips it to get `quantity`.
--
-- So a short position could not be inserted at all: the domain CHECK rejected
-- `-0.0001` outright, and `side: 'short'` was unreachable through this table. No
-- check caught it because the only writer is 15-schema, and it inserts '0.1'.
--
-- The fix is deliberately LOCAL. The domain stays untouched for the columns it
-- was written for; only this one column becomes plain `text` with its own signed
-- shape. Widening the domain itself would silently permit negative prices,
-- quantities and notional limits everywhere — a far worse bug than the one being
-- fixed.

BEGIN;

ALTER TABLE futures_position
  ALTER COLUMN active_pos TYPE text USING active_pos::text;

ALTER TABLE futures_position
  ADD CONSTRAINT futures_position_active_pos_signed CHECK (
    active_pos ~ '^-?[0-9]+(\.[0-9]+)?$'
  );

COMMIT;
