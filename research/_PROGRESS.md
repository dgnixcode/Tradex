# Tradex research progress

Working notes for whoever (or whatever context) picks this up next. Updated as files land.

## Method

- Ground truth for CoinDCX is `_sources/coindcx-docs.txt` (14,119 lines, converted from the single-page `docs.coindcx.com` reference). Section index with line numbers: `_sources/coindcx-docs-toc.txt`.
- `bash _sources/flat.sh START END` prints a line range with code samples stripped and table cells reflowed to one row per line - the cheap way to read a section. `bash _sources/flat.sh START END --json` prints only the JSON response samples.
- `WebFetch` gets 403 from `coindcx.com/api/help/*` and `support.coindcx.com`; `curl -sS -L -A "Mozilla/5.0"` works.
- Live probing is allowed and encouraged for public endpoints. Anything not read in the docs or measured live is tagged UNVERIFIED.
- House style: verdict first, tables over prose, every doc uses the same skeleton (Verdict / Decisions / Findings / Design / Failure modes / Open questions for Anand / Phase hints / Sources).

## Status

| File | State |
|---|---|
| `01-coindcx-spot-rest.md` | done (922 lines) |
| `02-coindcx-margin-rest.md` | done (270 lines) |
| `03-coindcx-futures-orders-rest.md` | done (360 lines) |
| `04-coindcx-futures-positions-wallets-rest.md` | done (870 lines) |
| `05-coindcx-websockets.md` | done (902 lines) |
| `06-coindcx-auth-ratelimits-errors-tos.md` | done (940 lines) |
| `07-api-key-security.md` | done (192 lines) |
| `08-fanout-execution-engine.md` | done (238 lines) |
| `09-sizing-allocation-rounding.md` | done (208 lines) |
| `10-multi-currency-inr-usdt.md` | done (188 lines) |
| `11-positions-ledger-pnl.md` | done |
| `12-order-state-reconciliation.md` | done |
| `13-charting-live-market-data.md` | done |
| `14-analytics-product-spec.md` | done |
| `15-india-regulatory-compliance.md` | done |
| `16-competitive-benchmark.md` | done |
| `17-architecture-stack.md` | done |
| `18-testing-correctness-program.md` | done |
| `19-accounts-groups-data-model.md` | done |
| `20-ops-audit-runbook.md` | done |
| `21-frontend-ux-spec.md` | done |
| `22-nonfunctional-slos-capacity.md` | done |
| `ARCHITECTURE.md` `DATA-MODEL.md` `RISK-REGISTER.md` `DECISIONS.md` `OPEN-QUESTIONS.md` | done |
| `../plan/` | done - 16 files, 1,533 lines, phases 00-14 |
| `00-INDEX.md`, `../README.md` | done |

## Scope change 2026-09-05 — read versus display

The owner narrowed v1: **Tradex is an execution product, not a reporting product.** It reads CoinDCX data inbound (market metadata to legalise an order, order book to price it, balances to fund-check and size sell-all, `orders/status` and `trade_history` to verify it filled) and **displays no CoinDCX-derived prices outbound**. Our own orders and fills are our records, not Market Data, so the execution report, blotter and realised P&L stay.

| Consequence | Detail |
|---|---|
| Risk **R04** (API Terms clause 2.3(c)) | Retired by scope, not mitigation. The plan's only external gate is gone |
| Dropped from v1 | Charts, depth panel, trade tape, unrealised P&L, mark-to-market equity, exposure, drawdown, equity curves, analytics dashboards, group P&L aggregation |
| Kept, and unaffected | All four reconciler loops. Reading order state back is **correctness, not reporting** — `orders/status` by `client_order_id` is the only way to resolve an ambiguous create |
| `13` and `14` | Scope banners added; content retained in full so the surface can revive as additive work |
| Plan | Phase 10 deferred (order-book read + slippage guard moved to Phase 04 as T04.10/T04.11), Phase 11 deferred, Phase 07 and 12 rescoped, Phase 04 grew. **100-125 → 85-105 developer-days** |
| Authoritative sources | `ARCHITECTURE.md` §6a, `DECISIONS.md` D51 |

The only gate left inside the plan is **G2** — is the rate limit per key or per IP (`OPEN-QUESTIONS` Q2) — a two-hour experiment in Phase 01.

## Findings that later docs must not contradict

