# DECISIONS

Status: 2026-09-03 | every decision made across the 22 research documents, consolidated. **Sorted so the one-way doors come first** - the choices that are expensive or impossible to reverse after launch. Each entry names its source file so the argument can be checked.

Reversibility is judged as: **one-way** (cannot be undone without rebuilding or migrating live money data), **costly** (weeks of work), **cheap** (a config change or a small refactor).

## One-way doors

| # | Decision | Choice | Rationale | Rejected | Consequence | Source |
|---|---|---|---|---|---|---|
| D01 | Money representation | Exact decimals: `numeric(38,0)` minor units for money, `numeric(38,18)` for quantities. **Never a float, anywhere** | A float error is silent, cumulative and unrecoverable once written | `float`/`double`; `numeric` with implicit scale | Every arithmetic path, every column, every API boundary. Changing this later means rewriting and re-deriving all history | `09`, `DATA-MODEL` |
| D02 | Ledger is append-only | No `UPDATE`, no `DELETE`. Corrections are new rows referencing the original | It is the audit record and the basis of every number a customer sees | Mutable rows with an updated-at | The holdings projection must be rebuildable by replay (X8); every "fix" becomes a correction entry | `11` L3 |
| D03 | Audit is append-only, separate, 5-year retention | `INSERT`-only grant; monthly partitions; export to write-once storage | CoinDCX clause 6.6 and PMLA both require 5 years and transaction reconstruction | Application logs as the record; 90-day retention | Records we never kept cannot be created later. Partitioning retrofitted onto a live legally-retained table is the worst version of this job | `15`, `20`, `22` F5 |
| D04 | Idempotency key derivation | `client_order_id` = `"t" + base32(HMAC(pepper, group_trade_id‖account_id‖leg_seq))[0..27]`, 27 chars inside the 36-char limit | Deterministic, so a retry recomputes it; CoinDCX rejects reuse, so a duplicate fails closed | Random UUID per attempt | Changing the derivation orphans every historical order's ability to be re-resolved by key | `08` F5 |
| D05 | Write the order row **before** the HTTP call | Commit `sending` in the same transaction that reserves the `client_order_id` | It is the only thing that makes an unknown outcome discoverable | Write on response | The entire recovery story (P1, P2, X4) depends on it. Retrofitting means auditing every order path | `08` F4 |
| D06 | Products in v1 | **Spot only** | Futures and margin have no client-supplied idempotency key at all, so P2 cannot be guaranteed | Ship futures for the position semantics | Adding futures later is a new phase with its own L1-L4 safety protocol, not a feature toggle | `02`, `03` |
| D07 | Money store | PostgreSQL. Ledger, orders, jobs, credentials, audit | Exact numerics, cross-table transactions, real constraints, `SKIP LOCKED` | MongoDB - briefly chosen on 2026-09-05 and reverted the same day once the premise (that Postgres needs XAMPP locally) turned out to be false. Mongo would have moved four schema-level guarantees into application code | Migrating a live ledger between stores is the one migration nobody wants | `17` F2 |
| D08 | Credential custody | Managed KMS envelope encryption; per-credential DEK; AES-256-GCM with AAD bound to `tenant‖account‖credential‖version` | A stolen database is inert; a row cannot be transplanted between accounts | Vault; a static application key | Re-keying is possible but the AAD scheme and `key_version` must be right from the first stored credential | `07` F3 |
| D09 | Cost basis method | Weighted average cost, with all fills retained | Incremental, partial-fill friendly, matches "average entry"; FIFO buys no tax benefit under a flat 30% no-set-off regime | FIFO; LIFO | Switching later restates every historical realised P&L figure. Retaining fills keeps FIFO derivable if a rule changes | `11` |
| D10 | TDS is not a fee and not a cost basis component | Its own `tds` ledger kind, excluded from P&L, included in cash flow, labelled `estimated` | It is creditable withheld tax; netting it corrupts P&L *and* loses the customer's tax figure | Net into fees; net into basis; ignore | Reclassifying later restates P&L and every fee-drag metric | `11` F4 |
| D11 | Tenant scoping | `tenant_id` on every row; one enforced query layer; `(tenant_id, id)` composite lookups | The cross-tenant leak is the unrecoverable failure | Scattered `where` clauses; RLS alone | Retrofitting a query layer over an existing codebase means re-auditing every query | `17` F5 |
| D12 | Exchange adapter boundary | `ExchangeAdapter` port; CoinDCX types confined to one package; enforced in CI | CoinDCX may terminate *"without any notice … and without assigning any reason"* (clause 5.2) | Direct coupling | Untangling exchange types from a whole codebase after a termination notice is not a plan | `15` F1, `17` F4 |
| D13 | Capture-or-lose-forever fields | Decision-time mid, `fx_snapshot_id`, market-metadata version, sizing basis, refusal reason, raw exchange status, spread at submit - all persisted at plan time | None can be reconstructed later. The mid exists for a few hundred milliseconds | Compute analytics from fills alone | Slippage (`M16`) is permanently uncomputable for any order that predates capture | `14` F2 |
| D14 | Hosting region | AWS `ap-south-1` (Mumbai) | Measured 37.6 ms warm to CoinDCX; DPDP data residency | Singapore; a US region | Moving a live money system between regions is a migration, not a config change | `17` F1 |
| D15 | KYC-capable model from Phase 00 | Fields, verification states and audit present even if collection is deferred | FIU-IND registration must be a policy change, not a migration under a takedown notice | Add when required | 53 providers have already been directed for takedown; a migration under that pressure is the worst case | `15` F5, `19` |

