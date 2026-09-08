# 14 - Analytics product specification

> **SCOPE NOTE, 2026-09-05 — partially deferred.** v1 displays no CoinDCX-derived prices (`ARCHITECTURE` §6a, `DECISIONS` D51), so **14 of the 22 metrics below ship** and 8 do not. Kept: M1, M2, M5, M6 realised P&L, M10 fee drag, M11 TDS, M12, M13, M16 slippage, M17, M18, M19 group divergence, M20, M22. Dropped: **M3, M4, M7, M8, M9, M14, M15, M21** — every one requires valuing a holding at a current market price. Dashboards and equity/drawdown curves go with them; the blotter, group-trade detail and realised-P&L report stay. See `plan/phase-12-analytics.md`.
>
> **F2 is unaffected and still critical.** The capture-or-lose-forever list — decision-time mid, fx snapshot, metadata version, sizing basis, refusal reason, raw status, spread at submit — is all persisted at plan time in Phase 04 regardless. It costs nothing now and is unrecoverable later, so if the dropped metrics ever return, their inputs will exist.
>
> Everything below is retained and accurate.

Status: 2026-09-03 | track: product surface | scope: the group, account and P&L analytics the owner asked for - every metric defined as a formula over named tables, with an honest note on which are computable in v1 and which are already unrecoverable if we do not capture them now.

## Verdict

- **Define every metric as a formula over named columns, or it will mean three different things in three screens.** "Return" alone is unusable: return on what, over which window, in which currency, before or after fees and TDS? The metric table in F1 is the contract, and the UI must never compute a number that is not in it.
- **One capture decision is irreversible and must happen in the first trading phase: the decision-time mid price.** Slippage - the only honest measure of execution quality - is `fill_price` against the mid at the moment the customer pressed submit. That mid exists for a few hundred milliseconds. If `08`'s planning stage does not persist it, execution quality is permanently uncomputable, for all history, with no workaround.
- **Every performance metric is a lie if outside deposits and withdrawals are unaccounted.** A customer who wires in fresh capital and sees "return on allocated capital" jump has been misinformed by us. Any account with an unexplained `external_adjustment` (`11` F6) must have its performance metrics visibly marked approximate until it is classified. That badge is not a nicety; it is the difference between an estimate and a false claim.
- **Group P&L must always carry its valuation currency and its rate provenance.** A group of INR- and USDT-funded accounts has no natural single number. Show per-currency subtotals first, then a converted total labelled with the rate basis (`10`, `11` F8).
- **TDS is reported, never netted.** It is withheld creditable tax, not an expense (`11` F4), and our figure is an *estimate* because no API exposes it. So it gets its own report, its own label, and a pointer to the customer's authoritative CoinDCX statement.
- **The metric a customer will care about most is one no exchange screen can show them: group divergence.** Best fill versus worst fill across accounts in one group trade, and why. That is the number that justifies the product's existence, and it comes free from the execution report.
- **Snapshot, do not recompute.** Equity curves are read from stored snapshots (`11` Design). A curve recomputed from fills and current prices redraws differently every time it is viewed.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Metric authority | The F1 table is the single definition; screens reference it by id | Prevents the same word meaning different things per screen | Define metrics per screen |
| Return denominator | **Allocated capital** by default, matching the sizing basis (`09` F4) | Consistent with how the customer sized the trade | Current equity (moves), deposits-weighted (correct but unexplainable without deposit data we lack) |
| Fee and TDS treatment | Fees reduce P&L; TDS does not, and is reported separately | `11` F5, and TDS is creditable | Net both into P&L |
| Execution quality | Slippage against the **decision-time mid**, captured at submit | The only measure that reflects what the customer chose to do | Slippage against the fill-time mid (flatters us by hiding queue delay) |
| Unexplained balance deltas | Metrics for that account are badged `approximate` until classified | Honesty; and the badge creates pressure to classify | Silently absorb into performance |
| Currency | Per-currency subtotals first; converted total second, with its rate basis | A single number would hide which half of the group traded | Converted total only |
| Equity curve source | Stored snapshots | Reproducibility (`11` L10) | Recompute on read |
| Time zone | All windows are IST calendar days; timestamps stored UTC | Indian customers and the Indian financial year | UTC days (off by 5.5 h at every boundary) |
| Financial year | 1 April - 31 March, as India's tax year | TDS and 30% reporting align to it | Calendar year |
| Charts in analytics | uPlot for equity and drawdown curves; Lightweight Charts only for price | uPlot is 533 KB, MIT, and built for exactly this (`13` F1) | One library for everything |
| Export | CSV of fills, fees and TDS per financial year, in v1 | Removes a large support burden cheaply (`11` open question 4) | A formatted PDF report |

