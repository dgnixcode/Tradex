BEGIN;
-- Keep prior FX samples immutable. New plans identify the distinct futures rate.
ALTER TABLE fx_snapshot DROP CONSTRAINT fx_snapshot_source_check;
ALTER TABLE fx_snapshot ADD CONSTRAINT fx_snapshot_source_check CHECK (source IN
  ('coindcx_ticker_last','coindcx_ticker_bid','coindcx_ticker_ask','coindcx_orderbook_mid','coindcx_futures_conversion'));
COMMIT;
