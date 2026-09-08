# 11 - Positions, ledger and P&L

Status: 2026-09-03 | track: books | scope: how holdings are derived when the exchange has no position object, how cost basis and P&L are computed, and why fees and the 1% TDS must each be their own ledger line.

## Verdict

- **Spot has no position object, so holdings are ours to derive - and `users/balances` will not do it.** The balance endpoint returns `[{currency, balance, locked_balance}]` and nothing else: no cost basis, no entry price, no history. `balance` is documented as *"usable balance"* and `locked_balance` as *"balance currently being used by an open order"*. So the exchange tells us **how much** but never **at what price**. Cost basis exists only in our own ledger, built from fills.
- **Build a double-entry ledger of fills; derive holdings from it; reconcile against `users/balances`.** Three layers, in that order. The ledger is the immutable record, the holding is a derived projection, and the exchange balance is the referee. When the projection and the referee disagree, the exchange wins, we alarm, and we append a correcting entry - we never edit history.
- **The 1% TDS is not a fee and must never be folded into one.** CoinDCX applies it asymmetrically: **no TDS on an INR-market buy, 1% on an INR-market sell, and 1% on *both* legs of a non-INR (C2C) market.** On a C2C buy it is charged *on top of* the notional - their example: buying 1 BTC at 40,000 USDT costs **40,520 USDT**. TDS is also creditable against the customer's annual tax liability, so it is withheld capital rather than an expense. A ledger that nets it into fees reports the wrong P&L *and* loses the number the customer needs at tax time.
- **We can compute expected TDS but cannot verify it from the API.** `orders/trade_history` returns only `fee_amount`; there is no TDS field anywhere, and the TDS certificate lives in the CoinDCX app with no API. So our TDS line is a *derived expectation* (1% of notional on the applicable legs), flagged as such, reconciled against the balance movement rather than against a reported figure. This is a real gap and the customer must be told that our TDS figure is an estimate until their statement arrives.
- **Weighted average cost, not FIFO.** Both are defensible; WAC is chosen because it is computable incrementally, survives partial fills without a lot-tracking table, and is what a customer looking at "average entry" expects. Indian VDA tax is levied on each transfer at 30% with no loss set-off, so the lot-matching precision FIFO buys us has no tax benefit here. Keep the fills, though - they are what would let us produce FIFO later if a rule change demanded it.
- **Outside activity is the thing that silently invalidates every number.** A deposit, a withdrawal or a trade the customer places directly on CoinDCX changes the balance with no fill in our ledger. Undetected, it corrupts holdings, cost basis, P&L and every analytic downstream. Detect it by balance-delta reconciliation, classify it, record it as an explicit `EXTERNAL_ADJUSTMENT`, and mark the affected metrics as approximate until the customer confirms what happened.
- **The allocated balance the customer types at onboarding is an assertion, not a fact.** Treat it as a *sizing parameter* (`09`) and never as an opening ledger entry. The opening ledger entry is the balance we actually observe.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Source of truth for quantity held | Exchange `users/balances`, reconciled | It is the only authority on what can actually be sold | Our derived holding (drifts on any outside activity) |
| Source of truth for cost basis | Our ledger of fills | The exchange does not store it | Ask the customer |
| Cost basis method | **Weighted average cost** per (account, asset) | Incremental, partial-fill friendly, matches "average entry" in the UI; no tax benefit to FIFO under a flat 30% no-set-off regime | FIFO (needs lot tracking, no upside here), LIFO (not permitted) |
| Fee treatment | Separate ledger line, in the market's quote currency | It is an expense and it must be visible as fee drag | Netted into cost basis (hides it) |
| TDS treatment | **Separate ledger line, classified as withheld tax, excluded from P&L, included in cash-flow** | It is creditable against tax, not an expense; and it is the number the customer needs for their return | Netted into fees, netted into cost basis, ignored |
| TDS value | Derived (1% of notional on applicable legs), tagged `estimated` | No API exposes it | Assume the exchange's `fee_amount` includes it |
| P&L on unfilled or refused orders | None. Only fills move the ledger | An order is not a transaction | Reserve or accrue on placement |
| Conversions (`USDTINR`) | Balance-affecting, **zero P&L**, tagged distinctly | Converting currency is not trading profit | Treat as a trade (inflates win rate and P&L) |
| Futures positions | Exchange `List Positions` is truth; store snapshots, do not derive | The exchange maintains the position and its `pnl` | Derive from fills like spot |
| Equity curve | Snapshot daily close plus intraday marks; never recompute historically | Recomputation makes yesterday's number move | Compute on read from fills + current prices |
| Valuation price for unrealised P&L | Orderbook mid at snapshot time, recorded with the snapshot | Reproducible; `/exchange/ticker` is CDN-cached and unreliable (`01`) | Ticker last price |
| Outside activity | Detect, classify, record as `EXTERNAL_ADJUSTMENT`, flag affected metrics | Silence here is what makes analytics lie | Absorb the delta into cost basis |
| Opening balance typed by the customer | A sizing parameter only (`allocated_capital`) | It is unverifiable and often wrong | An opening ledger credit |
| History mutability | Append-only. Corrections are new entries referencing the original | Audit integrity, and the customer can see what changed | Update rows in place |