## Findings

### F1 - Metric definitions

`L` = `ledger_entry`, `C` = `child_order`, `G` = `group_trade`, `S` = `equity_snapshot`, `A` = `exchange_account`. All money in minor units; all cross-currency conversion via the stored `fx_snapshot_id` (`10`).

| id | Metric | Formula | Window | Currency | Source | v1? |
|---|---|---|---|---|---|---|
| M1 | Allocated capital | `A.allocated_capital_minor` | point in time | account's own | `A` | Yes |
| M2 | Free balance | `account_balance.free_minor` | latest observation | per currency | reconciler | Yes |
| M3 | Holdings value | `Σ qty × mark_price` over assets | latest snapshot | valuation ccy | `S` | Yes |
| M4 | Equity | `M2 + locked + M3` | latest snapshot | valuation ccy | `S` | Yes |
| M5 | Deployed capital | `Σ cost_total` over open holdings | point in time | valuation ccy | holding projection | Yes |
| M6 | Realised P&L | `Σ (proceeds − wac × qty)` over sells | any | valuation ccy | `L` fold (`11` F5) | Yes |
| M7 | Unrealised P&L | `Σ (qty × mark_price − cost_total)` | latest snapshot | valuation ccy | `S` | Yes |
| M8 | Total P&L | `M6 + M7` | any | valuation ccy | derived | Yes |
| M9 | Return on allocated capital | `M8 / M1` | any | ratio | derived | Yes, **badge if M18 > 0** |
| M10 | Fee drag | `−Σ L.delta where kind='fee'` | any | per currency | `L` | Yes |
| M11 | TDS withheld | `−Σ L.delta where kind='tds'` | financial year | per currency | `L` | Yes, **labelled estimated** |
| M12 | Win rate | `count(closed lots with pnl>0) / count(closed lots)` | any | ratio | `L` fold | Yes |
| M13 | Average win / average loss | mean positive / mean negative realised amount | any | valuation ccy | `L` fold | Yes |
| M14 | Max drawdown | `max over t of (peak(M4, ≤t) − M4(t)) / peak(M4, ≤t)` | any | ratio | `S` | Yes |
| M15 | Exposure by asset | `qty × mark_price` per asset, as a share of M4 | latest | valuation ccy | `S` | Yes |
| M16 | Slippage | `(fill_price − decision_mid) / decision_mid`, signed by side | per child order | basis points | `C` | **Only if captured at submit** |
| M17 | Fill rate | `filled_quantity / total_quantity` | per child order or aggregated | ratio | `C` | Yes |
| M18 | Unexplained delta count | `count(L where kind='external_adjustment' and unclassified)` | any | count | `L` | Yes |
| M19 | Group divergence | `(max fill_price − min fill_price) / min fill_price` across a group trade's children | per group trade | basis points | `C` | Yes |
| M20 | Group participation | `count(children filled) / count(accounts in group)` | per group trade | ratio | `C`, `G` | Yes |
| M21 | Round-trip cost | `spread + 2×fee_rate + tds_rate(market)` | per market, live | ratio | market meta + `10` F7 | Yes |
| M22 | Time to last fill | `max(C.terminal_at) − G.submitted_at` | per group trade | seconds | `C`, `G` | Yes |

Three notes on this table. **M9 is the metric most likely to mislead** - it is a return on a static, customer-typed denominator that decays (`09` F4), so it must display the denominator next to it. **M12's "closed lot"** under weighted-average cost means a sell event, not a matched purchase lot; with WAC there are no lots, so a win is a sell whose proceeds exceeded `wac × qty`. **M16 is the only one that can become permanently impossible**, which is why it appears in the phase hints as a first-phase capture requirement rather than an analytics task.

### F2 - What must be captured at trade time or lost forever

