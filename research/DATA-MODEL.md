# DATA-MODEL

Status: 2026-09-03 | **PostgreSQL 16+** | the consolidated physical schema for Tradex. Where a research file's DDL differed from another's, this document is authoritative and the divergence is noted. All money exact, every tenant-scoped row carrying `tenant_id`.

> A MongoDB variant of this document was written and reverted on 2026-09-05. The reason for reverting was that its premise - that PostgreSQL requires XAMPP for local development - is false; Postgres ships its own Windows installer, exactly as MongoDB does. Mongo remains a viable choice but would move four schema-level guarantees into application code. See `DECISIONS.md` D07.

## Conventions

| Convention | Rule |
|---|---|
| Money | `numeric(38,0)` **minor units** with an explicit `scale` column or a known per-currency scale (INR 2, USDT 8). Never `float`, `double precision`, or `numeric` with implicit scale |
| Crypto quantity | `numeric(38,18)` exact decimal, plus the market's `target_currency_precision` recorded on the order that produced it |
| Prices | `numeric(38,18)`. CoinDCX price precision comes from `base_currency_precision` (their "base" is the quote asset - see `01`) |
| Ids | `uuid` for our entities; **`text`** for exchange order ids, because CoinDCX states an order id is *"a positive numeric string. UUID format is no longer accepted"* |
| Timestamps | `timestamptz`, stored UTC, displayed IST. Windows and financial years are IST calendar (`14`) |
| Tenant scoping | `tenant_id NOT NULL` on every tenant-scoped table; every lookup is `(tenant_id, id)` (`17` F5) |
| Enums | `CHECK` constraints, not Postgres `ENUM` types - adding a value must not need a migration lock |
| Immutability | `ledger_entry` and `audit_event` get `INSERT`-only grants to the application role |
| Partitioning | Monthly on `audit_event` and `ledger_entry` from day one (`22` F5) |

## The driver trap that protects all of this

**`pg` returns `numeric`, `decimal` and `int8` as JavaScript strings, not numbers.** That is deliberate on node-postgres's part - a `numeric(38,0)` cannot survive a double, so it refuses to try. It is exactly the behaviour we want, and it has three consequences worth writing down before the first migration:

| Consequence | Detail |
|---|---|
| Kysely's generated types will say `string` for every money column | This looks wrong and is right. The `Money`/`Qty` wrapper is what gives those strings meaning |
| **Never register a type parser that converts `numeric` to `number`** | It is the single most common "fix" applied to node-postgres, and here it would silently reintroduce float error into every balance, fill, fee and P&L figure. The CI rule banning `number` in money types (`plan/phase-00` T00.2) is what stops it |
| `int8`/`bigserial` ids also arrive as strings | `ledger_entry.id` and `execution_job.id` are strings in application code. Compare them as strings or as `BigInt`, never by coercing to `number` - beyond 2^53 that is lossy |

A single test asserts the property: insert `numeric(38,0)` values at 38 digits and at 1 minor unit, read them back, and assert exact string equality. If someone adds a type parser, that test fails immediately rather than a customer's balance drifting a paisa at a time.

## Domain 1 - Tenancy and identity

Full DDL in `19` F2. Summary and the invariants that matter:

| Table | Key columns | Enforced invariants |
|---|---|---|
| `tenant` | `valuation_currency` (INR default), `kyc_status`, `gstin`, `status` | `CHECK` on currency and status; KYC-capable from day one (`15` F5) |
| `app_user` | `tenant_id`, `email`, `password_hash`, `totp_secret_ct`, `role` | `UNIQUE (email)`; role in (`owner`,`trader`,`viewer`); `totp_secret_ct` is **our** 2FA, encrypted - never the exchange's |
| `tenant_limit` | caps, `typed_confirm_above_minor`, `trading_paused` | One row per tenant; the customer's kill switch lives here |
| `platform_state` | single row: global kill switch, current degraded mode and its reason | The global brake (`plan/phase-05`) |

## Domain 2 - Credentials

