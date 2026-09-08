# 09 - Sizing, allocation and rounding

Status: 2026-09-03 | track: execution core | scope: turning a human intent ("buy 20% across this group", "sell all", "close the position") into an exact, exchange-legal quantity per account - and the arithmetic rules that keep it exact.

## Verdict

- **CoinDCX cannot be told to spend money. It can only be told a quantity.** Spot `orders/create` accepts `total_quantity` and `price_per_unit`; there is no notional, amount or quote-size parameter in any product. So every "buy Rs 20,000 worth" and every percentage becomes `quantity = money / price` computed **by us**, against a price **we** choose, and then legalised against eight independent per-market constraints. This conversion is the highest-risk arithmetic in the product and it lives entirely on our side of the boundary.
- **The percentage basis the owner specified is the static allocated capital, and it decays.** "20% of the amount set when the account was added" is unambiguous and implementable, and it has one property worth naming out loud: it does not move when the account makes or loses money. An account that doubled still trades 20% of its original figure; an account that halved will start failing balance checks. Ship the owner's rule as the default, **store which basis each trade used**, expose the other two bases as options, and add an explicit "update allocated capital" action so the number is refreshed deliberately rather than drifting silently.
- **Money is never a float, and crypto quantity is never a float either.** Money in integer minor units (paise for INR, and a fixed 8-scale integer for USDT); quantities as fixed-scale decimals carried as strings end to end. `0.1 + 0.2` is the canonical example, but the one that actually costs money here is `1e-8` rounding at 8 decimal places turning a legal quantity into an illegal one.
- **Always round DOWN, on both sides.** Buys round down so the notional never exceeds the customer's stated budget. Sells round down so we never attempt to sell more than is held. There is no case in this product where rounding up is correct, which makes it a single enforceable rule rather than a judgement.
- **Reserve fee headroom or "buy with 100% of my balance" fails every time.** The taker fee is charged on top of the notional; a buy sized to the exact free balance leaves nothing to pay it with. Reserve the taker rate plus a safety margin before sizing.
- **Market orders need a slippage guard, and spot gives us no tools to build one.** Spot `orders/create` has no `time_in_force`, no `post_only`, no `reduce_only` - the parameter list is six fields long. So slippage control has to be constructed: check the orderbook depth for the intended quantity, refuse if the volume-weighted fill price would move more than a configured tolerance, and offer a priced limit order as the alternative. A market order into a thin INR pair is the most likely way this product loses a customer money without any bug being present.
- **"Sell all" and "close position" derive their quantity from the exchange, not from our books.** Any deposit, withdrawal or trade the customer made outside Tradex makes our derived holding wrong. Read the balance fresh, immediately before sending, and round down to `step`.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Percent basis (default) | `allocated_capital` - the figure captured at account-add, per the owner's spec | It is what was asked for, it is stable and predictable, and it makes group behaviour reproducible | Current equity (moves with P&L, so the same "20%" means something different every day), free balance (moves with open orders, so two identical trades size differently) |
| Percent basis (available) | All three, selected per trade, **recorded on the trade** | The right basis differs by intent; without recording it, no historical report can be explained | One hard-coded basis |
| Allocated capital freshness | Explicit "update allocated capital" action, plus a nag when it diverges from the real balance by more than 25% | A static number that silently decays produces sizes nobody expects | Auto-sync (turns the owner's stable basis into current equity by stealth) |
| Money representation | Integer minor units: INR in paise, USDT at scale 8. Stored as `numeric(38,0)` with the scale recorded per currency | Exact, comparable, sortable, no library needed for storage | `float`/`double` (rejected outright), `numeric` with implicit scale (invites mixed-scale bugs) |
| Quantity representation | Fixed-scale decimal, carried as a string, computed with a decimal library. Scale per market from `target_currency_precision` | Crypto quantities have market-specific scales; minor units are meaningless for them | Floats, or a single global scale |
| Decimal library | `decimal.js` (or `big.js` if only +-*/ is needed) with a project-wide `Decimal` wrapper that forbids implicit `number` construction | Battle-tested, exact, configurable rounding modes | Native `BigInt`-only arithmetic (awkward for division and market-specific scales) |
| Rounding direction | **DOWN, always**, both sides | Never exceed a budget; never oversell | Nearest (can exceed budget), banker's (same problem, harder to explain) |
| Price used for a money-to-quantity conversion | **Top of book from `market_data/orderbook`** - best ask for buys, best bid for sells; the customer's limit price for limit orders. Snapshot recorded on the trade | Reproducible, auditable, and *not* CDN-cached. `01-coindcx-spot-rest.md` verified live that `/exchange/ticker` is served from Cloudflare with `cf-cache-status: HIT`, so it is stale by an unknown amount - never price an order from it | `/exchange/ticker` (cached, stale), mid price (not a price you can trade at), last traded price (already gone) |
| Fee headroom | Reserve `taker_fee + 0.1%` safety on buys sized from balance - **plus 1% TDS on non-INR (C2C) markets**, where TDS is charged on top of the notional | The fee is charged in addition to the notional, and on a USDT market so is the 1% TDS. CoinDCX's own example: buying 1 BTC at 40,000 USDT requires **40,520 USDT** (400 TDS + 120 fee) | Assume the exchange nets it; use one holdback rate for all markets (under-reserves by 1% on every C2C buy) |
| Slippage protection | Pre-trade orderbook check with a configurable tolerance (default 0.5%); refuse and suggest a limit order | Spot has no IOC/FOK to lean on | Send the market order and hope |
| Sell-all quantity source | Exchange free balance, read immediately before send, rounded down to `step` | Our derived holding can be stale for reasons outside our control | Our own position record |
| Sub-minimum accounts | **Skip with a reason, never round up to the minimum** | Rounding up spends more of the customer's money than they authorised | Bump to `min_quantity` |

## Findings

### F1 - The order parameters we actually have

VERIFIED, spot `orders/create` (`01-coindcx-spot-rest.md`, docs lines 2179-2245). Six fields:

| Param | Required | Note |
|---|---|---|
| `market` | Yes | e.g. `SNTBTC` - the concatenated form, **not** the `B-BTC_USDT` pair form |
| `total_quantity` | Yes | Quantity in the **target** currency (the asset being bought) |
| `price_per_unit` | No | Not required for a market order |
| `side` | Yes | `buy` / `sell` |
| `order_type` | Yes | e.g. `market_order`, `limit_order` - but only those the market allows |
| `client_order_id` | No | *"Must be unique per order for each user. Reusing an existing client_order_id will be rejected"* |

What is absent shapes this whole document: **no notional, no `time_in_force`, no `post_only`, no `reduce_only`, no slippage or price-protection parameter.** There is nothing to delegate to. Also note the response `id` is *"Now a positive numeric string. UUID format is no longer accepted"* - so order ids are numeric strings and must not be typed as UUIDs.

### F2 - The eight constraints a quantity must satisfy

All from `GET /exchange/v1/markets_details`. VERIFIED, docs lines 940-1020.

| Field | Meaning (as documented) | Constraint |
|---|---|---|
| `step` | *"minimum increment accepted for the target currency"* | quantity must be a multiple of `step` |
| `target_currency_precision` | *"Number of decimals accepted for the target currency"* | quantity must not exceed this many decimals |
| `min_quantity` / `max_quantity` | Min/max target-currency quantity | `min_quantity ≤ qty ≤ max_quantity` |
| `min_market_orders_qty` / `max_quantity_market` | Separate min/max **for market orders only** | applies instead of the above when `order_type` is a market order |
| `min_notional` | *"minimum amount of **base** currency"* - i.e. the quote asset, INR or USDT | `qty × price ≥ min_notional` |
| `base_currency_precision` | Decimals accepted for the **price** | limit price rounded to this scale |
| `min_price` / `max_price` | Absolute price bounds | `min_price ≤ price ≤ max_price` |
| `order_types` | Types the market accepts | the chosen type must be in this list |
| `status` | `active` / `inactive` | must be `active` |

Two traps live in this table, both from CoinDCX's inverted naming (`01`): **`base_currency` is the pricing asset** (INR, USDT) and **`target_currency` is the asset being bought**. So `min_notional` is in rupees or USDT, `base_currency_precision` is *price* precision, and `target_currency_precision` is *quantity* precision. Reading these the industry-standard way silently mis-sizes every order.

And market orders have their own limits - `min_market_orders_qty` and `max_quantity_market`, distinct from `min_quantity`/`max_quantity`. Applying the limit-order bounds to a market order will pass validation locally and be rejected by the exchange.

### F3 - The effective minimum quantity is a maximum

The FAQ states this explicitly and it is the single most commonly-missed rule in the whole API:

> *"if the min_quantity returns 0.0001 and the target_currency_precision is 2, then the min quantity allowed is actually 0.01 and not 0.0001."*

```
effective_min_qty = max( min_quantity,
                         10^(-target_currency_precision),
                         step,
                         min_market_orders_qty  … if this is a market order )
```

Three sources of a floor, and the binding one differs by market. Computing it as anything other than a maximum produces orders that are rejected for being too small while our own validation says they are fine.

### F4 - The three percent bases, compared honestly

The owner specified the first. The comparison exists so the choice is informed and so the UI can label it correctly.

| Basis | Definition | Behaviour after +100% P&L | Behaviour after -50% P&L | Reproducible? |
|---|---|---|---|---|
| **`allocated_capital`** (default) | The figure typed at account-add | Still 20% of the original - under-deploys a grown account | Still 20% of the original - **will fail the balance gate** | Yes, exactly |
| `current_equity` | Free + locked + marked-to-market holdings, now | Scales up with the account | Scales down; never fails for lack of funds | No - the same button gives a different size each day |
| `free_balance` | Currently unencumbered quote balance | Scales up | Scales down | No - open orders change it minute to minute |

The failure mode of the chosen default is worth stating plainly: **on an account that has lost money, a percentage of the original allocation can exceed the balance that remains.** That is not a bug, it is the definition, and the gate in `08-fanout-execution-engine.md` will skip the account with "insufficient balance". The mitigation is the divergence nag - when `allocated_capital` and the real balance differ by more than 25%, prompt the customer to update it - plus showing both numbers on the account card at all times.

### F5 - The sizing algorithm

Pure, no I/O, fully testable. Inputs are values, not services.

```
size(intent, account, market_meta, price, balances, holdings) -> Sized | Skipped

# 1. establish the money or quantity the customer means
switch intent.mode:
  QUOTE_AMOUNT   : budget_minor = intent.amount_minor
  BASE_QUANTITY  : qty = intent.quantity                       -> goto 4
  PCT_ALLOCATED  : budget_minor = account.allocated_capital_minor * pct / 100
  PCT_EQUITY     : budget_minor = equity_minor(account)        * pct / 100
  PCT_FREE       : budget_minor = balances.free_minor           * pct / 100
  PCT_POSITION   : qty = holdings.exchange_free_qty * pct / 100 -> goto 4   # SELL only
  SELL_ALL       : qty = holdings.exchange_free_qty             -> goto 4   # SELL only

# 2. buys only: hold back the fee, and the TDS if this is a C2C market
if side == BUY and budget came from a balance-derived basis:
    tds_rate = (market.base_currency == "INR") ? 0 : 0.01      # 11-positions-ledger-pnl.md F4
    budget_minor = budget_minor * (1 - taker_fee - tds_rate - 0.001)

# 3. money -> quantity
qty = Decimal(budget_minor) / minor_scale(quote_ccy) / price

# 4. legalise, rounding DOWN at every step
qty = floor_to_step(qty, market_meta.step)
qty = floor_to_scale(qty, market_meta.target_currency_precision)

# 5. refuse, never adjust
if qty < effective_min_qty(market_meta, order_type) : return Skipped(BELOW_MIN_QTY)
if qty > effective_max_qty(market_meta, order_type) : return Skipped(ABOVE_MAX_QTY)
if qty * price < market_meta.min_notional           : return Skipped(BELOW_MIN_NOTIONAL)
if side == SELL and qty > holdings.exchange_free_qty: return Skipped(INSUFFICIENT_HOLDING)
if side == BUY  and qty * price * (1+taker_fee) > balances.free
                                                    : return Skipped(INSUFFICIENT_BALANCE)
return Sized(qty, price, notional = qty * price, basis = intent.mode, price_source = …)
```

Step 5 is the whole safety argument: **every failure is a refusal with a named reason, never a silent adjustment.** The reason strings are what the confirmation table in `21-frontend-ux-spec.md` displays per account.

### F6 - Live market metadata, measured

Fetched from `GET /exchange/v1/markets_details` and `GET /exchange/ticker` on 2026-09-04. **999 markets** exist. The ticker figures below are for illustration only - `01-coindcx-spot-rest.md` verified live that `/exchange/ticker` is CDN-cached (`cf-cache-status: HIT`), so a real order must be priced from `market_data/orderbook`, never from these. Four representative markets:

| | I-BTC_INR | B-BTC_USDT | I-XRP_INR | I-DOGE_INR |
|---|---|---|---|---|
| `market` (what `orders/create` takes) | `BTCINR` | `BTCUSDT` | `XRPINR` | `DOGEINR` |
| quote (`base_currency_short_name`) | INR | USDT | INR | INR |
| `min_quantity` | 0.00001 | 0.00001 | 1 | 0.001 |
| `max_quantity` | 2 | 9000 | 25000 | 200000 |
| **`max_quantity_market`** | **0.0158** | 122.6936997 | 549.5758 | 5760.368664 |
| `min_notional` | 100 | 5 | 100 | 100 |
| `step` | 0.00001 | 0.00001 | 0.1 | **1** |
| `target_currency_precision` (qty) | 5 | 5 | 1 | **0** |
| `base_currency_precision` (price) | 1 | 2 | 3 | 4 |
| `order_types` | limit, market | limit, market, stop_limit, take_profit_limit, take_profit_market | limit, market | limit, market |
| `min_market_orders_qty` | **absent** | absent | absent | absent |
| last / bid / ask | 8,079,092 / 8,043,561.6 / 8,077,476.1 | 81,602.00 / 81,601.99 / 81,602.00 | 145.136 / 145.136 / 145.665 | 8.8686 / 8.8009 / 8.8724 |

Five things this measurement establishes that no document states:

1. **`max_quantity_market` is drastically smaller than `max_quantity`, and it is the binding constraint on market orders.** On `BTCINR` it is 0.0158 BTC - about **Rs 1.28 lakh** at the current ask - against a `max_quantity` of 2 BTC. A market buy larger than that is rejected. This is the constraint that will bite the owner's *largest* accounts first.
2. **The values look computed, not configured** (`122.6936997`, `5760.368664`), which strongly suggests they are derived from live orderbook depth and therefore **change**. Cache them briefly, re-read before sizing, and never treat a cached `max_quantity_market` as authoritative. UNVERIFIED how often they move - worth sampling hourly for a day.
3. **`min_market_orders_qty` is documented but absent from the response.** Code must treat it as optional and fall back to `min_quantity`; a strict schema will reject all 999 markets.
4. **`DOGEINR` has `target_currency_precision = 0` and `step = 1`** while `min_quantity = 0.001`. So the effective minimum is `max(0.001, 1, 1) = 1` whole DOGE - a live confirmation of F3, and proof that reading `min_quantity` alone under-estimates the floor by 1000x on this market.
5. **INR pairs carry a wide spread; USDT pairs do not.** Measured bid-ask: `BTCINR` **0.42%**, `XRPINR` 0.36%, `DOGEINR` 0.81%, `BTCUSDT` 0.0000%. With an assumed 0.5% taker fee each way, a round trip on `BTCINR` costs roughly **1.4%** before any price movement. That number belongs in the UI, because a customer running a 20-account group trade on an INR pair is paying it 20 times.

`USDTINR` last traded at **99.11**, which is the reference rate for any INR/USDT comparison in this document (`10-multi-currency-inr-usdt.md` owns rate sourcing).

The spot taker fee is **not** in `markets_details` and there is no fee-tier API (FAQ: *"Can I get my fee tier via APIs - We currently don't have this available"*). The 0.5% used below is an **assumption**; the real rate must be read from the `fee` field on an order response (FAQ: *"fee returns the fee percentage charged on the transaction"*) and cached per account.

### F7 - Worked examples, with live numbers

All BUY examples price at the **ask** (`BTCINR` 8,077,476.1) and hold back 0.6% (0.5% assumed taker fee + 0.1% safety). INR-market buys attract **no TDS**, so 0.6% is the correct holdback for rows 1-6 and 8; row 7 is a USDT market and therefore holds back **1.6%** (0.5% fee + 1% TDS + 0.1% safety) - see `11-positions-ledger-pnl.md` F4. Intent throughout: the owner's own scenario - *market buy, 20% of allocated capital*.

| # | Account allocated | Budget (20%) | After 0.6% holdback | Raw qty | After floor to `step`/precision | Notional | Outcome |
|---|---|---|---|---|---|---|---|
| 1 | Rs 1,00,000 | Rs 20,000 | Rs 19,880 | 0.00246116 BTC | **0.00246** | Rs 19,870.6 | **FILL** |
| 2 | Rs 5,00,000 | Rs 1,00,000 | Rs 99,400 | 0.01230581 | **0.01230** | Rs 99,353.0 | **FILL** |
| 3 | Rs 10,00,000 | Rs 2,00,000 | Rs 1,98,800 | 0.02461162 | 0.02461 | Rs 1,98,787 | **REFUSED - ABOVE_MAX_QTY_MARKET** (0.02461 > 0.0158) |
| 4 | Rs 500 | Rs 100 | Rs 99.40 | 0.00001230 | 0.00001 | Rs 80.77 | **REFUSED - BELOW_MIN_NOTIONAL** (80.77 < 100) |
| 5 | Rs 50,000 (XRPINR) | Rs 10,000 | Rs 9,940 | 68.2385 XRP | **68.2** (step 0.1) | Rs 9,934.4 | **FILL** |
| 6 | Rs 5,000 (DOGEINR) | Rs 1,000 | Rs 994 | 112.0349 DOGE | **112** (step 1, precision 0) | Rs 993.7 | **FILL** |
| 7 | 1,000 USDT (BTCUSDT) | 200 USDT | 196.80 USDT (1.6% - fee **+ 1% TDS**) | 0.00241220 BTC | **0.00241** | 196.66 USDT | **FILL** |
| 8 | SELL ALL: holds 0.00246 BTC | - | - | 0.00246 | 0.00246 (at bid 8,043,561.6) | Rs 19,787.2 | **FILL** |

Read rows 1, 2 and 3 together, because that is the owner's requirement executing exactly as specified: **one group trade, one "20%", three different quantities, and the largest account is the one that fails.** Row 3 is not a bug - it is `max_quantity_market` doing its job - but it is deeply counter-intuitive and it must be visible on the confirmation screen *before* submit, with the remedy offered ("use a limit order" or "split this order").

Rows 1 and 7 are the same "20%" producing 0.00246 BTC and 0.00241 BTC. They differ for three reasons: the bases are different currencies at a rate of 99.11, the two markets quote BTC at slightly different implied prices, and the USDT market's buy leg carries **1% TDS that the INR market's does not**. Any group P&L that adds these two together must state its valuation currency (`10`, `11`).

Row 8 shows the round-trip cost concretely: buying at the ask and selling at the bid on `BTCINR` returns Rs 19,787 from a Rs 19,871 purchase - a **0.42% loss on a flat market**, before fees.

### F8 - Slippage, with nothing from the exchange to help

Spot has no `time_in_force`, no IOC, no FOK, no post-only and no price-protection parameter (F1). So every guard is ours:

| Guard | How | Default |
|---|---|---|
| Depth check | Walk `market_data/orderbook` for the intended quantity; compute the volume-weighted fill price; compare to the best ask/bid | Refuse if VWAP deviates more than **0.5%** from the touch |
| Spread check | Refuse a market order when the bid-ask spread already exceeds the tolerance | `BTCINR` at 0.42% passes a 0.5% test only just; `DOGEINR` at 0.81% would be refused |
| Limit alternative | Offer a limit order priced at the touch, or touch ± a configurable offset, with a cancel-if-unfilled timer | Presented as the remedy whenever a market order is refused |
| Notional ceiling per order | Independent of the exchange's `max_quantity_market`, a Tradex per-order cap the customer sets | Prevents a fat-fingered percentage from becoming a large market order |

The depth check costs one orderbook read per market per group trade - not per account, since all accounts in a group trade the same market. That matters against the `active_orders` 300/60 s style limits (`08` F1).

### F9 - Dust, residuals and the sell-all edge

| Situation | Rule |
|---|---|
| Buy leaves an unspendable remainder of quote currency | Expected and harmless. Never chase it with a second order |
| Holding is below `effective_min_qty` and cannot be sold | It is dust. Show it, label it unsellable, exclude it from "sell all" without failing the whole trade |
| `step` rounding leaves a holding fragment after a percentage sell | Expected. A subsequent "sell all" clears it if it is above the minimum |
| Free balance changed between preview and send | Re-read before sending; if the sized quantity now exceeds the holding, clamp **down** to the holding and record that the clamp happened |
| Holding is entirely locked by an open order | Skip with `HOLDING_LOCKED` and offer to cancel the open order first |

The clamp in row 4 is the one intentional exception to "refuse, never adjust", and it is safe in one direction only: reducing a sell to what is actually held cannot spend money the customer did not authorise. A clamp *upward* is never permitted.

## Design

### Invariants (testable as properties)

| # | Invariant |
|---|---|
| S1 | For a BUY, `quantity × price × (1 + fee)` never exceeds the stated budget |
| S2 | For a SELL, `quantity` never exceeds the exchange-reported free holding at send time |
| S3 | Every emitted quantity is an exact multiple of `step` and has at most `target_currency_precision` decimals |
| S4 | Every emitted quantity satisfies `effective_min_qty ≤ qty ≤ effective_max_qty` for its order type |
| S5 | Every emitted order satisfies `qty × price ≥ min_notional` |
| S6 | No float appears anywhere between the intent and the serialised request body |
| S7 | A percentage of zero, or of an unfunded account, is a refusal - never a zero-quantity order |
| S8 | Rounding is monotonic: a larger budget never produces a smaller quantity |
| S9 | The same inputs always produce the same output (no reliance on wall-clock or ambient state) |
| S10 | Every refusal carries a machine-readable reason code and a human sentence |

S8 deserves a note: it is trivially true for correct code and it catches an entire class of step/precision interaction bugs. It is the cheapest property test in the file.

### Persisted per trade

Without these, no historical order can be explained or recomputed:

`sizing_mode`, `percent_value`, `basis_used`, `basis_amount_minor`, `price_source` (`ask` / `bid` / `last` / `limit`), `price_used`, `fee_rate_assumed`, `market_meta_version`, `raw_quantity`, `final_quantity`, `notional_minor`, `refusal_code`.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Float used anywhere in the chain | Property test S6; a lint rule banning `number` in money types | Decimal wrapper, integer minor units | Silent, tiny, cumulative wrongness - the hardest kind to notice |
| `min_quantity` read without the precision/step maximum | Property test S4 against all 999 live markets | The F3 maximum | Rejections on ~any market whose precision floor exceeds `min_quantity`; `DOGEINR` is off by 1000x |
| `max_quantity` applied to a market order instead of `max_quantity_market` | Rejections only on large accounts | Order-type-aware limits (F2) | The customer's biggest accounts, which is the worst possible subset |
| Stale `max_quantity_market` from cache | Rejection despite passing local validation | Re-read before sizing; short TTL | Whole group fails at once when depth thins |
| Base/quote naming inversion | Notionals off by the price of the asset | Name the fields `price_precision` and `quantity_precision` in our own types, never pass CoinDCX's names inward | Every order on every market |
| Fee not reserved on a full-balance buy | Rejection for insufficient balance at exactly 100% | 0.6% holdback (F5 step 2) | Only the "max out" case, which is the case customers try first |
| Assumed 0.5% fee is wrong for this account | Ledger fees do not match `fee_amount` on fills | Read `fee` from the first fill and cache per account; treat the assumption as provisional | Sizing slightly off, P&L visibly off |
| Selling from our position record instead of the exchange balance | `INSUFFICIENT_HOLDING` rejections after outside activity | Read fresh, clamp down (F9) | One account, and a confusing error |
| Percentage of a decayed `allocated_capital` exceeds the balance | Balance gate refusal | The divergence nag; show both numbers on the account card | Accounts that have lost money - exactly when a customer is most sensitive |
| Market order into a thin INR pair | Post-fill slippage visible in the report | Depth and spread guards (F8), default 0.5% | Real money lost with no bug present |

## Open questions for Anand

1. **Confirm the percent basis.** The spec says the balance recorded at account-add, and F4 shows what that means: a grown account under-deploys, and a shrunk account starts failing. Recommended default: **keep it as specified**, add the "update allocated capital" action and the divergence nag, and offer current-equity as an opt-in per trade.
2. **Market orders on INR pairs: allow, warn, or block?** Measured spreads are 0.36-0.81% on INR pairs versus effectively zero on USDT pairs. Recommended default: **allow with a mandatory warning showing the measured spread and the estimated round-trip cost**, and refuse above a configurable tolerance (0.5%).
3. **What happens when an account exceeds `max_quantity_market` (row 3)?** Three options: refuse and tell them, auto-convert to a limit order at the touch, or auto-split into several market orders. Recommended default: **refuse and offer the limit order as a one-click alternative**. Auto-splitting turns one authorised order into several at prices the customer never saw, and CoinDCX already splits large orders on the futures side (`03`), so the behaviour would be inconsistent.
4. **Per-order and per-day notional caps: what defaults?** These are the backstop against a fat-fingered percentage. Recommended default: **per-order Rs 2,00,000 and per-day Rs 5,00,000 per tenant**, customer-raisable with a confirmation step.

## Phase hints

- This is a **pure-function phase with no I/O**, and it should land early - before the fan-out engine, alongside the market-metadata cache. Its entire surface is testable with property tests against the 999 live markets, which is the strongest correctness lever available in the whole plan.
- The **market-metadata cache** must be built here, must expose `step`, both precisions, both quantity ranges, both market-order ranges, `min_notional`, `min_price`/`max_price`, `order_types` and `status`, must tolerate `min_market_orders_qty` being absent, and must be **versioned** so an order records what it was legalised against.
- **Fee discovery** is a small task that belongs here: read `fee` from the first fill per account, cache it, and stop using the 0.5% assumption. Until then, every sizing decision carries an assumed constant, which must be visible in the code and in the report.
- The **depth/slippage guard (F8)** can ship one phase later than basic sizing, but it must ship before the first market order is offered on an INR pair.
- The **divergence nag** for `allocated_capital` belongs with the accounts UI, not here - but the comparison it needs (typed figure versus live balance) is computed at onboarding (`07` F9, `19-accounts-groups-data-model.md`).

## Sources

- `_sources/coindcx-docs.txt` - spot `orders/create` parameters (lines 2179-2245); `markets_details` response definitions (lines 940-1020) including `step`, `min_notional` as base currency, both precisions, `min_market_orders_qty`, `max_quantity_market`, `order_types`; FAQ on the min-quantity-versus-precision maximum, on `fee` being a percentage, and on there being no fee-tier API.
- Live `GET https://api.coindcx.com/exchange/v1/markets_details` on 2026-09-04: 999 markets; the full metadata rows for `I-BTC_INR`, `B-BTC_USDT`, `I-XRP_INR`, `I-DOGE_INR` reproduced in F6; `min_market_orders_qty` absent on all four; `max_quantity_market` values that appear depth-derived.
- Live `GET https://api.coindcx.com/exchange/ticker` on 2026-09-04: last/bid/ask for `BTCINR`, `BTCUSDT`, `XRPINR`, `DOGEINR`, and `USDTINR` at 99.11.
- Assumption flagged in F6: a 0.5% spot taker fee. Not published in `markets_details`; must be replaced by the `fee` field from a real fill.
- Cross-references: `01-coindcx-spot-rest.md` (base/target inversion, `market` versus `pair` identifiers), `08-fanout-execution-engine.md` (gates, which consume this function), `10-multi-currency-inr-usdt.md` (rate sourcing, mixed-currency groups), `11-positions-ledger-pnl.md` (holdings as truth, fees and TDS as ledger lines), `18-testing-correctness-program.md` (S1-S10 as property tests), `21-frontend-ux-spec.md` (refusal reasons on the confirmation table).



