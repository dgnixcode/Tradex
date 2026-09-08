# 03 - CoinDCX futures market data and order REST contract

Status: 2026-09-03 | track: exchange ground truth | scope: `/exchange/v1/derivatives/futures/data/*` (instruments, trades, orderbook), the `public.coindcx.com` candlestick and orderbook feeds, and the futures order endpoints (list, create, cancel). Positions, margin, wallets and TP/SL are in `04-coindcx-futures-positions-wallets-rest.md`.

## Verdict

- **INR-margined perpetual futures are real and first-class.** `margin_currency_short_name` accepts `INR` and `USDT` (default `USDT`) on create and on list. This is the only CoinDCX product where INR collateral and a genuine, closable position object coexist - which makes futures the natural home for the owner's CLOSE POSITION requirement, *if* leverage is acceptable at all (see the open question in `02-coindcx-margin-rest.md`).
- **There is no `client_order_id` anywhere in the futures API.** Every parameter table in this range was read: create, cancel and list all identify orders solely by the server-assigned `id`. Spot has a client-supplied key; futures and margin do not. So futures fan-out cannot be made retry-safe by key. Safety has to be manufactured from a per-(account, pair) single-flight lock, a read-back of `List Orders` on any ambiguous outcome, and a position-delta check - all of which are weaker than an idempotency key and all of which must be built. **This is the single largest correctness risk in the whole product.**
- **A signed futures order expires in 10 seconds.** Documented verbatim on create: *"Orders with a delay of more than 10 seconds will be rejected."* Two hard consequences: sign at *send* time and never at *enqueue* time, and any queue latency over 10 s turns into a rejection rather than a late fill. Our hosts must be NTP-synced; see `06-coindcx-auth-ratelimits-errors-tos.md`.
- **Making an order legal is an eight-constraint problem, not a rounding problem.** `data/instrument` exposes `price_increment`, `quantity_increment`, `min_price`, `max_price`, `min_quantity`, `max_quantity`, `min_notional`, `min_trade_size`, `max_market_order_quantity`, and two LTP-relative price bands (`multiplier_up`, `multiplier_down`). The error table adds a hard `9500` quantity ceiling. All of it must be checked *before* we send, or the customer discovers it as a rejection.
- **Leverage is sticky per pair and is account state, not an order field.** *"Order leverage must be equal to position leverage"* is a documented 422. Leverage *"needs to be set only once post which it will be saved in the system for that particular pair."* So Tradex must set leverage deliberately, cache it per (account, pair), and treat a mismatch as a pre-trade block.
- **INR futures are a two-currency instrument.** The docs state: *"`fee_amount` and `ideal_margin` values are in USDT for INR Futures"*, and every order carries `settlement_currency_conversion_price`, the USDT↔INR rate at order time. INR-futures P&L must be computed with that field, captured per order - not with a rate we look up afterwards.
- **Charting is solved by this section, not by the spot API.** `GET https://public.coindcx.com/market_data/candlesticks` takes `pair`, `from`, `to`, `resolution` and `pcode`, and is documented. That is a windowed, backfillable OHLCV feed - exactly what a chart needs, and what the spot `market_data/candles` endpoint cannot provide (see `01-coindcx-spot-rest.md`).

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Futures in v1? | **Only if the owner confirms leverage is wanted.** Default: no | The missing `client_order_id` means every futures order needs a bespoke safety apparatus that spot gets for free | Ship futures in v1 for the position semantics - rejected, it front-loads the hardest correctness problem |
| Idempotency substitute for futures | Per-(account, pair) advisory lock held across the HTTP call + mandatory `List Orders` read-back on timeout + position-delta assertion | There is no key to deduplicate by; the lock is what prevents a concurrent second attempt | Blind retry with a short timeout - rejected, it places duplicate leveraged positions |
| When to sign | At send, inside the worker, immediately before the socket write | The 10 s expiry makes a pre-signed queued payload a guaranteed rejection under load | Sign when the job is created |
| Leverage handling | Read and cache per (account, pair); set explicitly via `positions/update_leverage`; block the order on mismatch | The exchange rejects mismatches and remembers the last value | Send `leverage` on every order and hope it agrees |
| Order legality | A single `legalise()` function that applies all constraints from `data/instrument` and refuses rather than truncates | A rejection after send is a customer-visible failure; a refusal before send is a UI message | Round and send, handle the 4xx |
| Instrument metadata | Cached, refreshed on a schedule, and **versioned** - an order records the metadata version it was legalised against | `exit_only`, bands and leverage tiers change; a stale cache silently mis-sizes | Fetch on every order (rate-limit cost) or cache forever |
| Candle source for charts | `public.coindcx.com/market_data/candlesticks` | Documented, windowed, backfillable | Spot `market_data/candles` - only 4 fixed intervals, no from/to |
| Fill accounting | Aggregate by `group_id`, never assume one order id equals one execution stream | The exchange auto-splits large market orders into parts sharing a `group_id` | Treat the order id as the unit of fill |

