# 04 - CoinDCX futures positions, margin, wallet and TP/SL REST contract

Status: 2026-09-03 | track 04 (ground-truth extraction) | The verbatim request/response contract for the 21 CoinDCX futures endpoints that manage positions, margin, wallets, TP/SL, trades and conversions - plus the four decisions that fall out of it.

Money representation assumed by this doc: **every numeric field below is a JSON double on the wire and MUST be re-read from raw bytes as a decimal string, then held as a `Decimal`** (or scaled integer). No `JSON.parse` number ever reaches sizing, balance, fee or P&L arithmetic. Rationale in Gotchas G1/G2.

Stated once, plainly: "100% error free" is not a property any system that talks to CoinDCX over the internet can have. CoinDCX itself documents 500 and 503 as expected outcomes (V-doc 13910-13920), gives futures orders no idempotency key, and returns a bare `{message:"success"}` for six mutations. What this contract *can* deliver, and where each is engineered: no lost order (D3 write-then-verify, D6 sweep), no duplicate order (D3 single-flight + UNKNOWN-never-retries, G17), no silent divergence (D6 alarms, F19's balance cross-check), no wrong size (D4 clamp-and-floor, F24 instrument limits, U1 units), and partial group failure as a first-class reported outcome (D4's `{confirmed, refused, unknown}`).


## Verdict

- CLOSE POSITION = `POST /exchange/v1/derivatives/futures/positions/exit` with only `{timestamp, id}`. It closes the **whole** position at market and returns a `group_id`, not an order id. Partial close has no dedicated call.
- There is **no `reduce_only` flag anywhere in the futures API** (VERIFIED by exhaustive grep). A partial SELL is an ordinary opposite-side order, so an oversized one silently **flips** the position. Our sizing layer must clamp every reducing order to `abs(active_pos)` and refuse otherwise. This is the single largest correctness risk in the whole product.
- The position object carries **no P&L field**. Unrealised P&L must be computed by us as `active_pos * (mark_price - avg_price)`; realised P&L comes only from `positions/transactions` (`amount` = per-transaction PnL, `fee_amount` = fee).
- Margin currency is `INR` or `USDT` and it is a **collateral/settlement** choice, not a quote choice. Every pair is still `B-<COIN>_USDT` and every price is USDT. VERIFIED live: 499 active INR-margined instruments today, same `pair` strings as the USDT book.
- Unit convention is **self-contradictory across endpoints**: positions/orders/trades report margins and fees in USDT even for INR-margined books, while `positions/transactions` and the add/remove-margin *inputs* are in INR. Table U1 is the contract; hard-code it, never infer it.
- `Get Currency Conversion` is an unauthenticated `GET` returning CoinDCX's **internal notional peg** (live today: `USDTINR = 102.0`, last changed 2026-05-26). It is not a market FX rate and does not let us aggregate INR and USDT accounts as one number. It lets us *label* and *detect peg drift*.
- Three endpoints in this set are **GET-only with a signed JSON body** (`wallets`, `wallets/transactions`, `positions/cross_margin_details`). `undici`/`fetch` cannot send a body on GET - the adapter must use `node:https` directly. VERIFIED by live verb probe (table V1).

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| How to close a full position | `positions/exit` | One call, atomic on the exchange side, auto-splits huge orders itself | Opposite market order sized at `abs(active_pos)` - racy against fills and funding, and can flip |
| How to close part of a position | Opposite-side order via order-placement track, quantity clamped to `abs(active_pos)` | No partial-exit endpoint and no `reduce_only` exist | `positions/exit` then re-enter - two crossings of the spread, two fees |
| Unrealised P&L source | Computed by us from `active_pos`, `avg_price` and a *fresh* mark price from `current_prices/futures/rt` | `mark_price` on the position object is explicitly stale ("not real-time, only for reference") | Trusting `position.mark_price` |
| Realised P&L source | `positions/transactions`, summed by `stage` | Only field the docs call PnL; also the only place funding appears | Deriving from `trades` - has no PnL, only price/qty/fee |
| Fee source for P&L | `fee_amount` echoed on trades/transactions | The instrument endpoint's `maker_fee`/`taker_fee` are public defaults; there is no fee-tier API (FAQ line 14050) | Recomputing fee = notional x taker_fee |
| Cross-currency aggregation | Never. Group analytics show INR and USDT sub-totals side by side, plus an explicitly-labelled "indicative combined at peg 102.0" line | Requirement 7: never silently convert. The peg is not tradable | One blended number using `conversion_price` |
| Timestamp units | Milliseconds | Every code sample computes ms; the prose says "seconds" and is wrong | Trusting the prose tables |
| HTTP verb per route | Hard-coded from live probe table V1, not from the docs' "HTTP Request" line | The docs' verb line is wrong for 5 of 21 routes | Following the docs |
| Idempotency for exit / margin / transfer | Our own single-flight lock + pre/post state read. No exchange-side key exists | `client_order_id` exists **only in the spot API** (grep: lines 2072-6596, zero hits after 7779) | Assuming a retry is safe |
| Margin type | Isolated per position, set once at account onboarding | Cross margin pools all positions in one account, so one bad group trade can liquidate unrelated positions; and cross is USDT-only | Cross margin by default |

## Findings

Host for everything authenticated: `https://api.coindcx.com`. Signing is identical to spot - `HMAC-SHA256(compact-JSON-body, secret)` hex, headers `X-AUTH-APIKEY` + `X-AUTH-SIGNATURE`, `Content-Type: application/json`. See 01-coindcx-spot-rest.md for the signing mechanics; only the futures deltas are recorded here. VERIFIED (V-doc 1278-1402).

### F0. Verb matrix - table V1 (VERIFIED live 2026-09-03)

The docs' `### HTTP Request` line is wrong for 5 routes. Probed each route with a deliberately invalid key: `401 Invalid credentials` proves the route+verb exists (auth runs before routing rejects); `404 not_found` proves it does not.

