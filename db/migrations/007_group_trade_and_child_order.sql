-- 007_group_trade_and_child_order.sql
-- plan/phase-04 T04.1, T04.5, T04.10 · DATA-MODEL.md domain 4
--
-- DATA-MODEL numbers this "005"; on disk it is 007, after 004 (accounts) and
-- 005 (market_metadata/fx_snapshot) and 006 (groups). The trading domain: the
-- one group_trade a customer previews, the N child_order rows it fans out into,
-- and the execution_job queue that Phase 06 will drain. Nothing enqueues a job
-- in this phase — the table exists so the schema is complete before anything
-- can send.
--
-- THREE CONVENTIONS INHERITED FROM 004 AND 005, applied here without restating
-- the full reasoning:
--
-- 1. Exact decimals (price, quantity, rate) are the `venue_decimal` domain from
--    005 — text constrained to a plain non-negative decimal — NOT numeric(38,18)
--    as DATA-MODEL's DDL shows. The reason is the same one that put venue
--    decimals in text in 005: a numeric column re-renders the literal, the number
--    of decimal places is itself information sizing reads, and
--    checks/00-tenant-isolation asserts every numeric(P,S) is (38,0) minor units.
--    Money in minor units stays numeric(38,0).
--
-- 2. Composite tenant foreign keys everywhere, so a cross-tenant child is
--    unrepresentable rather than merely unwritten. group_trade and child_order
--    each carry the parent UNIQUE (tenant_id, id) the next table down references.
--
-- 3. state carries NO transition legality in its CHECK — that is application
--    logic (12 F1). Encoding a state machine in constraints makes every product
--    change a migration; the simulation tests cover legality instead.
--
-- ONE VOCABULARY DEPARTURE FROM DATA-MODEL: order_type is 'market'/'limit', our
-- canonical OrderType, not the venue's 'market_order'/'limit_order'. Venue
-- vocabulary does not cross the adapter boundary (D12), and the sizing Intent
-- already speaks 'market'/'limit'; storing the venue's spelling here would be the
-- one place it leaked back inward.

BEGIN;