## Findings

### F1 - Endpoint inventory for this range

VERIFIED, docs lines 7779-9498. Note the two different hosts.

| Purpose | Method + path | Auth |
|---|---|---|
| Active instruments | `GET api.coindcx.com/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]={mode}` | public |
| Instrument details | `GET api.coindcx.com/exchange/v1/derivatives/futures/data/instrument?pair={pair}&margin_currency_short_name={mode}` | public |
| Real-time trades | `GET api.coindcx.com/exchange/v1/derivatives/futures/data/trades?pair={pair}` | public |
| Orderbook | `GET public.coindcx.com/market_data/v3/orderbook/{instrument}-futures/{depth}` | public |
| Candlesticks | `GET public.coindcx.com/market_data/candlesticks?pair=&from=&to=&resolution=&pcode=f` | public |
| List orders | `POST api.coindcx.com/exchange/v1/derivatives/futures/orders` | signed |
| Create order | `POST api.coindcx.com/exchange/v1/derivatives/futures/orders/create` | signed |
| Cancel order | `POST api.coindcx.com/exchange/v1/derivatives/futures/orders/cancel` | signed |

Two documentation defects in this table, both harmless once known: the cancel URL is printed with a **double slash** (`api.coindcx.com//exchange/...`), and the three `data/*` and both `public.coindcx.com` endpoints appear with no rate limit anywhere in the document (the rate-limit table covers spot only - see `06-coindcx-auth-ratelimits-errors-tos.md`).

The docs recommend against polling the market-data three: *"While rest APIs exist for this, we recommend using Futures Websockets."* Treat REST as backfill and reconnect-repair only; the socket is the live path (see `05-coindcx-websockets.md`).

### F2 - Pair naming and margin currency

| Item | Value | Note |
|---|---|---|
| `pair` format | `B-ETH_USDT` | Stated twice in the docs. The `B-` prefix is part of the identifier |
| Orderbook path form | `{instrument}-futures` | A *different* spelling of the same instrument, e.g. `B-ETH_USDT-futures` |
| `margin_currency_short_name` (create) | String, optional, default `"USDT"`, values `INR` and `USDT` | |
| `margin_currency_short_name` (list, active_instruments) | **Array**, default `["USDT"]` | Same name, different arity per endpoint. `active_instruments` uses PHP-style `[]` bracket syntax in the query string |
| `kind` | always `perpetual` | No dated futures |
| `settlement` | always `never` | |

So the same logical concept appears in three shapes across five endpoints. The adapter should normalise once and never let the raw forms leak upward.

### F3 - Instrument metadata: the sizing constraint set

From `data/instrument`. VERIFIED, docs section `Get instrument details`, lines 7886-8178. Fields the docs mark *"Ignore this"* are omitted below (`max_leverage_long`, `max_leverage_short`, `safety_percentage`, `quanto_to_settle_multiplier`, `is_inverse`, `is_quanto`, `allow_post_only`, `allow_hidden`, `max_notional`, `expiry_time`).