| Datum | Captured where | Why it cannot be reconstructed |
|---|---|---|
| Decision-time mid | `08` planning stage, per group trade per market | The book moves within milliseconds; no historical book snapshot exists |
| `fx_snapshot_id` | `08` planning stage | A rate resolved later would change history (`10` C5) |
| Market metadata version | `08` planning stage | `max_quantity_market` and bands move (`09` F6); a rejection cannot be explained without knowing what the limits were |
| Sizing basis and value | `09` | "Why is this quantity 0.00246?" is otherwise unanswerable |
| Refusal reason per skipped account | `08` gates | The gate inputs will have changed by the time anyone asks |
| Raw exchange status string | `12` | Vocabulary changes leave no other evidence |
| Spread at submit | orderbook read already being made for the slippage guard (`09` F8) | Free to store, impossible to recover |

Every row is cheap at write time and impossible afterwards. This table is the strongest argument in the document for building analytics capture *before* analytics screens.

### F3 - Screens

| Screen | Primary metrics | Notes |
|---|---|---|
| Group dashboard | M4, M8, M9, M15, M14 aggregated over member accounts; per-currency subtotals | Header states the group, the account count and the valuation currency |
| Account dashboard | M1 vs M2 vs M4 (the three numbers customers confuse), M8, M10, M11, M18 badge | Shows allocated capital beside real balance - the divergence nag lives here (`09` F4) |
| Trade blotter | One row per child order: account, market, side, quantity, avg price, M16, M17, fee, outcome | Filterable by group trade, account, market, outcome; the default view of "what happened" |
| Group trade detail | The execution report (`08` F7): per-account table, M19, M20, M22, skipped accounts with reasons | The screen that answers "why did account 7 get a worse price" |
| Positions | Per asset per account: qty, wac, mark, M7; group roll-up | Dust flagged as unsellable (`09` F9) |
| P&L report | M6, M7, M8, M10, M11 by date range and financial year; CSV export | Financial-year selector defaults to the current Indian FY |
| Equity curve | M4 over time from `S`, with M14 shaded | uPlot; snapshots only |

### F4 - Layouts

```
GROUP DASHBOARD  ── group: "INR majors"   12 accounts   valuation: INR ─────────
┌──────────────┬──────────────┬──────────────┬──────────────────────────────────┐
│ Equity   M4  │ Total P&L M8 │ Return   M9  │ Max drawdown            M14      │
│ ₹42,18,900   │ +₹1,84,220   │ +4.6%        │ −8.2%   (peak 14 Aug)            │
│              │              │ of ₹40,00,000│                                  │
└──────────────┴──────────────┴──────────────┴──────────────────────────────────┘
  per currency:  INR ₹38,20,100   ·   USDT 4,024.19  (₹3,98,800 @ 99.11)
┌─ equity curve (uPlot) ────────────────────────┬─ exposure M15 ────────────────┐
│                                    ╭─╮        │ BTC   38%  ████████           │
│                          ╭─────╮╭──╯ ╰──      │ ETH   21%  ████               │
│            ╭──╮╭────╮╭───╯     ╰╯             │ XRP   12%  ██                 │
│  ──────────╯  ╰╯    ╰╯                        │ cash  29%  █████              │
└───────────────────────────────────────────────┴───────────────────────────────┘
┌─ recent group trades ─────────────────────────────────────────────────────────┐
│ 04 Sep 11:02  BUY BTC  20% alloc   14/12 filled  divergence 31bp   2.4s      │
│               ⚠ 2 skipped: below min notional (1), no INR market (1)          │
└───────────────────────────────────────────────────────────────────────────────┘

ACCOUNT CARD  ── "Ravi main"  ·  INR + USDT ─────────────────────────────────────
  allocated M1  ₹5,00,000        real balance M2  ₹3,84,120   ⚠ 23% below
  equity    M4  ₹5,42,300        total P&L  M8   +₹42,300  (+8.5% of allocated)
  fees M10 ₹4,120   ·   TDS M11 ₹8,240 (estimated)   ·   ⚠ 1 unexplained delta
```

The account card deliberately puts M1 and M2 side by side with the divergence warning. Those two numbers being different is the single most common source of confusion in this product, and hiding it does not make it go away.

## Design

### Invariants

| # | Invariant |
|---|---|
| N1 | Every number rendered maps to exactly one metric id in F1 |
| N2 | Every aggregate displays its valuation currency |
| N3 | Any account with an unclassified `external_adjustment` shows `approximate` on M6-M9, M12-M14 |
| N4 | M11 is always labelled `estimated` and always links to the CoinDCX statement route |
| N5 | Re-running any report for a past window returns identical numbers (`11` L10) |
| N6 | A group aggregate states how many of the group's accounts it covers |
| N7 | No metric is computed from `/exchange/ticker` data |
| N8 | M16 renders as "not captured" for orders predating decision-mid capture - never as zero |