## Findings

### F1 - What the exchange gives us

VERIFIED from the docs dump.

**`POST /exchange/v1/users/balances`** returns one object per currency held:

| Field | Sample | Documented meaning |
|---|---|---|
| `currency` | `"BTC"` | |
| `balance` | `1.167` | *"usable balance"* - i.e. free, excluding locked |
| `locked_balance` | `2.1` | *"balance currently being used by an open order"* |

That is the entire response. No cost basis, no average price, no acquisition date, no total. Note that **total held = `balance` + `locked_balance`**, and that a sell must be sized against `balance` alone (`09` F5).

**`POST /exchange/v1/orders/trade_history`** returns fills:

| Field | Sample | Note |
|---|---|---|
| `id` | `252949810` | Trade id, numeric |
| `order_id` | `"284195365"` | **String**, and it is the exchange order id - not our `client_order_id` |
| `side` | `"buy"` | |
| `fee_amount` | `2.9469615` | Absolute fee, in the market's **base** currency (i.e. the quote asset) |
| `ecode` | `"I"` | The venue (`10` F2) |
| `quantity` | `4.97` | |
| `price` | `100.5` | |
| `symbol` | `"USDTINR"` | The concatenated market form |
| `timestamp` | `1780415747836` | Epoch **milliseconds** |

Request parameters: `from_timestamp`, `to_timestamp`, `symbol` - all optional - plus `limit` (default and max **500**) and `timestamp`. With no `symbol` it returns fills across all markets, which makes it the only global divergence detector in the spot API (`01`).

Four gaps in this fill record shape the ledger design:

| Gap | Consequence |
|---|---|
| No `client_order_id` on the fill | Fills join to orders by the exchange `order_id`, so that id must be stored on our order row the moment we receive it |
| No `is_maker` flag | We cannot attribute a fill to the maker or taker fee rate. Fee rates can only be inferred from `fee_amount / notional` per fill |
| No fee **currency** field | Implied to be the market's quote asset. Must be derived from `symbol`, never assumed INR |
| **No TDS field** | The 1% is invisible in this feed. See F4 |

And note the sample the docs chose: `symbol: "USDTINR"`. A currency conversion arrives in `trade_history` looking exactly like an asset trade. Classification must be by market, not by feed (`10` F5).

### F2 - The three layers

```
   LEDGER            (append-only, immutable)          the record
     fills, fees, TDS, conversions, external adjustments
        │  fold
        ▼
   HOLDING           (derived projection, rebuildable)  our belief
     per (account, asset): quantity, wac_cost, realised_pnl
        │  compare
        ▼
   users/balances    (exchange)                         the referee
        └─ mismatch -> alarm + append a correcting entry, never edit
```

The projection must be **rebuildable from the ledger alone**. That single property is what makes the whole design safe: any bug in the fold is repairable by replaying, and any disagreement with the exchange is provable rather than argued about.

### F3 - Ledger schema

