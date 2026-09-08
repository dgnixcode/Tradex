# Phase 03 - Sizing and legalisation

Status: **COMPLETE 2026-09-07** - T03.1-T03.9 done, `npm run verify` green (16 checks, 2,276,929 assertions, 425 unit tests, 7 CI rules) | goal: one pure function turns any intent into an exchange-legal quantity or a named refusal, proven across all live markets | depends on: 00, 01 | implements: `09`, `10` F3, `18` F4

## Scope

**In:** `packages/sizing` - the six intent modes, market resolution per account, the effective-minimum maximum, floor-to-step rounding, fee and TDS holdback, the ten-step legalisation, refusal codes; `fx_snapshot` writing; the 999-market property suite.

**Explicitly out:** anything with I/O. No database reads, no HTTP, no clock, no random. Inputs are values; outputs are values. Also out: gates that need live state (balance freshness, kill switches) - those are Phase 04.

## Preconditions

| Precondition | How to check | Actual |
|---|---|---|
| `market_metadata` populated and versioned | 999 rows with a version | **met 2026-09-07.** Migration 005 applied to the live database; **963 markets ingested under version 1** via `scripts/ingest-market-metadata.mjs`. Not 999 - see the count note below |
| `packages/money` complete | `checks/00-money-and-precision.check.js` green | **met by a different route.** That check does not exist; `packages/money` is covered by vitest (`money.test.ts`) and by 17,080 assertions in `01-market-rules` |
| The 999-market fixture captured for tests | Fixture file present in `checks/fixtures/` | **met.** `checks/fixtures/markets_details.json`, 997 rows |

**The "999 markets" count, corrected.** Every document in this phase says 999, from `09` F6's live measurement on 2026-09-04. The committed capture holds **997 rows**, of which the adapter maps **963** and skips **34** with a reason (quoted in BTC/ETH/USDC/TRX, or carrying no order type we represent). Those 963 collapse to **648 distinct assets** - 315 listed against both INR and USDT, 23 INR-only, 310 USDT-only. So the suites sweep 963 markets and 648 assets, and the phrase "all 999 markets" below should be read as "every market the venue lists that we can represent".

## Tasks

**T03.1 - Intent model**
`quote_amount`, `base_quantity`, `pct_allocated`, `pct_equity`, `pct_free`, `pct_position`, `sell_all`. Percentage modes carry which basis they used, and the basis is part of the output.
*Acceptance:* a type-level test proves `pct_position` and `sell_all` are unreachable for a buy.
*Result (2026-09-06):* **done.** `intents.ts` splits `BuyIntent` and `SellIntent` into separate unions - `pct_position`/`sell_all` exist only on the sell side, so a buy carrying them is a **type error**, not a runtime check. Percentages are integer basis points (2000 = 20%). `basisOf` resolves the basis, which travels into the `Sized` output.

**T03.2 - Market resolution (`10` F3)**
Given an asset and an account, choose a concrete market from the account's funding currencies. No candidates → `ASSET_NOT_LISTED`. Candidates but none funded → `NO_MARKET_FOR_FUNDING_CURRENCY`, carrying which currencies *would* work. Both available → **prefer INR** and record `currency_choice_reason`.
*Acceptance:* a USDT-only asset skips an INR-funded account with the remedy detail; an account funded in both picks INR and records why.
*Result (2026-09-07):* **done** in `market-resolution.ts`, and completed on 09-07 after a re-read of `10` F3 found three steps missing. The signature is now `resolveMarket(asset, balances, candidates)` - **balances, not a pre-computed currency list**, because F3 derives funding from balances (`funded = { ccy | free[ccy] > 0 }`) and the affordability step needs the amounts anyway; one source of truth means a declared funding currency cannot disagree with the money present. Five outcomes: `ASSET_NOT_LISTED`, `MARKET_INACTIVE`, `NO_MARKET_FOR_FUNDING_CURRENCY` (carrying `remedyCurrencies`), `INSUFFICIENT_BALANCE_EITHER_CURRENCY`, or a `ResolvedMarket` with `chosenQuote`, `alternativeQuotes` and `currencyChoiceReason`.