```sql
CREATE TABLE exchange_credential (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  account_id         uuid NOT NULL REFERENCES exchange_account(id) ON DELETE RESTRICT,
  exchange           text NOT NULL DEFAULT 'coindcx' CHECK (exchange IN ('coindcx')),

  key_version        smallint NOT NULL DEFAULT 1,
  kms_key_arn        text  NOT NULL,
  dek_wrapped        bytea,                       -- NULLed on revoke = crypto-shred
  api_key_ct         bytea NOT NULL,
  api_key_nonce      bytea NOT NULL,
  api_key_tag        bytea NOT NULL,
  api_secret_ct      bytea NOT NULL,
  api_secret_nonce   bytea NOT NULL,
  api_secret_tag     bytea NOT NULL,

  api_key_last4      text  NOT NULL,
  fingerprint        bytea NOT NULL,              -- HMAC(pepper, api_key)
  status             text  NOT NULL DEFAULT 'pending_validation'
                       CHECK (status IN ('pending_validation','active','revoked','failed_auth')),
  validated_at       timestamptz,
  last_auth_error_at timestamptz,
  auth_error_count   int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,

  UNIQUE (account_id),
  UNIQUE (tenant_id, fingerprint),
  CHECK (status <> 'active' OR dek_wrapped IS NOT NULL)
);
```

One change from `07` F4: **`dek_wrapped` is nullable.** Revocation sets it to `NULL`, which makes the ciphertext unrecoverable even by us - crypto-shredding without deleting the audit-bearing row. The `CHECK` keeps an active credential honest.

## Domain 3 - Accounts, groups, balances

| Table | Purpose | Notes |
|---|---|---|
| `exchange_account` | The customer's connected account | `allocated_capital_minor` + `allocated_currency` are the percentage-sizing basis (`09` F4); `allocated_confirmed_against_minor` records the real balance shown at confirmation; `funding_currencies text[]` is **derived**, never typed |
| `account_balance` | `(account_id, currency)` → `free_minor`, `locked_minor`, `scale`, `observed_at` | Total held = free + locked; a sell sizes against `free` only (`11` F1) |
| `group` / `group_member` | Named subsets, many-to-many | `PRIMARY KEY (group_id, account_id)` prevents double-sizing; `weight_bp` and `max_notional_minor` exist but are **unused in v1** |
| `account_market_seen` | `(account_id, market)` → first/last fill, count | The anomaly signal for the `16` F2 attack shape |

## Domain 4 - Trading