| Route (under `https://api.coindcx.com`) | GET | POST | Contract |
|---|---|---|---|
| `/exchange/v1/derivatives/futures/orders` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/orders/create` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/orders/cancel` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/orders/edit` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/positions` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/positions/update_leverage` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/positions/add_margin` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/positions/remove_margin` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/positions/cancel_all_open_orders` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/positions/cancel_all_open_orders_for_position` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/positions/exit` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/positions/create_tpsl` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/positions/transactions` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/positions/margin_type` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/trades` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/wallets/transfer` | 404 | 401 | POST |
| `/exchange/v1/derivatives/futures/wallets` | **401** | 404 | **GET + signed body** |
| `/exchange/v1/derivatives/futures/wallets/transactions` | **401** | 404 | **GET + signed body** |
| `/exchange/v1/derivatives/futures/positions/cross_margin_details` | **401** | **404** | **GET + signed body** (docs say POST - wrong) |
| `/api/v1/derivatives/futures/data/stats?pair=` | **200** | **404** | **GET, no auth** (docs say POST - wrong) |
| `/api/v1/derivatives/futures/data/conversions` | **200** | **404** | **GET, no auth** (docs say POST - wrong) |

Consequence: two of our reads (`wallets`, `cross_margin_details`) and one paginated read (`wallets/transactions`) are GET-with-body. Node's `fetch`/`undici` throws `Request with GET/HEAD method cannot have body`. The adapter must issue these with `node:https.request` (or `axios` whose http adapter permits `data` on GET). UNVERIFIED: whether those three also accept `timestamp` as a **query parameter** with an empty body - test with a real key before committing to the GET-with-body path, because a query-param variant would let us use one HTTP client for everything.

### F1. Unit convention - table U1 (VERIFIED, contradictory by design)

For an **INR-margined** position, the same concept is reported in different currencies depending on which endpoint you ask.

| Where | Doc note (line) | Unit for INR-margined |
|---|---|---|
| `positions` / `positions` by pair | "All the margin values are in USDT for INR Futures" (9651, 9911) | **USDT** |
| `orders` list | "fee_amount and ideal_margin values are in USDT for INR Futures" (8677) | **USDT** |
| `trades` | "fee_amount value is in USDT for INR Futures" (11618) | **USDT** |
| `positions/transactions` | "amount, fee_amount, settlement_amount will show in INR for INR margined Futures" (11371) | **INR** |
| `positions/add_margin` **input** | "Input will be in INR for INR margined futures" (10306) | **INR** |
| `positions/remove_margin` **input** | same (10435) | **INR** |
| `wallets`, `wallets/transfer`, `wallets/transactions` | per-row `currency_short_name` | **native to the row** |
| `positions/cross_margin_details` | no note; cross is USDT-only (12105) | **USDT** |
| all prices (`avg_price`, `mark_price`, `price`, `stop_price`, `liquidation_price`) | quote currency is USDT for every pair | **USDT** |

Every value we persist must carry an explicit `(amount, currency)` pair derived from this table, never a bare number. `settlement_currency_avg_price` (position) and `settlement_currency_conversion_price` (order/trade) are the frozen USDT->INR rate at entry, which is how a USDT-reported margin becomes the INR the user actually paid.

### F2. Shared objects

Three response shapes recur. Defined once here; each endpoint below records only its deltas.

**POSITION** (V-doc 9584-9731, 9836-10001, 13060-13175; socket variant 13470-13500)

| Field | Wire type | Meaning / trap |
|---|---|---|
| `id` | string uuid | Position id, **stable per pair forever** (9660). UNVERIFIED whether the INR and USDT book of the same pair share one id - almost certainly two ids; test by holding both |
| `pair` | string | `B-<COIN>_USDT`. Does **not** encode margin currency |
| `active_pos` | double | Signed quantity in base units. **Negative = short.** `0.0` rows are still returned |
| `inactive_pos_buy` / `inactive_pos_sell` | double | Sum of open (unfilled) buy / sell quantities |
| `avg_price` | double | Average entry price, USDT |
| `liquidation_price` | double | Isolated only; meaningless for `crossed` (9678) |
| `locked_margin` | double | Margin in position **after** fees and funding |
| `locked_user_margin` | double | Margin originally invested, **excluding** fees and funding |
| `locked_order_margin` | double | Margin locked by open orders |
| `take_profit_trigger` | double\|null | Full-position TP trigger. `null` in one example, `0.0` in another - treat both as absent |
| `stop_loss_trigger` | double\|null | Full-position SL trigger, same caveat |
| `leverage` | double\|**null** | `null` observed at 9852 - must be nullable in our type |
| `maintenance_margin` | double\|**null** | Cross: the sum over all cross positions, not this one |
| `mark_price` | double\|**null** | **Stale by contract** (9718): "not real-time and is only for reference" |
| `margin_type` | `"crossed"` \| `"isolated"` \| null | Docs use `"Isolated"` capitalised in prose but `"isolated"` in payloads. **Treat null as isolated** (9712) |
| `settlement_currency_avg_price` | double | Average USDT<->INR rate for the position; INR-margined only |
| `margin_currency_short_name` | `"INR"` \| `"USDT"` | The collateral book |
| `updated_at` | int ms | Bumped by trade, funding, add/remove margin, or full-position TP/SL change (9727) |

Absent from POSITION and therefore not obtainable this way: **any P&L field**, any realised-P&L field, any funding-to-date field, `notional`, `roe`. `positions/margin_type` returns a POSITION **missing** `settlement_currency_avg_price` and `margin_currency_short_name` (13060-13081) - the shape is not uniform across endpoints.

**ORDER** (V-doc 8560-8620 list, 8961-8998 create, 12745-12779 edit; socket 13520-13560)

Full field table lives in the futures order-placement track (03). Fields this doc depends on: `id`, `pair`, `side`, `status`, `order_type`, `price`, `stop_price`, `avg_price`, `total_quantity`, `remaining_quantity`, `cancelled_quantity`, `fee_amount`, `stage`, `group_id`, `position_margin_type`, `margin_currency_short_name`, `settlement_currency_conversion_price`, `created_at`, `updated_at`.
- `status` vocabulary (8688-8712, verbatim lowercase in payloads): `open`, `partially_filled`, `filled`, `cancelled`, `partially_cancelled`, `rejected`, `untriggered`. Prose spells them upper-case and spells cancel American ("CANCELED") - payloads use `cancelled`. Query param accepts a comma-separated list.
- `stage` vocabulary (8790-8798): `default` | `exit` | `liquidate` | `tpsl_exit`. This is our only way to tell a user close from a liquidation.
- `order_type` vocabulary: `market_order`, `limit_order`, `stop_limit`, `stop_market`, `take_profit_limit`, `take_profit_market`. Note the `_order` suffix on the first two only, and that the prose tables drop it ("market, limit, stop_limit, ...", 9055) - the payload and the instrument `order_types` array both use `market_order`/`limit_order`.
- `status` on a **create/edit** response is documented as meaningless ("Ignore this... initial for all newly placed orders", 9282) - never treat a create response as terminal.

**ACK** - `{"message":"success","status":200,"code":200}`. Returned by cancel, update_leverage, add_margin, remove_margin, cancel_all_open_orders, cancel_all_open_orders_for_position. Carries **no echo of what changed**, so every ACK must be followed by a state read (see Design D3).

### F3. `POST /exchange/v1/derivatives/futures/orders/cancel` - Cancel Order (V-doc 9368-9490)

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms (see G3) |
| `id` | string | YES | **Order** id (uuid). Sample value `c87ca633-6218-44ea-900b-e86981358cbd` |

Response: ACK. The docs' HTTP line prints a **double slash** (`https://api.coindcx.com//exchange/...`, line 9464) - typo; single slash VERIFIED live.
Gotcha: no batch cancel by order-id list exists for futures (spot has `cancel_multiple_by_ids`; futures does not). Cancelling N orders = N calls against a shared rate limit.
UNVERIFIED: the error string for cancelling an already-filled order. Spot's FAQ gives "This order cannot be cancelled" for filled/cancelled/rejected (line ~14066); assume futures matches but confirm. Experiment: place a `limit_order` 1 tick from LTP with `total_quantity = min_quantity`, let it fill, then cancel it and record the exact body.

### F4. `POST /exchange/v1/derivatives/futures/positions` - List Positions (V-doc 9491-9732)

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `page` | **string** | YES | `"1"`. Pagination starts at 1 (V-doc 6199) |
| `size` | **string** | YES | `"10"`. Default 100, max 1000 (V-doc 6202) |
| `margin_currency_short_name` | **array of string** | OPTIONAL | `["USDT"]` default. `["INR","USDT"]` to get both books in one call |

Response: array of POSITION.
Load-bearing: **you must pass `["INR","USDT"]`** or you will silently see only the USDT book - a "no position" answer that is wrong. Pagination metadata arrives in the `x-pagination` response header, not the body (V-doc 6207-6220). UNVERIFIED whether the futures endpoints emit that header; experiment: request `size=1` with >1 position and inspect response headers.

### F5. `POST /exchange/v1/derivatives/futures/positions` - Get Positions By pairs or position_ids (V-doc 9733-10001)

Same URL as F4, filtered.

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `page`, `size` | string | YES | as F4 |
| `pairs` | **string** | OPTIONAL | comma-separated, no spaces: `"B-BTC_USDT,B-ETH_USDT"` |
| `position_ids` | **string** | OPTIONAL | comma-separated uuids |
| `margin_currency_short_name` | array | OPTIONAL | as F4 |

Response: array of POSITION. Docs: "use either one of the 2 parameters" (9926) - UNVERIFIED what happens if both are sent, or if `pairs` names a pair with no position (empty array, or a zeroed row?). Experiment: request a pair you have never traded.
Naming inconsistency to guard: filter param is `position_ids`, but `update_leverage` calls the same concept `id`.

### F6. `POST /exchange/v1/derivatives/futures/positions/update_leverage` - Update position leverage (V-doc 10003-10177)

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `leverage` | **string** | YES | `"5"` - sent as a string in both samples |
| `pair` | string | OPTIONAL | comma-separated allowed per prose |
| `id` | string | OPTIONAL | position id(s), comma-separated |
| `margin_currency_short_name` | **string** | YES | Type column says String and mandatory, description says `Default ["USDT"]` - **contradictory** (10152). Send the scalar `"USDT"` / `"INR"` |

Response: ACK. Documented errors: `400 Leverage cannot be less than 1x`; `400 Max allowed leverage for current position size = 5x`; `400 Insufficient funds`; `422 Liquidation will be triggered instantly`.
Both code samples embed a **literal newline inside the URL string** (`.../update_leverage\n`, lines 10030 and 10075) - copy-pasting yields a 404. Single-line path VERIFIED live.
Order leverage must equal position leverage or the order is rejected `422 Order leverage must be equal to position leverage` (9126). So leverage is a **per-(pair, account) mode we must set before a group trade**, not a per-order argument. Max leverage is tiered by notional via `dynamic_position_leverage_details` on the instrument endpoint.

### F7. `POST .../positions/add_margin` - Add Margin (V-doc 10178-10308)

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `id` | string | YES | **Position** id |
| `amount` | **"Integer"** | YES | Sample sends `1` (bare number, not string). **Unit: INR for INR-margined, USDT for USDT-margined** (10306) |

Response: ACK.
The `"Integer"` type is almost certainly wrong - `wallets/transfer` documents the same concept as `Float` (V-doc 1997) and `Edit Order` documents `price` as Integer while its own sample sends `0.999501`. UNVERIFIED. Experiment: `add_margin` with `amount: 0.5` on a USDT-margined position and record whether it is accepted, truncated to 0, or rejected. Until settled, **send integers only** and refuse fractional add-margin requests at our boundary.
Isolated-margin only in practice (adding margin to a cross position is not meaningful - cross draws from the wallet).

### F8. `POST .../positions/remove_margin` - Remove Margin (V-doc 10309-10474)

Params identical to F7 (`timestamp`, `id`, `amount`). Response: ACK.
Documented errors - all worth surfacing verbatim to the user:

| Code | Message |
|---|---|
| 422 | `Cannot remove margin as exit or liquidation is already in process` |
| 422 | `Cannot change margin for an inactive position` |
| 422 | `Cannot remove margin more than available in position` |
| 422 | `Liquidation will be triggered instantly` |
| 422 | `Max Y USDT can be removed` (Y interpolated) |
| 400 | `Insufficient funds` |

Note the `Max Y USDT` message says USDT even though the input is INR for INR books - a live example of U1's contradiction leaking into an error string.

### F9. `POST .../positions/cancel_all_open_orders` - Cancel All Open Orders (V-doc 10475-10595)

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `margin_currency_short_name` | array | OPTIONAL | Default `["USDT"]` |

Response: ACK.
Scope is **the entire account** for the given margin currency - every pair, every open order. Wording "cancel all the open orders till time" (10570) suggests `timestamp` may act as a cut-off; UNVERIFIED and dangerous to assume. Guard rail: never expose this to a group action; it would cancel orders our system did not place. The JS sample is also broken - it uses Python `#` comments inside a JS object literal (10490).
Spot's `cancel_all` is rate-limited to 30/60s (V-doc 715-767); no futures figure is published. Assume the same order of magnitude.

### F10. `POST .../positions/cancel_all_open_orders_for_position` - Cancel All Open Orders for Position (V-doc 10596-10720)

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `id` | string | YES | **Position** id |

Response: ACK. This is the safe variant and the one our "cancel this pair's working orders before exiting" step should use. UNVERIFIED whether it also cancels `untriggered` TP/SL orders attached to the position - it matters, because a stale SL left behind after an exit will open a **new opposite position** when it triggers. Experiment: set a TP/SL via F12, call this endpoint, then list orders filtered on `status=untriggered` and check.

### F11. `POST .../positions/exit` - Exit Position (V-doc 10721-10868) - **this is CLOSE POSITION**

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `id` | string | YES | **Position** id. Nothing else - no quantity, no price, no side |

Response - the only endpoint in this set with a `data` envelope:

| Field | Type | Meaning |
|---|---|---|
| `message` / `status` / `code` | string / int / int | `"success"` / 200 / 200 |
| `data.group_id` | string | e.g. `"baf926e6B-ID_USDT1705647709"`. Correlates the child orders when the exchange auto-splits a large exit into parts (10850) |

Behaviour, verbatim from the docs: it is a market-variant "quick exit" that closes the **entire** position; the system "auto-splits the exit order into smaller parts if the order size is huge" and all parts share the `group_id` (10850, 9328). Resulting orders carry `stage: "exit"`, and the resulting transactions carry `stage: "exit"` (11342).
The `group_id` is **not** an order id: to follow the exit to a terminal state you must list orders and match on `group_id`. `List Orders` has no `group_id` filter parameter (V-doc 8620-8676), so this is a client-side filter over a paged list, or a socket subscription on `df-order-update`.
UNVERIFIED: whether calling `exit` twice in quick succession places two exits (no idempotency key exists). Treat as **not** idempotent. Experiment: on a tiny position, fire two `exit` calls ~200 ms apart and check whether a second, opposite position appears.

### F12. `POST .../positions/create_tpsl` - Create Take Profit and Stop Loss Orders (V-doc 10869-11199)

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `id` | string | YES | **Position** id |
| `take_profit.stop_price` | string | YES | trigger price, sent as a **string** |
| `take_profit.limit_price` | string | NO | "Ignore this for now. This is not supported" (11065) |
| `take_profit.order_type` | string | YES | "Only `take_profit_market` is supported for now" (11072) |
| `stop_loss.stop_price` | string | YES | trigger price, string |
| `stop_loss.limit_price` | string | NO | not supported |
| `stop_loss.order_type` | string | YES | "Only `stop_market` is supported for now" (11093) |

The code samples contradict the tables: they send `take_profit_limit` + `limit_price: "0.9"` and `stop_limit` + `limit_price: "0.270"`, and the sample **response** echoes `order_type: "stop_limit"` with `price: 0.27`. The tables are newer and explicit. Send only `take_profit_market` / `stop_market`, omit `limit_price`. UNVERIFIED which wins; experiment: send `stop_limit` and see whether the response echoes `stop_limit` or coerces to `stop_market`.

Response - a two-key object, **not** an array, and **partially failable**:

```
{ "stop_loss":   { ...ORDER... }            // or { "success": false, "error": "..." }
, "take_profit": { "success": false, "error": "TP already exists" } }
```

| Field | Meaning |
|---|---|
| `<leg>` = ORDER | On success, a full ORDER with `status: "untriggered"`, `order_category: "complete_tpsl"`, `stage: "tpsl_exit"`, `side` auto-derived (`"sell"` for a long) |
| `<leg>.success` | `false` when that leg failed |
| `<leg>.error` | reason, e.g. `"TP already exists"` |

This is the **only** endpoint in the set that reports per-leg partial success, and it does so with an HTTP 200. Our client must treat `{success:false}` on either key as a failure of that leg and never read the top-level HTTP status as the outcome. `"TP already exists"` also tells us the call is **not** an upsert - to move a TP you must first cancel the existing untriggered order.
Also note: TP/SL created here are **full-position** orders (`stage: tpsl_exit`), and their triggers are mirrored onto `position.take_profit_trigger` / `position.stop_loss_trigger`. That gives us a cheap way to verify per-account TP/SL parity across a group without listing orders.

### F13. `POST .../positions/transactions` - Get Transactions (V-doc 11200-11436) - **the P&L ledger**

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `stage` | string | YES | `all` \| `default` \| `funding` \| `exit` \| `tpsl_exit` \| `liquidation`. The samples' comment says "all OR default OR funding"; the table adds the other three (11330-11347) |
| `page`, `size` | string | YES | |
| `margin_currency_short_name` | array | OPTIONAL | default `["USDT"]` |

Response: array of

| Field | Type | Meaning |
|---|---|---|
| `pair` | string | |
| `stage` | string | as above; `default` excludes quick-exit and full-position TP/SL |
| `amount` | double | **The PnL of this transaction.** Unit: INR for INR books, USDT for USDT books (11371) |
| `fee_amount` | double | Fee for this transaction; one transaction per **trade**, not per order |
| `price_in_inr` | double | Trade price in INR |
| `price_in_btc` | double | Trade price in BTC - arrives in exponential notation (`1.85407055628e-7`) |
| `price_in_usdt` | double | Trade price in USDT |
| `source` | `"user"` \| `"system"` | `system` = liquidation |
| `parent_type` | string | `"Derivatives::Futures::Order"` - a Ruby class name |
| `parent_id` | string | the order id |
| `position_id` | string | |
| `settlement_amount` | double | "Ignore this" |
| `margin_currency_short_name` | string | |
| `created_at` / `updated_at` | int ms | |

The sample row shows `amount: 0.0` with `fee_amount: 8.899963104` and `price_in_inr: 1.0` - i.e. an entry leg (no PnL yet) on an INR book. There is **no `pair`-level or date-range filter** documented; only `stage` + paging. Reconciling one account's realised P&L therefore means walking pages until `created_at` passes our watermark. `parent_id` is the join key back to our order record.
UNVERIFIED: whether `from_date`/`to_date` are accepted here as they are on `trades`. Experiment: send them and compare row counts.

### F14. `POST /exchange/v1/derivatives/futures/trades` - Get Trades (V-doc 11437-11663)

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `pair` | string | **YES** | single pair only - no comma-separated form documented |
| `order_id` | string | OPTIONAL | |
| `from_date` / `to_date` | string | YES | `YYYY-MM-DD`. No timezone stated - **UNVERIFIED** (IST or UTC?). Experiment: place a trade at 00:15 IST and query only that date |
| `page`, `size` | string | YES | |
| `margin_currency_short_name` | array | YES (table) / omitted in the Python sample | send it |

Response: array of

| Field | Type | Notes |
|---|---|---|
| `price`, `quantity` | double | |
| `is_maker` | bool | |
| `fee_amount` | double | **USDT even for INR books** (11618) |
| `pair`, `side` | string | |
| `timestamp` | double | **Fractional milliseconds**: `1705645534425.8374` (11544). Not an integer. Truncate deliberately, and never use it as a primary key |
| `order_id` | string | |
| `settlement_currency_conversion_price` | double | frozen USDT<->INR rate for the order; `0.0` on USDT books |
| `margin_currency_short_name` | string | |

No trade id field. `pair` being mandatory means "all my fills today" costs one call per pair held.

### F15. `GET https://public.coindcx.com/market_data/v3/current_prices/futures/rt` - Get Current Prices RT (V-doc 11664-11797)

No auth, no params. VERIFIED live 2026-09-03: HTTP 200, ~125 KB, **536 pairs**, all `B-*_USDT`, exactly the 14 documented per-pair fields.

Top level: `ts` (int ms), `vs` (int version), `prices` (map keyed by pair).