*Three additions, and one deliberate deviation from F3:*
- **The `status == "active"` filter was absent** - an account could have resolved to a halted market.
- **The affordability step and `INSUFFICIENT_BALANCE_EITHER_CURRENCY` were absent.** The code compares free balance against `min_notional_minor`, which is already in the quote currency's minor units, so no price and no fx conversion is involved. This is where `10` F6's asymmetry bites: Rs 100 on an INR market against 5 USDT (~Rs 496) on a C2C one, so the same account is affordable in INR and not in USDT - asserted directly.
- **Locked balance must not count as funding** (11 F1) - asserted.
- *Deviation:* F3 folds the status filter into building `candidates`, so an entirely halted asset would report `ASSET_NOT_LISTED`. That sentence would be false - the asset IS listed, it just cannot be traded now - and the customer's next action differs (wait, rather than fund another currency). The halted case therefore returns `MARKET_INACTIVE` naming the halted symbols.
- *Kept from F3 verbatim:* with exactly ONE usable market, resolution returns it **without** testing affordability, so the refusal comes from `legalise()` naming the actual quantity and limit. That is also why the code is named EITHER_CURRENCY - it is reachable only when there was a real choice and every option failed. Both halves asserted.

**T03.3 - The effective minimum**
`effective_min_qty = max(min_quantity, 10^-quantity_precision, step, min_market_orders_qty?)`, with the last term skipped when absent.
*Acceptance:* `DOGEINR` yields **1 whole DOGE** (`min_quantity` 0.001, `step` 1, precision 0); `XRPINR` yields 1; `BTCINR` yields 0.00001.
*Result (2026-09-06):* **done** in `effective-min.ts`. Every venue decimal is parsed at its **natural scale** and widened to a supported one (`scaleAtLeast`), because DOGEINR's `min_quantity` 0.001 does not fit precision 0 - parsing at market precision throws, truncating is the bug this exists to prevent. Proven by the worked-examples and sweep checks against the real fixture.

**T03.4 - Rounding**
`floor_to_step` then `floor_to_scale`, always down, both sides. No rounding mode is configurable.
*Acceptance:* a property test asserts the result is always an exact multiple of `step` with no more than `quantity_precision` decimals, over all 999 markets.
*Result (2026-09-06):* **done, and it found two venue defects.** `floorQuantity` floors to step FIRST, then to precision - in that order, because three live INR markets carry contradictory metadata (BRETTINR step 0.1 at precision 0; finding 32), and the venue's own precision is the binding constraint. The sweep asserts step-multiples by exact BigInt modulo, never `Number()`.

**T03.5 - Fee and TDS holdback**
For a buy sized from a balance-derived basis: `budget × (1 − taker_fee − tds_rate − 0.001)`, where `tds_rate` is **0 on INR markets and 0.01 on C2C markets** (`11` F4).
*Acceptance:* a `BTCUSDT` buy holds back 1.6%, a `BTCINR` buy 0.6%; a test asserts the C2C case reserves enough that notional + fee + TDS ≤ balance.
*Result (2026-09-06):* **done** in `rounding.ts`. `applyHoldback(budget, quote)`: keep = 1 − 0.005 fee − TDS − 0.001 safety, with TDS **0 on INR and 0.01 on C2C** - the asymmetry 11 F4 found. The spendable side is floored (the reserve keeps the spare sub-unit). Worked-example rows 1 and 7 assert both rates end to end: INR 0.6%, USDT 1.6% with `tdsRateApplied` recorded on the output.

**T03.6 - The ten-step legalisation**
Per `09` F5 step 5 and `03`'s ordering: active status, not `exit_only`, step and precision, min and max quantity **by order type** (`max_quantity_market` for market orders), min notional, price tick and range, holding sufficiency, balance sufficiency. Every failure returns a code plus a human sentence containing the numbers.
*Acceptance:* `BTCINR` with quantity between 0.0158 and 2 is refused as `ABOVE_MAX_QTY_MARKET` for a market order and accepted for a limit order.
*Result (2026-09-06):* **done** in `legalise.ts`. All ten steps, cheapest first; the FIRST failure is returned. Worked-example row 3 proves the exact case: Rs 10 lakh at 20% -> 0.02461 BTC refused `ABOVE_MAX_QTY_MARKET` (offending 0.02461, limit 0.0158, message offers the limit-order/split remedy) and the SAME quantity as a limit order is accepted.