## The scope decision that reshaped the plan

| # | Decision | Choice | Rationale | Rejected | Consequence | Source |
|---|---|---|---|---|---|---|
| **D51** | The read/display boundary | **v1 reads CoinDCX data inbound to legalise, price, fund and verify orders. It displays no CoinDCX-derived prices outbound.** Charts, depth, mark-to-market P&L, exposure, drawdown, equity curves and analytics dashboards are out of v1 | Tradex is an execution product. P&L and price discovery already exist in the CoinDCX app, so rebuilding them adds scope *and* is the only thing clause 2.3(c) reaches. Our own orders and fills are our records, not Market Data, so the execution report, blotter and realised P&L stay | Build the full analytics surface and gate it on a written answer from CoinDCX | Retires risk R04; removes the plan's only external gate; cuts phases 07, 10, 11 and 12; saves ~20-30 developer-days. Adding display later is **additive**, so this is cheap to reverse if the letter comes back permissive | `ARCHITECTURE` §6a, decided 2026-09-05 |

The distinction, stated once: **inbound data sizes, funds and verifies an order; outbound pixels are only ever our own records.** A fill price arriving in a response to *our* order is a fact about our transaction and stays displayable. A current market price used to value a holding is not.

Reading order state back is **not** reporting and is not affected: `orders/status` by `client_order_id` is the only way to resolve an ambiguous create, and `trade_history` is the only detector of fills we did not cause. P1, P2 and P3 all depend on them.

## Costly to reverse