1. **Only spot has `client_order_id`.** Futures and margin have no client-supplied idempotency key at all. This is the dominant correctness constraint in the product and the main argument for a spot-only v1.
2. **Spot `orders/create` takes `total_quantity` only** - no quote-notional parameter anywhere in any product. Every "buy Rs 20,000 worth" and every percentage is converted to a quantity *by us*, then legalised against per-market constraints.
3. **CoinDCX inverts base/quote naming.** `base_currency` is the pricing asset (INR, USDT); `target_currency` is the asset being bought. So `base_currency_precision` is *price* precision and `target_currency_precision` is *quantity* precision.
4. **A signed futures order expires in 10 seconds.** Sign at send, never at enqueue.
5. **INR-margined futures exist** (`margin_currency_short_name` in `{INR, USDT}`), but fees and `ideal_margin` on them are denominated in **USDT**, with the rate in `settlement_currency_conversion_price` per order.
6. **Charting feed (live-verified 2026-09-04):** `GET public.coindcx.com/market_data/candlesticks?pair=&from=&to=&resolution=&pcode=` covers both `I-BTC_INR` spot and `B-BTC_USDT` futures. Resolutions accepted: `1, 5, 15, 30, 60, 240, 480, 1D, 1M, D`; rejected: `3, 7, 120, 720, 1W, W, 1440`. `from`/`to` are **seconds**, `time` in the response is **milliseconds**. No bar cap up to 10,080 bars. This corrects `01`, which described the resolution set as arbitrary.
7. **Three incompatible order-status vocabularies** (spot, margin, futures), with `cancelled` vs `CANCELED` differing by one letter between a futures request filter and its response. One status map per product, translated at the adapter edge, plus an `UNKNOWN` fallback that alarms instead of throwing.
8. **The exchange splits large market orders** into parts sharing `group_id`. Fill accounting aggregates by `group_id`.
9. **`exit_only` per instrument** is an exchange-side freeze that fails every account in a group at once.
10. **Rate limits are documented for spot only.** Margin, futures and the `public.coindcx.com` feeds have no published limits - measure, never assume.
11. **Two contradictory rate limits.** The SPOT table says 2000 creates/60 s, the FAQ says a global **16/sec, 960/min**. The reads are the tight ones: `active_orders` 300/60 s, `cancel_all` **30/60 s**. Whether the limit is per key or per **IP** is unknown and it decides platform capacity - the experiment is in `08` F1 and it is the highest-value early test in the project.
12. **CoinDCX offers no restricted API keys.** FAQ: no read-only APIs, *"all API users have the same level of permissions, API keys are interchangeable"*. IP binding binds to the **key-generating device's IP**, so it is unusable for a server-side platform. There is no withdrawal endpoint in the API, but `wallets/transfer` and `wallets/sub_account_transfer` exist. Our encryption is the entire defence, not defence in depth.
13. **`client_order_id` max length is 36 characters** (FAQ). Our derivation is a 27-char HMAC-based value so a retry recomputes it exactly.
14. **The effective minimum quantity is a MAXIMUM** of `min_quantity`, `10^-target_currency_precision`, `step` and (for market orders) `min_market_orders_qty`. FAQ's own example: `min_quantity` 0.0001 with precision 2 means the real floor is 0.01. Live confirmation: `DOGEINR` has `min_quantity` 0.001 but `step` 1 and precision 0, so the floor is **1 whole DOGE** - reading `min_quantity` alone is wrong by 1000x.
15. **`max_quantity_market` is the binding limit on market orders and it is far smaller than `max_quantity`.** Live: `BTCINR` `max_quantity_market` = **0.0158 BTC** (about Rs 1.28 lakh) against `max_quantity` = 2. Values look depth-derived (`122.6936997`, `5760.368664`), so they move - re-read, do not cache long. Consequence: a percentage-based group trade fails on the **largest** accounts first.
16. **`min_market_orders_qty` is documented but absent** from the live response on all four pairs sampled. Treat as optional or a strict schema rejects all 999 markets.
17. **Live market structure (2026-09-04):** 999 markets, all `active`. Quotes: USDT 626, INR 339, BTC 27, ETH 5, USDC 1, TRX 1. Asset coverage: 339 INR, 626 USDT, 316 both, **310 USDT-only**, 23 INR-only, 649 distinct. So an INR-funded account can reach 52% of assets - skipping is the normal case in a mixed-currency group.
18. **`ecode` is the venue, not a label.** Prefix counts: `I` 339 (CoinDCX's own INR book), `B` 376, `KC` 244, `G` 40 (third-party exchanges - the futures glossary's "TPE"). INR and USDT markets for one asset have independent liquidity, and outages cluster by `ecode`.
19. **Measured spreads: INR pairs are expensive.** `BTCINR` 0.42%, `XRPINR` 0.36%, `DOGEINR` 0.81%, `BTCUSDT` 0.0000%. `USDTINR` last 99.11. A `BTCINR` round trip costs roughly 1.4% with an assumed 0.5% taker fee each way.
20. **There is no fee-tier API** (FAQ) and `markets_details` carries no spot fee. The 0.5% used in worked examples is an assumption; the real rate must be read from the `fee` field on a real fill and cached per account.
21. **Spot `orders/create` has six parameters** - `market`, `total_quantity`, `price_per_unit`, `side`, `order_type`, `client_order_id`. No `time_in_force`, no `post_only`, no `reduce_only`, no notional. All slippage protection must be built by us. Response `id` is *"a positive numeric string. UUID format is no longer accepted"*.
22. **A market order can be accepted and then rejected later** if its value falls below `min_notional` (FAQ). `acked` is never `filled`.