**T03.7 - Refusal catalogue**
A closed enum of refusal codes, each with a message template carrying the offending value and the limit.
*Acceptance:* every code has a template; a test asserts no template omits its numbers.
*Result (2026-09-07):* **done** in `refusals.ts`. **16 codes** (T03.2 added `INSUFFICIENT_BALANCE_EITHER_CURRENCY`), each with a template interpolating `{offending}`/`{limit}`/`{detail}`; `refuse()` renders the sentence and also carries the raw `offending`/`limit`/`remedyCurrencies` as structured fields, so a machine reader never has to parse prose. Codes are categorised as `NUMERIC_REFUSALS` or `DETAIL_REFUSALS` and `checks/03-refusal-catalogue.check.mjs` (453 assertions) asserts per category that no numeric template omits its numbers and no contextual one omits its subject, that nothing renders a leftover `{placeholder}` or a doubled space even when given no input, and that both figures are plain decimals.

*The assertion worth keeping:* the check proves **every code is reachable by a real call** through `size()`, `legalise()` or `resolveMarket()` - 15 of 16 are, and the sixteenth (`PRICE_NOT_ON_TICK`) is listed as knowingly reserved because `MarketRules` carries `pricePrecision` but no tick size (CoinDCX does not publish one). A catalogue with a silently dead code reads as a guarantee nobody is providing; this way adding a tick source later is a deliberate edit to a named list.

**T03.8 - `fx_snapshot`**
Write an immutable snapshot from `USDTINR` at plan time; every cross-currency figure references one. Include the `BTCUSDT × USDTINR` versus `BTCINR` cross-check with a drift threshold.
*Acceptance:* snapshots are insert-only; the cross-check alarms above the threshold.
*Result (2026-09-07):* **done**, and it needed the schema that phase 00/01 left as an unwritten delta. Split across three places so the phase's "no I/O in sizing" rule survives: the arithmetic is pure in `packages/sizing/src/fx.ts`, the persistence is `packages/db/src/fx-repo.ts`, and the guarantees are in the schema.

- **`db/migrations/005_market_metadata_and_fx_snapshot.sql`** creates both tables. Migration 004's header had already promised this as 005 (DATA-MODEL numbers it 003; 002 and 003 went to audit partitions).
- **Both tables are append-only, enforced by a statement-level trigger** covering UPDATE, DELETE **and TRUNCATE** - and a DELETE matching zero rows still raises, because "you cannot delete here" is a clearer contract than "you happened to delete nothing". Verified on the live database, not only in a throwaway schema.
- **Venue decimals are `text` under a `venue_decimal` domain**, not `numeric`. `numeric(38,18)` would re-render `BSVINR.min_price` from `566.6666666666666` to `566.666666666600000000`, losing the venue's own literal, and the number of decimal places is itself information the sizing layer reads. The domain forbids exponent notation outright, which is a **stronger** guarantee than numeric gave: phase 01 found 90 live fields arriving as `1e-7`/`1e-11`, and `packages/money` refuses those on purpose. Money in minor units stays `numeric(38,0)`.
- **The drift figure is signed integer basis points** so the database can CHECK that `cross_alarmed` agrees with its own numbers rather than trusting the writer. Both legs are stored so the drift is recomputable.
- **`crossCheck()` rounds the drift magnitude UP** - the one deliberate exception to D17's floor-everything rule, documented in place. Flooring a drift figure understates how far apart two venues are, which hides the condition the alarm exists to catch; for a risk figure, under-reporting is the expensive direction.
- **Threshold 100bp**, justified in both directions: the measured gap is 11bp, but the BTCINR bid-ask spread alone is 42bp and DOGEINR's is 81bp (`09` F6), and the two legs come from different books - so a threshold near the spread would alarm continuously on healthy markets.
- **`market_metadata` versions come from a sequence**, not `max(version) + 1`: two concurrent ingests reading the same maximum would interleave two snapshots under one version, and a version that does not identify a single snapshot is worse than none. `loadMarketRules()` restamps `rulesVersion` to the DB version, because the number an order records must be the number that finds the snapshot again.
- **`checks/03-fx-snapshot.check.mjs`, 1,047 assertions.** All 963 markets round-trip **byte-identically** field by field; the loop closes by sizing the `09` F7 row-1 example from metadata read back out of the database and asserting both the quantity (0.00246) and `marketMetaVersion` - the only assertion that proves the version is load-bearing rather than decorative.