N8 matters because a missing slippage value rendered as `0.00%` is a false claim of perfect execution.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Decision-time mid never captured | M16 is uncomputable | Capture in the first trading phase (F2) | Execution quality permanently unmeasurable, for all history |
| Deposit inflates return | M18 > 0 with M9 jumping | N3 badge until classified | Customer believes a false performance number |
| Group total mixes currencies | Total inconsistent with subtotals | N2, per-currency first | Every group figure |
| TDS presented as fact | Mismatch against the customer's statement | N4 label | Trust, and possibly a tax filing |
| Equity curve recomputed | Chart shape changes between views | Snapshots only (`11`) | Trust in all history |
| M9 shown without its denominator | Customer reads a return on a number they forgot they typed | Always render M1 beside M9 | Misinterpretation of every account |
| Slippage shown as 0 when absent | - | N8 | A false claim of perfect fills |
| Win rate computed on orders rather than fills | Unfilled orders counted as losses | M12 counts sell events from `L` only | A materially wrong headline number |
| Blotter unpaginated | Page times out after a few thousand fills | Cursor pagination on `(occurred_at, id)` | Usability at scale |
| Skipped accounts excluded silently from averages | Group average describes a different set than the customer chose | N6 | Subtle, persistent misreading |

## Open questions for Anand

1. **Return on allocated capital, or on current equity?** M9 uses allocated capital to stay consistent with sizing, but that denominator decays and can flatter or understate badly. Recommended default: **allocated capital, always rendered with the denominator visible**, plus an equity-based variant on the same card once customers ask.
2. **What is a "win" under weighted-average cost?** With WAC there are no lots, so M12 counts sell events whose proceeds beat `wac × qty`. This differs from a lot-matched win rate and will not equal what a customer sees in a portfolio tracker. Recommended default: **define it as above and say so in a tooltip.**
3. **Should analytics include accounts the customer has since disconnected?** Excluding them flatters history; including them shows orphaned rows. Recommended default: **include with a "disconnected" marker**, because excluding them silently changes past P&L.
4. **Is a formatted tax report needed for v1, beyond CSV?** Recommended default: **CSV only in v1.** The 30%-plus-TDS regime means customers will hand data to an accountant or a tool like KoinX regardless; a bad formatted report is worse than a clean export.

## Phase hints

- **F2 is the whole point of this document arriving early.** The capture list must be implemented in the phase that sends the first order - decision-time mid, fx snapshot, metadata version, sizing basis, refusal reasons, raw status, spread. Analytics screens can come much later; the capture cannot.
- **Metric definitions (F1) belong in one module with one function per id**, so N1 is mechanically checkable and no screen can invent a variant.
- **The trade blotter and the group-trade detail screen come first** among the screens: they are what a customer needs on day one of real trading, and they are direct reads of `child_order`.
- **Equity curves wait for snapshots**, which wait for reconciliation to be trustworthy (`11`). Building them earlier guarantees rework.
- The **`approximate` badge (N3)** ships with reconciliation, not with analytics - the reconciler is what raises the condition.
- **CSV export** is a small task, worth doing in the same phase as the P&L report to pre-empt support load.

## Sources

- `08-fanout-execution-engine.md` - the execution report shape (F7), planning-stage capture points, group-trade lifecycle.
- `09-sizing-allocation-rounding.md` - the three percent bases and the allocated-capital decay (F4); persisted sizing fields; measured spreads and round-trip cost feeding M21.
- `10-multi-currency-inr-usdt.md` - `fx_snapshot`, per-currency reporting, F7's TDS asymmetry for M21.
- `11-positions-ledger-pnl.md` - the ledger schema and fold (F3, F5) behind M5-M13; `external_adjustment` behind M18 and N3; snapshots behind M4, M7, M14; the TDS estimate behind M11 and the CoinDCX statement route.
- `12-order-state-reconciliation.md` - `child_order` fields behind M16, M17, M19, M20, M22; raw status retention.
- `13-charting-live-market-data.md` - uPlot for curves, Lightweight Charts for price, and the overlays that share M16 and M19.
- `01-coindcx-spot-rest.md` - `/exchange/ticker` is CDN-cached, hence N7.
- No external sources were needed for this document; every metric is defined over our own tables.