```sql
CREATE TYPE ledger_kind AS ENUM (
  'trade_buy','trade_sell',       -- asset legs of a fill
  'fee','tds',                    -- costs, each its own line
  'conversion_in','conversion_out',
  'external_adjustment',          -- reconciliation-detected, unexplained
  'correction'                    -- references a prior entry
);

CREATE TABLE ledger_entry (
  id              bigserial PRIMARY KEY,
  tenant_id       uuid NOT NULL,
  account_id      uuid NOT NULL REFERENCES exchange_account(id),
  kind            ledger_kind NOT NULL,

  asset           text NOT NULL,             -- 'BTC' or 'INR' or 'USDT'
  delta_minor     numeric(38,0) NOT NULL,    -- signed; + credit, - debit
  scale           smallint NOT NULL,

  -- provenance: at most one of these is set
  child_order_id  uuid REFERENCES child_order(id),
  exchange_trade_id text,
  corrects_id     bigint REFERENCES ledger_entry(id),

  -- valuation context, frozen at write time
  price           numeric(38,18),            -- fill price, in quote asset
  quote_asset     text,
  fx_snapshot_id  bigint REFERENCES fx_snapshot(id),

  estimated       boolean NOT NULL DEFAULT false,   -- true for derived TDS (F4)
  occurred_at     timestamptz NOT NULL,             -- exchange timestamp
  recorded_at     timestamptz NOT NULL DEFAULT now(),

  UNIQUE (account_id, exchange_trade_id, kind)      -- idempotent fill ingestion
);

CREATE INDEX ON ledger_entry (account_id, asset, occurred_at);
CREATE INDEX ON ledger_entry (tenant_id, occurred_at);
```

`UNIQUE (account_id, exchange_trade_id, kind)` is the whole idempotency story for ingestion: the reconciler can re-read the same `trade_history` page a hundred times and the ledger cannot double-count. Every fill produces **two to four** entries - the asset leg, the quote leg, a fee line, and a TDS line where applicable - and they are written in one transaction.

A worked example, spot buy of 0.00246 BTC at 8,077,476.1 on `BTCINR` with a 0.5% fee and no TDS:

| kind | asset | delta | note |
|---|---|---|---|
| `trade_buy` | BTC | +0.00246 | quantity acquired |
| `trade_buy` | INR | -19,870.61 | notional paid |
| `fee` | INR | -99.35 | 0.5% of notional |

The same trade on `BTCUSDT` at 81,602 for 0.00241 BTC would add a fourth line:

| kind | asset | delta | note |
|---|---|---|---|
| `trade_buy` | BTC | +0.00241 | |
| `trade_buy` | USDT | -196.66 | notional |
| `fee` | USDT | -0.98 | 0.5% |
| `tds` | USDT | **-1.97** | 1% of notional, `estimated = true` |

### F4 - TDS, in full

VERIFIED from CoinDCX's own product documentation (dated 21 Mar 2023 - `15-india-regulatory-compliance.md` must confirm it is still current).

| Product and side | TDS |
|---|---|
| Spot buy, **INR** pair | **None** |
| Spot sell, **INR** pair | 1% of transaction value, deducted from proceeds |
| Spot buy, **non-INR (C2C)** pair | **1%, charged on top of the notional**, in the quote token |
| Spot sell, non-INR (C2C) pair | 1%, deducted from proceeds, in the quote token |
| Margin long or short | 1% of **total position value including leverage**, on both opening and closing - held as extra margin |
| Lend / Earn | None |
| **Futures** | **None** |

CoinDCX's own worked examples:

| Case | Numbers |
|---|---|
| Spot sell, INR, value Rs 1,500 | TDS Rs 15 + fee 0.3% Rs 4.50 → customer receives **Rs 1,480.50** |
| Spot buy, BTC-USDT, 1 BTC at 40,000 USDT | TDS 400 + fee 120 → customer pays **40,520 USDT** |
| Spot sell, BTC-USDT, 1 BTC at 40,000 USDT | TDS 400 deducted → customer receives **39,600 USDT** |
| Margin 10x, 10,000 USDT order | Effective margin rises ~20%: 1,000 base + ~200 TDS margin (100 open, 100 close) |