| Field | Meaning | Used for |
|---|---|---|
| `settle_currency_short_name` | Currency you buy/sell the contract in | Which wallet funds it |
| `quote_currency_short_name` | Currency the price is quoted in | Display, notional math |
| `position_currency_short_name` / `underlying_currency_short_name` | Underlying crypto (documented identically) | Asset identity |
| `status` | `active` / `inactive` | Tradability gate |
| `price_increment` | Tick size. *"If price increment is 0.1 then price inputs for limit order can be x, x+0.1, …"* | Price rounding |
| `quantity_increment` | Step size | Quantity rounding |
| `min_trade_size` | Minimum settleable trade quantity | Floor |
| `min_price` / `max_price` | Absolute price bounds | Limit-price validation |
| `min_quantity` / `max_quantity` | Absolute quantity bounds | Quantity validation |
| `min_notional` | *"Minimum value you can purchase for a symbol"* | The refusal that bites small accounts |
| `max_market_order_quantity` | Max quantity in a market order | Market-order validation |
| `maker_fee` / `taker_fee` | Fee rates | Fee headroom, P&L |
| `liquidation_fee` | Fee on a liquidation trade | Worst-case P&L |
| `funding_frequency` | Hours between funding events (`8` = every 8 h) | Carry cost in P&L |
| `exit_only` | If true, no new or added positions; reduce and cancel still allowed | **Hard pre-trade block** |
| `multiplier_up` | Buy limit price must be within `[min_price, LTP*(1+multiplier_up/100)]` | Band validation |
| `multiplier_down` | Sell limit price must be within `[LTP*(1-multiplier_down/100), max_price]` | Band validation |
| `time_in_force_options` | `good_till_cancel`, `immediate_or_cancel`, `fill_or_kill` | TIF whitelist, per instrument |
| `dynamic_position_leverage_details` | Map of leverage → max position size, e.g. `{"5":15000000,"10":1000000,"20":100000}` | Max leverage depends on size |
| `dynamic_safety_margin_details` | Tiered maintenance-margin table, e.g. `{"50000":1.5,"100000":2.0}` | Liquidation price |
| `margin_currency_short_name` | The margin mode this row describes | Cache key |

Two of these deserve emphasis. `exit_only` is a per-instrument kill switch owned by the exchange; a fan-out that ignores it will fail on every account at once. And the two `dynamic_*` maps mean leverage and liquidation are **functions of position size**, not constants - the docs' own worked example: a 120K position sits in the >100K, ≤500K band, so max leverage is 15x; a 60K position's maintenance margin is `50K*1.5% + 10K*2% = 950 USDT`.

### F4 - `orders/create` request contract

VERIFIED, docs section `Create Order`.

| Param | Type | Mandatory | Notes |
|---|---|---|---|
| `timestamp` | Integer | YES | *"Latest epoch timestamp when the order is placed. Orders with a delay of more than 10 seconds will be rejected."* |
| `side` | String | YES | `buy` / `sell` |
| `pair` | String | YES | `B-ETH_USDT` |
| `order_type` | String | YES | `market`, `limit`, `stop_limit`, `stop_market`, `take_profit_limit`, `take_profit_market` |
| `price` | Integer* | YES | Limit price for limit / stop-limit / take-profit-limit. **Must be NULL for market orders, "else the order will be rejected"** |
| `stop_price` | Integer* | YES | Trigger price for the four stop/TP types |
| `total_quantity` | Integer* | YES | Quantity. **No notional parameter, same as spot** |
| `leverage` | Integer | OPTIONAL | *"Should match the leverage of the position. Preferably set before placing the order to avoid rejection."* |
| `notification` | String | YES | `no_notification` / `email_notification` |
| `time_in_force` | String | OPTIONAL | `good_till_cancel` (default), `fill_or_kill`, `immediate_or_cancel`. *"Should be null for market orders"* and the NOTE block says *"Do not include 'time_in_force' parameter for market orders"* |
| `hidden` | Boolean | NO | *"Ignore this (Not supported at the moment)"* |
| `post_only` | Boolean | NO | *"Ignore this (Not supported at the moment)"* |
| `margin_currency_short_name` | String | OPTIONAL | Default `"USDT"`; `INR` or `USDT` |
| `position_margin_type` | String | OPTIONAL | `isolated` / `crossed`; defaults to the position's existing type. *"Cross margin mode is only supported on USDT margined Futures at the moment"* |

