# ARCHITECTURE

Status: 2026-09-03 | the authoritative design for Tradex. Consolidates the 22 research documents in this directory and resolves the places where they disagreed. A developer should be able to build from this document plus the research file it points at for each area.

## 1. What we are building, and what we actually guarantee

Tradex lets one customer connect many CoinDCX accounts by API key, organise them into named groups, and place a single trade that fans out across every account in a group - sized either as an absolute amount or quantity, or as a percentage of the capital allocated to each account when it was added. Sell side adds percent-of-holding, sell-all and close-position. Funding may be INR or USDT, per account, and the system must never silently convert. Analytics run per group, per account and per P&L.

**On "100% accuracy and 100% error free".** That property is not achievable, and the upstream says so in capitals: CoinDCX's own API Terms state the API is provided *"AS IS"* and that they *"DO NOT WARRANT THAT THE COINDCX API … WILL BE SAFE, UNINTERRUPTED, ERROR FREE"* (clause 7). What is achievable, and what this architecture is built to deliver:

| # | Property | Enforced by |
|---|---|---|
| P1 | **No lost order** - every accepted intent reaches a terminal, known state | Write-before-send, the `ambiguous` state, the resolve ladder, `needs_human` as a real outcome |
| P2 | **No duplicate order** - a retry can never place a second order | Deterministic `client_order_id`, CoinDCX rejecting reuse, per-(account, market) locks, reaper routing dead jobs to `resolve` |
| P3 | **No silent divergence** - any mismatch with the exchange is detected, alarmed and surfaced | Four reconciler loops, balance reconciliation, `external_adjustment`, alert on reconciler *silence* |
| P4 | **No wrong size** - an order is either exchange-legal before it is sent, or refused | Pure sizing function, ten-step legalisation, refuse-never-truncate, property tests over all 999 live markets |
| P5 | **Partial group failure is a first-class reported outcome** - never silent | Per-account preview before send, per-account execution report, reasons carrying numbers |

Everything below exists to make one of those five true.

## 2. System context

```
 ┌───────────┐        ┌──────────────────────── Tradex (AWS ap-south-1, Mumbai) ─────────────────────┐
 │  browser  │        │                                                                              │
 │  React    │◀─HTTPS─┤  web (API)  ──┐                                                              │
 │           │◀─SSE───┤               │                                                              │
 └───────────┘        │               ├─▶ Postgres  (orders, ledger, audit, jobs, credentials-CT)     │
                      │               │                                                              │
                      │  execution-worker ──▶ signer ──▶ KMS (CMK; sole decrypt role)                 │
                      │  reconciler        │                                                          │
                      │  market-data       │      Redis (buckets, caches - nothing authoritative)     │
                      │  scheduler         │                                                          │
                      └────────────────────┼──────────────────────────────────────────────────────────┘
                                           │  pinned static egress (NAT)
                        ┌──────────────────┴─────────────────────┐
                        ▼                                        ▼
             api.coindcx.com (REST, signed)        public.coindcx.com (candles, depth)
             stream-spot.coindcx.com (socket.io, 1 conn per API key)
             stream.coindcx.com (market data, 1 conn total)
```

The browser never contacts a CoinDCX host. Every price it sees comes through our cache; every order it places goes through our gates.

## 3. Components

| Component | Owns | May not |
|---|---|---|
| `web` | HTTP API, auth, previews, reads, SSE fan-out to browsers | Place orders; hold plaintext credentials; call KMS |
| `execution-worker` | Claims `place`/`cancel` jobs; re-runs gates; calls signer; sends; records placement transitions | Size orders (calls a pure function); poll; write observation transitions |
| `reconciler` | Loops A-D; ledger ingestion; holdings projection; divergence detection | Place or cancel anything; write placement transitions |
| `market-data` | Candle cache with coverage windows; depth subscriptions; ticker fan-out | Touch credentials or orders |
| `signer` | Decrypts a credential, HMACs an exact body, returns headers | Return plaintext; log anything sensitive; call the exchange |
| `scheduler` | Enqueues periodic work; runs the stale-lock reaper on every start | Do the work itself |

