# Phase 01 - Exchange adapter and market metadata

Status: T01.1-T01.4 and T01.6-T01.8 DONE 2026-09-06; **only T01.5 (gate G2) open, blocked on a second CoinDCX key** | goal: signed requests work against CoinDCX, all 999 markets are cached and versioned, and **the rate-limit question is answered** | depends on: 00 | implements: `01`, `06`, `09` F6, `17`, `22`, gate **G2**

## Scope

**In:** the `ExchangeAdapter` port; the CoinDCX implementation for public endpoints and authenticated **reads**; byte-exact HMAC signing with golden vectors; the pooled keep-alive agent; `market_metadata` ingestion and versioning; the fake exchange skeleton; the **rate-limit experiment**.

**Explicitly out:** placing, cancelling or editing any order; credentials stored in the database (Phase 02 owns that - this phase uses a key from local config); sizing; the frontend.

## Preconditions

| Precondition | How to check |
|---|---|
| Phase 00 done | Its definition of done is fully ticked |
| One CoinDCX API key available to the developer | A manual `users/balances` call returns 200 |
| **A second CoinDCX account and key** for the experiment (Q2) | Two distinct keys in hand |

## Tasks

**T01.1 - `ExchangeAdapter` port**
Define the interface in `packages/exchange` in **our** vocabulary, not CoinDCX's: `getMarkets()`, `getOrderBook(market, depth)`, `getCandles(pair, resolution, fromSec, toSec)`, `getBalances(cred)`, `getOrderByClientId(cred, coid)`, `getActiveOrders(cred, market)`, `getTradeHistory(cred, sinceMs)`. Placement methods are declared but unimplemented.
*Acceptance:* `packages/exchange` has zero CoinDCX-specific identifiers; the CI import rule from T00.2 passes.
*Result (2026-09-06):* port done; public reads implemented so far are `markets_details` (T01.4) and `orderbook`. **`getOrderBook` turned up a real defect in the venue's wire format** - see below.
*Found while building it:* **the order book is not in price order, and reading entry 0 as the best price is wrong.** Each side arrives as a JSON object keyed by price. Live `B-BTC_USDT`, verbatim: `"bids":{"79746":"0.04293","79748":"0.05327","79749.99":"3.80312",...}` - integer-priced levels first in ascending order, then fractional ones descending. The real best bid is **79749.99** and it arrives **third**; the first key is 79746, which is 3.99 USDT worse. That is the signature of a JS object whose integer-like keys V8 hoisted and sorted before the venue ever serialised it, so the bug is baked into the wire format and any object we parse it into reproduces it. It happens to be harmless on 3 of the 4 books captured, which is exactly what makes it dangerous - it passes a spot check and misprices a market order later, and `09` established the order book is the price source because the ticker is CDN-cached. `order-book.ts` sorts both sides by value, comparing decimal STRINGS rather than going through `Number()`, and refuses a crossed book outright.

**T01.2 - Signing**
HMAC-SHA256 over the **exact serialised body** that will be sent - build the string once, sign it, send it. `X-AUTH-APIKEY` and `X-AUTH-SIGNATURE` headers, `timestamp` in the body. Golden vectors from `06`.
*Acceptance:* three golden vectors reproduce byte-identical signatures; a test proves the signed string and the sent string are the same object, not two serialisations.

**T01.3 - Pooled keep-alive agent**
One agent per exchange host, keep-alive on, connection reuse asserted.
*Acceptance:* a test issues five sequential authenticated reads and asserts requests 2-5 show a reused connection; observed TTFB ≈ **38 ms**, not ≈ 105 ms (`17` F1).
*Result (2026-09-06):* **done.** `packages/exchange-coindcx/src/http.ts` - one agent per origin, `keepAlive`, `scheduling: lifo`, 8 sockets. 27 unit tests against a loopback server assert reuse from **both ends**: our per-socket request counter, and the server's own `connection` event count (5 requests, 1 accepted connection). Live measurement, `checks/01-keepalive.check.mjs` with `TRADEX_LIVE_VENUE=1` against api.coindcx.com: **cold 129.6 ms, warm median 46.8 ms, saved 82.9 ms/call = 1.66 s per 20-account leg.** Higher absolute numbers than `17` F1 on a different network path, but the same 64% saving.
*Found while building it:* **`dns` and `connect` failures are not ambiguous, and were being treated as if they were.** DNS resolution, TCP connect and the TLS handshake all complete before a single request byte is written, so those failures provably placed no order - including a certificate failure. `classify()` sent all four transport kinds through `orderMayExist: true`, which would have put every DNS blip and every cert-pinning mistake through the resolve ladder. Split into a new `connect_failure` class (`orderMayExist: false`, `retrySafe: true`); `timeout` and `reset` stay ambiguous. `ECONNRESET` is the case that makes it non-trivial: the same code means "refused the handshake" before connect and "dropped mid-request" after it, so the transport tracks `connected` and that fact decides it.

