-- 014_futures.sql
-- plan/phase-15 futures + leverage + SL/TP + hard exit — schema foundation.
--
-- This migration is additive to spot: `is_futures BOOL NOT NULL DEFAULT false`
-- on `group_trade` is the top-level branch every downstream reads. Existing spot
-- rows are unchanged and stay legal (false, everything else NULL). A futures row
-- must carry leverage + margin_currency + position_margin_type together, and
-- the SL/TP fields are OPTIONAL even on a futures row (a customer can open a
-- position without attaching protection first — that's the trigger for the A21
-- "stale SL after exit" alert we DO NOT accidentally invert here).
--
-- `child_order` gains a `leg_kind` discriminator: the ENTRY leg is what fans out
-- across accounts, and each account's `stop_loss`/`take_profit` legs are its
-- siblings linked by `linked_entry_child_order_id`. New states cover the
-- conditional lifecycle: `untriggered` (a resting SL/TP), `sl_hit`/`tp_hit`
-- (terminal, protection fired), `liquidated` (terminal, venue force-closed the
-- position — visible so a fan-out doesn't retry it as a normal failure).
--
-- `futures_position` mirrors what the venue's REST returns. REST is the source
-- of truth (research/04 D6); this table is a durable cache the reconciler
-- refreshes and the positions view reads. It intentionally holds mark_price,
-- liquidation_price and unrealised inputs — that is exactly the §6a carve-out
-- futures requires (recorded in `checks/07-no-mark-to-market`'s allowlist by a
-- follow-up code change).
--
-- `futures_execution_lock` is the anti-duplicate-order substitute for the
-- missing `client_order_id` on futures (research/03 Verdict): a leg holds the
-- (account_id, pair) lock across write-before-send and the read-back window.
-- Row-based rather than pg_advisory so it survives across sessions/workers and
-- the reaper can clear stale locks the same way it does execution_job.

BEGIN;

-- --------------------------------------------------- group_trade widens
ALTER TABLE group_trade
  DROP CONSTRAINT group_trade_order_type_check;
ALTER TABLE group_trade
  ADD CONSTRAINT group_trade_order_type_check
  CHECK (order_type IN
    ('market','limit','stop_market','stop_limit','take_profit_market','take_profit_limit'));

ALTER TABLE group_trade
  ADD COLUMN is_futures            boolean NOT NULL DEFAULT false,
  -- leverage is a decimal ratio (venue_decimal, text domain). App + venue enforce
  -- the tier-appropriate max; schema-level range is unnecessary and would need a cast.
  ADD COLUMN leverage              venue_decimal,
  ADD COLUMN margin_currency       text CHECK (margin_currency IS NULL OR margin_currency IN ('INR','USDT')),
  ADD COLUMN position_margin_type  text CHECK (position_margin_type IS NULL OR position_margin_type IN ('isolated','crossed')),
  ADD COLUMN stop_loss_price       venue_decimal,
  ADD COLUMN take_profit_price     venue_decimal,
  ADD COLUMN reduce_only           boolean NOT NULL DEFAULT false;

-- The venue supports 'crossed' on USDT-margined only (research/03 F4). Enforce
-- it as a schema invariant, not a runtime check, so a futures spot-and-cross
-- misconfiguration cannot land as a persisted row.
ALTER TABLE group_trade
  ADD CONSTRAINT group_trade_futures_required_fields CHECK (
    is_futures = false OR (
      leverage IS NOT NULL
      AND margin_currency IS NOT NULL
      AND position_margin_type IS NOT NULL
    )
  ),
  ADD CONSTRAINT group_trade_cross_margin_usdt_only CHECK (
    position_margin_type IS NULL
    OR position_margin_type = 'isolated'
    OR margin_currency = 'USDT'
  ),
  ADD CONSTRAINT group_trade_reduce_only_only_when_futures CHECK (
    reduce_only = false OR is_futures = true
  );

-- The original shape check (007) tied limit_price to order_type='limit'. Futures
-- adds two more types that also carry a limit_price (stop_limit + take_profit_limit).
-- The stop_market / take_profit_market variants carry a trigger price only, not
-- a limit — schema-side they carry no limit_price either.
ALTER TABLE group_trade
  DROP CONSTRAINT group_trade_limit_price_shape;
ALTER TABLE group_trade
  ADD CONSTRAINT group_trade_limit_price_shape CHECK (
    (order_type IN ('limit','stop_limit','take_profit_limit')) = (limit_price IS NOT NULL)
  );

-- --------------------------------------------------- child_order widens
-- Add the new terminal + conditional states first so a follow-on ALTER can
-- insert rows in them for tests without a CHECK violation.
ALTER TABLE child_order
  DROP CONSTRAINT child_order_state_check;
ALTER TABLE child_order
  ADD CONSTRAINT child_order_state_check
  CHECK (state IN (
    'planned','skipped','sending','ambiguous','not_placed','acked','open',
    'partially_filled','filled','cancelled','partially_cancelled',
    'rejected','unknown','needs_human',
    -- futures additions:
    'untriggered','sl_hit','tp_hit','liquidated'
  ));

ALTER TABLE child_order
  ADD COLUMN leg_kind                     text NOT NULL DEFAULT 'entry'
    CHECK (leg_kind IN ('entry','stop_loss','take_profit')),
  ADD COLUMN linked_entry_child_order_id  uuid,
  ADD COLUMN trigger_state                text
    CHECK (trigger_state IS NULL OR trigger_state IN ('untriggered','triggered','expired')),
  ADD COLUMN venue_position_id            text;

-- A conditional leg must link back to an entry; an entry must not link.
ALTER TABLE child_order
  ADD CONSTRAINT child_order_conditional_links CHECK (
    (leg_kind = 'entry' AND linked_entry_child_order_id IS NULL)
    OR (leg_kind IN ('stop_loss','take_profit') AND linked_entry_child_order_id IS NOT NULL)
  ),
  ADD CONSTRAINT child_order_conditional_link_fk
    FOREIGN KEY (linked_entry_child_order_id) REFERENCES child_order(id) ON DELETE RESTRICT,
  ADD CONSTRAINT child_order_trigger_state_only_for_conditional CHECK (
    trigger_state IS NULL OR leg_kind IN ('stop_loss','take_profit')
  );

CREATE INDEX child_order_leg_kind_idx ON child_order (leg_kind, state) WHERE leg_kind <> 'entry';
CREATE INDEX child_order_linked_entry_idx ON child_order (linked_entry_child_order_id)
  WHERE linked_entry_child_order_id IS NOT NULL;

-- --------------------------------------------------- futures_position
-- The venue's position row, cached. REST is source of truth (research/04 D6);
-- this table is what the positions view reads and what the reconciler refreshes.
-- Persisted mark_price + liquidation_price + unrealised inputs are the §6a
-- carve-out that requires an explicit allowlist in 07-no-mark-to-market.
CREATE TABLE futures_position (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  account_id                  uuid NOT NULL,
  pair                        text NOT NULL,
  margin_currency             text NOT NULL CHECK (margin_currency IN ('INR','USDT')),
  venue_position_id           text NOT NULL,
  -- Signed base quantity: positive = long, negative = short, 0 = closed.
  active_pos                  venue_decimal NOT NULL,
  avg_entry_price             venue_decimal,
  -- Mark price is stale-by-design (research/04 F2 "not real-time and is only for
  -- reference"). Keep it here so the view has SOMETHING to show between socket
  -- pushes; the socket refresh is what makes it near-live.
  mark_price                  venue_decimal,
  mark_observed_at            timestamptz,
  liquidation_price           venue_decimal,
  leverage                    venue_decimal,
  locked_margin_minor         numeric(38,0),
  take_profit_trigger         venue_decimal,
  stop_loss_trigger           venue_decimal,
  margin_type                 text CHECK (margin_type IS NULL OR margin_type IN ('isolated','crossed')),
  -- The rt feed carries funding via `fr`/`efr` (research/04 F15). Cache the
  -- currently-quoted rate so a page load has a value before the socket connects.
  funding_rate_bp             integer,
  updated_at                  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT futures_position_venue_unique UNIQUE (tenant_id, venue_position_id),
  CONSTRAINT futures_position_pair_unique  UNIQUE (tenant_id, account_id, pair, margin_currency),
  CONSTRAINT futures_position_tenant_account_fk
    FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX futures_position_account_idx ON futures_position (account_id, pair);
CREATE INDEX futures_position_tenant_updated_idx ON futures_position (tenant_id, updated_at DESC);

-- --------------------------------------------------- futures_execution_lock
-- The anti-duplicate-order substitute (research/03 Verdict).
--
-- Before a leg's write-before-send, the worker acquires the (account_id, pair)
-- lock: INSERT ON CONFLICT DO NOTHING. If the insert loses the race, another
-- worker is mid-send for the same pair — this worker STANDS DOWN, exactly like
-- spot's write-before-send race. The lock is released after the venue's
-- observed truth is settled into child_order (fill, ack + open, or terminal).
-- A crash between send and settle leaves a stale lock; the reaper (Phase 13
-- boot reaper + the periodic requeueStale) is extended in T15.4 to also clear
-- these older than `lock_stale_ms` (default 30 s — well outside the venue's
-- 10 s signing window, so a legitimately-in-flight send cannot be reaped).
CREATE TABLE futures_execution_lock (
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  account_id      uuid NOT NULL,
  pair            text NOT NULL,
  child_order_id  uuid NOT NULL,
  acquired_at     timestamptz NOT NULL DEFAULT now(),
  locked_by       text NOT NULL,
  PRIMARY KEY (account_id, pair),
  CONSTRAINT futures_execution_lock_tenant_account_fk
    FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX futures_execution_lock_tenant_acquired_idx ON futures_execution_lock (tenant_id, acquired_at);

COMMIT;