Their stated reason for the C2C buy asymmetry: *"when you buy the Non-INR pair the exchange actually first sell the base pair. For eg: If you want to buy BTC with USDT, here USDT is getting sold and BTC is getting bought."* So a C2C trade is two VDA transfers and each is taxable.

Consequences for this document:

| Consequence | Where it lands |
|---|---|
| A C2C buy needs 1% **more** quote currency than the notional | Sizing holdback (`09` F5 step 2) |
| An INR round trip costs ~2.4% versus a C2C round trip's ~3.0% | Market preference (`10` F7) |
| Margin needs ~20% extra margin at 10x | A further argument against margin (`02`) |
| Futures attract no TDS at all | A real argument *for* futures, partially offsetting its idempotency gap (`03`) |
| TDS is creditable, so it is withheld capital, not an expense | Excluded from P&L, included in cash-flow and in a dedicated TDS report (`14`) |
| No API exposes TDS | Our figure is `estimated = true` and must be labelled as such in the UI |

### F5 - Cost basis and P&L, written out

Per `(account_id, asset)`, folding the ledger in `occurred_at` order. All arithmetic in exact decimals.

```
state: qty, cost_total (in quote asset), realised_pnl

on trade_buy(q, price, fee):
    qty        += q
    cost_total += q * price + fee          # fees capitalised into basis on entry
    # TDS on a C2C buy is NOT added to basis - it is withheld tax, tracked separately

on trade_sell(q, price, fee, tds):
    wac         = cost_total / qty                    # before mutation
    proceeds    = q * price - fee                     # TDS excluded here too
    realised_pnl += proceeds - (wac * q)
    cost_total  -= wac * q
    qty         -= q

wac              = qty > 0 ? cost_total / qty : 0
unrealised_pnl   = qty * mark_price - cost_total
total_pnl        = realised_pnl + unrealised_pnl
tds_withheld     = -sum(ledger.delta where kind = 'tds')      # a positive number
fee_drag         = -sum(ledger.delta where kind = 'fee')
```

Three choices in there worth defending explicitly:

| Choice | Reason |
|---|---|
| Entry fees are capitalised into cost basis; exit fees reduce proceeds | Standard practice, and it makes `wac` the true break-even price |
| TDS is in **neither** basis nor proceeds | It is not a cost of acquisition or disposal; it is tax withheld and creditable. Including it would understate P&L and double-count at tax time |
| `realised_pnl` uses WAC at the moment of the sell | Incremental, order-independent within a timestamp, and matches the displayed average entry |

### F6 - Reconciliation against the exchange

Run per account on a schedule and after every group trade.

```
for each asset in (our holdings ∪ exchange balances):
    ours     = holding.qty                                  # derived from the ledger
    theirs   = balances.balance + balances.locked_balance    # total held
    delta    = theirs - ours

    if |delta| <= tolerance(asset):                continue   # dust from step rounding
    if a fill explains it (not yet ingested):     ingest, recompute, continue
    if an open order explains the locked portion: continue

    # unexplained
    append ledger_entry(kind = 'external_adjustment', delta_minor = delta,
                        estimated = true)
    mark (account, asset) as needs_explanation
    alarm; flag every derived metric for this account as approximate
```

`tolerance(asset)` is one `step` of the asset's smallest market, because floor-to-step rounding legitimately leaves fragments (`09` F9). Anything larger is real.

The `external_adjustment` entry is deliberately *not* silent: it keeps the projection consistent with the exchange (so sizing and sell-all stay correct) while recording that the cause is unknown, so no analytic can quietly present it as trading performance. Classification comes later, from the customer or from a deposit/withdrawal record if one becomes available.

### F7 - Futures positions are different

If futures ever ship: the exchange maintains the position and computes `pnl`, `avg_entry` and liquidation price (`04`). Do not derive those - snapshot them. Store the snapshot with its `settlement_currency_conversion_price` for INR-margined positions, because that rate is the only way to express an INR-futures P&L in rupees at the time it was earned (`03`, `10` F6). Funding, at `funding_frequency` hours, is a recurring `fee`-kind ledger line, and for margin `interest_amount` is the equivalent (`02`).

### F8 - Group-level aggregation

A group holds accounts, not positions, so every group figure is a sum over accounts - and every sum crosses currencies.