| # | Decision | Choice | Rationale | Rejected | Source |
|---|---|---|---|---|---|
| D16 | Percentage sizing basis | **Allocated capital** - the figure captured at account-add - as default, with the basis recorded per trade and the other two selectable | It is what the owner specified; stable and reproducible. Recording the basis is what makes any historical trade explainable | Current equity; free balance | `09` F4 |
| D17 | Rounding direction | **Always down**, both sides | Never exceed a budget; never oversell. One rule, no judgement | Nearest; banker's | `09` |
| D18 | Refuse, never truncate | An account that cannot legally trade is skipped with a reason containing numbers | A rejection after send is a customer-visible failure; a refusal before send is a UI message | Round to the minimum and send | `09` F5 |
| D19 | Durable execution substrate | Postgres job table + `FOR UPDATE SKIP LOCKED` | Inspectable with SQL during an incident; shares transactions with the rows it describes | Temporal; BullMQ/Redis | `08` F10 |
| D20 | Socket role | **Trigger only.** A socket event enqueues a poll; the poll mutates state | Sockets fail silently in four verified ways; correctness must not depend on them | Apply socket payloads as authoritative | `12` F2, `05` |
| D21 | Reconciliation ships with the first real order | Loops A and C, plus the resolve ladder, in the same phase as the first live trade | An unreconciled order is money in an unknown state | Add reconciliation in a later phase | `12`, `18` F6 |
| D22 | Signer process split | Port from day one; separate process before the first real-money order | Turns "app server compromised" into a smaller, more detectable loss | In-process forever | `07` F5 |
| D23 | Group membership overrides | Deferred past v1. Columns exist, unused | Weights would introduce a *second* sizing basis alongside the percentage rule | Ship weights and caps in v1 | `19` |
| D24 | Charting library | TradingView Lightweight Charts 5.2.1, Apache-2.0 (verified from `LICENSE`: stock Apache, no branding clause) | Financial-first, canvas, 10 files, 1 dependency | ECharts (58.9 MB, 1,347 files); Highcharts (commercial); KLineCharts (viable runner-up) | `13` F1 |
| D25 | Candle feed | `public.coindcx.com/market_data/candlesticks` - live-verified 9 resolutions, windowed, covers INR spot | The documented spot `candles` endpoint has 4 fixed intervals and no windowing | Documented endpoint | `03` F9 |
| D26 | Language and shape | TypeScript throughout; modular monolith, 6 process types, one deployable | Nothing is CPU-bound at a 38 ms round trip; transactions where we need them | A Go execution service; microservices | `17` |
| D27 | Frontend stack | React + TypeScript + Vite + TanStack Query | Matches the team; no SSR need behind a login | Next.js; Svelte | `21` |
| D28 | Preview is mandatory | The trade ticket has **no submit button**. The only path forward is a server-computed preview with a hard expiry | It is the last point a human can stop a 20-account mistake | Submit directly from the ticket | `21` F2, F3 |
| D29 | Advisory posture | Pure execution. No signals, no recommendations, no pre-built strategy groups, **no pre-filled sizing values** | Keeps us clear of investment-adviser characterisation, at zero product cost | Add "suggested allocations" | `15` F6 |
| D30 | Market preference when both INR and USDT are available | **Prefer INR** | A C2C buy carries 1% TDS an INR buy does not, so INR round trips cost ~2.4% against ~3.0% | Prefer the tighter spread - measurably wrong once TDS is counted | `10` F7 |
| D31 | No auto-conversion | INR↔USDT conversion is a separate, explicitly authorised action with its own audit and ledger lines, and zero P&L | It changes the customer's currency exposure; doing it silently inside a trade is indefensible | Convert just enough to let an account participate | `10` F5 |
| D32 | Order pricing source | `market_data/orderbook` top of book at send time | `/exchange/ticker` is CDN-cached (`cf-cache-status: HIT`), so it is stale by an unknown amount | Ticker; last traded price; mid | `01`, `09` |

## Cheap to reverse