23. **90 numeric fields arrive in exponent form, and one of them is on ETHINR.** In the captured 997-market response: `min_price` 82 times (down to `1e-11`), `min_quantity` 7 times, `step` once. Named markets: `ETHINR` `min_quantity` `1e-7`, `DEFIINR` `step` `1e-7`, `IMXINR`/`ENSINR` `1e-8`, `DAOINR`/`ARINR`/`TRBINR` `1e-9`. `packages/money` rejects exponent notation on purpose, so every one of these would have thrown the first time the sizing layer touched it - including the second-largest INR book on the venue. Expansion must move the decimal point through the digit string: `Number('5.34966666667e-7')` reintroduces the loss the decimal-safe parser exists to prevent (D58).
24. **The market list drifted by two markets in two days.** Finding 17 measured 999 markets on 2026-09-04; the 2026-09-06 capture has **997**, and the coverage counts moved with it (INR assets 339 -> 338, USDT 626 -> 625, both 316 -> 315, USDT-only unchanged at 310, INR-only unchanged at 23). Neither number is wrong. This is the concrete argument for the monotonic `version` on `market_metadata`: a rule set is a snapshot with a timestamp, not a constant, and an order sized against a stale snapshot is sized against a market that may no longer exist.

25. **Keep-alive measured against the real venue, 2026-09-06:** cold TTFB to `api.coindcx.com` **129.6 ms**, warm median **46.8 ms** over 6 sequential requests on one socket, warm range 45.6-51.8 ms. Saving **82.9 ms per call**, so a 20-account sequential leg saves **1.66 s**. Absolute numbers run ~23% above `17` F1's 105/38 ms on a different network path, but the proportion is identical: 64% of time-to-first-byte on a cold connection is handshake, not work. Reproduce with `TRADEX_LIVE_VENUE=1 node checks/run-all.mjs 01-keepalive`.