Two ownership rules make the audit trail meaningful: **only `execution-worker` writes order transitions caused by placement, and only `reconciler` writes transitions caused by observation.** A bug in one cannot fabricate the other's history. And **only `signer` holds KMS decrypt permission** - `web` demonstrably cannot decrypt a credential.

Deployment: one repository, one build, six process types. A modular monolith, not microservices - because the ledger, the order row and the job must be written in one transaction.

## 4. The canonical group-trade flow

```
 1  INTENT      customer picks group, coin, side, type, sizing mode, value
                → group_trade row (draft). This row is the audit anchor.        [08 F4]

 2  PLAN        one shared orderbook read for the market            [09, 13]
                per account:  resolve market from funding currency  [10 F3]
                              size + legalise (pure, 10 checks)     [09 F5]
                              run gates 1-12                        [08 F3]
                capture decision-time mid, fx snapshot, metadata version [14 F2]
                → N child_order rows (planned | skipped, with reasons)
                → PREVIEW returned to browser, with a hard expiry     [21 F3]

 3  CONFIRM     customer approves a fresh preview; typed confirmation above
                the tenant threshold; acknowledgement if any account is skipped
                → group_trade.executing; one job per planned child

 4  EXECUTE     worker, 8 in flight, per account:
                  advisory lock (account, market)
                  re-run gates          (staleness catch)
                  reserve client_order_id, write `sending`  ── COMMIT ──┐
                  signer.sign(exact body)                               │ before
                  POST /exchange/v1/orders/create                       │ the call
                  record acked | rejected | ambiguous  ── COMMIT ───────┘
                  enqueue poll job; release lock                        [08 F5-F6]

 5  SETTLE      socket event → trigger an immediate poll (never applied as truth)
                reconciler Loop A advances each child to terminal        [12 F2, F4]
                fills → ledger entries (asset, quote, fee, TDS)          [11 F3]

 6  REPORT      per-account outcomes, divergence, slippage vs decision mid,
                skipped accounts with reasons, per-currency totals       [08 F7, 14]
```

The load-bearing detail is in step 4: **the `sending` row is committed before the HTTP call.** That is what makes P1 and P2 possible - after any crash, a row in `sending` is by definition ambiguous, and ambiguity is resolvable because we hold the `client_order_id`.

## 5. The credential path

```
 add account ──▶ live users/balances call proves key+secret+our signing   [07 F9, 19 F3]
             ──▶ fingerprint = HMAC(pepper, api_key); UNIQUE per tenant
             ──▶ DEK (256-bit, per credential) ← wrapped by KMS CMK
             ──▶ AES-256-GCM, AAD = tenant | account | credential | version
             ──▶ store ciphertext + wrapped DEK + api_key_last4

 per order ──▶ signer: KMS.decrypt(wrapped DEK) → AES-GCM open → HMAC body
           ──▶ zero the buffers; return headers only, never plaintext
```

Plaintext exists only inside the signer, for the duration of one signing operation. There is **no** decrypt path for support, no plaintext in a queue payload, no plaintext cache.

Sobering context from `07` F1: CoinDCX offers **no restricted API keys** (*"all API users have the same level of permissions, API keys are interchangeable"*), and its IP-binding option binds to the key-generating device's IP, so it is unusable for a server-side platform. There is no exchange-side blast-radius control available to us. Our encryption is not defence in depth; it is the entire defence. And per `16` F1, the 3Commas breach drained accounts by *trading*, not withdrawing - so "the key cannot withdraw" is not a safety property.

## 6. Data ownership

| Data | Store | Why |
|---|---|---|
| Orders, ledger, holdings, jobs, audit, credentials (ciphertext), tenancy | **Postgres** | Exact `numeric`, cross-table transactions, real constraints, `SKIP LOCKED` |
| Rate-limit buckets, hot metadata, candle slices, session lookups | **Redis** | All reconstructible |
| Raw exchange response bodies (forensics), notification templates, UI preferences | Postgres `jsonb` | No invariant worth enforcing |