```sql
CREATE TABLE group_trade (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  group_id           uuid NOT NULL REFERENCES "group"(id),
  created_by         uuid NOT NULL REFERENCES app_user(id),

  asset              text NOT NULL,                       -- 'BTC'
  side               text NOT NULL CHECK (side IN ('buy','sell')),
  order_type         text NOT NULL CHECK (order_type IN ('market_order','limit_order')),
  sizing_mode        text NOT NULL CHECK (sizing_mode IN
                       ('quote_amount','base_quantity','pct_allocated','pct_equity',
                        'pct_free','pct_position','sell_all')),
  sizing_value       numeric(38,18),                      -- amount, quantity or percent
  limit_price        numeric(38,18),

  status             text NOT NULL DEFAULT 'draft' CHECK (status IN
                       ('draft','previewed','executing','completed','abandoned')),
  preview_token      text,
  preview_expires_at timestamptz,
  decision_mid       numeric(38,18),                      -- capture-or-lose-forever (14 F2)
  fx_snapshot_id     bigint REFERENCES fx_snapshot(id),
  market_meta_version bigint,
  code_version       text,                                -- for R7 quarantine (20)
  submitted_at       timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  submitted_from_ip  inet
);

CREATE TABLE child_order (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  group_trade_id      uuid NOT NULL REFERENCES group_trade(id),
  account_id          uuid NOT NULL REFERENCES exchange_account(id) ON DELETE RESTRICT,
  leg_seq             smallint NOT NULL DEFAULT 0,

  -- resolution and sizing provenance
  market              text,                               -- 'BTCINR' (orders/create form)
  pair                text,                               -- 'I-BTC_INR' (socket/candle form)
  market_ecode        text,                               -- I | B | KC | G
  quote_currency      text,
  currency_choice_reason text,
  basis_used          text,
  basis_amount_minor  numeric(38,0),
  price_source        text CHECK (price_source IN ('book_ask','book_bid','limit')),
  price_used          numeric(38,18),
  fee_rate_assumed    numeric(10,8),
  tds_rate_applied    numeric(10,8),
  raw_quantity        numeric(38,18),
  final_quantity      numeric(38,18),
  notional_minor      numeric(38,0),
  clamped_from_quantity numeric(38,18),

  -- lifecycle
  state               text NOT NULL CHECK (state IN
                        ('planned','skipped','sending','ambiguous','not_placed','acked','open',
                         'partially_filled','filled','cancelled','partially_cancelled',
                         'rejected','unknown','needs_human')),
  refusal_code        text,
  refusal_detail      text,
  client_order_id     text,                               -- 27 chars, <= 36 limit
  exchange_order_id   text,                               -- numeric string, NOT a uuid
  exchange_status_raw text,                               -- forensics (12)
  filled_quantity     numeric(38,18) NOT NULL DEFAULT 0,
  remaining_quantity  numeric(38,18),
  cancelled_quantity  numeric(38,18) NOT NULL DEFAULT 0,
  avg_fill_price      numeric(38,18),
  fee_amount_minor    numeric(38,0),
  exchange_group_id   text,                               -- exchange-side split (03 G11)
  sent_at             timestamptz,
  last_observed_at    timestamptz,
  terminal_at         timestamptz,
  resolve_attempts    int NOT NULL DEFAULT 0,
  divergence_count    int NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),

  UNIQUE (group_trade_id, account_id, leg_seq),           -- X1
  UNIQUE (client_order_id)                                -- global; derived deterministically
);
CREATE INDEX ON child_order (account_id, state) WHERE state NOT IN
  ('filled','cancelled','partially_cancelled','rejected','skipped','not_placed');
CREATE INDEX ON child_order (tenant_id, created_at DESC);
```

`UNIQUE (group_trade_id, account_id, leg_seq)` is invariant **X1** expressed in the database: at most one order per account per group trade, enforced by Postgres rather than by hope. `UNIQUE (client_order_id)` is the second half - the id is derived deterministically, so a duplicate insert attempt fails before any HTTP call is made.

Note `state` has **no** transition legality in the check constraint; that is application logic (`12` F1), because encoding a state machine in `CHECK` constraints makes every legitimate product change a migration.

```sql
CREATE TABLE execution_job (
  id             bigserial PRIMARY KEY,
  child_order_id uuid NOT NULL REFERENCES child_order(id),
  tenant_id      uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('place','resolve','cancel','poll')),
  run_after      timestamptz NOT NULL DEFAULT now(),
  attempts       int NOT NULL DEFAULT 0,
  locked_by      text,
  locked_at      timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON execution_job (run_after) WHERE locked_by IS NULL;
CREATE INDEX ON execution_job (tenant_id, run_after);
```

The claim query is the entire scheduler, and it is the single biggest reason this store is Postgres:

```sql
UPDATE execution_job j SET locked_by = $worker, locked_at = now(), attempts = attempts + 1
WHERE j.id IN (
  SELECT id FROM execution_job
  WHERE locked_by IS NULL AND run_after <= now()
  ORDER BY run_after
  FOR UPDATE SKIP LOCKED
  LIMIT $batch
) RETURNING *;
```

One round trip claims a **batch** with a well-understood guarantee, in the same transaction as the order row it describes.

## Domain 5 - Ledger and holdings

```sql
CREATE TYPE ledger_kind AS ENUM (
  'trade_buy','trade_sell','fee','tds',
  'conversion_in','conversion_out','external_adjustment','correction'
);

CREATE TABLE ledger_entry (
  id                bigserial,
  tenant_id         uuid NOT NULL,
  account_id        uuid NOT NULL REFERENCES exchange_account(id) ON DELETE RESTRICT,
  kind              ledger_kind NOT NULL,

  asset             text NOT NULL,
  delta_minor       numeric(38,0) NOT NULL,     -- signed
  scale             smallint NOT NULL,

  child_order_id    uuid REFERENCES child_order(id),
  exchange_trade_id text,
  corrects_id       bigint,

  price             numeric(38,18),
  quote_asset       text,
  fx_snapshot_id    bigint REFERENCES fx_snapshot(id),

  estimated         boolean NOT NULL DEFAULT false,   -- true for derived TDS (11 F4)
  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (id, occurred_at),                       -- partition key included
  UNIQUE (account_id, exchange_trade_id, kind, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX ON ledger_entry (account_id, asset, occurred_at);
```

