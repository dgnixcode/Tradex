-- 011_ledger_and_holding.sql
-- plan/phase-07 T07.1, T07.2 · DATA-MODEL.md domain 5, as rescoped 2026-09-05
--
-- The immutable record of what we actually did, and the projection rebuilt from
-- it. `equity_snapshot` is deliberately NOT created (§6a): no mark-to-market, no
-- unrealised P&L — only the books.
--
-- ledger_entry  — one row per leg of a fill (asset leg, quote leg, fee, TDS),
--                 INSERT-only, partitioned monthly by occurred_at. Re-ingesting
--                 the same venue trade adds nothing: the unique index on
--                 (account_id, exchange_trade_id, kind, occurred_at) is the
--                 idempotency backstop (L4).
-- holding       — the DERIVED projection (qty, weighted-average cost, realised
--                 P&L). Never the source of truth; rebuilt from ledger_entry by
--                 the fold (Phase 07 T07.2). A row per (account_id, asset).
--
-- CONVENTIONS from the rest of the schema, applied without restating the reasons:
--   exact decimals (qty, price) are the venue_decimal DOMAIN from migration 005
--   (text + plain-decimal CHECK), because checks/00-tenant-isolation requires
--   every numeric(P,S) column to be numeric(38,0) minor money;
--   signed minor money (delta, fee, tds, realised, cost) is numeric(38,0);
--   tenant-scoped rows carry tenant_id and a composite FK to the parent account;
--   INSERT-only is enforced by the same forbid-mutation trigger as domain 6.

BEGIN;

-- ---------------------------------------------------------------- ledger_entry
CREATE TABLE ledger_entry (
  id                 bigserial,
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  account_id         uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN
                       ('trade_buy','trade_sell','fee','tds',
                        'conversion_in','conversion_out','external_adjustment','correction')),
  asset              text NOT NULL CHECK (asset = upper(asset) AND length(asset) BETWEEN 1 AND 32),
  quote_asset        text,
  delta_minor        numeric(38,0) NOT NULL,           -- signed minor units of `asset`
  scale              smallint NOT NULL CHECK (scale BETWEEN 0 AND 18),
  price              venue_decimal,                    -- quote per one asset, exact
  child_order_id     uuid,
  exchange_trade_id  text,
  fee_minor          numeric(38,0),                    -- on a fee row: the fee, quote minor
  tds_minor          numeric(38,0),                    -- on a tds row: TDS withheld, quote minor
  -- TDS is always estimated until the ledger is reconciled with a statement (11 F4).
  estimated          boolean NOT NULL DEFAULT false,
  occurred_at        timestamptz NOT NULL,
  recorded_at        timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id, occurred_at),
  -- The idempotency backstop: the reconciler re-reads the same page by design,
  -- and a re-ingest must add nothing (L4).
  CONSTRAINT ledger_entry_ingest_unique
    UNIQUE (account_id, exchange_trade_id, kind, occurred_at),
  CONSTRAINT ledger_entry_tenant_account_fk
    FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT ledger_entry_child_order_fk
    FOREIGN KEY (tenant_id, child_order_id) REFERENCES child_order (tenant_id, id) ON DELETE RESTRICT
) PARTITION BY RANGE (occurred_at);

-- A DEFAULT partition so an insert can never fail because the scheduler fell
-- behind, mirroring the audit table. Monthly partitions are pre-created below.
CREATE TABLE ledger_entry_default PARTITION OF ledger_entry DEFAULT;

-- Rejects every mutation on the table it guards (shared with domain 6).
CREATE TRIGGER ledger_entry_append_only
  BEFORE UPDATE OR DELETE OR TRUNCATE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION tradex_forbid_mutation();

CREATE INDEX ledger_entry_account_idx ON ledger_entry (account_id, asset, occurred_at);
CREATE INDEX ledger_entry_tenant_occurred_idx ON ledger_entry (tenant_id, occurred_at DESC);

-- Pre-create the current and next month's partitions (the runner will not run on
-- a schedule in dev; production adds a partition-maintenance job like audit's).
DO $$
DECLARE
  m timestamptz := date_trunc('month', now());
BEGIN
  FOR i IN 0..1 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS ledger_entry_%s PARTITION OF ledger_entry FOR VALUES FROM (%L) TO (%L)',
      to_char(m + make_interval(months => i), 'YYYYMM'),
      m + make_interval(months => i),
      m + make_interval(months => i + 1));
  END LOOP;
END $$;

-- ------------------------------------------------------------------- holding
-- The derived projection. `rebuilt_at` records when the fold last ran over this
-- account so a stale projection is visible, not trusted. `qty` is an exact
-- decimal; `cost_total` and `realised_pnl` are signed minor units of the quote.
CREATE TABLE holding (
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  account_id     uuid NOT NULL,
  asset          text NOT NULL CHECK (asset = upper(asset) AND length(asset) BETWEEN 1 AND 32),
  qty            venue_decimal NOT NULL,
  cost_total_minor numeric(38,0) NOT NULL,
  realised_pnl_minor numeric(38,0) NOT NULL,
  fee_drag_minor numeric(38,0) NOT NULL,
  tds_withheld_minor numeric(38,0) NOT NULL,
  quote_asset    text NOT NULL CHECK (quote_asset IN ('INR','USDT')),
  rebuilt_at     timestamptz NOT NULL,

  PRIMARY KEY (account_id, asset),
  CONSTRAINT holding_tenant_account_fk
    FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id) ON DELETE RESTRICT,
  -- L6: cost is zero exactly when the quantity is zero. Enforced here as a
  -- best-effort (the invariant check owns the authoritative, periodic version).
  CONSTRAINT holding_cost_zero_when_qty_zero
    CHECK ((qty = '0') = (cost_total_minor = 0))
);

COMMIT;