| Field | Meaning | Confidence |
|---|---|---|
| `ls` | **last price** | VERIFIED (glossary 7813) |
| `mp` | **mark price** | VERIFIED (glossary 7823) |
| `h` / `l` | 24h high / low | VERIFIED |
| `v` | 24h volume | VERIFIED (glossary "volume 24h") |
| `pc` | price change percent | VERIFIED |
| `fr` | funding rate | UNVERIFIED - table leaves it blank; inferred from name and magnitude (`8.893e-5`) |
| `efr` | estimated/effective funding rate | UNVERIFIED, same reasoning |
| `mkt` | third-party market symbol (`"BTCUSDT"`) | VERIFIED |
| `skw` | skew | UNVERIFIED - blank in docs; observed small signed integer (`34`, `-207`) |
| `btST` / `ctRT` | source tick send time / our receive time | partly documented |
| `bmST` / `cmRT` | source mark-price send time / our receive time | partly documented |

Live sample: `B-BTC_USDT` -> `{"ls":81126.7,"mp":81123.4,"fr":0.00008893,"efr":0.0001,...}`.
This one unauthenticated call is the right mark-price source for P&L across all accounts: **one poll serves all 100 accounts**, so it costs nothing per account and cannot be rate-limited per key. Do not derive marks from position objects.

### F16. `GET /api/v1/derivatives/futures/data/stats?pair=` - Get Pair Stats (V-doc 11798-11984)

Docs say POST + signed; **VERIFIED live: plain GET, no authentication, POST returns 404.**
Query param: `pair` (single). Body/`timestamp` not required.

| Field | Shape |
|---|---|
| `price_change_percent` | `{1H,1D,1W,1M}` doubles |
| `high_and_low` | `{1D:{h,l}, 1W:{h,l}}` - only 1D and 1W, despite `price_change_percent` having 1M |
| `position.count_percent` | `{long,short}` - % of *accounts* long/short |
| `position.value_percent` | `{long,short}` - % of *notional* long/short |

Live 2026-09-03 `B-BTC_USDT`: `{"price_change_percent":{"1H":0.34,"1D":4.925,"1W":0.79,"1M":26.96},"high_and_low":{"1D":{"h":81333.4,"l":76927.3},"1W":{"h":81500.0,"l":76151.9}},"position":{"count_percent":{"long":55.59,"short":44.41},"value_percent":{"long":38.12,"short":61.88}}}`. Sentiment garnish for the chart panel; not needed for correctness.

### F17. `GET .../positions/cross_margin_details` - Get Cross Margin Details (V-doc 11985-12166)

Docs say POST; **VERIFIED live: GET (401 with a bad key), POST returns 404.** Auth required, signed body over `{timestamp}`.
Request: `timestamp` only. Note the doc's own line: "**Cross margin mode is not supported on INR margined Futures**" (12105) - so this endpoint describes the USDT book only.

| Field | Meaning | Use |
|---|---|---|
| `pnl` | **Unrealised PnL of all cross positions** | the only P&L number the API hands us directly |
| `total_wallet_balance` | wallet excluding PnL, funding and fees of active positions | denominator candidate for account equity |
| `total_account_equity` | `total_wallet_balance + pnl` | our headline per-account equity for cross accounts |
| `maintenance_margin` | cumulative MM of all cross positions | |
| `total_initial_margin` | cross + isolated positions and orders | described as "maintenance" in the text - **the label contradicts the key name** (12130) |
| `total_initial_margin_isolated` | isolated positions and orders | |
| `total_initial_margin_crossed` | cross positions, excluding orders | |
| `total_open_order_initial_margin_crossed` | initial margin locked by open orders | |
| `available_balance_cross` | tradable in cross mode | pre-trade affordability check |
| `available_balance_isolated` | tradable in isolated mode | pre-trade affordability check |
| `margin_ratio_cross` | **liquidation at >= 1.0** | our per-account risk alarm |
| `withdrawable_balance` | to spot wallet | |
| `available_wallet_balance` | "Ignore this" | |
| `updated_at` | "Ignore this" | |

Live sample from the docs: `available_balance_cross == available_balance_isolated == withdrawable_balance == 6.42080088` - suspiciously identical, so do not assume they diverge in a way we can rely on. All values USDT.

### F18. `POST .../wallets/transfer` - Wallet Transfer (futures) (V-doc 12167-12340)

Disambiguation: **two different transfer endpoints exist.** This one, and the generic `POST /exchange/v1/wallets/transfer` (V-doc 1830-2018) which takes `source_wallet_type` / `destination_wallet_type` (`spot`|`futures`) and types `amount` as **Float**. Prefer the generic one if fractional amounts matter (see G4).

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `transfer_type` | string | YES | `"deposit"` = spot -> futures; `"withdraw"` = futures -> spot |
| `amount` | **"Integer"** | YES | in `currency_short_name` units |
| `currency_short_name` | string | YES | `"USDT"` or `"INR"` |

Response: array of WALLET rows (same shape as F19), reflecting the post-transfer state.
`transfer_type` semantics are stated from the futures wallet's point of view - easy to invert. Errors documented on the generic endpoint apply in spirit: `422 Invalid amount`, `422 Invalid currency`, `422 This feature is not enabled yet.`, `404 Wallet not found`, `400 Insufficient funds`.
Not idempotent and no client key. A retried transfer moves money twice. Treat as the highest-risk call in this document; gate it behind a single-flight lock plus a pre/post `wallets/transactions` read.

### F19. `GET /exchange/v1/derivatives/futures/wallets` - Wallet Details (V-doc 12341-12482)

GET with signed body over `{timestamp}` (VERIFIED live: GET 401, POST 404). Returns **both** the INR and USDT futures wallets - no filter param.

| Field | Type | Meaning |
|---|---|---|
| `id` | string uuid | futures wallet id |
| `currency_short_name` | string | `"USDT"` / `"INR"` |
| `balance` | **string** | "Ignore this" per the field table (12459) - yet the NOTE at 12326 says `Total wallet balance = balance + locked_balance`. **Direct contradiction inside one page** |
| `locked_balance` | **string** | initial margin locked in *isolated* orders and positions |
| `cross_order_margin` | **string** | initial margin locked in cross **orders** |
| `cross_user_margin` | **string** | initial margin locked in cross **positions** |

All four numbers arrive as **JSON strings** here (`"6.1693226"`), unlike positions where they are numbers. Good for us - parse them as decimals directly.
Resolution of the contradiction: use `total = balance + locked_balance` per the NOTE, and cross-check against `cross_margin_details.total_wallet_balance` for USDT accounts. If they disagree, alarm; do not pick a winner silently.

### F20. `GET .../wallets/transactions?page=&size=` - Wallet Transactions (V-doc 12483-12638)

GET with signed body (VERIFIED live: GET 401, POST 404). Paging is in the **query string**, not the body (`?page=1&size=1000`).

| Field | Type | Meaning |
|---|---|---|
| `derivatives_futures_wallet_id` | string | joins to F19 `id` |
| `transaction_type` | `"credit"` \| `"debit"` | credit = into the futures wallet |
| `amount` | double | |
| `currency_short_name` / `currency_full_name` | string | `"USDT"` / `"Tether"` |
| `reason` | enum | `by_universal_wallet` (spot<->futures transfer), `by_futures_order` (any order-driven movement), `by_futures_funding` (funding, **cross positions only**) |
| `created_at` | int ms | |

No transaction id in the response, so dedupe must key on `(wallet_id, created_at, amount, reason, transaction_type)`. `by_futures_funding` appearing only for cross positions means **isolated-position funding is not visible here** - it shows up inside `positions/transactions` with `stage: funding` instead.

### F21. `POST /exchange/v1/derivatives/futures/orders/edit` - Edit Order (V-doc 12639-12953)

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `id` | string | YES | order id |
| `total_quantity` | "Integer" | YES | sample sends `12` |
| `price` | "Integer" | YES | sample sends `0.999501` - **so "Integer" means "numeric"** |

Response: **array** containing one ORDER, with `display_message: "Order edited successfully"` and `status: "open"`.
Constraint, verbatim: "**Edit order is only supported on USDT margined Futures at the moment**" (12849). So for INR accounts, amend = cancel + replace, which is not atomic and can leave the account flat during a fast market. Both `total_quantity` and `price` are mandatory, so this is a replace, not a patch: to change only the price you must re-send the current quantity, which you must first read - and that read can race a partial fill. Recommendation: our v1 does not offer edit; it offers cancel-and-replace uniformly across both books so behaviour does not diverge by margin currency.

### F22. `POST .../positions/margin_type` - Change Position Margin Type (V-doc 12954-13175)

| Param | Type | Mand. | Notes |
|---|---|---|---|
| `timestamp` | int | YES | ms |
| `pair` | string | YES | `B-BTC_USDT` format |
| `margin_type` | string (table says "Integer" - wrong) | YES | `"isolated"` or `"crossed"` |