\* The docs type `price`, `stop_price` and `total_quantity` as **Integer**, which is certainly a documentation error - the same fields are shown with decimal values elsewhere and `price_increment` may be `0.1`. Send them as JSON numbers with the instrument's precision; see G3 in `06-coindcx-auth-ratelimits-errors-tos.md` for why number serialisation matters to the signature.

Three mandatory-but-conditional parameters (`price`, `stop_price`, `time_in_force`) are marked YES while the prose says to send them as null or omit them by order type. The practical contract:

| Order type | `price` | `stop_price` | `time_in_force` |
|---|---|---|---|
| `market` | null | omit | **omit the key entirely** |
| `limit` | required | omit | optional |
| `stop_market` / `take_profit_market` | null | required | omit |
| `stop_limit` / `take_profit_limit` | required | required | optional |

### F5 - The futures order object

Returned by create and list. VERIFIED. Fields the docs mark *"Ignore this"* are noted rather than dropped, because they still arrive on the wire: `stop_trigger_instruction`, `ideal_margin`, `order_category`, `display_message`, `group_status`.

| Field | Meaning |
|---|---|
| `id` | Order id. The only handle |
| `pair`, `side`, `order_type`, `leverage`, `notification` | As submitted |
| `status` | See F6. **On the create response the docs say to ignore it: it is `initial` for every new order** |
| `price` | Limit price; for a market order, *"the market price at the time when the market order was placed"* |
| `stop_price` | Trigger price |
| `avg_price` | Average execution price. Zero on a fresh order; *"You can check the latest fill price from the list orders endpoint"* |
| `total_quantity` / `remaining_quantity` / `cancelled_quantity` | Fill accounting. Note there is **no `filled_quantity`** - it must be derived as `total - remaining - cancelled` |
| `maker_fee` / `taker_fee` | Rates |
| `fee_amount` | Fee charged **so far**, for the executed part only. Zero at placement |
| `liquidation_fee` | Fee if the trade was a liquidation |
| `stage` | `default`, `exit` (quick exit closing the whole position), `liquidate` (system-generated), `tpsl_exit` |
| `group_id` | Shared by all parts when the system splits a large market-variant order |
| `position_margin_type` | `crossed`, `Isolated`, or **NULL which also means isolated** |
| `margin_currency_short_name` | `INR` or `USDT` |
| `settlement_currency_conversion_price` | USDT↔INR rate at order time; *"relevant only for INR margined Orders"* |
| `created_at` / `updated_at` | Timestamps |

The absence of `filled_quantity` is worth restating: every fill calculation on futures is a subtraction, and `cancelled_quantity` is part of it. A partially-filled-then-cancelled order has non-zero values in both, and treating `remaining_quantity == 0` as "fully filled" is wrong.

### F6 - Status vocabulary, and a spelling trap

The docs give the same set twice, in two different casings and **two different spellings**. VERIFIED.

| Sent as a `status` filter on List Orders (lowercase) | Described in the response definitions (uppercase) |
|---|---|
| `open` | `OPEN` - accepted and open |
| `filled` | `FILLED` - completely filled |
| `partially_filled` | `PARTIALLY_FILLED` - partly filled, remainder open |
| `partially_cancelled` | `PARTIALLY_CANCELED` - partly filled, remainder cancelled |
| `cancelled` | `CANCELED` - cancelled |
| `rejected` | `REJECTED` - not accepted by the system |
| `untriggered` | `UNTRIGGERED` - TP/SL order not yet triggered |

Note `cancelled` (two L) in the request filter versus `CANCELED` (one L) in the response description. Plus `initial` from the create response (F5), which appears in neither list. A case-insensitive comparison handles the casing but **not** the spelling; the adapter needs an explicit alias map covering `cancelled`/`canceled`/`CANCELLED`/`CANCELED`, and an `UNKNOWN` fallback that alarms rather than throws.

`List Orders` requires `status`, `side`, `page` and `size` - all four marked YES. So there is no "give me all my orders" call: enumerating an account's open orders means iterating both sides, and any status you forget is invisible. For reconciliation, always request the full status CSV for both sides.

### F7 - Order types and the LTP-relative price rules

Six types, VERIFIED: `market`, `limit`, `stop_market`, `stop_limit`, `take_profit_market`, `take_profit_limit`.

