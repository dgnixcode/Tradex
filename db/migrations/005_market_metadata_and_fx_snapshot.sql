-- 005_market_metadata_and_fx_snapshot.sql
-- plan/phase-03 T03.8 · DATA-MODEL.md domain 6 · 10 F4
--
-- DATA-MODEL numbers these 003; on disk they are 005, because 002 created the
-- audit partitions and 003 fixed the schema-scope bug in their maintenance
-- function. Migration 004's header already promised this delta as 005.
--
-- Two tables, both INSERT-ONLY, for the same reason: they are the evidence a
-- historical order was legalised and valued correctly. `market_metadata` is what
-- an order was legalised against, and `fx_snapshot` is the rate a cross-currency
-- figure used. If either can be updated, then every past order silently
-- re-legalises against today's numbers and no report is reproducible (X10, L9,
-- L10). Forward-only is enforced by a trigger below, not by convention.
--
-- WHY THE VENUE DECIMALS ARE `text`, NOT `numeric`
--
-- Three reasons, in order of weight.
--
-- 1. `numeric(38,18)` would re-render on read. CoinDCX ships float artefacts in
--    its price bands — BSVINR.min_price is 566.6666666666666, SOLVINR.min_price
--    is 0.11983333333333333 — and a numeric column returns those padded to 18
--    places. The value is preserved, but the venue's own literal is not, and the
--    literal is what the adapter's golden tests compare.
-- 2. The number of decimal places is itself information. `quantity_step` of '1'
--    and '1.0' mean the same quantity but describe different markets, and
--    `packages/sizing` parses each decimal at its own natural scale for exactly
--    that reason.
-- 3. `checks/00-tenant-isolation.check.mjs` asserts every `numeric(P,S)` in the
--    migrations is `numeric(38,0)` minor units. A price is not money in minor
--    units, so it does not belong in that type — and weakening that assertion to
--    admit a price column would weaken it for an actual money column too.
--
-- `text` on its own would be a licence to store anything, so the `venue_decimal`
-- domain below constrains the format. That is a STRONGER guarantee than numeric
-- gave us: phase 01 found 90 fields in the live response arriving in exponent
-- form (`min_quantity: 1e-7`, `min_price: 1e-11`), and `packages/money` refuses
-- exponent notation on purpose. The domain makes an unexpanded exponent
-- unstorable rather than something sizing discovers at order time.
--
-- Money in minor units stays `numeric(38,0)`: `min_notional_minor` is already
-- converted by the adapter, and the drift figures are integer basis points.

BEGIN;

-- A plain, non-negative decimal literal: digits, optionally a fractional part.
-- No exponent, no sign, no leading '.', no whitespace. This is precisely the
-- grammar `scaledFromString` accepts, expressed where the data enters.
CREATE DOMAIN venue_decimal AS text
  CHECK (VALUE ~ '^[0-9]+(\.[0-9]+)?$');

-- Rejects every mutation on the table it guards. Statement-level so that a
-- DELETE matching zero rows still raises: "you cannot delete from this table" is
-- a clearer contract than "you happened not to delete anything". TRUNCATE is
-- included because it is the one DELETE that no row-level trigger would see.
CREATE FUNCTION tradex_forbid_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'insert_only_table: % is append-only; % is not permitted (DATA-MODEL domain 6, invariants X10/L9/L10)',
    TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- ------------------------------------------------------------ market_metadata