Response: array with one POSITION, **missing** `settlement_currency_avg_price` and `margin_currency_short_name`.
Two hard preconditions, verbatim: changeable "only when you don't have any active position or open orders in the instrument" (13089), and "**Cross margin mode is only supported on USDT margined Futures**" (13092). Together these make margin type an onboarding-time, per-pair setting - never something a group trade can flip mid-flight. There is no `margin_currency_short_name` request param, so for an account that holds both books, UNVERIFIED which book is affected. Experiment: hold an INR-margined and a USDT-margined position in the same pair, call with `crossed`, and see which errors.

### F23. `GET /api/v1/derivatives/futures/data/conversions` - Get Currency Conversion (V-doc 13176-13320)

Docs say POST + signed; **VERIFIED live: unauthenticated GET, POST returns 404.** No params.

| Field | Type | Live value 2026-09-03 |
|---|---|---|
| `symbol` | string | `"USDTINR"` |
| `margin_currency_short_name` | string | `"INR"` |
| `target_currency_short_name` | string | `"USDT"` |
| `conversion_price` | double | **`102.0`** (docs example: `89.0`) |
| `last_updated_at` | int ms | `1779797515701` = **2026-05-26T12:11:55Z** |

Verbatim meaning (13303): "When using INR margin, CoinDCX notionally converts INR to USDT & vice-versa at this conversion rate. This conversion rate may change periodically due to extreme market movements."
The live `last_updated_at` is ~100 days old, which settles the nature of the number: it is a **slowly-adjusted internal peg, not a market rate**. Response is an array of one element today; treat it as an array keyed by `symbol` in case more pairs appear.

### F24. Instrument constraints that gate every order (V-doc 7886-8178)

Not in my endpoint list but load-bearing for "no wrong size", and **VERIFIED live for both margin currencies** on `B-BTC_USDT` via `GET /exchange/v1/derivatives/futures/data/instrument?pair=&margin_currency_short_name=` (unauthenticated):

| Field | USDT book | INR book | Note |
|---|---|---|---|
| `pair`, `settle_currency_short_name`, `quote_currency_short_name` | `B-BTC_USDT`, `USDT`, `USDT` | identical | **the contract is USDT-quoted in both books** |
| `min_notional` | 60 | 60 | in USDT in both |
| `min_quantity` / `quantity_increment` | 0.001 / 0.001 | identical | |
| `price_increment` | 0.1 | identical | |
| `max_market_order_quantity` | 120 | identical | market orders capped separately from `max_quantity` |
| `maker_fee` / `taker_fee` | 0.0236 / 0.059 | identical | docs example says 0.025/0.075 - **stale** |
| `multiplier_up` / `multiplier_down` | 4 / 4 | identical | limit price band vs LTP |
| `max_leverage_long` | 20 | 20 | docs: "Ignore this" - and `dynamic_position_leverage_details` has a 100x tier, so it really is wrong |
| `dynamic_position_leverage_details` | `{2:2e8, ... 50:5e6, 100:20000}` | `{2:3.38e7, ... 50:650000, 100:10000}` | **DIFFERENT per margin currency** |

The USDT/INR ratio across those leverage tiers is 5.92, 6.15, 6.15, 6.15, 6.15, 5.77, 5.13, 5.38, 4.62, 7.69, 2.0 - **not a constant**, so the INR table is an independent risk table, not a currency conversion of the USDT one. Consequence: cache instrument metadata per `(pair, margin_currency_short_name)`, never per pair. UNVERIFIED whether the INR-book thresholds are denominated in INR or USDT; experiment: set 100x leverage on an INR-margined pair and grow the position past 10,000 INR (~98 USDT) and then past 10,000 USDT, recording where `Max allowed leverage ... = Nx` first fires.
Minimum tradable quantity is `max(min_quantity, 10^-target_precision)` and must also satisfy `min_notional` (FAQ 13974-13990).

### Q(a) Exactly which call implements CLOSE POSITION, and what it needs

`POST /exchange/v1/derivatives/futures/positions/exit` with body `{"timestamp": <ms>, "id": "<position_id>"}`. Nothing else. VERIFIED (V-doc 10721-10868).

| Requirement | How we satisfy it |
|---|---|
| the `position_id` | from `POST .../positions` filtered by `pairs` **and** `margin_currency_short_name: ["INR","USDT"]`. `position.id` is stable per pair, so it can be cached, but must be re-read if the account's book changed |
| a non-zero position | `active_pos != 0`. A zero row is still returned by the list call, so "position exists" is not the same as "position is open" |
| no interfering working orders | call `cancel_all_open_orders_for_position` first, else a resting entry order can re-open the position seconds after the exit fills |
| terminal-state tracking | keep `data.group_id`, then poll `POST .../orders` (`status: "open,partially_filled,filled,cancelled,partially_cancelled,rejected"`) and match `group_id`, or subscribe to `df-order-update` on the socket. `exit` returns **no order id** |
| the confirmation | re-read the position; **closed means `active_pos == 0`**, not "the ACK said success" |

Distinctions that matter for the product spec:
- **SELL ALL vs CLOSE POSITION.** For a futures account these are the same intent, and `exit` implements both. "SELL ALL" phrased as a spot concept (dump the whole base balance) does not exist in the futures API - there is no base-currency balance, only a signed position.
- **Partial close has no endpoint.** It is an ordinary opposite-side order. Because **no `reduce_only` exists**, a quantity greater than `abs(active_pos)` will close the position *and open a new one in the opposite direction*. Our sizing must compute `qty = min(requested, abs(active_pos))`, round **down** to `quantity_increment`, and refuse if the result is below `min_quantity` or `min_notional`. Rounding up here is how you accidentally go short.
- Percent-of-position sizing (requirement 5) resolves against `abs(active_pos)`, floor-rounded to `quantity_increment`. At 100% prefer `exit` over a computed order: `exit` cannot be raced by a funding tick or a partial fill changing `active_pos` between read and send.

### Q(b) What a position object contains that we can use for P&L

| We need | Available? | Source |
|---|---|---|
| Signed size | yes | `active_pos` (negative = short) |
| Entry price | yes | `avg_price` (USDT) |
| Current mark | **stale on the object** | use `mp` from `current_prices/futures/rt` instead |
| **Unrealised P&L** | **NO FIELD - we compute it** | `uPnL_USDT = active_pos * (mark - avg_price)` |
| Margin invested | yes | `locked_user_margin` (excl. fees/funding), `locked_margin` (incl.) |
| Fees+funding to date on the position | derived | `locked_user_margin - locked_margin` |
| Realised P&L | not on the position | sum `positions/transactions.amount` where `stage in (default, exit, tpsl_exit, liquidation)` |
| Funding paid | not on the position | `positions/transactions` with `stage: funding` |
| Fees paid | not on the position | sum `positions/transactions.fee_amount` |
| Liquidation distance | yes (isolated) | `liquidation_price`; for cross use `margin_ratio_cross` from `cross_margin_details` (alarm >= 1.0) |
| Return on margin | derived | `uPnL / locked_user_margin` |
| FX basis for an INR book | yes | `settlement_currency_avg_price` (entry peg) vs `conversions.conversion_price` (current peg) |

`unit_contract_value == 1.0` for every perpetual and `is_inverse == false`, `is_quanto == false` (V-doc 8022-8036), so the linear formula above needs no contract multiplier. Aggregations for group analytics: sum `uPnL` **within a margin currency only**, and never mix the USDT sum with the INR sum.

### Q(c) Margin currency options and how INR collateral works

- Exactly two values, verbatim: `"INR"` and `"USDT"`. They appear as a **scalar string** on write endpoints (`orders/create`, `update_leverage`, `wallets/transfer`) and as an **array** on read endpoints (`positions`, `orders`, `trades`, `transactions`, `cancel_all_open_orders`). Default when omitted is `USDT` / `["USDT"]` **everywhere** - omitting it on a read is how you fail to see an INR position.
- INR is **collateral only**. VERIFIED live: the INR book lists 499 active instruments, all named `B-<COIN>_USDT`, and `GET .../data/instrument?...&margin_currency_short_name=INR` returns `settle_currency_short_name: "USDT"`, `quote_currency_short_name: "USDT"`, `min_notional: 60` (USDT). Prices, sizes and notionals are USDT in both books.
- Mechanics: you fund an INR futures wallet (`wallets/transfer` with `currency_short_name: "INR"`), CoinDCX notionally converts INR to USDT at the peg (`conversions.conversion_price`) to compute margin, and freezes the peg used onto the position as `settlement_currency_avg_price` and onto each order/trade as `settlement_currency_conversion_price`. Margins and fees are then *reported* in USDT (U1) while `add_margin`/`remove_margin` *inputs* and `positions/transactions` amounts are in INR.
- Restrictions that differ by margin currency:

| Capability | USDT book | INR book |
|---|---|---|
| Isolated margin | yes | yes |
| **Cross margin** | yes | **NO** (12105, 13092) |
| `cross_margin_details` | meaningful | not applicable |
| **Edit Order** | yes | **NO** (12849) |
| Leverage tiers | own table | **different table** (F24) |