The docs' NOTE block states the price ordering rules relative to LTP. These are validation rules we must implement, because getting them wrong is a rejection:

| Side | Type | Rule |
|---|---|---|
| Buy | Stop limit | `stop_price > LTP` and `limit price > stop_price` |
| Buy | Take profit limit | `stop_price < LTP` and `stop_price < limit price < LTP` |
| Sell | Stop limit | `stop_price < LTP` and `limit price < stop_price` |
| Sell | Take profit limit | `stop_price > LTP` and `LTP < limit price < stop_price` |

Combined with `multiplier_up`/`multiplier_down` from F3, a limit price has to satisfy: divisibility by `price_increment`, the absolute `[min_price, max_price]` window, the LTP-relative band, **and** the ordering rule above if it is a stop or TP variant. Four independent checks on one number.

### F8 - Documented error codes for `orders/create`

VERIFIED. Four of these rows were unreadable in the first pass of our docs converter because a literal `<` swallowed the rest of the cell; the converter was fixed on 2026-09-04 and the full text is recovered below.

| HTTP | Message | Cause |
|---|---|---|
| 422 | `Order leverage must be equal to position leverage` | Order leverage ≠ current position leverage |
| 422 | `Quantity for limit variant orders should be less than 9500.0` | Hard ceiling on limit quantity |
| 422 | `Quantity for market variant orders should be less than 9500.0` | Hard ceiling on market quantity |
| 422 | `Price can't be empty for limit_order Order` | Missing limit price |
| 422 | `Quantity should be greater than y` | Below `min_quantity` |
| 400 | `Price is out of permissible range` | `price > max_price \|\| price < min_price` for the instrument |
| 400 | `Please enter a value lower than x` | Above `ltp + ltp * multiplier_up` |
| 400 | `Please enter a value higher than x` | Below `ltp - ltp * multiplier_down` |
| 400 | `Price should be divisible by 0.01` | Not a multiple of the tick size |
| 400 | `Insufficient funds` | Wallet cannot fund the order |
| 400 | `Minimum order value should be x USDT` | Below `min_notional` |
| 400 | `Instrument is in exit-only mode. You can't add more position.` | `exit_only` is true |
| 400 | `You've exceeded the max allowed position of x USDT.` | Existing position over the threshold |
| 400 | `Order is exceeding the max allowed position of x USDT.` | Position + order value over the threshold |
| 400 | `Trigger price should be greater than the current price` | Buy order, `trigger_price < current price` |
| 400 | `Limit price should be greater than the trigger price` | Buy limit order, `limit price < trigger price` |
| 400 | `Trigger price should be less than the current price` | Sell order, `trigger price > current price` |
| 400 | `Limit price should be less than the trigger price` | Sell order, `limit price < trigger price` |
| 500 | *(blank)* | `Invalid input` |

Every one of these is a **business rejection: never retry it.** Retrying a 422 or a validation 400 cannot succeed and burns rate-limit budget; the correct response is to surface the reason against that specific account in the execution report. The `9500` ceiling and the two "max allowed position" errors also mean a large percentage-based order on a well-funded account can be rejected where the same percentage succeeds on a smaller one - a group trade can therefore fail *only on the biggest accounts*, which is deeply counter-intuitive for a customer and must be explained in the UI.

Note the messages embed live numbers (`x`, `y`) - so error classification must match on a normalised prefix, never on the whole string.

### F9 - Market data, with live measurements

Three feeds, on two hosts. The candlestick endpoint is the one that matters for the product, so it was probed live on 2026-09-04 rather than trusted.

**Candlesticks** - `GET https://public.coindcx.com/market_data/candlesticks`

| Param | Type | Mandatory | Docs say | Live result |
|---|---|---|---|---|
| `pair` | String | YES | Name of the pair | `B-BTC_USDT` (futures) **and** `I-BTC_INR` (INR spot) both return data - VERIFIED live |
| `from` | Integer | YES | EPOCH start, **seconds** | Genuinely mandatory: omitting it returns `{"code":400,"message":"Invalid Request."}` - VERIFIED live |
| `to` | Integer | YES | EPOCH end, **seconds** | as above |
| `resolution` | String | YES | *"'1' OR '5' OR '60' OR '1D'"* | **The docs understate it.** Accepted live: `1, 5, 15, 30, 60, 240, 480, 1D, 1M, D`. Rejected live: `3, 7, 120, 720, 1W, W, 1440` |
| `pcode` | String | YES | *"Static value 'f' … denotes product = futures"* | `pcode=s` and `pcode=f` returned **byte-identical data** for `I-BTC_INR` - VERIFIED live. The parameter appears not to select the series |