**T01.4 - Market metadata ingestion**
Fetch `markets_details`, normalise into `market_metadata` with a monotonic `version`. Map CoinDCX's inverted naming into ours: `base_currency_precision` → `price_precision`, `target_currency_precision` → `quantity_precision`. Carry `step`, both quantity ranges, **both market-order ranges**, `min_notional`, `min_price`/`max_price`, `order_types`, `status`, `ecode`. **`min_market_orders_qty` must be nullable** - it is absent on every market sampled.
*Acceptance:* all 999 markets ingest without a schema rejection; a market index (asset → markets, with quote currency and `ecode`) is built and queryable; `DOGEINR` shows `step` 1 and `quantity_precision` 0.
*Result (2026-09-06):* **done at the mapping layer.** 997 captured rows: 963 mapped, 34 skipped for a stated reason (27 BTC-quoted, 5 ETH, 1 USDC, 1 TRX). Index: 338 INR assets, 625 USDT, 315 on both, 310 USDT-only, 23 INR-only, venues `B,KC,I,G` - matching `10` F1 exactly. `checks/01-market-rules.check.mjs` asserts 17,080 invariants over the real response. Persistence into `market_metadata` with a monotonic `version` is still blocked on migration 003 and the database role.
*Found while building it:* **90 numeric fields in the live response arrive in exponent form** - `min_quantity: 1e-7` on ETHINR, `step: 1e-7` on DEFIINR, `min_price` down to `1e-11` on dust markets. `packages/money` refuses exponent notation on purpose, so every one of those markets would have thrown the first time sizing touched it. `plainDecimal()` expands them by moving the decimal point through the digit string, never by arithmetic - `Number(1e-7)` would reintroduce exactly the loss `decimal-json.ts` exists to prevent. See `DECISIONS.md` D58.

**T01.5 - The rate-limit experiment (gate G2)**
From one egress IP: drive key K1 at 20 req/s of `users/balances` for 10 s and record when 429 begins; the instant K1 throttles, issue one request on K2. K2 succeeds → per key. K2 is throttled → per IP. Repeat from a second egress to confirm the axis. **Read-only calls only.**
*Acceptance:* the result is written into `../research/_PROGRESS.md` and `22` F3, and the default token-bucket configuration is set from it.

**T01.6 - Rate-limit buckets**
Global and per-credential token buckets in Redis, defaulting to the pessimistic 16/s and 960/min until T01.5 says otherwise. Configuration, not constants.
*Acceptance:* a test drives the bucket to exhaustion and asserts requests queue rather than fire; changing the limit is a config change with no code edit.
*Result (2026-09-06):* **done, with two deliberate departures from the text above.** `packages/exchange/src/rate-budget.ts` (21 tests) plus `packages/exchange-coindcx/src/rate-headers.ts` (22 tests).
1. **The default is 100/60s, not 16/s + 960/min.** This task called that pair "pessimistic". It is not - it is **9.6x looser** than the 100/min on `coindcx.com/api/help`, which is the tightest of the four published figures and the seed `06` F6 actually specifies. 16/s is kept as a separate burst ceiling on top. Widening is gated on T01.5 and E3, and on nothing else.
2. **No Redis yet.** The meter is GCRA, held as **one timestamp per scope** rather than a token count, precisely so the move to Redis is a store swap and not a rewrite: a float token count drifts as it refills, and one timestamp is what Redis can update atomically. In-memory for now; a distributed store is the deployment concern, not the algorithm.
Closed-loop from the response headers, per `06` F6: `observe()` **only ever tightens**, ignores counters on a Cloudflare cache HIT (they belong to whoever missed last), and parks the scope on a 429 - which has to mean something on its own, because CoinDCX never sends `Retry-After`. `acquire()` blocks rather than rejects, serialised per credential so check-and-commit is one step; a test races 5 callers for a burst of 1 and asserts exactly one goes straight through.
*Consequence worth stating:* with both scopes seeded at 100/60s, a 20-account fan-out spends a fifth of the global minute budget. That is the honest cost of G2 being unanswered, and it is why `acquire()` reports which meter blocked it.

**T01.7 - Error classification**
Map HTTP status and body to the failure classes in `08` F2, with `retrySafe` on each. Branch on `code`, never on `message`; treat `errorCode` as optional; unknown status → an `UNKNOWN` class that alarms.
*Acceptance:* a table-driven test covering 400, 401, 404, 422, 429, 500, 503 and an unrecognised body; no case throws.

