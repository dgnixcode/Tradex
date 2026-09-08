# 10 - Multi-currency: INR and USDT

Status: 2026-09-03 | track: execution core | scope: how an account's funding currency decides which market it trades, what happens when one group mixes INR- and USDT-funded accounts, where the INR/USDT rate comes from, and why conversion must never be automatic.

## Verdict

- **Funding currency is not a display preference. It decides whether an account can trade the asset at all.** Measured live on 2026-09-04: of the 649 distinct assets with an INR or USDT market, **310 (48%) are USDT-only and 23 are INR-only**. Only 316 have both. So for roughly half of all tradable coins, an INR-funded account simply cannot participate in a group trade - not because of a balance, but because no market exists.
- **Skipping is the normal case, not an edge case.** A mixed-currency group trading a USDT-only altcoin will skip every INR account. That has to be a first-class, explained, pre-submit outcome on the confirmation screen, not an error discovered afterwards. `21-frontend-ux-spec.md` owns the presentation; the reason code is `NO_MARKET_FOR_FUNDING_CURRENCY`.
- **Resolve the market per account, never per group.** A group trade names an *asset and an intent*; each member account resolves its own concrete market from its own funding currency. One logical trade can legitimately execute on `BTCINR` for one account and `BTCUSDT` for another, at different prices, with different spreads, on different venues.
- **`ecode` reveals that INR and USDT markets are different venues, not different quotes.** The 999 markets carry four prefixes: `I` (339), `B` (376), `KC` (244), `G` (40). `I` is CoinDCX's own INR order book; the others are third-party exchanges - the futures glossary's "TPE" is *Third-Party Exchange*. So `BTCINR` and `BTCUSDT` are not two views of one book; they have independent depth, independent spreads and independent failure modes. The measured spread difference is stark: `BTCINR` **0.42%**, `BTCUSDT` **0.0000%** (`09-sizing-allocation-rounding.md` F6).
- **And yet the INR market is the cheaper one, because of TDS.** A C2C (USDT) **buy** carries 1% TDS that an INR buy does not, so a USDT round trip costs about **3.0%** against INR's **2.4%** (F7). Choosing the tighter spread would lose the customer money on every trade while appearing to be an optimisation. When an account can trade either market, prefer INR.
- **Never auto-convert.** Converting INR to USDT means placing a real order on `USDTINR` (live 99.11) at a real spread with a real fee. It changes the customer's currency exposure. It must be an explicit, separately-authorised, separately-audited action with its own confirmation - never a silent step inside a trade so that an account can participate.
- **Snapshot the rate on every trade and never recompute history.** Store `fx_rate_used`, its source and its timestamp on every child order. Historical P&L that re-derives the rate at read time moves every time it is viewed, which destroys trust faster than being wrong once.
- **INR-margined futures are a two-currency instrument even on their own.** Fees and `ideal_margin` are denominated in USDT even for INR futures, with the rate in `settlement_currency_conversion_price` per order (`03`). If futures ever ship, that field is mandatory input to P&L, not a curiosity.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Market resolution scope | Per account, from its funding currency | Accounts in one group are funded differently; a group-level market would exclude half of them arbitrarily | Resolve once per group and skip everyone who cannot use it |
| No market for an account | **Skip with `NO_MARKET_FOR_FUNDING_CURRENCY`, shown before submit** | It affects ~48% of assets for INR accounts; it must be predictable | Attempt and let the exchange reject |
| Auto-conversion to enable participation | **Never** | It is a real trade, at a real cost, changing the customer's exposure without them asking | Convert just enough INR to USDT behind the scenes |
| Explicit conversion feature | A separate action on `USDTINR` with its own confirmation, its own audit entry and its own ledger lines | Customers genuinely need it; it just must not hide inside a trade | Not offering it at all |
| Account funding currency | Derived from actual balances at onboarding and re-derived on reconciliation; **not** a field the customer types | A typed field goes stale the moment they deposit something else | Ask the customer to declare it |
| Accounts funded in both INR and USDT | Prefer the currency with sufficient free balance; if both suffice, **prefer the INR market**, and record why | The tighter USDT spread is more than cancelled by TDS: a C2C **buy** carries 1% TDS that an INR buy does not, so an INR round trip costs roughly 2.4% against a USDT round trip's 3.0% (F7) | Prefer the tighter spread (wrong - it ignores a 1% tax leg), always ask the customer (a decision that is objectively answerable) |
| Valuation currency for analytics | One per tenant, default **INR**, set once, changeable only with a full-history recompute warning | Every aggregate number needs one unit; switching it silently changes every historical figure | Per-report currency selection |
| FX rate source | `USDTINR` last traded price from `GET /exchange/ticker`, snapshotted at plan time | It is the price at which the customer could actually convert on the same venue | An external reference rate (not tradable here), the bid or ask alone (asymmetric) |
| Rate storage | `fx_rate_used`, `fx_rate_source`, `fx_rate_at` on every child order and every ledger entry that crosses currencies | Makes history immutable and explainable | Recompute at read time |
| Mixed-currency group totals | Report **per currency** first; a converted grand total is secondary and always displays its rate | A single number hides which half of the group actually traded | One converted total only |
| BTC/ETH/USDC/TRX-quoted markets (34 of 999) | Out of scope for v1 | They would require holding those assets as funding currency, which is a different product | Support all quote currencies |