Response: `{"s":"ok","data":[{"open","high","low","volume","close","time"}, …]}`, oldest bar first.

Live-measured behaviour that no document states:

| Measurement | Result |
|---|---|
| `time` unit | Epoch **milliseconds** (13 digits, e.g. `1788442200000`) while `from`/`to` are **seconds**. Two units in one endpoint |
| Bar cap | None found. 1-day/1m returned exactly 1440 bars; 7-day/1m returned exactly 10,080 - no truncation, no pagination envelope |
| Practical ceiling | A 30-day 1-minute pull (≈43,200 bars) had not returned inside a 2-minute budget. Treat long fine-grained pulls as slow, not impossible - window them and cache |
| Field order | `open, high, low, volume, close, time` - `close` sits *after* `volume`. Positional parsing would silently swap them |

This is a proper charting-grade feed: nine resolutions from 1 minute to 1 month, arbitrary windows, no bar cap, and it covers INR spot pairs as well as futures. It replaces the documented spot `market_data/candles` endpoint (4 fixed intervals, no windowing) for every charting purpose. The caveat from `01-coindcx-spot-rest.md` stands and is now sharper: this host carries no documented compatibility promise for spot pairs, so the charting layer must degrade gracefully if it changes.

Note this **corrects** a claim in `01-coindcx-spot-rest.md`, which reports that the endpoint "does serve arbitrary resolutions for spot pairs". It does not - the resolution set is a fixed whitelist, verified above. It is simply a much larger whitelist than the docs admit.

**Orderbook** - `GET https://public.coindcx.com/market_data/v3/orderbook/{instrument}-futures/{depth}`. Depth is a path segment; documented values `10`, `20`, `50`. Returns `ts` (epoch), `vs` (version), `asks`, `bids`. The `vs` version field is what makes incremental depth updates safe - see `05-coindcx-websockets.md`.

**Trades** - `GET api.coindcx.com/exchange/v1/derivatives/futures/data/trades?pair={pair}`. Returns `price`, `quantity`, `timestamp`, `is_maker`.

For both, the docs recommend the websocket instead. Use REST for the initial snapshot and post-reconnect repair only.

### Gotchas

| # | Gotcha | Consequence if missed |
|---|---|---|
| G1 | **No `client_order_id`** on any futures endpoint | No safe retry. See Design below |
| G2 | Signed order expires after **10 s** | Pre-signing before a queue hop guarantees rejection under load |
| G3 | `from`/`to` in seconds, `time` in milliseconds, same endpoint | Charts render 1970 or 58000 AD |
| G4 | No `filled_quantity`; derive `total - remaining - cancelled` | Partially-filled-then-cancelled orders mis-accounted |
| G5 | `cancelled` (request) vs `CANCELED` (response) | An alias map is mandatory; case-insensitive matching is not enough |
| G6 | `status` on the create response is always `initial` and the docs say to ignore it | Treating it as real state makes every new order look stuck |
| G7 | `position_margin_type` NULL means `isolated` | A null check that defaults to "unknown" blocks valid orders |
| G8 | `price` must be **null** for market orders, and `time_in_force` must be **absent** (not null) | Two different flavours of "don't send it", both cause rejection |
| G9 | `margin_currency_short_name` is a String on create but an Array on list, with `[]` bracket syntax on `active_instruments` | Wrong arity is a silent empty result on list |
| G10 | `fee_amount` and `ideal_margin` are in **USDT even for INR futures** | Fees under-counted by the INR/USDT rate - roughly 85x |
| G11 | The exchange splits large market orders; parts share `group_id` | Fill totals wrong; duplicate-looking orders that are not duplicates |
| G12 | Cancel URL is documented with a **double slash** | Harmless, but do not copy it into code |
| G13 | `9500` quantity ceiling and the "max allowed position" errors are size-dependent | A group trade can fail *only on the largest accounts* - counter-intuitive, must be explained in the UI |
| G14 | `exit_only` is an exchange-side per-instrument freeze | Every account in a group fails simultaneously; looks like our bug |
| G15 | Max leverage and maintenance margin are **functions of position size** (`dynamic_*` maps) | Leverage accepted at one size is rejected at another |