*Found while building it:* **`research/10` F4 states 81,602 × 99.11 = 8,087,594. The correct product is 8,087,574.22** (81,602 × 99 = 8,078,598; 81,602 × 0.11 = 8,976.22). The document's conclusion is unaffected - the gap is ~0.10%, which it rounds to 0.11% - and the exact figure is now pinned in `fx.test.ts`.

*Deliberately not done:* no fx snapshot was seeded into the live database. A stored rate is never refreshed (10 F4), so seeding a four-day-old rate would hand Phase 04 a stale snapshot to reference. Sampling belongs at plan time.

**T03.9 - The 999-market property suite**
Per `18` F4: for every market, 200 generated intents, asserting S1-S10 including monotonicity and determinism.
*Acceptance:* ~200,000 cases run in seconds with no I/O; the suite fails when rounding is flipped to nearest.
*Result (2026-09-07):* **done** as `checks/03-sizing-999-markets.check.mjs`. The 09-06 version swept 338 INR markets, buys only, and asserted the rounding-flip claim "by construction" - which is to say, not at all. Rewritten on 09-07:

**963 markets (338 INR + 625 USDT) × ~206 intents = 198,378 cases in ~2s, 2,252,939 property assertions, zero I/O** - matching `18` F4's "roughly 200,000 cases per run, seconds to execute". 87,043 sized (34,658 of them C2C), 111,335 refused, 28,890 sell cases.

*Four things the earlier sweep did not do:*
- **USDT markets are included.** 625 of the 963 are C2C and carry the 1% TDS that INR markets do not, so this is what exercises R14. The sweep asserts per fill that `tdsRateApplied` is `0` on INR and `0.01` on C2C.
- **S1 (budget containment) is asserted** - `notional × (1 + fee + tds) ≤ budget`, in exact BigInt parts-per-million. This was missing entirely and it is also **T03.5's acceptance criterion**, so that criterion was previously unproven.
- **The sell side is swept** (`pct_position`, `sell_all`, `base_quantity` against generated holdings), asserting S2: never sell more than is held.
- **S6 is asserted structurally** - every field of the serialised output must be a string, boolean or null, so a float cannot appear anywhere between intent and request body.

*The rounding-flip clause, now actually proved two ways.* Section 4 constructs, **per market**, the smallest step-aligned quantity that clears `min_notional` and adds nine tenths of a step - a value round-half-up would carry upward - then asserts the result is the floor and is strictly below what was asked for. It covers **959 of 963 markets** (4 are not constructible: an 18-place step leaves no room to express the fraction). And the flip was performed for real: patching the compiled `floorQuantity` to round half up makes the suite **fail at assertion 63**, on S1, with `PSGUSDT pct_allocated 50@7500bp: notional 5000000000 plus fee 0.005 and TDS 0.01 exceeds the budget 3750000000` - a 37.5 USDT budget turned into a 50 USDT order.

Also asserted: S3 (step multiple by exact BigInt modulo, and precision), S4 by order type, S5, S7 (a percentage of a zero balance refuses, never produces a zero-quantity order), S8 monotonicity per basis, S9 determinism (sampled every tenth case), S10 (every refusal carries a catalogued code and a sentence). Prices are the midpoint of each market's own band computed with BigInt - **no `Number()` anywhere in the checker**, since a checker less precise than the code it checks is worthless. Refusal mix over the sweep: ZERO_QUANTITY 80,140; BELOW_MIN_NOTIONAL 22,148; ABOVE_MAX_QTY_MARKET 4,047; BELOW_MIN_QTY 2,544; ABOVE_MAX_QTY 2,456.