| # | Decision | Choice | Source |
|---|---|---|---|
| D33 | Fan-out parallelism | 8 in flight, configurable per tenant | `08` F8 |
| D34 | Reconciler cadences | 1 s during a fan-out, 30 s with open orders, 5 min idle - all configuration, not constants | `12` F4 |
| D35 | Rate-limit buckets | Global + per-credential token buckets, defaulting to the pessimistic 16/s, 960/min until measured | `08` F1 |
| D36 | Slippage tolerance | 0.5% default, configurable | `09` F8 |
| D37 | Fee assumption | 0.5% taker, provisional, replaced by the `fee` field from the first real fill per account | `09` F6 |
| D38 | Notional caps | Per-order Rs 2,00,000, per-day Rs 5,00,000 per tenant, customer-raisable | `08`, `19` |
| D39 | Confirmation friction tiers | Single click below Rs 25,000; checkbox to Rs 2,00,000; typed amount above - and always typed for sell-all and close | `21` |
| D40 | Group-trade abandonment | A trade that cannot start within 60 s of confirmation is abandoned, not executed late | `08` F8 |
| D41 | Auth-failure blocking | Block an account after 3 consecutive 401s; notify; never auto-retry | `07` |
| D42 | Limits | 100 accounts per tenant, 50 per group | `19` |
| D43 | Valuation currency | INR default, tenant-wide, changeable with a restatement warning | `10`, `14` |
| D44 | Chart resolutions in the UI | 1m, 5m, 15m, 1h, 4h, 1D at launch (of 9 available) | `13` |
| D45 | Availability target | 99.5% monthly for the trading path | `22` |
| D46 | Degraded modes | `normal`, `cancel_only`, `read_only`, `frozen` - automatic entry, **manual exit** after a reconciliation sweep | `22` F7 |
| D47 | Retention beyond the statutory floor | 90 days candle cache, 3 years intraday snapshots, 30 days hot logs | `22` |
| D48 | Test funding | A dedicated account with Rs 2,000, never more, for rollout rungs 1-5 | `18` F6 |
| D49 | Check-script convention | Standalone Node scripts printing assertion counts; every phase's definition of done cites one | `18` F8 |
| D50 | Mobile scope | Responsive read-only on phone; trade ticket on tablet and up | `21` |
| D52 | HTTP framework | **Fastify 5.12.3** (MIT, 15 deps). Closed 2026-09-05 | `17` - pino is its native logger and redaction is a correctness requirement; Express 5 would also work |
| D53 | Query layer | **Kysely 0.29.5** (MIT, 0 deps) over **pg 8.23.0**. No full ORM on money paths. Closed 2026-09-05 | `17` - typed against the schema, compiles to legible SQL, raw escape hatch for `SKIP LOCKED` |
| D54 | Process count | **Five** process types, not six - `market-data` deferred with charting | `17` F3, D51 |
| D55 | Supporting libraries | **Verified against the npm registry during Phase 00 implementation, 2026-09-05** - and four of my earlier figures were wrong, so these are the installed ones: eslint **10.10.0**, @eslint/js **10.0.1**, @types/node **26.4.1**, typescript-eslint **8.69.0**, Vitest **5.0.0**. Frontend (not yet installed): React 19.2.8, Vite 8.2.2, TanStack Query 5.102.8 | `17` |
| D56 | TypeScript version | **6.0.3, not 7.0.2.** TypeScript 7 is the latest release but `typescript-eslint@8.69.0` declares `typescript >=4.8.4 <6.1.0`, so TS 7 leaves us with no ESLint parser for `.ts` at all. Working lint on strict TypeScript is worth more than the newest major | Revisit when typescript-eslint supports TS 7 | `17` |
| D61 | Order-book reads are sorted, never taken in wire order | **Both sides sorted by value on every read**, comparing decimal STRINGS (`compareDecimals`), and a crossed book is refused rather than priced against | The venue sends each side as a JSON object keyed by price and the keys are not in price order - integer-priced levels first ascending, then fractional descending. Live `B-BTC_USDT` best bid is 79749.99 arriving third, behind 79746. Three of the four captured book sides are correct by luck, so a naive reader passes a spot check and misprices a market order later. Comparison via `Number()` is rejected for the same reason `JSON.parse` is (D01): it is the loss of precision, not a shortcut around it | `09`, D01, T01.1 |
| D60 | Rate-limit seed and meter | **100 requests / 60 s per scope, metered on BOTH the egress and the API key, with a 16/s burst ceiling.** GCRA (one timestamp per scope) rather than a token count. `acquire()` blocks; `observe()` narrows from the `ratelimit` headers but never widens, ignores counters on a Cloudflare cache HIT, and parks a scope on 429 | The four published figures disagree by 50x and `06` F6 says to seed at the tightest, which is the help site's 100/min - not the FAQ's 960/min, which is 9.6x looser. Both scopes are metered because G2 (per key or per IP) is unanswered, and metering both is the only configuration correct under either answer; being wrong this way costs latency, the other way costs a 429 mid-fan-out with some accounts filled and some not. One timestamp is what a Redis script can update atomically, so the in-memory store swaps out without touching the algorithm; a float token count would drift as it refilled | `06` F6, `22` F3, T01.5, D59 |
| D59 | Transport failures are split by whether a byte was written | **Four kinds, two verdicts.** `dns` and `connect` (including every TLS/certificate failure) -> new `connect_failure` class, `orderMayExist: false`, `retrySafe: true`. `timeout` and `reset` -> `orderMayExist: true`, `retrySafe: false`. The transport tracks whether the socket ever connected, because `ECONNRESET` is the same code for "refused the handshake" and "dropped mid-request" | Name resolution, TCP connect and the TLS handshake all complete before the request body is written, so those failures provably placed no order. Treating them as ambiguous - which is what a single `transport` verdict did - would put every DNS blip and every cert-pinning mistake through the resolve ladder, and would report a pinning failure across 20 accounts as 20 possibly-placed orders instead of 20 definitely-refused connections. The conservative default is retained for anything unrecognised: an unmapped post-connect error is ambiguous, never safe | `08` F2, T01.3, T01.7 |
| D58 | Exponent-form numeric fields | **Expanded to plain decimal text at the adapter boundary** by `plainDecimal()` in `market-rules.ts`, by moving the decimal point through the digit string. `decimal-json.ts` keeps the venue's literal unchanged; only mapped `MarketRules` are normalised | 90 fields in the live 997-market response are exponent form - `min_quantity: 1e-7` on ETHINR, `step: 1e-7` on DEFIINR, `min_price: 1e-11` on dust markets. `packages/money` rejects exponent notation deliberately (it hides digit count), so those markets would throw on first contact with sizing. Arithmetic expansion is banned here: `Number(5.34966666667e-7)` reintroduces the exact loss D01 exists to prevent. The two responsibilities stay split because a signed body must echo byte-for-byte | D01, D57, `packages/exchange-coindcx` |
| D57 | Money arithmetic implementation | **Exact fixed-point on `bigint`, zero dependencies** - `packages/money/src/scaled.ts`. Not decimal.js | Every money value here is already an integer in minor units and every quantity an integer at the market's precision, so scaled bigints represent both exactly; floor division is the natural operation, which is precisely what D17 requires. Rejected: decimal.js (a dependency, and its default rounding is half-up - the wrong default for this product) | `packages/money`, D01, D17 |