## Design

### The idempotency substitute, in full

Spot gets this for free. Futures needs all four layers, and even together they are weaker than a key.

```
PlaceFuturesOrder(account, pair, intent):
  L1  acquire advisory lock (account_id, pair)            # blocks a concurrent second attempt
      if not acquired within 2s -> refuse, report "busy"
  L2  write our order row FIRST, state = SENDING,
      with our own internal id and the full request body   # durable before the network
  L3  sign now (not earlier: 10s expiry, G2) and POST orders/create
        200        -> record exchange id, state = ACKED, release lock
        4xx        -> classify from F8, state = REJECTED, release lock, no retry
        timeout /  -> state = AMBIGUOUS, DO NOT RETRY, go to L4
        5xx / reset
  L4  resolve the ambiguity, still holding the lock:
        a. POST orders (list) for this pair, all statuses, both sides,
           created_at within [sent_at - 5s, now + 5s]
        b. match on (pair, side, order_type, total_quantity, price)
        c. exactly one match  -> adopt it, state = ACKED
           zero matches       -> re-check positions (04) for a size delta;
                                 if none, state = NOT_PLACED
           two or more        -> state = NEEDS_HUMAN, alarm, freeze this account
      release lock
```

Step L4b is the weak point and must be stated plainly: if a customer legitimately places two identical orders within the search window, the matcher cannot distinguish them, and `NEEDS_HUMAN` is the only honest outcome. That is why the lock in L1 exists - it makes the two-identical-orders case impossible *from our side*, leaving only orders placed directly on CoinDCX by the customer. Those we cannot control, so the window must be narrow and the freeze must be real.

### Order legalisation, in order

Every check derives from cached `data/instrument` metadata plus current LTP. Refuse, never truncate silently.

```
legalise(instrument, side, type, qty, price, ltp):
  0  instrument.status == "active"                    else REFUSE inactive
  1  not instrument.exit_only  (unless reduce-only)   else REFUSE exit_only
  2  qty  = floor_to_step(qty, quantity_increment)    # DOWN, never up
  3  qty >= max(min_quantity, min_trade_size)         else REFUSE below_min_qty
  4  qty <= min(max_quantity, 9500)                   else REFUSE above_max_qty
  5  if type is market: qty <= max_market_order_quantity  else REFUSE
  6  if type needs a price:
       price = round_to_tick(price, price_increment)
       min_price <= price <= max_price               else REFUSE out_of_range
       side buy : price <= ltp*(1+multiplier_up/100)  else REFUSE band_up
       side sell: price >= ltp*(1-multiplier_down/100) else REFUSE band_down
  7  if stop/TP variant: apply the F7 ordering rule   else REFUSE ordering
  8  notional = qty * (price or ltp)
     notional >= min_notional                         else REFUSE below_min_notional
  9  leverage == cached position leverage for pair    else REFUSE leverage_mismatch
 10  max_leverage_for(notional, dynamic_position_leverage_details) >= leverage
                                                      else REFUSE leverage_too_high_for_size
```