## Schema delta

*Planned:* none beyond populating `fx_snapshot`.

*Actual:* **migration 005 had to be written**, because neither table existed. Phase 00 recorded them as "empty shells" and phase 01 recorded them as populated by "migration 003", but 002 and 003 went to the audit partitions and their schema-scope fix; migration 004's header already carried the correction forward to 005. So this phase created `market_metadata` and `fx_snapshot` (plus the `venue_decimal` domain, the `tradex_forbid_mutation()` trigger function and `market_metadata_version_seq`), applied it to the live database, and ingested 963 markets as version 1. The sizing package itself remained pure code plus tests.

## Interfaces

```
size(intent, account, marketMeta, price, balances, holdings) -> Sized | Skipped
resolveMarket(asset, account, marketIndex) -> Market | Skipped
legalise(marketMeta, side, orderType, qty, price, ltp) -> Legal | Refused
```

All three are pure. `Sized` carries `finalQuantity`, `priceUsed`, `priceSource`, `notionalMinor`, `basisUsed`, `basisAmountMinor`, `feeRateAssumed`, `tdsRateApplied`, `marketMetaVersion`.

## Verification

*Planned:* `03-sizing-999-markets` (~200,000 assertions), `03-market-resolution` (~120), `03-refusal-catalogue` (~60), `03-worked-examples` (~50). Target ~200,230.