-- A versioned snapshot of `markets_details`, one row per market per version.
-- Orders record the `version` they were legalised against, so a rejection months
-- later can be replayed against the same numbers the decision used.
--
-- `max_market_quantity` is the field this table exists for. It is depth-derived
-- and it MOVES (09 F6: values like 122.6936997 are computed, not configured), it
-- is far tighter than `max_quantity` (BTCINR: 0.0158 against 2), and it is the
-- constraint that refuses a percentage buy on the largest account in a group.
-- A cached value must never be trusted for legalisation — re-read, then record
-- which version was used.
CREATE TABLE market_metadata (
  version               bigint NOT NULL CHECK (version > 0),
  -- Venue-native identifier, e.g. 'BTCINR'. Opaque above the adapter.
  venue_symbol          text NOT NULL CHECK (length(btrim(venue_symbol)) > 0),

  -- OUR names, not the venue's. CoinDCX's `base_currency_short_name` is our
  -- QUOTE and its `target_currency_short_name` is our ASSET; the inversion is
  -- undone in the adapter and must never be re-applied here (09 failure modes).
  asset                 text NOT NULL CHECK (asset = upper(asset) AND length(asset) BETWEEN 1 AND 32),
  quote                 text NOT NULL CHECK (quote IN ('INR','USDT')),

  -- OUR status vocabulary, not the venue's. The adapter reduces CoinDCX's status
  -- to `tradable` at the port boundary on purpose (D12): venue vocabulary must
  -- not leak inward, because clause 5.2 lets them change it without notice. So
  -- this column is a closed enum derived at ingest, not a verbatim capture — if a
  -- later phase needs the venue's literal string for forensics, it has to be
  -- carried on `MarketRules` first, and this CHECK is where that shows up.
  status                text NOT NULL CHECK (status IN ('active','inactive')),
  tradable              boolean NOT NULL,

  quantity_step         venue_decimal NOT NULL,
  -- `target_currency_precision`. Precision is itself a quantity floor (T03.3).
  quantity_precision    smallint NOT NULL CHECK (quantity_precision BETWEEN 0 AND 18),
  -- `base_currency_precision`, un-inverted. This is the PRICE precision.
  price_precision       smallint NOT NULL CHECK (price_precision BETWEEN 0 AND 18),

  min_quantity          venue_decimal NOT NULL,
  max_quantity          venue_decimal NOT NULL,
  -- Documented by the venue but absent from every live row, so nullable on
  -- purpose: a NOT NULL here would reject all 999 markets (09 F6 finding 3).
  min_market_quantity   venue_decimal,
  -- The tight, depth-derived market-order cap. Nullable for the same reason.
  max_market_quantity   venue_decimal,

  -- Already in the quote currency's minor units, converted by the adapter.
  min_notional_minor    numeric(38,0) NOT NULL CHECK (min_notional_minor >= 0),
  min_price             venue_decimal NOT NULL,
  max_price             venue_decimal NOT NULL,

  -- Our canonical order types only. A venue type we cannot represent causes the
  -- market to be SKIPPED with a reason by the adapter, never silently defaulted.
  order_types           text[] NOT NULL
                          CHECK (order_types <@ ARRAY['market','limit']::text[]
                                 AND array_length(order_types, 1) >= 1),
  venue_code            text NOT NULL CHECK (length(btrim(venue_code)) > 0),

  observed_at           timestamptz NOT NULL,
  source                text NOT NULL CHECK (length(btrim(source)) > 0),
  ingested_at           timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (version, venue_symbol),
  -- One row per market per version, by asset/quote as well as by symbol, so a
  -- duplicate mapping cannot make market resolution ambiguous (10 F3).
  CONSTRAINT market_metadata_asset_quote_unique UNIQUE (version, asset, quote),
  -- A market order cap below the market order floor is unsatisfiable; that is a
  -- bad snapshot, not a market nobody can trade.
  CONSTRAINT market_metadata_market_range
    CHECK (min_market_quantity IS NULL OR max_market_quantity IS NULL
           OR max_market_quantity::numeric >= min_market_quantity::numeric),
  CONSTRAINT market_metadata_quantity_range
    CHECK (max_quantity::numeric >= min_quantity::numeric),
  CONSTRAINT market_metadata_price_range
    CHECK (max_price::numeric >= min_price::numeric),
  CONSTRAINT market_metadata_step_positive
    CHECK (quantity_step::numeric > 0),
  -- `tradable` is derived from `status` and must stay consistent with it, or the
  -- legalisation's first gate disagrees with the forensic record beside it.
  CONSTRAINT market_metadata_tradable_matches_status
    CHECK (tradable = (status = 'active'))
);

-- Market resolution asks "which markets list this asset", newest version first.
CREATE INDEX market_metadata_asset_idx ON market_metadata (asset, version DESC);
CREATE INDEX market_metadata_version_idx ON market_metadata (version DESC);

-- Versions come from a sequence rather than `max(version) + 1`: two concurrent
-- ingests reading the same maximum would both claim it and interleave two
-- snapshots under one version, which is the one thing a version must prevent.
CREATE SEQUENCE market_metadata_version_seq AS bigint START WITH 1 OWNED BY market_metadata.version;