| Group metric | Rule |
|---|---|
| Group holding of an asset | Sum of account quantities. Unambiguous: quantity is currency-free |
| Group average entry | **Quantity-weighted** across accounts, converted to the tenant's valuation currency at each fill's stored `fx_snapshot_id` - never at today's rate |
| Group realised / unrealised / total P&L | Sum of per-account figures, each converted at its own stored rate. The result **must** be displayed with its valuation currency |
| Group TDS withheld | Sum of `tds` lines, reported separately per currency **and** converted |
| Per-currency subtotals | Always shown before the converted total (`10`) |
| Accounts that were skipped | Counted and listed; excluded from averages, or the average silently describes a different group than the customer selected |

That last row is the subtle one. If 14 of 20 accounts traded, a "group average entry" over 14 accounts is correct but must be labelled as covering 14 of 20 - otherwise the customer compares it against a 20-account expectation.

## Design

### Invariants

| # | Invariant |
|---|---|
| L1 | The holding projection is exactly reproducible by replaying `ledger_entry` in `occurred_at`, `id` order |
| L2 | For every asset, sum of `delta_minor` over the ledger equals the projected quantity |
| L3 | No `ledger_entry` is ever updated or deleted; corrections are new rows with `corrects_id` set |
| L4 | Ingesting the same `exchange_trade_id` twice adds no rows |
| L5 | `qty` is never negative for a spot asset |
| L6 | `cost_total` is zero exactly when `qty` is zero |
| L7 | `tds` entries never affect `cost_total`, `realised_pnl` or `unrealised_pnl` |
| L8 | A conversion produces zero P&L |
| L9 | Every cross-currency figure carries an `fx_snapshot_id`; none uses a rate resolved at read time |
| L10 | Re-running any historical report returns byte-identical numbers |
| L11 | Every entry with `estimated = true` is visibly labelled wherever it is surfaced |

L6 is a cheap but powerful check: it catches the classic rounding bug where selling the entire holding leaves a fractional cost behind, which then divides by a zero quantity and produces an infinite average entry.

### Snapshots for the equity curve

| Snapshot | Cadence | Contents |
|---|---|---|
| Daily close | once per day, at a fixed IST time | per account per asset: qty, wac, mark price, valuation, realised-to-date, TDS-to-date |
| Intraday mark | every 5 minutes while positions are open | valuation only, for the live curve |
| Post-trade | after every group trade settles | full snapshot, so the trade's effect is pinned |

Snapshots are written, never computed on read. A curve recomputed from fills plus *current* prices changes shape every time it is drawn, which is the fastest way to lose a customer's trust in the numbers.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| TDS netted into fees | Fee drag looks ~2-3x too high; TDS report is empty | Separate `tds` kind (F3); L7 | Every P&L figure and the customer's tax filing |
| TDS omitted from a C2C buy's cash requirement | Order rejected for insufficient funds at exactly the balance | 1% holdback on C2C buys (`09` F5) | Every full-balance USDT buy fails |
| Outside deposit absorbed into cost basis | Average entry moves with no trade | `external_adjustment` (F6), never adjust basis | Cost basis and all P&L for that asset, permanently |
| Fill ingested twice | L2 fails; quantity doubles | `UNIQUE (account_id, exchange_trade_id, kind)` | Holdings and P&L, until repaired by replay |
| Fee currency assumed INR on a USDT market | Fees off by ~99x | Derive from `symbol` (F1) | Every USDT-market P&L |
| `trade_history` paging missed (limit 500) | Ledger sum diverges from balances | Page until exhausted; overlap windows by one page | Silent under-count of fills |
| `balance` treated as total held | Sells sized above what is free | Total = `balance` + `locked_balance`; sell against `balance` alone | Rejections, or overselling attempts |
| Equity curve recomputed on read | Yesterday's chart differs today | Snapshots (Design) | Trust in every number |
| Historical rate re-resolved | Old P&L moves | L9, `fx_snapshot_id` | Every cross-currency figure |
| Selling entire holding leaves residual cost | Infinite or absurd average entry | L6 | One asset's displayed basis |
| Conversion counted as a trade | Win rate and P&L inflated | L8, distinct ledger kinds (`10` F5) | Every performance metric |
| Customer's typed opening balance used as a ledger credit | Ledger disagrees with the exchange from day one | It is a sizing parameter only | Reconciliation alarms on every account, immediately |