*Actual, all green 2026-09-07* (`.mjs`, not `.js` - the repo's check convention):

| Check | Assertions | Planned |
|---|---|---|
| `03-sizing-999-markets.check.mjs` | **2,252,942** | ~200,000 |
| `03-market-resolution.check.mjs` | **4,736** | ~120 |
| `03-refusal-catalogue.check.mjs` | **453** | ~60 |
| `03-worked-examples.check.mjs` | **32** | ~50 |
| `03-fx-snapshot.check.mjs` (T03.8, unplanned) | **1,047** | - |
| **Phase 03 total** | **2,259,210** | ~200,230 |

Whole-repo `npm run verify`: **16 checks, 2,276,929 assertions**, 425 unit tests, 7 CI rules, 0 violations.

The counts run far above target because the plan estimated one assertion per generated case, while the sweep asserts up to eleven properties per case. The figure that should be compared against `18` F4 is the **case** count: 198,378, against its "roughly 200,000".

Two pre-existing checks moved as a consequence: `00-tenant-isolation` went 46 → 87 assertions (its bare-`numeric` scan had to be narrowed to exclude `::numeric` *casts*, since migration 005 range-checks text columns with them and a bare cast is the non-truncating choice; three self-tests were added so the narrowing cannot silently disarm the rule), and `01-db-live`/`02-credential-schema` picked up migration 005 in their migration loops.

## Definition of done

- [x] All eight worked examples from `09` F7 reproduce exactly, including the two refusals — `03-worked-examples`. Rows 1/2/8 pin the quantity **and** the notional in paise (0.00246 / Rs 19,870.59; 0.0123 / Rs 99,352.95; sell-all Rs 19,787.16); rows 3 and 4 are the two refusals; row 6 is exactly `112` whole DOGE. Rows 5/6/7 use a representative price in the stated range, because F7 derived those prices from already-rounded quantities — the row's demonstrated outcome is what is asserted
- [x] `DOGEINR` effective minimum is 1 DOGE — asserted from the fixture, and again in `03-fx-snapshot` from metadata that has been through the database, so storage cannot corrupt the max-of-four floor
- [x] A ₹10 lakh account at 20% on `BTCINR` market is refused as `ABOVE_MAX_QTY_MARKET` — offending `0.02461`, limit `0.0158`, message offers the limit-order/split remedy, and the same quantity **is accepted as a limit order**. Also re-proved from stored metadata
- [x] A ₹500 account at 20% is refused as `BELOW_MIN_NOTIONAL` — offending Rs 80.77 against the Rs 100 limit
- [x] C2C buys hold back 1.6%, INR buys 0.6% — worked-example rows 1 and 7, and asserted per fill across all 34,658 C2C fills in the sweep
- [x] The property suite passes over all 999 markets and fails on a deliberate rounding flip — 963 markets (every one the adapter can represent), 198,378 cases. The flip was **actually performed**: round-half-up fails the suite at assertion 63 on S1. Additionally proved per market on 959 of 963
- [x] Every refusal message contains the offending value and the limit — `03-refusal-catalogue`, asserted per category, plus every code proved reachable by a real call except the knowingly-reserved `PRICE_NOT_ON_TICK`
- [x] `packages/sizing` has zero imports with I/O (CI-enforced) — two new rules in `scripts/ci-rules.mjs`. `SIZING-PURE-NO-IO` bans `node:*`, `pg`/`kysely`/HTTP clients, `fetch`, `Date.now`, `new Date`, `Math.random`, `process.env` and `performance.now` (tests included — nothing here legitimately needs a clock). `SIZING-IMPORT-ALLOWLIST` closes the transitive hole: only `@tradex/money` and `@tradex/exchange` may be imported, so a dependency that does I/O cannot arrive without a banned token ever appearing. Both have violating fixtures under `scripts/__fixtures__/packages/sizing/`, and `ci-rules.test.mjs` requires every rule to fire against one

## Phase risks

| Risk | Addressed by |
|---|---|
| R03 wrong order size | The entire phase; the 999-market suite is the mitigation |
| R12 largest accounts fail first | T03.6's order-type-aware limits and T03.7's explanatory message |
| R14 TDS mishandled | T03.5's asymmetric holdback |
| R23 fee assumption wrong | `feeRateAssumed` recorded per trade; Phase 07 replaces it from a real fill |

## Notes for the next phase

`max_quantity_market` is depth-derived and moves, so Phase 04 must re-read metadata at plan time rather than trusting a long-lived cache. The gates that need live state (balance freshness, kill switches, in-flight checks) belong to Phase 04, which composes them around this pure core.

*Added after building it:*

- **Re-reading metadata now means writing a new version, not updating rows.** `market_metadata` is append-only. Phase 04's plan-time refresh calls `ingestMarketMetadata()`, which allocates a version from a sequence, and stamps that version on every child order. `scripts/ingest-market-metadata.mjs` skips the write when the snapshot is byte-identical to the newest stored one, so a refresh loop does not burn a version per poll — without that guard the version number stops meaning "the metadata changed", which is the only thing it is useful for.
- **`fx_snapshot` is empty and Phase 04 should be the first writer.** Sample `USDTINR` at plan time, run `crossCheck()` against a `BTCUSDT`/`BTCINR` pair from the same orderbook read, and store both together with `insertFxSnapshot()`. The staleness guard `10` F4 asks for is Phase 04's: a stored rate older than the preview freshness window invalidates the preview.
- **A fourth scale trap is waiting.** `packages/money`'s `Scale` union has gaps — no 11, nothing between 12 and 18 — and CoinDCX ships float artefacts that land in them (`min_price` with 13 to 17 places). Phase 03 hit this as a hard crash (`unsupported scale 15`) and fixed it with `scaleAtLeast`/`floorToPlaces` in `packages/sizing/src/decimal.ts`. Any new code that builds a `Scaled` from a venue decimal must go through those, never cast a place-count to `Scale`.
- **`resolveMarket` now takes balances**, so Phase 04's planner must pass `Balance[]` (locked funds excluded automatically) rather than a funding-currency list.
- **`legalise()` accepts `exitOnly` as a separate argument** because `MarketRules` carries no such field. If `exit_only` is a real venue state we must act on, it needs to reach the port first — today nothing populates it, so that gate is dormant.
- **`PRICE_NOT_ON_TICK` is reserved and unreachable** until a tick source exists. `03-refusal-catalogue` will fail if it becomes reachable without being removed from the reserved list, which is the reminder.