**The rule for money data: if losing it or getting it slightly wrong costs a customer money, it is a Postgres row with constraints, in minor units or exact decimals, written in a transaction with whatever else must be true at the same time.** Nothing authoritative ever lives only in Redis.

## 6a. The read/display boundary

Decided 2026-09-05. This is a **scope decision, not a legal workaround**, and it is the single largest simplification in the plan.

Tradex is an execution product, not a reporting product. Its job is to place buys and sells across many accounts at once. P&L, charts and portfolio analytics are things a customer can already see in the CoinDCX app, so v1 does not rebuild them - and dropping them removes almost the whole of clause 2.3(c)'s reach, because that clause restricts **display**, not reading.

```
   CoinDCX ──────────── inbound (authorised use, clause 2.1) ──────────▶ Tradex internals
     markets_details     legalise the order                              never rendered
     orderbook           price it, size it, guard slippage
     users/balances      fund check, sell-all quantity
     orders/status       did it fill?          ┐
     trade_history       what filled?          ├─ correctness, not reporting
                                               ┘
   Tradex ───────────── outbound (our own records only) ───────────────▶ the screen
     our orders, our fills, our quantities, our prices, our fees
     the execution report, the blotter, realised P&L from our own fills
```

| Kept - inbound reads | Why it is not optional |
|---|---|
| `markets_details` | Without `step`, precision, `min_notional` and `max_quantity_market`, we send illegally-sized orders |
| `market_data/orderbook` | There is **no notional parameter** in the API, so "₹20,000 worth" must become a quantity from a real price |
| `users/balances` | Funding check before send; the held quantity for sell-all and close-position |
| `orders/status` by `client_order_id` | The only way to resolve an ambiguous create. **P2 depends on it** |
| `orders/trade_history` | The only market-agnostic view; detects fills we did not cause. **P1 and P3 depend on it** |

| Dropped from v1 - outbound display | Consequence |
|---|---|
| Price chart, depth panel, trade tape | Customer uses the CoinDCX app for price discovery |
| Unrealised P&L, mark-to-market equity, exposure, drawdown, equity curves | No screen values a holding at a current CoinDCX price |
| Group P&L aggregation and analytics dashboards | Replaced by the blotter and the execution report |
| The numeric spread warning on the ticket | Replaced by a qualitative warning, or a refusal, from the same order-book read |

| Kept - outbound, but ours | Why it is safe |
|---|---|
| The execution report: which account filled, at what price, which were skipped and why | Built from our own order and fill records |
| The blotter | Same |
| Realised P&L, fees and estimated TDS from our own fills | Our transaction history, not Market Data |

The distinction that matters: **inbound data sizes, funds and verifies an order; outbound pixels are only ever our own records.** A CoinDCX fill price arriving in a response to *our* order is a fact about our transaction and stays displayable. A current market price used to value a holding is not.

One correctness note this does **not** relax: reading order state back is not reporting. When a create times out on account 14 of 20, `orders/status` by `client_order_id` is the only way to know whether the customer's money moved. Checking the CoinDCX app answers "what is my P&L"; it does not answer "which of my twenty accounts filled". Every reconciler loop stays.


## 7. The correctness architecture

Four mechanisms, each covering what the others cannot.

| Mechanism | What it guarantees | Where it fails alone |
|---|---|---|
| **Idempotency** - deterministic `client_order_id` (27 chars of HMAC, inside the 36-char limit), reuse rejected by CoinDCX, per-(account, market) lock | P2 | Spot only. Futures and margin have **no** client key at all |
| **Reconciliation** - Loop A `status_multiple`, Loop B `active_orders`, Loop C market-agnostic `trade_history`, Loop D `users/balances` | P1, P3 | Loops A and B can only ask about orders we remember, because `active_orders` requires a market and no order-history endpoint exists. Loop C is the only detector of activity we did not cause |
| **Audit** - append-only, `INSERT`-only grant, 5-year retention, decrypt events recorded | Attribution, dispute resolution, PMLA reconstruction | Detects nothing in real time |
| **Kill switches** - global, tenant, account, market; plus `read_only` / `cancel_only` / `frozen` modes | Bounds any failure we have not thought of | Only as good as the caps and the human who flips them |