## Findings

### F1 - Market coverage, measured

Live from `GET /exchange/v1/markets_details`, 2026-09-04. All 999 markets report `status: "active"`.

| Quote currency (`base_currency_short_name`) | Markets |
|---|---|
| USDT | 626 |
| INR | 339 |
| BTC | 27 |
| ETH | 5 |
| USDC | 1 |
| TRX | 1 |

Asset-level coverage, which is what actually determines whether an account can trade:

| | Count |
|---|---|
| Assets with an INR market | 339 |
| Assets with a USDT market | 626 |
| Assets with **both** | 316 |
| Assets **USDT-only** | **310** |
| Assets **INR-only** | 23 |
| Distinct assets reachable with INR or USDT funding | 649 |

So an INR-funded account can reach 339 of 649 assets (52%); a USDT-funded account can reach 626 (96%). The INR-only list includes `USDT` itself - that is the `USDTINR` market, and it is the conversion path (F4).

The practical consequence for the product: **in a group containing both INR- and USDT-funded accounts, the majority of coins will trade on only some accounts.** This is not a defect to engineer away; it is the market structure. The engineering job is to make it visible before the customer commits.

### F2 - `ecode` is the venue, and it explains the spread

The `pair` identifier is documented as *"a string created by (ecode, target_currency_short_name, base_currency_short_name)"* - for example `B-BTC_USDT`, `I-BTC_INR`, `KC-XYZ_USDT`. Measured prefix distribution across the 999 markets:

| `ecode` | Markets | Interpretation |
|---|---|---|
| `I` | 339 | CoinDCX's own INR book. Exactly matches the INR market count |
| `B` | 376 | Third-party exchange (Binance) |
| `KC` | 244 | Third-party exchange (KuCoin) |
| `G` | 40 | A fourth venue - UNVERIFIED which |

Supporting evidence that these are genuinely separate venues rather than labels: the futures glossary defines `Ets` as *"event timestamp as given by TPE"* and `bmST` as *"the timestamp at which Third-Party exchange sent this event"*, and spot `orders/create_multiple` requires `ecode: "I"` and works on INR markets only (`01`). Margin requires `ecode: "B"` (`02`).

Two consequences worth carrying into design:

1. **The same asset on INR and on USDT has independent liquidity.** Measured: `BTCINR` spread 0.42%, `BTCUSDT` spread 0.0000%. A group trade that hits both is paying two very different costs, and the execution report must show that rather than averaging it away (`14-analytics-product-spec.md`).
2. **Failure is not correlated across venues.** A third-party venue degrading affects USDT accounts while INR accounts trade normally, and vice versa. The alerting in `20-ops-audit-runbook.md` should segment by `ecode`, or an outage on 244 KuCoin-routed markets will look like a partial mystery.

### F3 - Market resolution

Pure function, no I/O, runs once per account inside the planning stage of `08-fanout-execution-engine.md`.

```
resolve_market(asset, account, balances, market_index, spreads) -> Market | Skipped

  candidates = market_index.for_asset(asset)
               .filter(m => m.status == "active")
               .filter(m => m.base_currency in {"INR","USDT"})     # v1 scope

  funded = { ccy for ccy in {"INR","USDT"} if balances.free[ccy] > 0 }

  usable = candidates.filter(m => m.base_currency in funded)

  if usable is empty:
      if candidates is empty : return Skipped(ASSET_NOT_LISTED)
      else                   : return Skipped(NO_MARKET_FOR_FUNDING_CURRENCY,
                                              detail = candidates.map(base_currency))
  if usable has one element : return it
  # both INR and USDT are funded and both markets exist
  affordable = usable.filter(m => balances.free[m.base_currency] >= required_notional(m))
  if affordable is empty    : return Skipped(INSUFFICIENT_BALANCE_EITHER_CURRENCY)
  return affordable.prefer("INR")        # TDS beats spread - see F7; record the reason
```