Two deviations from `11` F3, both forced by partitioning: the primary key includes `occurred_at`, and the idempotency unique index does too. The property that matters is unchanged - **re-ingesting the same exchange trade adds no rows** (invariant L4).

`holding` is a **derived projection**, rebuildable from the ledger, and may be a materialised view or a maintained table. Either way it is never the source of truth:

| Column | Meaning |
|---|---|
| `(account_id, asset)` | Key |
| `qty` | Exact decimal |
| `cost_total_minor`, `quote_asset` | Weighted-average-cost basis |
| `realised_pnl_minor` | Cumulative |
| `rebuilt_at` | When the fold last ran |

Invariant **L6** is worth a periodic check rather than a constraint: `cost_total` is zero exactly when `qty` is zero.

## Domain 6 - Market data and FX

| Table | Purpose | Notes |
|---|---|---|
| `market_metadata` | Versioned snapshot of `markets_details` per market | `version bigint`; carries `step`, both precisions, `min_quantity`/`max_quantity`, `min_market_orders_qty` (**nullable - absent on every market sampled**), `max_quantity_market`, `min_notional`, `min_price`/`max_price`, `order_types text[]`, `status`, `ecode`. Orders record the version they were legalised against |
| `fx_snapshot` | Immutable `(base, quote, rate, source, observed_at)` | Insert-only. Every cross-currency figure references one (X10) |

`candle_cache` and `equity_snapshot` are **not created** - charting and mark-to-market are out of v1 (`ARCHITECTURE` §6a).

`max_quantity_market` deserves its own note: it is depth-derived and moves (`09` F6), so a cached value must not be trusted for legalisation - re-read before sizing, and record the version used.

## Domain 7 - Audit

```sql
CREATE TABLE audit_event (
  id            bigserial,
  tenant_id     uuid NOT NULL,
  actor_user_id uuid,
  actor_process text NOT NULL,
  action        text NOT NULL,
  subject_type  text NOT NULL,
  subject_id    text NOT NULL,
  before        jsonb,
  after         jsonb,
  ip            inet,
  user_agent    text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX ON audit_event (tenant_id, occurred_at DESC);
CREATE INDEX ON audit_event (subject_type, subject_id, occurred_at DESC);
```

`before`/`after` pass through the same redaction serialiser as the logs, so a secret cannot reach an audit row (`07` F6). Retention is **5 years** - the stricter of CoinDCX clause 6.6 and PMLA (`15`). This is the largest table in the system: ~29 M rows and ~15 GB per year at 100 customers, ~73 GB over the statutory period (`22` F5), which is why it is partitioned from day one with a monthly export to write-once storage.

## Invariants enforced by the database, not by code

This table is the practical answer to "why Postgres". Each row is a guarantee that holds regardless of who is typing at 2am.

| Invariant | Mechanism | Why it cannot live in application code |
|---|---|---|
| X1 - one order per (group trade, account, leg) | `UNIQUE (group_trade_id, account_id, leg_seq)` | Two concurrent workers would both pass an application check |
| X1 - one order per client id | `UNIQUE (client_order_id)` | Same race, and this one prevents a duplicate *at the exchange* |
| One live credential per account | `UNIQUE (account_id)` | Concurrent adds |
| One CoinDCX key per tenant | `UNIQUE (tenant_id, fingerprint)` | Concurrent adds; and it is a security property |
| Fill ingestion is idempotent | `UNIQUE (account_id, exchange_trade_id, kind, occurred_at)` | The reconciler re-reads the same page by design |
| An account in a group once | `PRIMARY KEY (group_id, account_id)` | Duplicate membership double-sizes a group trade |
| **No account deleted with history** | `ON DELETE RESTRICT` from orders, ledger, membership | Retention duty (`15`) and analytics continuity (`14`). Application-only enforcement is bypassable by a migration script |
| Enum values constrained | `CHECK` on every status column | An unexpected value silently disables a code path |
| **Active credential has a DEK** | `CHECK (status <> 'active' OR dek_wrapped IS NOT NULL)` | A cross-column condition; no document validator can express it |
| Every row tenant-scoped | `tenant_id NOT NULL` + the query layer | The cross-tenant leak is the unrecoverable failure |
| Exactly one worker claims a job | `FOR UPDATE SKIP LOCKED` | Hand-built claim logic is where duplicate-order bugs come from |

