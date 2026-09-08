# 00 - Research index

Status: 2026-09-03 | 22 research documents, 5 synthesis documents, 9,300+ lines. Ground truth for CoinDCX is the local dump in `_sources/`, not anyone's recollection.

## Read these five first

| File | Why it matters most |
|---|---|
| `ARCHITECTURE.md` | The authoritative design, the five properties we actually guarantee, and the two questions that gate planning |
| `OPEN-QUESTIONS.md` | 15 questions only you, a lawyer, or a measurement can answer - each with a recommended default so nothing blocks |
| `07-api-key-security.md` | CoinDCX offers **no** restricted API keys and its IP binding is unusable for us, so our encryption is the entire defence |
| `09-sizing-allocation-rounding.md` | The money arithmetic, and the live-measured limit that makes percentage sizing fail on your **largest** accounts |
| `15-india-regulatory-compliance.md` | The CoinDCX API Terms clause that could prohibit the entire UI, and the PMLA exposure of storing API keys |

## CoinDCX contract (01-06)

Reference tables extracted from the docs dump. Consult these; do not read them end to end.

| File | Answers | Headline finding |
|---|---|---|
| `01-coindcx-spot-rest.md` | The complete spot REST contract | `orders/create` takes `total_quantity` only - **no notional parameter exists**, so every "buy ₹20,000 worth" is our arithmetic. `client_order_id` is a real idempotency key |
| `02-coindcx-margin-rest.md` | The 11 margin endpoints | Margin has a native position + `exit` call, but **no idempotency key at all** - disqualified from v1 |
| `03-coindcx-futures-orders-rest.md` | Futures market data and orders | INR-margined futures exist; a signed order **expires in 10 seconds**; the candle feed is live-verified with 9 resolutions |
| `04-coindcx-futures-positions-wallets-rest.md` | Futures positions, margin, wallets, TP/SL | `positions/exit` is the real close-position primitive, if futures is ever in scope |
| `05-coindcx-websockets.md` | Spot and futures sockets | Private channels need **one socket per API key**; `data` is a stringified JSON; auth failure is a **silent disconnect** |
| `06-coindcx-auth-ratelimits-errors-tos.md` | Signing, limits, errors, API Terms | Byte-exact HMAC signing; two contradictory rate limits; and the 13 Terms clauses quoted verbatim |

## Design research (07-22)

| File | Answers | Headline decision |
|---|---|---|
| `07-api-key-security.md` | How credentials are stored and used | Managed-KMS envelope encryption, per-credential DEK, AAD-bound; separate signer process. No exchange-side control exists to lean on |
| `08-fanout-execution-engine.md` | How one intent becomes N orders | Postgres job table + `SKIP LOCKED`; deterministic `client_order_id`; write-before-send; **never blind-retry a create** |
| `09-sizing-allocation-rounding.md` | Intent → exchange-legal quantity | Exact decimals, always round **down**, refuse rather than truncate. `BTCINR` market orders cap at ~₹1.28 lakh |
| `10-multi-currency-inr-usdt.md` | INR and USDT accounts in one group | 310 of 649 assets are USDT-only, so skipping is normal. **Prefer INR** - TDS beats spread |
| `11-positions-ledger-pnl.md` | Books a customer can trust | Double-entry ledger, weighted-average cost, and TDS as its **own line** - never netted into fees |
| `12-order-state-reconciliation.md` | No lost or phantom order | REST is truth, sockets are a trigger. Four reconciler loops. The reconciler must **never throw** |
| `13-charting-live-market-data.md` | Charting stack and data path | TradingView Lightweight Charts 5.2.1 (Apache-2.0, verified). Server-side candle cache; seconds out, milliseconds back |
| `14-analytics-product-spec.md` | Group, account and P&L analytics | 22 metrics defined as formulas. Decision-time mid must be captured at submit or slippage is lost forever |
| `15-india-regulatory-compliance.md` | Legal and platform rules | Clause 2.3(c) may prohibit displaying derived Market Data; PMLA activity (iv) reads onto storing API keys |
| `16-competitive-benchmark.md` | Competitors and their incidents | 3Commas: ~100,000 keys leaked, accounts drained **by trading, not withdrawing** |
| `17-architecture-stack.md` | Stack and shape | Postgres + TypeScript, modular monolith with 6 process types, Mumbai. **37.6 ms warm vs 105 ms cold** |
| `18-testing-correctness-program.md` | How we earn the right to trade | **There is no sandbox.** A hostile fake exchange plus a rollout ladder with numeric gates |
| `19-accounts-groups-data-model.md` | The customer-facing domain | Full DDL; the typed opening balance is a sizing parameter, never a ledger entry |
| `20-ops-audit-runbook.md` | Operating it | 18 alerts - including **alert on silence** - eight runbooks, and a restore drill that must sign a live request |
| `21-frontend-ux-spec.md` | Every screen | The trade ticket has **no submit button**; the per-account preview is the safety mechanism |
| `22-nonfunctional-slos-capacity.md` | Numbers, not adjectives | If the rate limit is per IP, the platform caps at ~400 accounts with resting orders |

## Synthesis