## Incompatibilities found between research files, and how they were resolved

| Conflict | Files | Resolution |
|---|---|---|
| Candle resolutions: "arbitrary" vs a fixed whitelist | `01` vs `03` F9 | **`03` is correct.** Live probe: `1, 5, 15, 30, 60, 240, 480, 1D, 1M, D` accepted; `3, 7, 120, 720, 1W, W, 1440` rejected. Fix the claim in `01` |
| Market preference: tighter spread vs INR | `10` (original) vs `11` F4 | **INR wins.** TDS asymmetry more than cancels the spread advantage. `10` corrected, F7 added |
| Order pricing: ticker vs order book | `09` (original) vs `01` | **Order book.** Ticker is CDN-cached. `09` corrected |
| Exchange IP allowlist: required vs impossible | `17` (implied) vs `07` F1 | **Impossible.** CoinDCX binds to the key-generating device's IP. A static egress IP is still worth having, for the per-IP rate-limit question and the HFT route - not for an allowlist |
| Cross-reference filenames | `05` | Invented names (`04-coindcx-rest-spot.md`, `08-order-lifecycle.md`, …) from an earlier numbering. Fix in the consistency sweep |
| `dek_wrapped` nullability | `07` F4 vs `DATA-MODEL` | **Nullable**, so revocation crypto-shreds by setting it to `NULL` while keeping the audit-bearing row. A `CHECK` keeps active credentials honest |
| `ledger_entry` primary key | `11` F3 vs `DATA-MODEL` | Partitioning forces `occurred_at` into the PK and the idempotency index. The property - re-ingesting a trade adds no rows - is unchanged |

## Decisions still open

These are not decided here. They are in `OPEN-QUESTIONS.md` because they need the owner, a lawyer, or a measurement.

| Awaiting | Blocks |
|---|---|
| The per-key-vs-per-IP rate-limit measurement | Capacity, reconciler cadence, pricing, onboarding pace - **the only gate left inside the plan** |
| Counsel on PMLA reporting-entity status | Launch |
| Whether leverage is wanted at all | Whether `02`/`03` ever get implemented |
| Demand validation | Whether to build past Phase 02 |
| CoinDCX's answer on clause 2.3(c) | **Nothing.** Retired as a gate by D51; a permissive answer would return charts and mark-to-market analytics as a later phase |