26. **The order book is not in price order, and entry 0 is not the best price.** Each side of `market_data/orderbook` is a JSON object keyed by price. Live `B-BTC_USDT`, verbatim from the wire: `"bids":{"79746":"0.04293","79748":"0.05327","79749.99":"3.80312","79749.98":...}` - integer-priced levels first in ascending order, then fractional ones descending. The true best bid is **79749.99**, arriving third; the first key is **79746**, 3.99 USDT worse (0.005%). That ordering is the signature of a JS object whose integer-like keys V8 hoisted and sorted before the venue serialised it, so it is baked into the wire format and every object we parse it into reproduces it. Of the four captured book sides, three are correct **by luck** (BTCINR has no integer-priced levels; BTCUSDT's lowest integer ask happens to be the true minimum) - which is what makes this dangerous: it passes a spot check and misprices a market order later. `09` established the order book is the price source because `/exchange/ticker` is CDN-cached, so this feeds order pricing directly. Sort by value, compare the decimal STRINGS, and refuse a crossed book.
27. **Response shapes are inconsistent about quoting numbers, within one venue.** `markets_details` and `ticker` quote their decimals (`"0.19770000"`). `market_data/trade_history` does not: `{"p":79750,"q":0.00037,"T":1788649136025,"m":false}`. `market_data/candlesticks` does not either: `{"open":79702.2,...}`. Order-book quantities are quoted but the prices are object KEYS, so quoting is not even a question there. Any consumer that assumes one convention is wrong on at least one endpoint - which is the argument for `decimal-json.ts` applying to every response rather than the ones that looked risky.

28. **An unqualified `pg_class` lookup is a cross-schema bug, and it hid in partition maintenance.** `ensure_audit_partition` in migration 002 tested `SELECT 1 FROM pg_class WHERE relname = part` — no schema qualifier, so it matched that table name anywhere in the database, returned "already exists", and created nothing. Measured: in a second schema with `public.audit_event_2026_09` present, 0 of 4 monthly partitions were created. The dangerous case is not two schemas, it is **archiving**: this function is what the monthly scheduler calls, so detaching an old partition into an `archive` schema leaves its name in `pg_class` permanently and every audit write for that month silently falls into the DEFAULT partition thereafter. Fixed in 003: resolve the parent through `search_path`, create the partition in the parent's schema, and qualify the existence test by that schema. General rule for this codebase — **`pg_class`/`pg_inherits` lookups must join `pg_namespace`**, always.
29. **A check that scans source text is testing prose unless it strips comments.** `00-tenant-isolation` asserts no float or money column type appears in the migrations, by regex over the raw SQL. Migration 003's comment contains the words "a real run", and `/\breal\b/` fired on it — reporting a D01 violation where nothing was declared. Comments are now stripped first, and the stripper has its own assertions including one that a commented `real` still exists in the raw text, so the stripper cannot quietly become dead code. Same family as the earlier finding that a `/*` inside a string ate half a file.
30. **A Node HTTP test server that simulates aborts must catch them, or it kills the worker instead of failing a test.** The fake venue ran its handler as `void this.handle(req, res)`. When a client vanishes mid-request — which the `blackhole` and `hangUp` faults exist to cause — the body iterator rejects, and the unhandled rejection took the vitest worker down with Windows exit code **0xC0000409**, reporting no failed assertion at all: just a varying pass count (346 or 363 of 368) and "Worker exited unexpectedly". Three fixes together: catch the handler's rejection, attach `error` handlers to the request and response streams, and track accepted sockets so `stop()` can destroy them (a blackholed request keeps `server.close()` pending forever). 20 consecutive clean runs afterwards.

31. **287 of 338 INR markets are LIMIT-ORDER-ONLY.** Live `order_types` on 2026-09-06: 51 INR books accept both, 287 accept `["limit_order"]` only, 0 market-only. Confirmed both in the captured fixture and against the live API minutes apart. The docs frame `market_order` as a standard spot type and every worked example assumed it was available - but a market buy on IMXINR, ENSINR, ARINR and 284 others is **rejected by the venue** with `Order type not allowed`. Product consequences: (a) the ticket UI must disable market orders per-market from metadata, not assume availability; (b) a group trade spanning limit-only books needs a limit price strategy (the plan's default has been market for immediacy - that default only works on 15% of INR books); (c) `ORDER_TYPE_NOT_ALLOWED` in the refusal catalogue is not a rare edge but a *common* outcome on INR. Found by the Phase 03 property sweep, which returned 13,776 such refusals across ~16,000 market-order intents.
32. **Three INR markets carry contradictory step/precision metadata.** BRETTINR: step 0.1 with `quantity_precision` 0. SAPIENINR: step 0.001 with precision 1. NIBIINR: step 0.0001 with precision 0. A quantity cannot simultaneously be a multiple of 0.1 and an integer, so the venue's own precision must be treated as binding and the step floor applied FIRST, then the precision floor (the other order can land off-step). Found by the sweep asserting S5 (no more decimals than precision) - 465.8 DOGE-style output on BRETTINR failed it. `floorQuantity` now floors to both, in that order.

33. **CoinDCX ships float artefacts in its price bands.** `BSVINR.min_price` is 566.6666666666666 (13 places), `SOLVINR.min_price` is 0.11983333333333333 (17), `BRISE-USDT.min_price` is 1e-11. Those place-counts (11, 13-17) do not exist in our money layer's `Scale` union, and the first property sweep died on `unsupported scale 15`. A recurring theme: **the venue serialises numbers that have passed through a float**, and any consumer that maps place-counts straight onto a fixed scale union will throw. `packages/sizing/src/decimal.ts` now widens every venue decimal to the nearest supported scale (`scaleAtLeast`) — lossless, since widening only pads zeros — and `floorToPlaces` floors to a place-count that is not itself a representable scale.

## Known defects to fix in the consistency sweep

- `05-coindcx-websockets.md` cross-references invented filenames (`04-coindcx-rest-spot.md`, `06-money-and-precision.md`, `08-order-lifecycle.md`, `09-inr-usdt-funding.md`, `10-sell-and-close-semantics.md`, `11-reconciliation.md`, `12-charting.md`) that do not match the real numbering. Rewrite to the real names.
- `01-coindcx-spot-rest.md` refers to "05-group-fanout... whichever track owns orchestration" - point it at `08-fanout-execution-engine.md`.
- `01-coindcx-spot-rest.md` claims the public candlestick endpoint serves arbitrary resolutions. Corrected in `03` F9; fix the claim in `01` too.
- Line citations in `04`, `05`, `06` may read up to 8 lines low for ranges after line 9145, because the docs converter was fixed on 2026-09-04 (a literal `<` had been truncating four cells) and the regenerated dump grew by 8 lines.