## Open questions for Anand

1. **Cost basis: confirm weighted average cost.** It is what "average entry" means to most traders and it needs no lot tracking. FIFO would be required only if a customer's accountant insists on lot-level matching. Recommended default: **WAC, with fills retained** so FIFO remains derivable later.
2. **How do we present an estimated TDS figure?** Our number is computed, not reported, and it will not match a CoinDCX statement to the paisa. Recommended default: **show it, label it "estimated", and put the exchange's TDS certificate route (CoinDCX app → Account → Download Report → TDS Summary) directly in the UI** as the authoritative source.
3. **What should happen when reconciliation finds an unexplained delta?** Options: block trading on that account until explained, or record it and continue with metrics flagged approximate. Recommended default: **continue but flag**, and block only if the delta exceeds a configurable share of the account's value - blocking on every small mystery would make the product unusable, while ignoring a large one is negligent.
4. **Do we need a tax report as a v1 feature?** A 30%/1%-TDS regime with no loss set-off means customers will want per-financial-year realised gains and TDS totals. Recommended default: **a CSV export of fills, fees and TDS in v1**, a formatted report later. It is cheap and it removes a large support burden.

## Phase hints

- The **ledger schema and the fold (F3, F5)** are a pure, testable phase with no exchange dependency - build and property-test them before the first live fill exists. Every invariant L1-L11 is a property test (`18`).
- **Fill ingestion** ships with the first real order, not later: an order whose fills were never ingested is money we cannot account for.
- **Reconciliation (F6) ships with the first real order too.** This is the "no silent divergence" guarantee, and it is worthless if it arrives a phase after the trading does.
- **TDS derivation (F4)** belongs with fill ingestion, because it is computed from the same numbers and because getting it wrong quietly is worse than not having it.
- **Snapshots and the equity curve** come after reconciliation is trustworthy - they are a projection of a projection, and building them on unreconciled data guarantees rework.
- The **`external_adjustment` path** must exist from the first reconciliation run. Without it the reconciler has nowhere to put what it finds, and the pressure will be to "fix" the holding instead.

## Sources

- `_sources/coindcx-docs.txt` - `users/balances` response and the definitions of `balance` (*"usable balance"*) and `locked_balance` (*"balance currently being used by an open order"*); `orders/trade_history` request parameters and the full fill object; `trade_history` limit default and max 500; the socket balance payload confirming the same two fields.
- CoinDCX product documentation, *What is 1% TDS on crypto trade in CoinDCX Pro App* - https://coindcx.com/blog/product-features/what-is-1-percent-tds-on-crypto-trade-in-coindcx-pro-app/ - the full applicability table (INR buy none, INR sell 1%, C2C both legs 1%, margin both legs on leveraged value, Lend/Earn none, **futures none**), all four worked examples, the C2C rationale, and the TDS certificate route. Fetched with curl on 2026-09-04; `WebFetch` returns 403. Page dated 21 Mar 2023 - currency to be confirmed by `15-india-regulatory-compliance.md`.
- CoinDCX blog, *1% TDS on crypto: how it works* - https://coindcx.com/blog/cryptocurrency/one-percent-tds-on-crypto/ - CoinDCX deducts and remits TDS on the customer's behalf.
- Cross-references: `01-coindcx-spot-rest.md` (no order-history endpoint, ticker is CDN-cached), `02`/`03`/`04` (margin interest, futures positions, `settlement_currency_conversion_price`), `09-sizing-allocation-rounding.md` (step rounding, holdback, sell-all quantity source), `10-multi-currency-inr-usdt.md` (fx snapshots, conversion classification, F7 round-trip costs), `12-order-state-reconciliation.md` (the order-level reconciler this document's balance-level one complements), `14-analytics-product-spec.md` (metric definitions), `15-india-regulatory-compliance.md` (the tax regime itself), `18-testing-correctness-program.md` (L1-L11 as properties).