Deliberately **not** database constraints: account and group count limits (configurable per tenant, would need a trigger), state-machine transition legality (would make every change a migration), and `L6`'s cost-zero-when-quantity-zero (a periodic check, because a mid-transaction intermediate state can legitimately violate it).

## Migration ordering

| Order | Migration | Depends on |
|---|---|---|
| 001 | `tenant`, `app_user`, `tenant_limit`, `platform_state`, `audit_event` (partitioned) | - |
| 002 | `exchange_account`, `exchange_credential` | 001 |
| 003 | `market_metadata`, `fx_snapshot` | - |
| 004 | `group`, `group_member` | 002 |
| 005 | `group_trade`, `child_order`, `execution_job` | 002, 003, 004 |
| 006 | `ledger_entry` (partitioned), `holding`, `account_balance`, `account_market_seen` | 002, 005 |
| 007 | Partition-maintenance function + monthly pre-creation | 001, 006 |

Forward-only, checked in, run on deploy. A code rollback must never require a schema rollback (`20` F5), so within a release migrations are additive: add a column, deploy code that writes both, backfill, then drop in a later release.

## Retention and partitioning

| Table | Retention | Mechanism |
|---|---|---|
| `audit_event` | **5 years** | Monthly partitions; monthly export to write-once storage; detach and archive after 5 years |
| `ledger_entry` | **5 years** minimum, in practice indefinite | Monthly partitions |
| `child_order`, `group_trade` | 5 years | Indexed by tenant + date; archive later if needed |
| `account_balance` | Current only | Updated in place |
| Logs | 30 days hot, 1 year cold | Separate from audit |

## Schema decisions most likely to be regretted

Stated with the reason for taking them anyway.

| Decision | The regret | Why anyway |
|---|---|---|
| Minor units as `numeric(38,0)` with a separate scale, rather than a single decimal column | Two fields to keep consistent; every read needs the scale | Exactness plus explicitness. A single `numeric(38,8)` would silently truncate an asset needing more precision |
| `holding` as a maintained table rather than always-computed | It can drift from the ledger | Query performance for the blotter and positions list. Mitigated by L1 - it is rebuildable, and a periodic rebuild-and-compare catches drift |
| `exchange_order_id` as `text` | No type safety, no join-time validation | CoinDCX explicitly states ids are numeric strings and *"UUID format is no longer accepted"*. Typing it `uuid` would break on the first order |
| `state` machine in application code | A bad deploy could write an illegal transition | Encoding it in constraints makes every product change a migration; the simulation tests (`18` F5) cover it instead |
| `group_member.weight_bp` present but unused | Dead columns invite premature use | Enabling overrides later becomes a feature flag rather than a migration on a live trading table |
| Partitioning from day one at 100 customers | Complexity long before it is needed | `audit_event` reaches 73 GB over its statutory life; retrofitting partitions onto a live, append-only, legally-retained table is the worst version of this job |
| `estimated boolean` on ledger entries | A boolean where a provenance enum might be better | Only TDS needs it today (`11` F4); a `source` enum can be added additively if a second estimated kind appears |
| Postgres over MongoDB, given the team's Mongo fluency | A real learning curve for whoever writes the queries | The eleven rows in "invariants enforced by the database" are the product's correctness guarantees. In Mongo, four of them become application code plus a nightly integrity job - and that layer is exactly where money bugs live |