| File | Contents |
|---|---|
| `ARCHITECTURE.md` | The authoritative design; components, flows, the correctness architecture, non-goals, and the seven inter-document contradictions resolved |
| `DATA-MODEL.md` | One consolidated physical schema, the invariants Postgres enforces, migration order, retention, and the decisions most likely to be regretted |
| `RISK-REGISTER.md` | 28 risks sorted by expected severity, plus the five that should keep you awake and what each cheaply reduces |
| `DECISIONS.md` | 50 decisions, **sorted by reversibility** so the 15 one-way doors come first |
| `OPEN-QUESTIONS.md` | 15 filtered questions with recommended defaults, and a five-item list of what to do this week |

## Method and provenance

| Item | Detail |
|---|---|
| `_sources/coindcx-docs.html` | 1.1 MB static dump of `docs.coindcx.com`, fetched 2026-09-04 |
| `_sources/coindcx-docs.txt` | **14,119 lines**, greppable. Every CoinDCX claim in these documents traces to a line range here |
| `_sources/coindcx-docs-toc.txt` | 105-section index with line numbers |
| `_sources/flat.sh START END [--json]` | Prints a line range with code samples stripped and table cells reflowed - the cheap way to read a section |
| `_sources/html2txt.mjs` | The converter. Fixed on 2026-09-04 to stop a literal `<` truncating four cells in the futures error table |
| `_PROGRESS.md` | Method notes, the 22 cross-cutting findings later work must not contradict, and known defects |

**Line-citation caveat:** the converter fix on 2026-09-04 grew the dump by 8 lines after line 9145. Citations in `04`, `05` and `06` for ranges past that point may read up to 8 lines low. They are navigation aids, not identifiers.

## What was verified live, not assumed

| Measurement | Result |
|---|---|
| `markets_details` | **999 markets**, all active. Quotes: USDT 626, INR 339, BTC 27, ETH 5, USDC 1, TRX 1 |
| Asset coverage | 316 assets on both INR and USDT; **310 USDT-only**; 23 INR-only; 649 distinct |
| `ecode` distribution | `I` 339 (CoinDCX's own INR book), `B` 376, `KC` 244, `G` 40 - these are separate venues |
| Market metadata | `BTCINR` `max_quantity_market` = **0.0158 BTC** against `max_quantity` = 2; `DOGEINR` `step` 1 with precision 0; `min_market_orders_qty` **absent on all four pairs sampled** |
| Tickers and spreads | `BTCINR` 0.42%, `XRPINR` 0.36%, `DOGEINR` 0.81%, `BTCUSDT` 0.0000%; `USDTINR` 99.11 |
| Candle endpoint | Accepts `1, 5, 15, 30, 60, 240, 480, 1D, 1M, D`; rejects `3, 7, 120, 720, 1W, W, 1440`. `from`/`to` in **seconds**, `time` in **milliseconds**. No bar cap to 10,080 bars |
| Latency to `api.coindcx.com` | **37.6 ms** warm keep-alive, 102-113 ms cold (from an Indian residential connection) |
| npm licences | `lightweight-charts` 5.2.1 Apache-2.0; `klinecharts` 10.0.3 Apache-2.0; `uplot` 1.6.32 MIT; `echarts` 6.1.0 Apache-2.0 (58.9 MB, 1,347 files) |
| Sandbox | **None.** Zero matches for sandbox, testnet, demo account or paper trading across 14,119 lines |
| Endpoint fabrication sweep | 64 distinct API paths claimed across all documents; **zero fabrications**. The five unmatched entries are path prefixes and one deliberately-invalid probe path |

## Scope change, 2026-09-05

| Change | Effect |
|---|---|
| **The read/display boundary** (`ARCHITECTURE` §6a, `DECISIONS` D51) | v1 reads CoinDCX data inbound to legalise, price, fund and verify orders; it displays **no** CoinDCX-derived prices. Charts, depth, mark-to-market P&L, exposure, drawdown, curves and dashboards are out of v1 |
| Risk **R04** (clause 2.3(c)) | Retired by scope rather than mitigation. The plan's only external gate is gone |
| `13-charting-live-market-data.md` | Deferred. Design retained in full; the order-book read and slippage guard moved into Phase 04 |
| `14-analytics-product-spec.md` | 14 of 22 metrics ship. The 8 requiring a current price do not |
| Plan | Phases 10 and 11 deferred, 07 and 12 rescoped, 04 grew. **100-125 → 85-105 developer-days** |

Both research documents remain complete and accurate - they carry scope banners, not deletions, so the dropped surface can be revived as additive work if clause 2.3(c) is ever answered permissively.

## Consistency sweep, 2026-09-04

| Defect | Status |
|---|---|
| `05` cross-referenced seven filenames that never existed | **Fixed** - remapped to the real files |
| `01` claimed the public candlestick endpoint serves arbitrary resolutions | **Fixed** - it is a fixed whitelist of nine values |
| `01` referred to "05-group-fanout… whichever track owns orchestration" | **Fixed** - now `08-fanout-execution-engine.md` |
| `10` preferred the tighter-spread market | **Fixed** - TDS asymmetry reverses it; F7 added |
| `09` priced orders from `/exchange/ticker` | **Fixed** - ticker is CDN-cached; now the order book |
| All 22 research files carry the 7-section skeleton | **Verified** 22/22 |
| All 15 phase docs carry the 6-section skeleton | **Verified** 15/15 |
| Every `NN-*.md` cross-reference resolves to a real file | **Verified** - remaining mentions are deliberate descriptions of the fixed defect |
