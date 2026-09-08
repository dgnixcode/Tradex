# Phase 12 - Blotter, execution history and realised P&L

Status: not started | **rescoped 2026-09-05** by the read/display decision (`ARCHITECTURE` §6a) - dashboards, mark-to-market metrics and curves are out of v1 | goal: the customer can see exactly what happened on every trade, from our own records | depends on: 07, 08

## Scope

**In:** the blotter; the permanent group-trade detail screen; realised P&L, fee drag and estimated TDS by date range and Indian financial year; CSV export; the `approximate` badge; the metric module for the subset that is computable from our own data.

**Explicitly out** (§6a): group and account dashboards; equity, unrealised P&L, exposure, drawdown, equity and drawdown curves - every metric requiring a current CoinDCX price. Also out: any tax computation (`15` F6).

**Why this is not gated.** Every number here comes from our own order and fill records. A fill price returned in response to *our* order is a fact about our transaction, not Market Data. Only valuing a holding at a *current* price crosses the line.

## Preconditions

| Precondition | How to check |
|---|---|
| Phase 07 done | Ledger invariants green; Loop D reconciling |
| Phase 08 done | Divergence and slippage populated on real reports |

## Metric subset

Of the 22 metrics in `14` F1, these survive into v1:

| Kept | Dropped (needs a current price) |
|---|---|
| M1 allocated capital · M2 free balance · M5 deployed capital (at cost) | M3 holdings value · M4 equity |
| **M6 realised P&L** · M10 fee drag · M11 TDS withheld (estimated) | M7 unrealised · M8 total P&L · M9 return on allocated capital |
| M12 win rate · M13 average win/loss | M14 max drawdown · M15 exposure by asset |
| **M16 slippage** · M17 fill rate · M18 unexplained deltas | - |
| **M19 group divergence** · M20 participation · M22 time to last fill | M21 round-trip cost (uses a live spread) |

Fourteen of twenty-two, and the four that matter most for an execution product - realised P&L, slippage, divergence and participation - are all in.

## Tasks

**T12.1 - The metric module**
One exported function per surviving metric id, each returning a value plus its currency and window. No screen computes a number itself (invariant **N1**).
*Acceptance:* a CI rule fails if a component performs arithmetic on money; every rendered number traces to a metric id; a test asserts no metric function takes a current market price as an input.

**T12.2 - The `approximate` badge (N3)**
Any account with an unclassified `external_adjustment` shows `approximate` on M6, M12 and M13.
*Acceptance:* creating an unexplained delta badges exactly those metrics and no others.

**T12.3 - Estimated and missing values (N4, N8)**
M11 (TDS) always labelled `estimated`, with a link to the CoinDCX statement route. **M16 renders "not captured" for orders predating decision-mid capture - never as zero**, because zero reads as perfect execution.
*Acceptance:* a fixture order without `decision_mid` renders "not captured".

**T12.4 - Blotter**
One row per child order: account, market, side, quantity, avg fill price, slippage, fill rate, fee, estimated TDS, outcome, refusal reason. Cursor pagination on `(occurred_at, id)`. Filterable by group trade, account, market and outcome.
*Acceptance:* 50,000 fixture rows paginate without timeout; every filter narrows correctly.

**T12.5 - Group-trade detail**
The execution report as a permanent screen: per-account table, divergence (M19), participation (M20), time to last fill (M22), skipped accounts with reasons. Identical to what Phase 08 rendered live.
*Acceptance:* reachable from the blotter and from a notification; matches the live report exactly.

**T12.6 - Realised P&L report and CSV**
Realised P&L, fee drag and estimated TDS by date range and Indian financial year (1 April - 31 March), defaulting to the current FY. CSV export of fills, fees and TDS. **No portfolio valuation section.**
*Acceptance:* re-running a past FY returns identical numbers (**N5**, **L10**); the CSV round-trips into a spreadsheet with correct types.

**T12.7 - Positions list, at cost**
Per asset per account: quantity and weighted-average cost. **No mark, no unrealised P&L, no valuation.** Dust flagged as unsellable; open orders shown against the holding they lock.
*Acceptance:* a test asserts the screen contains no field derived from a current market price.

## Schema delta

None. Reads `ledger_entry`, `child_order`, `group_trade`, `holding`.

## Verification

`checks/12-metrics.check.js` (the 14 surviving metrics against fixtures, ~140), `checks/12-badges-and-labels.check.js` (N3, N4, N8, ~45), `checks/12-report-reproducibility.check.js` (N5, ~40), `checks/12-blotter-pagination.check.js` (~25), `checks/12-no-market-price.check.js` (no metric or screen takes a live price, ~15). Target: **~265 assertions**.

## Definition of done

- [ ] Every rendered number maps to exactly one metric id
- [ ] No component performs money arithmetic (CI-enforced)
- [ ] **No metric or screen consumes a current market price** (§6a)
- [ ] Unexplained deltas badge exactly M6, M12 and M13
- [ ] TDS always labelled `estimated` with the statement link
- [ ] Missing slippage renders "not captured", never 0.00%
- [ ] Re-running a past financial year returns identical numbers
- [ ] The blotter paginates 50,000 rows without timeout
- [ ] Group-trade detail matches the live report exactly

## Phase risks

| Risk | Addressed by |
|---|---|
| R09 misleading numbers from outside activity | T12.2's badge - the honest option |
| R14 TDS presented as fact | T12.3's label and link |
| False claim of perfect execution | T12.3's "not captured" |
| Metric drift across screens | T12.1's single module and N1 |
| Scope creep back into valuation | T12.1 and T12.7's acceptance tests |

## Notes for the next phase

This is the last customer-facing surface in v1. If clause 2.3(c) comes back permissive, the eight dropped metrics and the dashboards are additive over the same tables - `research/14-analytics-product-spec.md` retains their full definitions.