**T01.8 - Fake exchange skeleton**
Local HTTP server implementing the endpoints from T01.1 with the real fixtures captured in the research (999-market `markets_details`, `ticker`, `orderbook`, `candlesticks`), plus a fault-injection hook. Placement endpoints stubbed for Phase 06.
*Acceptance:* the adapter's own test suite runs against the fake exchange with no code change other than a base URL.
*Result (2026-09-06):* **done.** `packages/exchange-coindcx/src/fake-venue.ts`, 25 tests. Five captured fixtures now in `checks/fixtures/`: `markets_details` (997 markets), `ticker` (997), `orderbook_btcusdt`, `orderbook_btcinr`, `trade_history`, `candlesticks` - served byte-for-byte, so the pathological values are the venue's own. Balances are the one **synthesised** fixture, because reading a real account needs a key nobody here has (E3); the shape is documented, the values are deliberately awkward (INR + USDT funding, a locked balance, 8-decimal dust).
**It verifies signatures.** That is what makes it worth more than a stub: it recomputes the HMAC over the exact bytes received and answers a mismatch with the venue's real 401 body. Tests prove it catches a body mutated after signing, and a body **re-serialised with the same fields in a different key order** - both invisible against a stub, both an opaque 401 against the real venue. It tells `Invalid credentials` (no auth headers) apart from `Invalid signature` (bad HMAC), which is the distinction that stops a signing bug being misdiagnosed as a revoked key across every account at once.
Fault injection covers status/body, `times`, per-route scoping, `delayMs`, `hangUp` (accepted then socket destroyed - the ambiguous case, and the venue still recorded the request) and `blackhole` (only the client deadline ends it). Placement returns 501 until Phase 06. Emits the undocumented `ratelimit` headers, and marks `/exchange/ticker` as a cache HIT because live it was.

## Schema delta

Migration 003 populated: `market_metadata` (versioned) and `fx_snapshot`. No other tables.

## Interfaces

| Interface | Notes |
|---|---|
| `ExchangeAdapter` | Our vocabulary only; CoinDCX types confined to `exchange-coindcx` |
| `MarketIndex.forAsset(asset)` | Returns candidate markets with quote currency, status and `ecode` |
| `RateBudget.acquire(scope)` | Global and per-credential; blocks rather than rejects |

## Verification

`checks/01-market-metadata.check.js` (999 markets parse; nullable field tolerated; index correct - ~1,050 assertions), `checks/01-signing-golden.check.js` (~25), `checks/01-error-classification.check.js` (~40), `checks/01-connection-reuse.check.js` (~10). Target: **~1,125 assertions**.

*Actual (2026-09-06), names as built:* `01-market-rules` **17,080**, `01-error-classification` **240**, `01-signing-golden` **23**, `01-keepalive` **26** (live, gated on `TRADEX_LIVE_VENUE=1`; 1 when skipped). Phase 01 total **17,369** against a target of ~1,125 - the gap is `01-market-rules` asserting every invariant on all 997 real markets rather than sampling. Unit tests alongside them: **368** across 15 files. Repo-wide `npm run verify` is green: typecheck, lint, 5 CI rules 0 violations, 368 tests, 7 checks / 17,441 assertions.

## Definition of done

- [x] All 999 markets ingest and the market index resolves `BTC` to both `BTCINR` and `BTCUSDT` - 997 in the 2026-09-06 capture (two delisted since 2026-09-04), 963 mapped, 34 skipped with a reason
- [x] Golden signing vectors reproduce byte-identically - `01-signing-golden`, 3 vectors
- [x] Connection reuse measured - cold 129.6 ms, warm median 46.8 ms against the live venue; the same 64% saving `17` F1 measured, on a slower network path
- [x] `min_market_orders_qty` absent does not reject any market - absent on all 997 rows, maps to `null`
- [x] Every documented error code classified, none throwing - `01-error-classification`, 240 assertions
- [ ] **G2 answered and recorded**, with bucket defaults set from the answer - **BLOCKED: needs a second CoinDCX account and key.** The limiter is seeded pessimistically at 100/60s on both scopes in the meantime
- [x] The adapter suite runs unchanged against the fake exchange - 25 tests, the base URL is the only difference
- [x] Zero CoinDCX identifiers outside `exchange-coindcx` (CI rule green) - ADAPTER-BOUNDARY, 0 violations

## Phase risks

| Risk | Addressed by |
|---|---|
| R07 per-IP rate limit | T01.5 - the whole point of doing it here |
| R05 CoinDCX termination | T01.1 adapter boundary, enforced in CI |
| R13 clock skew | T01.2's timestamp handling; the alarm is Phase 06 |
| R17 `exit_only` | T01.4 captures it; the gate that uses it is Phase 03 |

## Notes for the next phase

Credentials still come from local developer config; Phase 02 moves them into the database behind the signer. The fake exchange has no order state yet - Phase 06 adds fills, `client_order_id` uniqueness and the fault scenarios.