Because cross margin and edit are USDT-only, an account model that assumes them will break on INR accounts. Design for the intersection: **isolated margin, cancel-and-replace, no cross**. That is also the safer choice (isolated confines a bad group trade to one position).

### Q(d) What Get Currency Conversion is for, and whether it solves our INR/USDT problem

What it is for: it publishes the single peg CoinDCX uses to translate INR collateral into the USDT terms the futures engine works in. It is the number that explains why an INR-margined position reports its margin in USDT.

Does it solve requirement 7? **Partly - it solves labelling, not conversion.**

| Question | Answer |
|---|---|
| Can we use it to size an INR-funded account's order? | Yes, and we must: capital in INR / peg = capital in USDT, then notional and `min_notional` checks happen in USDT |
| Can we use it to display an INR account's P&L in INR? | For realised P&L, no conversion is needed at all - `positions/transactions.amount` is already INR. For unrealised, `uPnL_INR = uPnL_USDT * conversion_price`, labelled as indicative |
| Can we use it to add an INR account's P&L to a USDT account's P&L for a group total? | **No.** It is CoinDCX's internal peg (102.0, unchanged since 2026-05-26), not a market rate and not a rate anyone will trade at. A blended total would be a silent conversion, which requirement 7 forbids |
| Does it let us detect a problem? | Yes, and this is its best use. Poll it; when `last_updated_at` changes, every INR position's entry peg (`settlement_currency_avg_price`) is now stale relative to the live peg. That is a real, reportable P&L event, and it is invisible unless we watch this endpoint |
| Cost of polling | Zero: unauthenticated GET, so one poll serves all accounts and no API key budget is consumed |

Product consequence: group analytics render two columns (INR-margined, USDT-margined) plus an explicitly-labelled "indicative combined @ 102.0 (peg of 2026-05-26)" line. A single unlabelled number is not offered.

### Gotchas

| # | Gotcha | Evidence | What it costs if missed |
|---|---|---|---|
| G1 | **The signature covers the exact byte string of the body.** Python signs `json.dumps(body, separators=(',',':'))`; JS signs `JSON.stringify(body)`. Any re-serialisation by an HTTP client (key reorder, added space, `Buffer` round-trip) invalidates it. Sign the string, then POST **that string** as a raw body - never hand an object to the client | V-doc 1382-1390 | 401 on every call, intermittently |
| G2 | Numbers arrive as JSON doubles: `price_in_btc: 1.85407055628e-7`, `avg_price: 0.2962`, `fee_amount: 8.899963104`. `JSON.parse` turns these into binary floats before you can intervene | 11258-11262 | silent P&L drift; a sized order off by one increment |
| G3 | **Every request table says "EPOCH timestamp in seconds"; every code sample sends milliseconds** (`Date.now()`, `int(round(time.time()*1000))`). Use ms | 9503-9510 and ~20 other samples | universal 401/422 |
| G4 | `amount` is typed **Integer** on `add_margin`, `remove_margin`, futures `wallets/transfer`; `price` is typed Integer on `edit` while its own sample sends `0.999501`; the generic `wallets/transfer` types the same `amount` as **Float** | 10298 / 10435 / 12290 / 12920 / 1997 | either a rejected fractional add-margin, or a silently truncated transfer |
| G5 | Nulls arrive **as the four-character string `"None"`** in some payloads (`group_id`, `order_category`, `group_status`, `display_message`) and as JSON `null` in others | `"None"` at 8575-8613, 8971-8977, 11000-11002; `null` at 8582, 12759-12766 | `if (order.group_id)` is truthy for a missing group |
| G6 | `trades[].timestamp` is a **fractional** millisecond double: `1705645534425.8374` | 11544 | integer parse throws, or an ordering key collides |
| G7 | The docs' `### HTTP Request` verb is wrong for 5 routes; `data/stats` and `data/conversions` need **no auth at all**; three routes are **GET with a signed body** | table V1, VERIFIED live | 404s that look like outages; a fetch() that throws on GET+body |
| G8 | Read endpoints default to `["USDT"]`. An INR-margined position, order or transaction is **invisible** unless you pass `margin_currency_short_name` | 9640, 8672, 11377 | "no position" on an account that holds one - then a duplicate entry order |
| G9 | `positions` returns rows with `active_pos: 0.0`. Presence of a row is not presence of a position | 9584-9590 | closing nothing, or dividing by zero in ROE |
| G10 | `mark_price` on a position is documented stale; `leverage`, `maintenance_margin`, `mark_price` can all be `null` | 9718, 9852-9854 | a P&L number computed from a mark hours old |
| G11 | `create_tpsl` returns **HTTP 200 with a per-leg `{success:false,error}`**, and is not an upsert (`"TP already exists"`) | 11015-11018 | believing an SL is armed when only the TP landed |
| G12 | `exit` returns a `group_id`, **not** an order id, and `List Orders` has no `group_id` filter | 10820-10852, 8620-8676 | an exit you cannot follow to a terminal state |
| G13 | The same concept is named `position_ids` (get positions), `id` (update_leverage, add_margin, exit), and `pairs` vs `pair` on adjacent endpoints | 9911-9926 vs 10140-10150 | a filter that silently matches nothing |
| G14 | The POSITION shape differs by endpoint: `margin_type` response omits `settlement_currency_avg_price` and `margin_currency_short_name` | 13060-13081 | a parser that assumes a fixed shape |
| G15 | `update_leverage`'s two code samples embed a literal newline inside the URL string; `Cancel Order`'s HTTP line has a double slash | 10030, 10075, 9464 | copy-paste 404 |
| G16 | The `cancel_all_open_orders` JS sample contains Python `#` comments - it does not parse | 10490-10493 | wasted debugging |
| G17 | **No `client_order_id` in the futures API.** It exists only in spot (lines 2072-6596; zero hits after 7779). No `reduce_only` either (zero hits anywhere) | grep, VERIFIED by absence | every retry is a potential duplicate order; every oversized sell can flip a position |
| G18 | `wallets` types its four amounts as **strings**; `positions` types the analogous fields as numbers | 12440-12446 vs 9584-9600 | a `+` that concatenates |
| G19 | Instrument `maker_fee`/`taker_fee` are **public defaults** and there is no fee-tier API. Only the fee echoed on the order/trade/transaction is the account's real fee | FAQ 14050; live 0.0236/0.059 vs doc 0.025/0.075 | P&L wrong by the tier discount on every trade |
| G20 | `orders/create` rejects a `timestamp` more than **10 seconds** stale. Fanning out to 100 accounts serially will blow this budget if any call blocks | 9038 | tail accounts in a group trade rejected while early ones filled |
| G21 | Rate limits: only spot limits are published (V-doc 715-767); the FAQ gives a global **16/sec, 960/min**. No futures figures exist. 100 accounts x (positions + wallet + orders) is ~300 calls per reconciliation sweep | FAQ 13924 | 429 storms mid-fan-out |
| G22 | `margin_type` request param is typed "Integer" but takes the strings `"isolated"`/`"crossed"`; payloads use lowercase while prose capitalises `"Isolated"` | 13122-13126 | an enum comparison that never matches |

## Design

### D1. Adapter boundary types (illustrative)

```ts
type MarginCurrency = 'INR' | 'USDT';
type Money = { amount: Decimal; ccy: MarginCurrency };      // never a bare number
type Qty   = Decimal;                                        // base units, signed for positions

// Raw wire shape. All numerics kept as strings by a reviving JSON parser
// (json-bigint style: parse numbers to string, never to double).
interface RawPosition {
  id: string; pair: string;
  active_pos: string; inactive_pos_buy: string; inactive_pos_sell: string;
  avg_price: string; liquidation_price: string;
  locked_margin: string; locked_user_margin: string; locked_order_margin: string;
  take_profit_trigger: string | null; stop_loss_trigger: string | null;
  leverage: string | null; maintenance_margin: string | null; mark_price: string | null;
  margin_type: 'crossed' | 'isolated' | null;
  settlement_currency_avg_price: string;
  margin_currency_short_name: MarginCurrency;
  updated_at: number;
}

// Normalised. Note margins are USDT even on INR books (table U1).
interface Position {
  key: `${string}:${MarginCurrency}`;        // pair + book. NEVER pair alone
  exchangePositionId: string;
  size: Qty;                                 // signed; 0 => flat
  side: 'long' | 'short' | 'flat';
  entryPrice: Decimal;                       // USDT
  marginInvested: Money;                     // USDT by U1
  marginNow: Money;                           // USDT by U1
  feesAndFundingToDate: Money;               // marginInvested - marginNow, USDT
  liquidationPrice: Decimal | null;          // null when crossed
  marginType: 'isolated' | 'crossed';        // null coerced to isolated
  entryPeg: Decimal | null;                  // settlement_currency_avg_price, INR books only
  tpTrigger: Decimal | null; slTrigger: Decimal | null;  // 0 and null both => null
  updatedAt: number;
}
```