The `detail` on `NO_MARKET_FOR_FUNDING_CURRENCY` is what turns a skip into an explanation: *"XYZ trades only against USDT on CoinDCX; this account holds INR."* That sentence, plus a link to the conversion flow, is the entire remedy.

### F4 - The rate, and where it comes from

| Question | Answer |
|---|---|
| Source | `USDTINR` from `GET /exchange/ticker`. Live on 2026-09-04: last **99.11**, bid 99.09, ask 99.11 |
| Why this and not an external reference | It is the price at which the customer could actually convert, on the same venue, with the same fees. An external mid rate is not executable |
| Which side | `last` for valuation; `ask` when estimating a hypothetical INR→USDT conversion cost, `bid` for USDT→INR |
| When sampled | At plan time (stage 2 of the fan-out), stored on every child order and on every cross-currency ledger entry |
| Refresh cadence for display | Every few seconds alongside tickers; but a *stored* rate is never refreshed |
| Staleness guard | If the stored rate is older than the preview freshness window, the preview is invalid and must be recomputed |

A sanity check worth automating: `BTCUSDT × USDTINR` should approximate `BTCINR`. Measured: 81,602 × 99.11 = **8,087,594** against a `BTCINR` last of **8,079,092** - a 0.11% gap. A persistent gap far larger than that means either a stale ticker or a genuinely dislocated venue, and it is a cheap alarm to have.

### F5 - Conversion as an explicit action

INR↔USDT conversion is a trade on `USDTINR`, subject to every rule in `09-sizing-allocation-rounding.md`.

| Property | Rule |
|---|---|
| Trigger | Only a deliberate customer action, never implicit inside a trade |
| Authorisation | Its own confirmation screen showing amount, rate, spread, fee and the resulting balances |
| Audit | Its own audit entry, its own ledger lines, distinguishable from trading activity forever |
| Ledger treatment | Two entries (debit INR, credit USDT) plus a fee line - **not** a P&L event. Converting currency is not profit or loss |
| Reporting | Excluded from trading performance metrics; included in balance history (`14`) |
| Group conversion | Allowed as a fan-out of its own (convert 20% of INR to USDT across a group), reusing the same engine and the same per-account preview |

The ledger rule in row 5 is the one most likely to be got wrong: if a conversion is recorded as a buy of USDT, then every "win rate" and "total P&L" figure silently includes currency movements the customer never thought of as trades.

### F6 - Where else currency mixing appears

| Place | The mixing | Owner |
|---|---|---|
| INR-margined futures | Fees and `ideal_margin` are in USDT; `settlement_currency_conversion_price` carries the per-order rate | `03`, and `11-positions-ledger-pnl.md` for the P&L consequence |
| Spot fees | `fee_amount` is in the **base** currency, i.e. the quote asset - so INR for `BTCINR`, USDT for `BTCUSDT` | `11` |
| TDS at 1% | An INR obligation regardless of which currency the trade settled in (`15-india-regulatory-compliance.md`) | `11`, `15` |
| Group analytics | Sums across accounts funded in different currencies | `14` |
| `min_notional` | Rs 100 on INR markets, 5 USDT on USDT markets - roughly Rs 100 versus roughly Rs 496 | `09` |

That last row is a quietly important asymmetry: the minimum viable order on a USDT market is about **five times larger in rupee terms** than on an INR market. Small accounts will be skipped on USDT markets while passing on INR markets, which looks arbitrary unless the UI explains it.

### F7 - The INR market is cheaper, despite the wider spread

This inverts the conclusion the spread data alone suggests, and it is the single most important number in this document.

CoinDCX applies 1% TDS asymmetrically (VERIFIED, their own product documentation - full table in `11-positions-ledger-pnl.md` F4):

| Leg | INR market | USDT (C2C) market |
|---|---|---|
| Buy | **No TDS** | **1% TDS**, charged *on top of* the notional |
| Sell | 1% TDS, deducted from proceeds | 1% TDS, deducted from proceeds |

Their own worked example for the C2C buy: purchasing 1 BTC at 40,000 USDT requires **40,520 USDT** - 400 TDS plus 120 fee. The reason they give is that a C2C buy is legally two transfers: *"If you want to buy BTC with USDT, here USDT is getting sold and BTC is getting bought."*

Round-trip cost, using measured spreads and an assumed 0.5% taker fee each way:

| | INR market (`BTCINR`) | USDT market (`BTCUSDT`) |
|---|---|---|
| Spread | 0.42% | 0.0000% |
| Fees (2 legs) | 1.00% | 1.00% |
| TDS | 1.00% (sell only) | **2.00%** (both legs) |
| **Total round trip** | **≈ 2.42%** | **≈ 3.00%** |

So the venue with the visibly worse spread is the cheaper one, by roughly 0.6 percentage points per round trip. Preferring the tight spread would cost a customer money on every trade while looking like an optimisation.

Two caveats that keep this honest. TDS is **creditable against the customer's annual tax liability**, so it is a cash-flow cost rather than a permanent loss - but it is still capital withheld on every trade, which for an active trader compounds. And the 0.5% fee is our assumption (`09` F6), not a measured value; if real fees differ materially the arithmetic should be re-run, though it moves both columns equally and so does not change the ranking.

One further consequence worth carrying to `15-india-regulatory-compliance.md` and to the leverage question: **futures attract no TDS at all** per the same table. That is a genuine argument for futures beyond leverage, and it partially offsets the idempotency objection in `03-coindcx-futures-orders-rest.md`.


## Design

### Storage

```sql
-- per-account, per-currency balance snapshot (refreshed by reconciliation)
CREATE TABLE account_balance (
  account_id   uuid NOT NULL REFERENCES exchange_account(id),
  currency     text NOT NULL,
  free_minor   numeric(38,0) NOT NULL,
  locked_minor numeric(38,0) NOT NULL,
  scale        smallint NOT NULL,          -- 2 for INR, 8 for USDT
  observed_at  timestamptz NOT NULL,
  PRIMARY KEY (account_id, currency)
);

-- immutable rate snapshots; never updated, only inserted
CREATE TABLE fx_snapshot (
  id          bigserial PRIMARY KEY,
  base        text NOT NULL,               -- 'USDT'
  quote       text NOT NULL,               -- 'INR'
  rate        numeric(24,8) NOT NULL,      -- 99.11000000
  source      text NOT NULL,               -- 'coindcx_ticker_last'
  observed_at timestamptz NOT NULL
);

-- every child order records the currency facts that produced it
ALTER TABLE child_order
  ADD COLUMN quote_currency  text NOT NULL,
  ADD COLUMN market_ecode    text NOT NULL,          -- I | B | KC | G
  ADD COLUMN fx_snapshot_id  bigint REFERENCES fx_snapshot(id),
  ADD COLUMN currency_choice_reason text;            -- 'only_funded' | 'tighter_spread' | 'only_affordable'
```

`currency_choice_reason` exists so that a customer asking *"why did this account trade on the USDT market?"* gets an answer from the data rather than from someone reading the code.

### Invariants

| # | Invariant |
|---|---|
| C1 | No arithmetic ever adds two amounts whose currencies differ without an explicit `fx_snapshot_id` |
| C2 | Every stored monetary amount has an accompanying currency and scale |
| C3 | A conversion produces exactly two balance-affecting ledger entries plus a fee entry, and zero P&L |
| C4 | A child order's `quote_currency` equals the resolved market's `base_currency_short_name` |
| C5 | A historical report re-run for the same period returns identical numbers |
| C6 | An account with no funded currency that has a market for the asset is skipped, never attempted |

C5 is the one customers notice. It is guaranteed only by C1 plus never recomputing a stored rate.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Silent auto-conversion to let an account participate | Ledger shows a `USDTINR` trade nobody authorised | Conversion is a separate, explicitly-authorised action (F5) | Customer's currency exposure changed without consent - a trust-ending event |
| INR accounts silently skipped on a USDT-only coin | Customer reports "only 6 of my 20 accounts traded" | Show the skip and the reason **before** submit (F1, F3) | Looks like a broken product; affects ~48% of assets |
| Rate recomputed at read time | Yesterday's P&L differs today | Store `fx_snapshot_id`; never recompute (C1, C5) | Every historical figure becomes untrustworthy |
| Adding INR and USDT amounts as bare numbers | Totals off by ~99x | C1 and C2 enforced by the money type, not by review | Every aggregate |
| Fee currency assumed to be INR | Fee under- or over-counted by ~99x on USDT markets | `fee_amount` is in the market's base currency (F6) | P&L on all USDT markets |
| Conversion recorded as a trade | Win rate and P&L include currency moves | C3 | Every performance metric |
| Third-party venue (`B`/`KC`/`G`) degrades | Failures cluster by `ecode`, not by tenant | Segment alerts by `ecode` (F2) | Up to 376 markets at once, looking like our bug |
| `USDTINR` ticker stale or dislocated | The `BTCUSDT × USDTINR` vs `BTCINR` cross-check drifts past a threshold | Automate the cross-check (F4) | Every valuation, quietly |
| Account funding currency treated as static | Customer deposits USDT into an INR account; resolution keeps choosing INR | Re-derive from balances on every reconciliation | One account under-utilised |
| USDT `min_notional` of 5 surprises small accounts | Skips concentrated on USDT markets | Explain in rupee terms in the UI ("about Rs 496 minimum on this market") | Small accounts, repeatedly |