-- ------------------------------------------------------------------ group_trade
-- One customer decision: an asset, a side, a sizing mode, applied to a group.
-- It holds the capture-or-lose-forever fields that are shared across all its
-- children (14 F2): the reference mid captured BEFORE any sizing, the fx and
-- market-metadata versions the whole plan was computed against, and the code
-- version for R7 quarantine. Per-child provenance lives on child_order.
CREATE TABLE group_trade (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  group_id            uuid NOT NULL,
  created_by          uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,

  asset               text NOT NULL CHECK (asset = upper(asset) AND length(asset) BETWEEN 1 AND 32),
  side                text NOT NULL CHECK (side IN ('buy','sell')),
  order_type          text NOT NULL CHECK (order_type IN ('market','limit')),
  sizing_mode         text NOT NULL CHECK (sizing_mode IN
                        ('quote_amount','base_quantity','pct_allocated','pct_equity',
                         'pct_free','pct_position','sell_all')),
  -- Amount, quantity or percent depending on the mode. NULL only for sell_all,
  -- which needs no value. venue_decimal because a percent like '20' and an
  -- amount like '100000' are both plain decimals and neither is money in minor
  -- units at this layer.
  sizing_value        venue_decimal,
  -- Present for a limit order, absent for a market order. A CHECK below ties the
  -- two together so a market order cannot smuggle a price.
  limit_price         venue_decimal,

  status              text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','previewed','executing','completed','abandoned')),

  -- The preview handle (T04.6). The token is the ONLY thing that can later be
  -- confirmed, and it expires server-side. Both or neither.
  preview_token       text,
  preview_expires_at  timestamptz,

  -- Capture-or-lose-forever (14 F2), shared across children.
  -- decision_mid is the reference market's mid at plan time, captured before any
  -- sizing runs; a test asserts it is non-null on a previewed trade.
  decision_mid        venue_decimal,
  fx_snapshot_id      bigint REFERENCES fx_snapshot(id) ON DELETE RESTRICT,
  market_meta_version bigint,
  code_version        text,

  -- Dry-run rung 0 (T04.9): a previewed trade that is confirmed in this phase is
  -- marked completed with the send suppressed. This records that it was a dry run
  -- and never touched the venue.
  dry_run             boolean NOT NULL DEFAULT true,
  send_suppressed     boolean NOT NULL DEFAULT false,

  submitted_at        timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  submitted_from_ip   inet,

  -- Parent side of child_order's composite tenant FK.
  CONSTRAINT group_trade_tenant_id_key UNIQUE (tenant_id, id),
  -- A market order carries no limit price; a limit order must.
  CONSTRAINT group_trade_limit_price_shape CHECK (
    (order_type = 'limit') = (limit_price IS NOT NULL)
  ),
  -- sell_all is the one mode with no value; every other mode requires one.
  CONSTRAINT group_trade_sizing_value_shape CHECK (
    (sizing_mode = 'sell_all') OR (sizing_value IS NOT NULL)
  ),
  -- The preview token and its expiry travel together or not at all.
  CONSTRAINT group_trade_preview_pair CHECK (
    (preview_token IS NULL) = (preview_expires_at IS NULL)
  ),
  -- A previewed trade must actually carry a token to be confirmable.
  CONSTRAINT group_trade_previewed_has_token CHECK (
    status = 'draft' OR status = 'abandoned' OR preview_token IS NOT NULL
  ),
  CONSTRAINT group_trade_tenant_group_fk
    FOREIGN KEY (tenant_id, group_id) REFERENCES account_group (tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX group_trade_preview_token_idx ON group_trade (preview_token) WHERE preview_token IS NOT NULL;
CREATE INDEX group_trade_tenant_created_idx ON group_trade (tenant_id, created_at DESC);
CREATE INDEX group_trade_group_idx ON group_trade (group_id, created_at DESC);

-- ------------------------------------------------------------------ child_order
-- One leg of a group trade: what one account will do, or why it was skipped. The
-- planning stage writes N of these per group trade, each 'planned' or 'skipped'.
-- A skipped row carries a refusal_code and a message with numbers (09 F7) and is
-- never sent. This is the row the confirmation table renders one-for-one (U2).
CREATE TABLE child_order (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  group_trade_id        uuid NOT NULL,
  account_id            uuid NOT NULL,
  -- One leg per account per group trade in v1; leg_seq exists for a future split.
  leg_seq               smallint NOT NULL DEFAULT 0,

  -- Resolution and sizing provenance ------------------------------------------
  -- market is the orders/create form ('BTCINR'); pair is the socket/candle form
  -- ('I-BTC_INR'); market_ecode is the venue routing code (I|B|KC|G). All NULL on
  -- a row skipped before a market was resolved.
  market                text,
  pair                  text,
  market_ecode          text,
  quote_currency        text CHECK (quote_currency IS NULL OR quote_currency IN ('INR','USDT')),
  currency_choice_reason text,
  basis_used            text,
  basis_amount_minor    numeric(38,0) CHECK (basis_amount_minor IS NULL OR basis_amount_minor >= 0),
  price_source          text CHECK (price_source IS NULL OR price_source IN ('book_ask','book_bid','limit')),
  price_used            venue_decimal,
  -- Rates: fee and TDS assumed at plan time, exact decimals not minor units.
  fee_rate_assumed      venue_decimal,
  tds_rate_applied      venue_decimal,
  raw_quantity          venue_decimal,
  final_quantity        venue_decimal,
  notional_minor        numeric(38,0) CHECK (notional_minor IS NULL OR notional_minor >= 0),
  -- Set when a market-order cap clamped the quantity below what was requested,
  -- so the confirmation screen can show "you asked for X, the cap allows Y".
  clamped_from_quantity venue_decimal,

  -- The orderbook snapshot this leg was priced against (T04.10, T04.5). One read
  -- per market is shared across accounts; each child records the timestamp it saw
  -- and the spread measured from it, in integer basis points (minor-unit
  -- discipline). slippage_bp is the VWAP deviation the guard computed (T04.11).
  book_observed_at      timestamptz,
  spread_bp             numeric(38,0) CHECK (spread_bp IS NULL OR spread_bp >= 0),
  slippage_bp           numeric(38,0) CHECK (slippage_bp IS NULL OR slippage_bp >= 0),

  -- Lifecycle ------------------------------------------------------------------
  -- No transition legality here on purpose (12 F1); application logic owns it.
  state                 text NOT NULL CHECK (state IN
                          ('planned','skipped','sending','ambiguous','not_placed','acked','open',
                           'partially_filled','filled','cancelled','partially_cancelled',
                           'rejected','unknown','needs_human')),
  refusal_code          text,
  refusal_detail        text,
  -- Derived deterministically by Phase 06; NULL for every planned row today.
  -- UNIQUE below treats NULLs as distinct, so many planned rows coexist and the
  -- id becomes unique-enforced the moment it is populated.
  client_order_id       text CHECK (client_order_id IS NULL OR length(client_order_id) <= 36),
  exchange_order_id     text,
  exchange_status_raw   text,
  filled_quantity       venue_decimal NOT NULL DEFAULT '0',
  remaining_quantity    venue_decimal,
  cancelled_quantity    venue_decimal NOT NULL DEFAULT '0',
  avg_fill_price        venue_decimal,
  fee_amount_minor      numeric(38,0) CHECK (fee_amount_minor IS NULL OR fee_amount_minor >= 0),
  exchange_group_id     text,
  sent_at               timestamptz,
  last_observed_at      timestamptz,
  terminal_at           timestamptz,
  resolve_attempts      integer NOT NULL DEFAULT 0 CHECK (resolve_attempts >= 0),
  divergence_count      integer NOT NULL DEFAULT 0 CHECK (divergence_count >= 0),
  created_at            timestamptz NOT NULL DEFAULT now(),

  -- X1, expressed in the database: at most one order per account per group trade
  -- per leg. Two concurrent workers would both pass an application check.
  CONSTRAINT child_order_leg_unique UNIQUE (group_trade_id, account_id, leg_seq),
  -- X1's second half: the client order id is globally unique, so a duplicate
  -- insert fails before any HTTP call is made — a duplicate at the exchange.
  CONSTRAINT child_order_client_order_id_unique UNIQUE (client_order_id),
  -- A skipped row must say why; a planned row must not carry a refusal.
  CONSTRAINT child_order_skip_has_reason CHECK (
    (state <> 'skipped') OR (refusal_code IS NOT NULL)
  ),
  CONSTRAINT child_order_planned_no_refusal CHECK (
    (state <> 'planned') OR (refusal_code IS NULL)
  ),
  -- Parent side of execution_job's composite tenant FK.
  CONSTRAINT child_order_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT child_order_tenant_trade_fk
    FOREIGN KEY (tenant_id, group_trade_id) REFERENCES group_trade (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT child_order_tenant_account_fk
    FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id) ON DELETE RESTRICT
);
-- Supports gate 12 (no in-flight order for an account+market) and the blotter.
CREATE INDEX child_order_account_state_idx ON child_order (account_id, state)
  WHERE state NOT IN ('filled','cancelled','partially_cancelled','rejected','skipped','not_placed');
CREATE INDEX child_order_tenant_created_idx ON child_order (tenant_id, created_at DESC);
CREATE INDEX child_order_trade_idx ON child_order (group_trade_id, account_id, leg_seq);

-- ----------------------------------------------------------------- execution_job
-- The scheduler queue. Empty in this phase — nothing enqueues until Phase 06 —
-- but created now so the schema is complete before the first send. The claim
-- query (DATA-MODEL) is FOR UPDATE SKIP LOCKED across all tenants, which is why
-- this table is deliberately NOT read through the tenant-scoped query builder in
-- the worker; it is still listed in TENANT_SCOPED_TABLES so any builder use is
-- scoped, and the composite FK keeps its tenant honest against its child order.
CREATE TABLE execution_job (
  id             bigserial PRIMARY KEY,
  child_order_id uuid NOT NULL,
  tenant_id      uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  kind           text NOT NULL CHECK (kind IN ('place','resolve','cancel','poll')),
  run_after      timestamptz NOT NULL DEFAULT now(),
  attempts       integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_by      text,
  locked_at      timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- A lock is held by someone at some time, or by no one at no time.
  CONSTRAINT execution_job_lock_pair CHECK ((locked_by IS NULL) = (locked_at IS NULL)),
  CONSTRAINT execution_job_tenant_child_fk
    FOREIGN KEY (tenant_id, child_order_id) REFERENCES child_order (tenant_id, id) ON DELETE RESTRICT
);
-- The claim query's supporting index: unclaimed jobs whose time has come.
CREATE INDEX execution_job_claimable_idx ON execution_job (run_after) WHERE locked_by IS NULL;
CREATE INDEX execution_job_tenant_run_idx ON execution_job (tenant_id, run_after);

COMMIT;
