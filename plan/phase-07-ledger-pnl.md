# Phase 07 - Fill ledger and reconciliation

Status: **COMPLETE 2026-09-09** - migration 011, the pure fold + realised P&L, fill decomposition (TDS matrix), the idempotent ledger WRITER + account_market_seen, Loop D reconcile, the no-mark-to-market boundary, and the periodic invariant job (T07.8) are all built and gate-proven (40 checks, 2,366,146 assertions). | **rescoped 2026-09-05** by the read/display decision (`ARCHITECTURE` §6a) - mark-to-market valuation, equity snapshots and portfolio P&L are out of v1 | goal: an immutable record of what we actually did, reconciled against the exchange | depends on: 06 | implements: `11`, `12` Loop D

## Scope

**In:** the ledger of fills, fees and TDS; the holdings projection (quantity and weighted-average cost); **realised** P&L from our own fills; balance reconciliation (Loop D) with tolerance, `external_adjustment` and the `approximate` badge; `account_market_seen`; the periodic invariant check.

**Explicitly out** (§6a): mark-to-market valuation of any holding; `unrealised_pnl`; `equity_snapshot` and the equity curve; exposure and drawdown; group P&L aggregation. All of those require a current CoinDCX price on a screen, which v1 does not do.

**Still in, and worth stating plainly:** the holdings projection is **not** a reporting feature. Sell-all and close-position need a quantity, reconciliation needs something to compare against the exchange, and the ledger is the audit record. Dropping P&L reporting does not drop the books.

## Preconditions

| Precondition | How to check |
|---|---|
| Phase 06 done, rungs 1-3 passed | Evidence recorded |
| Real fills exist in `ledger_entry` | At least ten fills from rung 2 |
| Real fee rate cached per account | Non-null on the test account |

## Tasks

**T07.1 - Migration 006**
`ledger_entry` (partitioned by `occurred_at`, PK `(id, occurred_at)`, unique `(account_id, exchange_trade_id, kind, occurred_at)`), `holding`, `account_balance` extensions, `account_market_seen`. **`equity_snapshot` is not created.**
*Acceptance:* partitions pre-created; the idempotency index provably rejects a duplicate.

**T07.2 - The fold (`11` F5)**
Replay `ledger_entry` in `(occurred_at, id)` order into `holding`: `qty`, `cost_total`, `realised_pnl`. Entry fees capitalised into basis; exit fees reduce proceeds; **TDS in neither**.
*Acceptance:* a full replay reproduces the projection exactly (**L1**); `cost_total` is zero exactly when `qty` is zero (**L6**).

**T07.3 - Fill decomposition**
Each fill writes two to four entries in one transaction: asset leg, quote leg, `fee`, and `tds` where applicable - per the `11` F4 matrix: none on an INR buy, 1% on an INR sell, 1% on **both** legs of a C2C trade. TDS rows carry `estimated = true`.
*Acceptance:* an INR buy writes three rows, a C2C buy four; a test asserts `tds` never touches `cost_total` or realised P&L (**L7**).

**T07.4 - Realised P&L only**
`wac = cost_total / qty`; `realised_pnl` accumulated per sell as `proceeds − wac × qty`; `fee_drag` and `tds_withheld` as separate sums. **No `unrealised_pnl`, no mark price, no valuation.**
*Acceptance:* a hand-computed three-trade sequence matches to the paisa; a test asserts no code path reads a current market price to value a holding.

**T07.5 - Loop D and reconciliation (`11` F6)**
Per account per asset, compare the projection against `balance + locked_balance`. Tolerance = one `step` of the asset's smallest market. Explain by uningested fill or open-order lock; otherwise append `external_adjustment` with `estimated = true`, badge the account `approximate`, alarm.
*Acceptance:* a manual deposit on the test account is detected, classified as unexplained, and badges the metrics without corrupting cost basis.

**T07.6 - Conversion classification**
A `USDTINR` fill arriving in `trade_history` is classified as `conversion_in`/`conversion_out` plus a fee line, with **zero P&L** (**L8**), never as a trade.
*Acceptance:* a test asserts a conversion does not move `realised_pnl`.

**T07.7 - `account_market_seen`**
Append on first fill per `(account, market)`; maintain `first_fill_at`, `last_fill_at`, `fill_count`. The anomaly signal for the `16` F2 attack shape.
*Acceptance:* a first-ever market for an account is flagged as novel.

**T07.8 - Periodic invariant check**
A scheduled job asserting **L2** (ledger sum equals projection) and **L6** per account, alarming on failure.
*Acceptance:* deliberately corrupting a projection row causes the check to fail and alarm.

## Schema delta

Migration 006 minus `equity_snapshot`, plus a monthly partition-maintenance entry for `ledger_entry`.

## Interfaces

```
foldLedger(accountId) -> Holding[]                  # pure over fetched rows
realisedPnl(holding) -> { realised, feeDrag, tdsWithheld }
reconcileBalances(accountId) -> Reconciliation      # Loop D
```

No `computeUnrealised`, deliberately. If §6a is ever reversed, it is an additive function over the same projection.

## Verification

`checks/07-ledger-invariants.check.js` (L1-L11 over generated fill sequences, ~350), `checks/07-tds-matrix.check.js` (~40), `checks/07-realised-pnl-worked.check.js` (~50), `checks/07-loop-d.check.js` (~50), `checks/07-conversion-classification.check.js` (~25), `checks/07-no-mark-to-market.check.js` (asserts no valuation path exists, ~10). Target: **~525 assertions**.

## Definition of done

- [ ] A full ledger replay reproduces the projection exactly
- [ ] `cost_total` is zero exactly when `qty` is zero
- [ ] TDS never affects cost basis, proceeds or realised P&L, and is always labelled `estimated`
- [ ] An INR buy writes three ledger rows; a C2C buy writes four
- [ ] A hand-computed three-trade realised P&L matches to the paisa
- [ ] A manual deposit is detected, classified unexplained, and badges the account
- [ ] A `USDTINR` conversion produces zero P&L
- [ ] **No code path values a holding at a current market price** (§6a)
- [ ] The periodic invariant check fails loudly on a corrupted projection

## Phase risks

| Risk | Addressed by |
|---|---|
| R09 outside activity corrupts the books | T07.5's `external_adjustment` and the badge |
| R14 TDS mishandled | T07.3's matrix and **L7** |
| R06 silent divergence | T07.5 plus T07.8's periodic check |
| Scope creep back into valuation | T07.4's acceptance test and the §6a boundary |

## Notes for the next phase

The books are trustworthy for a single account, and they hold everything a group trade's report needs. Phase 08 multiplies the trading by twenty; the ledger needs no structural change, but the *volume* of Loop A traffic becomes the rate-limit question from G2.