`null`-coercion rules the adapter applies once, at the boundary: `"None" -> null`; `margin_type: null -> 'isolated'`; `take_profit_trigger: 0 -> null`; `mark_price` **discarded** (never surfaced).

### D2. Position lifecycle, as this API exposes it

```
                   orders/create (entry)
    FLAT ─────────────────────────────────────────► OPEN
   (active_pos=0)                                  (active_pos != 0)
      ▲  ▲                                          │  │  │
      │  │                                          │  │  └─ add_margin / remove_margin
      │  │                                          │  │        (isolated only; ACK only)
      │  │           positions/exit                 │  │
      │  └──────────────────────────────────────────┘  │
      │        (whole position, market, group_id)      │
      │                                                │
      │   orders/create opposite side, qty < |size|    │
      │  ◄─────────── PARTIAL REDUCE ──────────────────┘
      │        (no reduce_only: qty > |size| FLIPS)
      │
      │   create_tpsl → untriggered order, stage=tpsl_exit
      └────── triggered ──────────────────────────────┐
      │                                                │
      └────── liquidation (source=system, stage=liquidate)

  Truth for "is it closed?":  re-read positions ⇒ active_pos == 0
  Truth for "did my exit fill?":  orders filtered by group_id reach a terminal status
  ACK ({message:success}) proves NOTHING about position state.
```

Terminal order statuses: `filled`, `cancelled`, `partially_cancelled`, `rejected`. Non-terminal: `open`, `partially_filled`, `untriggered`.

### D3. Write-then-verify, because every mutation returns a bare ACK

Six endpoints (`orders/cancel`, `update_leverage`, `add_margin`, `remove_margin`, `cancel_all_open_orders`, `cancel_all_open_orders_for_position`) return `{message:"success",status:200,code:200}` and echo nothing. `exit` echoes only a `group_id`. So every mutation is a two-phase operation:

```
1. read   pre-state  (position / order / wallet)  → persist as the intent's "before"
2. write  the mutation, exactly once, under a per-(account,pair) single-flight lock
3. record the attempt as PENDING with the request bytes and a monotonic attempt id
4. read   post-state, with backoff, until it satisfies the intent's postcondition
5. classify: CONFIRMED | REFUSED (4xx with a body) | UNKNOWN (timeout / 5xx / 429)
6. UNKNOWN never retries the write. It escalates to reconciliation, which decides
   from the exchange's own state whether the write landed.
```

Postconditions worth hard-coding:

| Intent | Postcondition |
|---|---|
| exit | `active_pos == 0` **and** every order with our `group_id` is terminal |
| cancel order | that order's status is `cancelled` or `partially_cancelled` (or already `filled` - a losing race, not an error) |
| update_leverage | `position.leverage == requested` |
| add_margin(x) | `locked_user_margin` increased by x (converted per U1) |
| create_tpsl | `position.stop_loss_trigger == requested` **and** the SL leg's `success !== false` |
| wallets/transfer(x) | a new `wallets/transactions` row with matching `amount`, `reason: by_universal_wallet`, `created_at` > our send time |

### D4. Group CLOSE / SELL algorithm (per account, run in parallel across the group)

```
closeOrReduce(account, pair, book, mode, arg):
  inst = instrument(pair, book)                      # cached per (pair, book)
  pos  = positions(pairs=[pair], mcsn=[book])        # ALWAYS pass the book
  if pos is missing or pos.active_pos == 0:  return SKIPPED_FLAT

  if mode == CLOSE_POSITION or mode == SELL_ALL:
      cancel_all_open_orders_for_position(pos.id)     # verify no untriggered SL survives
      r = exit(pos.id)                                # keeps r.data.group_id
      return await verifyFlat(pos.id, r.group_id)

  # PARTIAL: quantity / amount / percent-of-position
  want = switch mode:
      QTY      -> arg
      PERCENT  -> abs(pos.active_pos) * arg / 100
      AMOUNT   -> arg / markPrice(pair)               # quote amount -> base qty
  qty = min(want, abs(pos.active_pos))                # ← the anti-flip clamp
  qty = floorTo(qty, inst.quantity_increment)         # ← floor, never round
  if qty < max(inst.min_quantity, inst.min_trade_size):        return REFUSED_TOO_SMALL
  if qty * markPrice(pair) < inst.min_notional:                return REFUSED_MIN_NOTIONAL
  if orderType == MARKET and qty > inst.max_market_order_quantity: split or REFUSE
  side = pos.active_pos > 0 ? 'sell' : 'buy'
  return placeOrder(side, pair, qty, book, leverage = pos.leverage)   # track 03
```

Every `REFUSED_*` is a first-class, reported per-account outcome, so a group action's result is always `{confirmed[], refused[], unknown[]}` - never a boolean. `qty == abs(active_pos)` after clamping should be promoted to `exit` rather than sent as an order.

### D5. P&L arithmetic (Decimal throughout; units per U1)

```
# per position, per book, USDT
uPnL          = active_pos * (mark_from_rt_feed - avg_price)
notional      = abs(active_pos) * mark_from_rt_feed        # unit_contract_value == 1
roMargin      = uPnL / locked_user_margin                  # guard zero
feesFunding   = locked_user_margin - locked_margin          # positive = paid out

# per account, realised, from positions/transactions
realised_USDT_book = SUM(amount) WHERE stage IN (default, exit, tpsl_exit, liquidation)
funding_USDT_book  = SUM(amount) WHERE stage = funding
fees_book          = SUM(fee_amount)
#   ^ on an INR book these three are already INR (U1). Do not convert.

# per account equity
USDT cross account:  total_account_equity          (cross_margin_details)
otherwise:           (balance + locked_balance)    (wallets, per currency) + SUM(uPnL of that book)

# INR presentation of an unrealised USDT figure - always labelled indicative
uPnL_INR_indicative = uPnL_USDT * conversions.conversion_price
peg_drift           = conversions.conversion_price - position.settlement_currency_avg_price
```

Group analytics roll up by `(group, book)`. The group row shows: notional, uPnL, realised, fees, funding, worst `margin_ratio_cross` / closest `liquidation_price`, and a count of accounts in each of `{confirmed, refused, unknown}` for the last group action.

### D6. Reconciliation sweep (the "no silent divergence" property)

| Cadence | Calls per account | What it proves |
|---|---|---|
| 1-2 s (shared, 0 keys) | `current_prices/futures/rt` once for all accounts | marks for P&L |
| socket, per account | `df-position-update`, `df-order-update`, `balance-update` (V-doc 13453-13600) | low-latency deltas |
| 30 s | `positions` with `["INR","USDT"]` | our position set == exchange's |
| 60 s | `wallets` (+ `cross_margin_details` for USDT cross accounts) | our balances == exchange's |
| 5 min | `positions/transactions` since watermark | realised P&L and funding are complete |
| 5 min (shared, 0 keys) | `conversions` | peg drift on INR books |
| on any UNKNOWN | targeted `positions` by `pairs`, then `orders` by status | did the write land? |

Any mismatch between our state and the exchange's raises a divergence alarm carrying both values, freezes new group actions for that account, and surfaces the account as degraded. It never auto-heals by overwriting our record.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Reducing order sized above `abs(active_pos)` **flips** the position (no `reduce_only`) | pre-send clamp; post-trade sign check `sign(active_pos)` unchanged or zero | clamp in D4; promote 100% to `exit`; refuse rather than round up | one account, unbounded loss - **worst case in this document** |
| `exit` retried after a timeout, opening an opposite position | `active_pos` sign flips after an exit; two `group_id`s for one intent | single-flight lock per (account, pair); UNKNOWN never re-writes; reconcile instead | one account |
| `wallets/transfer` retried, money moved twice | `wallets/transactions` shows two `by_universal_wallet` rows for one intent | same lock + pre/post transaction-row check; transfers are operator-initiated, never part of a group action | one account's wallet |
| INR position invisible because `margin_currency_short_name` was omitted | reconciliation finds a position we never recorded | always send `["INR","USDT"]`; assert `response.every(p => books.includes(p.margin_currency_short_name))` | one account, then a duplicate entry |
| `add_margin` fractional amount truncated to 0 by the Integer type | post-read `locked_user_margin` unchanged | integers only until the experiment in F7 settles it | one account, margin thinner than intended |
| Group trade's tail accounts rejected by the 10-second `timestamp` window | per-account error `422`/`400` with a stale-timestamp body | timestamp computed per request immediately before signing; bounded concurrency; per-account deadline | tail of a group - **partial fan-out, must be reported** |
| 429 storm during a 100-account sweep | 429 rate on the shared limiter | token bucket at 16/s global (FAQ) with per-key sub-buckets; reads deprioritised behind writes; socket-first for deltas | whole tenant's reads stall |
| Stale SL survives an exit and later opens a fresh position | after `exit`, list `status=untriggered` for the pair and assert empty | always `cancel_all_open_orders_for_position` before exit, then verify | one account, a surprise position |
| `create_tpsl` lands one leg, HTTP 200 | `{success:false}` on the other key | treat per-leg; report the SL leg as the safety-critical one; retry only the failed leg after cancelling any existing untriggered order | one account, unprotected position |
| P&L wrong because fees came from the public instrument fee | our computed fee != `fee_amount` on the transaction | never compute fees; sum `fee_amount` | all analytics |
| P&L drift from float arithmetic | invariant test: `sum(transactions.amount)` equals our realised total exactly | string-preserving JSON parse + Decimal | all analytics |
| Cross-margin account liquidated by an unrelated position | `margin_ratio_cross >= 0.8` alarm | isolated margin as the platform default; cross accounts flagged and rate-limited on group size | every position in that account |
| `mark_price` from the position object used for P&L | mark timestamp older than the rt feed's `ts` | discard `position.mark_price` at the adapter boundary | all analytics |
| Peg change silently re-values every INR position | `conversions.last_updated_at` changed | record peg history; label INR figures with the peg and date; alarm on change | every INR account |
| CoinDCX 500/503 mid-fan-out | 5xx rate; FAQ 13910-13920 confirms both are expected | classify as UNKNOWN, never as failure; reconcile; group result reports `unknown[]` | part of a group |
| `edit` unavailable on INR accounts leads to divergent code paths | integration test asserts both books take the same path | cancel-and-replace uniformly; do not ship `edit` in v1 | correctness risk in the amend path |