Ten checks, all client-side, all cheap. Every `REFUSE` reason is a string the confirmation screen shows next to that account (see `21-frontend-ux-spec.md`). This is what makes "no wrong size" achievable: an order is either legal before it is sent, or it is never sent.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| `create` response lost, order may exist | State `AMBIGUOUS` in our own row (written before the call) | The L1-L4 protocol above; freeze the account on an unresolvable match | One duplicate leveraged position, or a frozen account |
| Signed payload sits >10 s in a queue | Rejection with an auth/timestamp error, not a business error | Sign at send (G2); alert if send-time minus enqueue-time exceeds 2 s | Whole group fails; looks like an auth outage |
| Stale instrument cache (`exit_only` flipped, bands moved) | Cluster of identical rejections across accounts | Version the cache, record the version on each order, refresh on any band/exit-only rejection | Whole group fails simultaneously |
| Leverage drift between our cache and the exchange | 422 `Order leverage must be equal to position leverage` | Read leverage as part of pre-trade validation, not from cache alone, for the first order on a pair each session | Per-account rejection |
| Large accounts rejected on the 9500 / max-position ceiling while small ones fill | Per-account rejection reason in the report | Pre-trade check 4 and 10; explain in the UI *before* submit | Confusing partial group fill |
| INR-futures fees counted in INR | P&L diverges by roughly the INR/USDT rate | Fees are USDT for INR futures (G10); store `settlement_currency_conversion_price` per order | Every INR-futures P&L wrong |
| Split market order counted as several orders | Duplicate-looking rows sharing `group_id` | Aggregate by `group_id` before reporting fills | Over-stated fill count, wrong average price |
| Unknown status string reaches an exhaustive switch | Adapter throws; reconciler stops | Alias map plus `UNKNOWN` + alarm, never throw (G5, G6) | Reconciliation halts - the worst outcome |
| Charting host changes shape without notice | Candle fetch fails schema validation | Validate the response shape; fall back to the documented spot `candles` endpoint at reduced fidelity | Charts degrade, trading unaffected |

## Open questions for Anand

1. **Do we want leverage at all?** Same question as `02-coindcx-margin-rest.md`, and it decides whether this document gets implemented. Futures is the only product with INR collateral *and* a real position object, but it is also the only one where a lost response cannot be resolved by key. Recommended default: **spot-only v1**, futures reconsidered once the spot fan-out has run clean for a month.
2. **If futures ships, is cross margin needed?** Cross margin is USDT-only, so enabling it splits behaviour by funding currency. Recommended default: **isolated only**, which keeps every account's blast radius to one position.

## Phase hints

- The **market-metadata phase** should build the instrument cache with versioning (F3, Design) even if only spot ships first - the same cache shape serves spot's `markets_details`, and retrofitting versioning later means re-touching every order path.
- The **charting phase** can start immediately and independently: F9 gives it a verified, windowed OHLCV feed with nine resolutions covering both INR spot and futures pairs, plus the ms-vs-seconds trap and the absent bar cap. No dependency on any trading code.
- The **pre-trade validation phase** implements the ten-step legalisation as a pure function with no I/O, which makes it exhaustively property-testable (see `18-testing-correctness-program.md`). Build it before any order is ever sent.
- **No phase implements futures orders** unless open question 1 is answered yes. If it is, futures becomes its own phase *after* spot fan-out is proven, and its first task is the L1-L4 protocol, not order placement.

## Sources

- `_sources/coindcx-docs.txt` lines **7779-9498** - Futures End Points: glossary, `active_instruments`, `instrument`, `trades`, `orderbook`, `candlesticks`, `List Orders`, `Create Order`, `Cancel Order`.
- Live probes on 2026-09-04 against `https://public.coindcx.com/market_data/candlesticks`: mandatory `from`/`to`; the accepted resolution whitelist `1, 5, 15, 30, 60, 240, 480, 1D, 1M, D` and the rejected set `3, 7, 120, 720, 1W, W, 1440`; `pcode=s` and `pcode=f` returning identical data for `I-BTC_INR`; `time` in milliseconds against `from`/`to` in seconds; exact bar counts of 1440 (1 day at 1m) and 10,080 (7 days at 1m) with no truncation.
- Converter fix on 2026-09-04 recovering four error-table cells that a literal `<` had truncated; `_sources/html2txt.mjs` now parks comparison operators before tag stripping. Line numbers after 9145 in `coindcx-docs.txt` shifted by +8 as a result, so line citations in `04`, `05` and `06` may read up to 8 low.
- Cross-references: `01-coindcx-spot-rest.md` (spot contract, and the arbitrary-resolution claim corrected in F9), `02-coindcx-margin-rest.md` (the leverage open question), `04-coindcx-futures-positions-wallets-rest.md` (positions, exit, wallets), `05-coindcx-websockets.md` (live channels, orderbook versioning), `06-coindcx-auth-ratelimits-errors-tos.md` (signing, timestamp units, number serialisation).