## Open questions for Anand

1. **What is the default valuation currency, and can a customer change it?** Recommended default: **INR, tenant-wide, changeable only with an explicit warning that all historical aggregates will be restated.** Most customers will think in rupees; a USDT-native customer will want the other.
2. **When an account holds both INR and USDT and both markets exist, who chooses?** Recommended default: **the system prefers the INR market and records why** (F3, F7). It is objectively cheaper once TDS is counted, so this is not a matter of taste. Offer a per-trade override for a customer who deliberately wants USDT exposure.
3. **Do we build group conversion (convert across a whole group in one action)?** It reuses the fan-out engine and is genuinely useful for a customer with 20 INR accounts who wants to trade a USDT-only coin. Recommended default: **yes, but one phase after single-account conversion works**, because it is the same engine and the same risks with a bigger blast radius.
4. **Do we ever support BTC- or ETH-quoted markets (34 of 999)?** Recommended default: **no.** It means treating BTC as a funding currency, which changes the account model, the analytics and the tax treatment for a 3% coverage gain.

## Phase hints

- **Market resolution (F3) belongs in the same phase as sizing (`09`)** - both are pure functions over the same metadata cache, and the preview screen needs both together.
- The **market index** the resolver needs (asset → markets, with quote currency, status and `ecode`) is a small derived structure over `markets_details` and should be built once, in the metadata phase, not re-derived per request across 999 rows.
- **Per-currency balances (`account_balance`)** land with onboarding, because onboarding already reads `users/balances` to validate the credential (`07` F9). Deriving funding currency there costs nothing extra.
- The **`fx_snapshot` table and the rate cross-check (F4)** ship before the first real trade, because a child order without a rate snapshot can never be explained afterwards.
- **Conversion (F5)** is its own small phase, after single-account trading works and before group analytics, since analytics depends on conversions being correctly classified as non-P&L.
- The **`ecode` segmentation in alerting** is a one-line requirement for the ops phase, but it must be captured on the child order from day one (`market_ecode`), or the data to segment by will not exist.

## Sources

- Live `GET https://api.coindcx.com/exchange/v1/markets_details`, 2026-09-04: 999 markets, all `active`; quote-currency distribution (USDT 626, INR 339, BTC 27, ETH 5, USDC 1, TRX 1); `ecode` prefix distribution (`B` 376, `I` 339, `KC` 244, `G` 40); asset-level coverage (339 INR, 626 USDT, 316 both, 310 USDT-only, 23 INR-only, 649 distinct).
- Live `GET https://api.coindcx.com/exchange/ticker`, 2026-09-04: `USDTINR` last 99.11 / bid 99.09 / ask 99.11; `BTCINR` last 8,079,092; `BTCUSDT` last 81,602.00; the 0.11% cross-check gap.
- `_sources/coindcx-docs.txt` - `markets_details` definition of `pair` as `(ecode, target, base)` with the `B-BTC_USDT` / `I-BTC_INR` / `KC-XYZ_USDT` examples; futures glossary defining `Ets` and `bmST` in terms of a Third-Party Exchange; `create_multiple` requiring `ecode: "I"`.
- `09-sizing-allocation-rounding.md` F6 - measured spreads (`BTCINR` 0.42%, `BTCUSDT` 0.0000%, `XRPINR` 0.36%, `DOGEINR` 0.81%) and `min_notional` values.
- Cross-references: `01-coindcx-spot-rest.md` (base/target inversion, `ecode`), `02`/`03` (margin `ecode: B`; INR futures fees in USDT and `settlement_currency_conversion_price`), `08-fanout-execution-engine.md` (planning stage, skip reasons), `11-positions-ledger-pnl.md` (fee and TDS currency, conversion ledger lines), `14-analytics-product-spec.md` (per-currency reporting), `15-india-regulatory-compliance.md` (TDS), `20-ops-audit-runbook.md` (`ecode` alert segmentation).