## Open questions for Anand

1. **Futures or spot for v1?** This whole document is the *futures* (derivatives) API. The brief's language - "opening balance", "percent of the held position", "SELL ALL" - reads like spot. Futures has no coin balance, only signed positions and leverage, and every account must first move funds into a futures wallet. Which product are we trading? The two answers give different schemas, different sizing maths and different risk.
2. **Leverage policy.** Leverage is a per-(account, pair) setting that an order must match, and its ceiling is tiered by notional. Do we (a) force 1x everywhere, (b) let the customer set it per group, or (c) per account? Option (a) is the only one where "percent of capital" means what a non-trader expects.
3. **Does "20% of allocated capital" mean 20% as margin or 20% as notional?** At 10x leverage those differ by 10x. Needs to be nailed before the sizing track can be correct.
4. **Isolated only for v1?** Recommended: yes. Cross is USDT-only, pools risk across the account, and makes per-position P&L attribution harder. Accepting isolated-only also means both books behave the same.
5. **INR and USDT accounts in the same group - allowed?** If yes, a group trade produces two currency-denominated result sets and the group P&L cannot be one number. If no, groups become single-currency and the UI gets much simpler.
6. **Do we ever move money?** `wallets/transfer` is the only irreversible, non-idempotent call here. Recommendation: exclude it from v1 entirely; the customer funds each futures wallet themselves on CoinDCX.
7. **Testnet?** No CoinDCX futures testnet is mentioned anywhere in the docs (VERIFIED by absence). Every experiment in this document therefore costs real money on a real account. Are you willing to fund one small account (~2,000 INR) as a dedicated integration-test account? Without it, "100% accuracy" is unverifiable.

## Phase hints

| Phase | Does what | Must precede it |
|---|---|---|
| P0 Verification spike | Run the 13 open experiments flagged UNVERIFIED in this doc against one funded account. Produce a signed fixture file per endpoint (real request bytes, real response bytes) | A funded test account (open question 7) and 07-api-key-security.md for how the test key is stored |
| P1 Transport | String-preserving JSON parse; HMAC over exact body bytes; the three GET-with-body routes via `node:https`; verb table V1 hard-coded; global 16/s token bucket + per-key sub-buckets; 401/404/422/429/5xx classification | P0 fixtures |
| P2 Reference data cache | `active_instruments` and `instrument` per **(pair, margin_currency)**; `conversions` poller; `current_prices/futures/rt` poller. All unauthenticated, so this phase needs no keys | P1 |
| P3 Read model | `positions`, `wallets`, `cross_margin_details`, `orders`, `trades`, `positions/transactions` with paging and watermarks; POSITION/ORDER normalisers with the null-coercion rules from D1 | P1, P2 |
| P4 Sizing and validation | The clamp-and-floor algorithm (D4), `min_notional`/`min_quantity`/increment/`max_market_order_quantity` checks, U1-aware money types. Pure functions, exhaustively unit-tested with no network | P2 (needs instrument metadata), P3 (needs `active_pos`) |
| P5 Write path | `orders/create` (track 03), `orders/cancel`, `exit`, `create_tpsl`, `update_leverage`, `add_margin`, `remove_margin`, `margin_type` - each wrapped in the write-then-verify state machine of D3 | P3, P4 |
| P6 Reconciliation and alarms | The sweep in D6, divergence detection, UNKNOWN resolution, degraded-account gating | P3, P5 |
| P7 Group fan-out | Bounded-concurrency fan-out with per-account deadlines inside the 10-second timestamp window; `{confirmed, refused, unknown}` result surface | P4, P5, P6 |
| P8 Analytics | Per-account and per-group P&L from D5; per-book roll-ups; peg-drift reporting | P3, P6 |
| Excluded from v1 | `wallets/transfer`, `orders/edit`, `cancel_all_open_orders` (account-wide), cross margin | - |

## Sources

Local ground truth - `C:/Users/anand/Tradex/research/_sources/coindcx-docs.txt` (14,111 lines):

| Section | Lines |
|---|---|
| Authentication (signing scheme) | 1278-1403 |
| Generic wallets/transfer (spot<->futures) | 1830-2018 |
| Pagination (`page`/`size`, `x-pagination` header) | 6147-6229 |
| Futures glossary (socket field abbreviations) | 7781-7824 |
| Get active instruments | 7825-7885 |
| Get instrument details | 7886-8178 |
| List Orders (status/stage/order_type vocabularies) | 8461-8838 |
| Create Order (error codes, 10-second window) | 8839-9367 |
| **Cancel Order** | 9368-9490 |
| **List Positions** | 9491-9732 |
| **Get Positions By pairs or positionid** | 9733-10002 |
| **Update position leverage** | 10003-10177 |
| **Add Margin** | 10178-10308 |
| **Remove Margin** | 10309-10474 |
| **Cancel All Open Orders** | 10475-10595 |
| **Cancel All Open Orders for Position** | 10596-10720 |
| **Exit Position** | 10721-10868 |
| **Create Take Profit and Stop Loss Orders** | 10869-11199 |
| **Get Transactions** | 11200-11436 |
| **Get Trades** | 11437-11663 |
| **Get Current Prices RT** | 11664-11797 |
| **Get Pair Stats** | 11798-11984 |
| **Get Cross Margin Details** | 11985-12166 |
| **Wallet Transfer (futures)** | 12167-12340 |
| **Wallet Details** | 12341-12482 |
| **Wallet Transactions** | 12483-12638 |
| **Edit Order** | 12639-12953 |
| **Change Position Margin Type** | 12954-13175 |
| **Get Currency Conversion** | 13176-13320 |
| Futures sockets (position/order/balance update) | 13453-13600 |
| FAQ (rate limits, 5xx, fee tier, min quantity) | 13899-14076 |
| Errors (400/401/404/429/500/503) | 14077-14111 |

Live verification, 2026-09-03, via `curl -sS -L -A "Mozilla/5.0"`:

- `https://api.coindcx.com/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=INR` - 200, 499 pairs, all `B-*_USDT`
- `https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument?pair=B-BTC_USDT&margin_currency_short_name=USDT` and `...=INR` - 200, identical except `dynamic_position_leverage_details`
- `https://api.coindcx.com/api/v1/derivatives/futures/data/conversions` - **GET 200 unauthenticated** (`USDTINR 102.0`, `last_updated_at` 2026-05-26T12:11:55Z); POST 404
- `https://api.coindcx.com/api/v1/derivatives/futures/data/stats?pair=B-BTC_USDT` - **GET 200 unauthenticated**; POST 404
- `https://public.coindcx.com/market_data/v3/current_prices/futures/rt` - 200, 536 pairs, 14 fields each
- Verb matrix V1 - all 21 authenticated routes probed GET and POST with an invalid key; `401 Invalid credentials` vs `404 not_found`

External, consulted and **not** relied on: [CoinDCX API docs portal](https://docs.coindcx.com/) (same content as the local file), [CoinDCX futures API announcement](https://coindcx.com/blog/announcements/coindcx-futures-api-elevating-your-crypto-trading-experience/) ("high rate limits" - no numbers), [CoinDCX HFT help page](https://coindcx.com/api/help/High%20Frequency%20Trading/) (enterprise tier, no numbers), [CoinDCX futures page](https://coindcx.com/crypto-futures/) ("up to 100x on BTC and ETH" - consistent with the live 100x leverage tier). `coindcx.com/api/help/*` returns 403 to curl as well as WebFetch.

Cross-references: 01-coindcx-spot-rest.md (hosts, signing, spot rate limits, identifier namespaces), 07-api-key-security.md (key storage), futures order-placement track 03 (`orders/create`, `orders`, full ORDER field table), sizing track (percent-of-capital semantics, open questions 2 and 3).