CREATE TRIGGER market_metadata_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON market_metadata
  FOR EACH STATEMENT EXECUTE FUNCTION tradex_forbid_mutation();

-- ---------------------------------------------------------------- fx_snapshot
-- An immutable (base, quote, rate, source, observed_at), sampled at plan time
-- and referenced by every cross-currency figure thereafter (10 F4, X10).
--
-- The rule that makes this table worth having: a STORED rate is never refreshed.
-- Display rates move every few seconds; a rate that has been written into a
-- ledger entry or a child order is frozen, because re-resolving it makes last
-- month's P&L move (L9, L10). Insert-only is how that is guaranteed rather than
-- remembered.
--
-- `source` distinguishes which side was sampled, because the correct side
-- depends on the question (10 F4): `last` values a holding, `ask` prices a
-- hypothetical INR->USDT conversion, `bid` prices USDT->INR.
CREATE TABLE fx_snapshot (
  id                  bigserial PRIMARY KEY,
  base                text NOT NULL CHECK (base = upper(base) AND length(base) BETWEEN 2 AND 16),
  quote               text NOT NULL CHECK (quote = upper(quote) AND length(quote) BETWEEN 2 AND 16),
  -- Units of `quote` per one `base`. For USDTINR at 99.11: base USDT, quote INR.
  rate                venue_decimal NOT NULL CHECK (rate::numeric > 0),
  source              text NOT NULL
                        CHECK (source IN ('coindcx_ticker_last','coindcx_ticker_bid',
                                          'coindcx_ticker_ask','coindcx_orderbook_mid')),
  observed_at         timestamptz NOT NULL,

  -- The 10 F4 cross-check, recorded so the alarm is auditable after the fact
  -- rather than only visible in a log line that has since rotated:
  --   BTCUSDT x USDTINR should approximate BTCINR.
  -- Measured 2026-09-04: 81,602 x 99.11 = 8,087,594 against a BTCINR last of
  -- 8,079,092, a gap of 0.11%. A persistently larger gap means a stale ticker or
  -- a genuinely dislocated venue, and it is a cheap alarm to have.
  --
  -- Both legs are kept as their exact literals so the drift is recomputable, and
  -- the drift itself is stored as SIGNED INTEGER BASIS POINTS — integer minor
  -- units, the same discipline as every money column, which is also what lets
  -- the consistency CHECK below be arithmetic rather than trust.
  cross_base_rate     venue_decimal,
  cross_quote_rate    venue_decimal,
  cross_drift_bp      numeric(38,0),
  cross_threshold_bp  numeric(38,0) CHECK (cross_threshold_bp IS NULL OR cross_threshold_bp > 0),
  cross_alarmed       boolean,

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fx_snapshot_base_not_quote CHECK (base <> quote),
  -- The cross-check is all-or-nothing. A drift with no threshold cannot be
  -- judged, and an alarm with no drift cannot be explained.
  CONSTRAINT fx_snapshot_cross_check_complete CHECK (
    (cross_base_rate IS NULL AND cross_quote_rate IS NULL AND cross_drift_bp IS NULL
     AND cross_threshold_bp IS NULL AND cross_alarmed IS NULL)
    OR
    (cross_base_rate IS NOT NULL AND cross_quote_rate IS NOT NULL AND cross_drift_bp IS NOT NULL
     AND cross_threshold_bp IS NOT NULL AND cross_alarmed IS NOT NULL)
  ),
  -- The alarm is not a field a writer gets to disagree with the numbers about.
  CONSTRAINT fx_snapshot_alarm_matches_drift CHECK (
    cross_alarmed IS NULL OR cross_alarmed = (abs(cross_drift_bp) > cross_threshold_bp)
  )
);

CREATE INDEX fx_snapshot_pair_idx ON fx_snapshot (base, quote, observed_at DESC);
CREATE INDEX fx_snapshot_alarmed_idx ON fx_snapshot (observed_at DESC) WHERE cross_alarmed;

CREATE TRIGGER fx_snapshot_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON fx_snapshot
  FOR EACH STATEMENT EXECUTE FUNCTION tradex_forbid_mutation();

COMMIT;