Composed: an order is written before it is sent, keyed so a retry is safe, observed by two independent channels, recorded immutably, and bounded by a switch a customer can reach in two clicks.

**The single most dangerous failure in the whole system is the reconciler throwing on an unrecognised status string.** It stops reconciling, and everything else looks healthy. Hence `R5`/`R10`: an unknown status becomes an `UNKNOWN` state that alarms, never an exception - and alert `A3` fires on the *absence* of reconciliation progress.

## 8. Technology decisions

| Choice | Decision | Rejected | Argued in |
|---|---|---|---|
| Money store | PostgreSQL 16+, `numeric` minor units | MongoDB - no cross-document constraints, and the ledger invariants would be application-only | `17` F2 |
| Language | TypeScript throughout, Node 24 | A Go execution service - nothing is CPU-bound at a 38 ms round trip | `17` |
| Shape | Modular monolith, 6 process types, one deployable | Microservices - would put a network boundary where we need a transaction | `17` F3 |
| Durable execution | Postgres job table + `FOR UPDATE SKIP LOCKED` | Temporal, BullMQ - a second source of truth, opaque during an incident | `08` F10 |
| Credential custody | Managed KMS envelope encryption, per-credential DEK, AAD-bound | Vault (ops burden), static app key (one leak loses all) | `07` F3 |
| Signer | Separate process from the first real-money phase; port from day one | In-process forever | `07` F5 |
| Charting | TradingView Lightweight Charts 5.2.1 (Apache-2.0, verified from `LICENSE`) | ECharts (58.9 MB, 1,347 files), Highcharts (commercial) | `13` F1 |
| Candle feed | `public.coindcx.com/market_data/candlesticks` - 9 resolutions, windowed, covers INR spot | Documented spot `candles` - 4 fixed intervals, no windowing | `03` F9 |
| Frontend | React + TypeScript + Vite, TanStack Query | Next.js - SSR buys nothing behind a login | `21` |
| Hosting | AWS `ap-south-1` (Mumbai), pinned static egress | Elsewhere - adds tens of ms and a DPDP residency argument | `17` F1 |
| Exchange coupling | `ExchangeAdapter` port; CoinDCX types confined to one package, enforced in CI | Direct coupling - CoinDCX may terminate without notice or reason (clause 5.2) | `15` F1, `17` F4 |
| Cost basis | Weighted average cost | FIFO - no tax benefit under a flat 30% no-set-off regime | `11` |
| Products in v1 | **Spot only** | Futures and margin - neither has a client-supplied idempotency key | `02`, `03` |

## 9. Cross-cutting invariants

Seventy-three numbered invariants live in the research files and each becomes a test with the same id (`18` F3). These twelve are the system-wide ones a reviewer should be able to recite.

| # | Invariant |
|---|---|
| X1 | For every `(group_trade_id, account_id, leg_seq)` at most one order exists on CoinDCX, forever |
| X2 | Every order row is committed before its create call is made |
| X3 | No child order is non-terminal without a scheduled job to advance it |
| X4 | After a restart, every `sending`/`ambiguous` order for an account is resolved before any new order for that account |
| X5 | No business rejection is ever retried |
| X6 | Every emitted quantity is exchange-legal, or no order was sent |
| X7 | No float appears anywhere between an intent and a serialised request body |
| X8 | The holdings projection is exactly reproducible by replaying the ledger |
| X9 | No `ledger_entry` or `audit_event` is ever updated or deleted; corrections are new rows |
| X10 | No cross-currency figure exists without a stored `fx_snapshot_id` |
| X11 | The reconciler never throws; it records, alarms and continues |
| X12 | No plaintext credential exists outside the signer, and no browser request reaches a CoinDCX host |

## 10. Non-goals for v1

Stated so scope creep has to argue against a written decision.

| Not in v1 | Why |
|---|---|
| Futures and margin trading | No `client_order_id`, so P2 cannot be guaranteed (`02`, `03`) |
| Leverage of any kind | Not in the brief; and it is what futures/margin exist for |
| Trading bots, DCA, grid, rule engines | Separate products, each with its own correctness burden |
| Copy trading or any discretionary feature | Changes the regulatory posture completely (`15` F6) |
| Backtesting | Needs historical infrastructure and invites advisory framing |
| A second exchange | The adapter boundary makes it possible later; doing it now doubles the correctness surface |
| Native mobile app | Responsive web; the 20-account preview table needs width (`21`) |
| Per-membership weights and caps in groups | Would introduce a second sizing basis (`19`) |
| BTC/ETH/USDC/TRX-quoted markets (34 of 999) | Would make BTC a funding currency - a different product (`10`) |
| Any form of trading advice | Deliberate, permanent (`15` F6) |
| **Price charts, depth panel, trade tape** | §6a - v1 displays no CoinDCX-derived prices; the customer uses the CoinDCX app for price discovery |
| **Unrealised P&L, mark-to-market equity, exposure, drawdown, equity curves** | §6a - all require valuing a holding at a current CoinDCX price |
| **Group P&L aggregation and analytics dashboards** | §6a - replaced by the blotter and the execution report, both built from our own records |

## 11. Contradictions found and resolved

Where the research files disagreed, this document is the tie-breaker. All four are listed in `_PROGRESS.md` for the consistency sweep.

| Disagreement | Resolution |
|---|---|
| `01` says the public candlestick endpoint serves *arbitrary* resolutions for spot pairs | **Wrong.** Live probing found a fixed whitelist: `1, 5, 15, 30, 60, 240, 480, 1D, 1M, D` accepted; `3, 7, 120, 720, 1W, W, 1440` rejected. `03` F9 is correct; fix `01` |
| `10` originally preferred the tighter-spread (USDT) market | **Reversed.** A C2C buy carries 1% TDS an INR buy does not, so an INR round trip costs ~2.4% against USDT's ~3.0%. Prefer INR (`10` F7, `11` F4) |
| `09` originally priced orders from `/exchange/ticker` | **Reversed.** `01` verified live that ticker is CDN-cached (`cf-cache-status: HIT`). Price from `market_data/orderbook` |
| `07`/`17` on exchange-side IP allowlisting | A static egress IP is worth having for the per-IP rate-limit question and the HFT route - **not** for a key allowlist, which CoinDCX's binding model makes impossible |
| `05` cross-references filenames that do not exist (`04-coindcx-rest-spot.md`, `08-order-lifecycle.md`, …) | Naming drift from an earlier numbering. Fix in the sweep |

## 12. The two questions that gate planning

Neither is an engineering choice.

1. **CoinDCX API Terms clause 2.3(c)** forbids displaying Market Data *"or any data, charts, analytics, research, or other works based on, referring to, or derived from the Market Data to any third party."* **As of the §6a scope decision this is no longer blocking**: v1 displays no CoinDCX-derived prices at all, so nothing waits on the answer. Still worth asking - it is one letter, and a permissive answer would let charts and mark-to-market analytics return in a later phase (`15` F2).
2. **Is the rate limit per API key or per IP?** Per key, and capacity scales with customers. Per IP, and the entire platform shares 960 requests/minute - roughly 2,400 idle accounts or 400 with resting orders, total. A single 20-account fan-out at a 1-second reconciler cadence would exceed the whole budget. It is a two-hour experiment with read-only calls and it must run in the first authenticated phase (`08` F1, `22` F3). **This is now the only gate inside the plan.**


## Reading order

`_PROGRESS.md` for method and the cross-cutting findings, then: `07` (credentials), `08` (the engine), `09` (the money arithmetic), `12` (reconciliation), `15` (the legal surface). `01`-`06` are reference tables to consult, not to read end to end. `DATA-MODEL.md` is the consolidated schema; `RISK-REGISTER.md`, `DECISIONS.md` and `OPEN-QUESTIONS.md` are the decision surface; `../plan/` is the build sequence.
