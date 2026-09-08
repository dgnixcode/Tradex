# 02 - CoinDCX margin REST contract

Status: 2026-09-03 | track: exchange ground truth | scope: the complete request/response contract for the CoinDCX margin-order API (`/exchange/v1/margin/*`, 11 endpoints) plus the shared Pagination contract, and a verdict on whether margin belongs in Tradex v1.

## Verdict

- **Margin is the only CoinDCX product with a native "one order = one closable position" primitive on non-futures markets.** A single `POST /exchange/v1/margin/exit` with the order id closes it. That maps almost exactly onto the owner's CLOSE POSITION requirement, which is why margin has to be evaluated seriously and not dismissed as "leverage we don't need".
- **It is nevertheless disqualified from v1, on one fact: the margin API has no `client_order_id` and no idempotency key of any kind.** Every parameter table in the section was read; the only identifier is the server-assigned `id` returned in the response. If a `margin/create` call times out, we cannot ask "did my order land?" - there is no key to ask by, and `fetch_orders` cannot distinguish our lost order from a legitimate second one. Spot **does** have `client_order_id` (see `01-coindcx-spot-rest.md`). Choosing margin would mean knowingly giving up the no-duplicate-order guarantee on a real-money fan-out. Not acceptable.
- **Margin's status vocabulary is a third, incompatible enum.** `init, partial_entry, open, partial_close, close, cancelled, rejected, triggered` - it shares not one value with the spot order statuses. Any attempt at a single global order-status enum across spot, margin and futures will silently mis-map. Keep one status map per product, translated at the adapter edge.
- **Every margin mutation is fire-and-forget.** `cancel`, `exit`, `edit_target`, `edit_price_of_target_order`, `edit_sl`, `edit_trailing_sl`, `add_margin` and `remove_margin` all return only `{message, status, code}` - no order id, no resulting state, no echo of what changed. A 200 means "accepted", never "done". Every one of these must be followed by a `margin/order` re-query before we tell a customer anything.
- **Margin carries a funding cost that spot does not.** The order object exposes `interest` (a rate, `0.05` in the sample) and `interest_amount` (accrued). Any P&L figure for a margin position that ignores `interest_amount` is wrong and drifts further wrong the longer the position is held.
- **Recommendation: v1 uses spot for buy/sell and futures for positions. Margin is deferred, not deleted** - it is the fallback if futures INR-collateral coverage turns out to be too narrow (see `04-coindcx-futures-positions-wallets-rest.md`), and it is the only path to leverage on a market that has no futures contract.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Is margin in v1? | **No** | No `client_order_id` means no safe retry, so the no-duplicate-order guarantee cannot be met | Ship margin for leverage in v1 - rejected, it trades a correctness guarantee for a feature nobody asked for |
| What serves CLOSE POSITION? | Futures `positions/exit`; for spot, a derived SELL of the full held quantity | Futures has a real position object and an explicit exit call | Margin `exit` - correct semantics, unsafe retry story |
| Order-status modelling | One status map **per product**, translated in the adapter to our own canonical states | The three vocabularies share no values; a merged enum guarantees a silent mis-map | A single global enum with best-effort mapping |
| Trusting a 2xx on a mutation | Never. Always re-query `margin/order` (or the product's equivalent) before reporting an outcome | Mutation responses contain no state at all, only a message string | Treat HTTP 200 as terminal success |
| Margin P&L | If margin is ever enabled, `interest_amount` becomes a mandatory ledger line, not a footnote | It accrues with time and silently eats the position's return | Fold interest into fees |
| Pagination defaults | Read the per-endpoint default, never the global one | The global Pagination section and `margin/fetch_orders` disagree (100 vs 10) - see G6 | Assume the documented global default of 100 |

## Findings

### F1 - The 11 margin endpoints

All are `POST`, all on `https://api.coindcx.com`, all authenticated with the standard `X-AUTH-APIKEY` / `X-AUTH-SIGNATURE` HMAC-SHA256 scheme documented in `06-coindcx-auth-ratelimits-errors-tos.md`. All require `timestamp`. VERIFIED, docs lines 4348-6146.

| # | Purpose | Path | Required params beyond `timestamp` |
|---|---|---|---|
| 1 | Place order | `/exchange/v1/margin/create` | `market`, `quantity`, `side`, `order_type`, `ecode` |
| 2 | Cancel order | `/exchange/v1/margin/cancel` | `id` |
| 3 | Exit (close) order | `/exchange/v1/margin/exit` | `id` |
| 4 | Edit target price | `/exchange/v1/margin/edit_target` | `id`, `target_price` |
| 5 | Edit price of one internal target order | `/exchange/v1/margin/edit_price_of_target_order` | `id`, `target_price`, `itpo_id` |
| 6 | Edit stop-loss price | `/exchange/v1/margin/edit_sl` | `id`, `sl_price` |
| 7 | Edit trailing stop-loss price | `/exchange/v1/margin/edit_trailing_sl` | `id`, `sl_price` |
| 8 | Add margin (lower effective leverage) | `/exchange/v1/margin/add_margin` | `id`, `amount` |
| 9 | Remove margin (raise effective leverage) | `/exchange/v1/margin/remove_margin` | `id`, `amount` |
| 10 | Fetch orders (paginated) | `/exchange/v1/margin/fetch_orders` | none |
| 11 | Query one order | `/exchange/v1/margin/order` | `id` |

Rate limits: the documented "SPOT API Rate Limits" table names no `margin/*` endpoint. UNVERIFIED whether margin shares the spot buckets, has its own, or is ungoverned. If margin is ever enabled, measure it - do not assume the spot allowance.

### F2 - Enum vocabularies, verbatim

Quoted exactly as the docs give them (docs lines 4350-4370). VERIFIED.

| Name | Values |
|---|---|
| `side` | `buy`, `sell` |
| `order_type` | `market_order`, `limit_order`, `stop_limit`, `take_profit` |
| `order_status` | `init`, `partial_entry`, `open`, `partial_close`, `close`, `cancelled`, `rejected`, `triggered` |
| `ecode` | `B` |
| `timestamp` | `1524211224` (sample value, seconds-looking - see G1) |

Two traps live in this table:

- `order_type` values are **suffixed** (`market_order`, `limit_order`) where spot uses bare `market_order`/`limit_order` too but futures uses a different set again - check each adapter against its own product doc, never by analogy.
- The docs instruct: *"Set `ecode` parameter to B for all the api calls wherever necessary"*, and the enum admits only `B`. Meanwhile spot `orders/create_multiple` requires `ecode: "I"` for INR markets (see `01-coindcx-spot-rest.md`). So `ecode` is not a constant - it is product- and market-dependent, and `B` is the only documented margin value. UNVERIFIED whether an INR margin market exists and what `ecode` it would need.

### F3 - `margin/create` request contract

VERIFIED, docs lines 4372-4420.

| Param | Type | Req | Example | Notes |
|---|---|---|---|---|
| `market` | string | Yes | `XRPBTC` | The trading pair. Note the sample is BTC-quoted, not INR - see F8 |
| `quantity` | number | Yes | `1.101` | Quantity in the target asset. **There is no notional/amount parameter** |
| `price` | number | No | `0.082` | Per unit. Not required for `market_order`, mandatory for all other types |
| `leverage` | number | No | `1` | Omitted defaults are undocumented; `1` in the sample |
| `side` | string | Yes | `buy` | |
| `stop_price` | number | No | `0.082` | Mandatory for `stop_limit` and `take_profit` |
| `order_type` | string | Yes | `market_order` | |
| `trailing_sl` | boolean | No | `true` | Selects which SL-edit endpoint applies later (F6) |
| `target_price` | number | No | `0.082` | The price at which to close the position |
| `ecode` | string | Yes | `B` | |
| `timestamp` | number | Yes | `1524211224` | |

Cap: **"You can only have a maximum of 10 open orders at a time for one specific market"** (docs line 4381). Spot's cap is 25 per market. A 20-account group is unaffected (the cap is per key), but a customer running several strategies on one account is.

Absent, and consequential: no `client_order_id`, no `time_in_force`, no `post_only`, no `reduce_only`, no notional parameter.

### F4 - The margin order object

Returned by `create`, `fetch_orders` and `order` as an **array**, even for a single order. VERIFIED from the docs' own response samples (docs lines 4560-4625, 5900-5960).

| Field | Sample | What it is |
|---|---|---|
| `id` | `"30b5002f-…"` | UUID string. The only handle that exists. Losing it loses the order |
| `side` / `market` / `order_type` | `sell` / `XRPBTC` / `limit_order` | As submitted |
| `status` | `init` | Parent status, from the F2 enum |
| `trailing_sl` / `trail_percent` | `false` / `null` | |
| `avg_entry` / `avg_exit` | `0` / `0` | Volume-weighted entry and exit price. **This is the position's cost basis, computed by the exchange** |
| `entry_fee` / `exit_fee` / `fee` | `0` / `0` / `0.02` | `fee` is a *rate* (2%? 0.02%?) - unit UNVERIFIED. `entry_fee`/`exit_fee` are amounts |
| `active_pos` / `exit_pos` / `total_pos` | `0` / `0` / `0` | Open size, closed size, total. **`active_pos` is the live position quantity** |
| `quantity` / `price` | `200` / `0.000026` | As submitted |
| `sl_price` / `target_price` / `stop_price` | `0.00005005` / `0` / `0` | Note `0` is used as "unset", not `null` |
| `pnl` | `0` | Exchange-computed P&L. Does **not** visibly include `interest_amount` - UNVERIFIED whether it is netted |
| `initial_margin` | `0.00520208` | Collateral committed |
| `interest` / `interest_amount` | `0.05` / `0` | Funding rate and accrued cost |
| `leverage` | `1` | |
| `result` | `null` | Undocumented. Populated on close, presumably |
| `created_at` / `updated_at` | `1568122929782` | Integer epoch **milliseconds** (13 digits) - contradicting the 10-digit `timestamp` request sample |
| `orders[]` | array | The internal exchange orders that implement the bracket |

Each element of `orders[]`:

| Field | Sample | Note |
|---|---|---|
| `id` | `164993` | **Integer**, not a UUID - a different id space from the parent |
| `status` | `"initial"` | **Not in the F2 enum.** A fourth vocabulary, for internal orders only |
| `bo_stage` | `"stage_entry"` | Which leg of the bracket this is. Other values undocumented |
| `total_quantity` / `filled_quantity` / `remaining_quantity` / `cancelled_quantity` | `200` / `0` / `200` / `0` | Fill accounting |
| `avg_price` / `price_per_unit` | `0` / `0.000026` | |
| `fee` / `fee_amount` | `0.02` / `0` | Rate and amount |
| `timestamp` | `1568122929880.75` | **Fractional milliseconds.** `parseInt` silently truncates; a naive integer column rejects or rounds it. See G2 |

### F5 - The documented state machine

The docs state the legal preconditions for two operations explicitly, which is enough to pin the graph. VERIFIED, docs lines 4628-4634 and 4758-4764.

- *"Any order with order_status among the following can only be **cancelled**: `init`, `partial_entry`, or `triggered`"*
- *"Any order with order_status among the following can only be **exited**: `open` or `partial_close`"*

```
                 cancel ok            exit ok
                 ┌───────────┐     ┌──────────────┐
  create ──▶ init ──▶ partial_entry ──▶ open ──▶ partial_close ──▶ close   (terminal)
              │            │            │             │
              ├──▶ rejected (terminal)  │             │
              ├──▶ cancelled (terminal) ┘             │
              └──▶ triggered ──▶ (cancel ok) ─────────┘
```

The practical rule: **`cancel` kills an order that has not become a position; `exit` closes one that has.** Calling the wrong one is a business rejection, not a retryable error - so our client must branch on the current status, which means a `margin/order` read before every close attempt. That is one extra round trip per account per close, and at 20 accounts it is 20 extra calls before any exit is sent.

### F6 - The four edit endpoints and the `trailing_sl` branch

VERIFIED, docs lines 4886-5440.

| Endpoint | Precondition stated in docs | Params |
|---|---|---|
| `edit_target` | *"You can update target price only if order has 0 or 1 target order"* | `id`, `target_price` |
| `edit_price_of_target_order` | For orders with **multiple** open targets | `id`, `target_price`, `itpo_id` |
| `edit_sl` | *"Only for orders where `trailing_sl` is **false**"* | `id`, `sl_price` |
| `edit_trailing_sl` | *"Only for orders where `trailing_sl` is **true**"* | `id`, `sl_price` |

So "change the stop loss" is four endpoints behind two boolean branches (`trailing_sl`, and target count 0/1 vs many), and the parameter that tells you which branch you are on (`itpo_id`) is only obtainable by reading `orders[]` from a prior query. There is no unified edit. Any UI that offers "edit SL" must first read the order, then dispatch. Note also that `edit_price_of_target_order` is the one endpoint whose parameter table is **malformed in the source docs** - the `id` row carries only four cells where every sibling row carries five, so its Description is simply absent. The parameter itself is unambiguous.

### F7 - Reading orders

| | `fetch_orders` | `order` |
|---|---|---|
| Path | `/exchange/v1/margin/fetch_orders` | `/exchange/v1/margin/order` |
| Selects | all, or filtered | one, by `id` |
| `market` | optional; default *all markets* | n/a |
| `status` | optional CSV; default *all* | n/a |
| `details` | optional boolean, default `false` | optional boolean, default `false` |
| `size` | optional, **default 10** | n/a |
| Paginated | Yes, per the Pagination section | No |

`details=false` omits the nested `orders[]` array; `details=true` includes it. Fill-level truth therefore costs `details=true`, and the docs do not say whether that changes the rate-limit weight.

Unlike spot - where `active_orders` **requires** a market and there is no global order-history endpoint - `margin/fetch_orders` defaults to all markets and accepts a status filter. Margin is the better-instrumented product for reconciliation, which is a genuine point in its favour and worth remembering if the futures reconciliation story turns out worse.

### F8 - Market coverage is the unanswered question

Every example in the entire margin section uses `XRPBTC` - a **BTC-quoted** market. The `ecode` enum admits only `B`. Nothing in the section names an INR or USDT margin market.

This matters enormously for Tradex, because the owner's accounts are funded in **INR or USDT** (brief item 7). A margin product that only quotes against BTC would require every customer to first hold BTC, which is a different product than the one being built.

UNVERIFIED and **must be settled before margin is ever scheduled**: fetch `/exchange/v1/markets_details` and filter for margin-enabled markets, then check which `base_currency` values appear. The spot doc (`01-coindcx-spot-rest.md`) documents the fields needed to do this. Until that is measured, treat margin as BTC-quoted-only.

### F9 - Pagination, and a documented contradiction

The shared Pagination section (docs lines 6147-6229) VERIFIED:

| Param | Description |
|---|---|
| `page` | Page number to fetch. **Pagination starts at page 1** |
| `size` | Records per page. Default **100**, max **1000** |

Pagination details come back **in the response headers**, not the body - so any HTTP client wrapper that discards headers loses the total count and cannot know it is on the last page.

The contradiction: this section says `size` defaults to 100, while `margin/fetch_orders` documents `size` default **10**. Both are in the same document. Never rely on a default - always send `size` explicitly. (Recorded as G6.)

### Gotchas

| # | Gotcha | Consequence if missed |
|---|---|---|
| G1 | The request `timestamp` sample is 10 digits (`1524211224`, seconds) while `created_at`/`updated_at` in responses are 13 digits (ms). The Authentication section is the authority here - see `06-coindcx-auth-ratelimits-errors-tos.md` | Signing with the wrong unit fails every call with an opaque auth error |
| G2 | Nested `orders[].timestamp` is **fractional ms** (`1568122929880.75`) | `parseInt` truncates, a `bigint` column rejects, and an ordering comparison on truncated values can tie |
| G3 | Nested `orders[].id` is an **integer** while the parent `id` is a **UUID string** | A single `order_id` column typed as UUID cannot hold both; a string column that holds both invites joining the wrong id space |
| G4 | Nested `orders[].status` is `"initial"`, absent from the documented `order_status` enum | An exhaustive switch throws on live data |
| G5 | `0` means "unset" for `target_price`, `stop_price`, `avg_entry`, `avg_exit` | "Target price is zero" reads as a real price of zero; a naive `if (target_price)` check happens to work, a `!= null` check does not |
| G6 | `size` default is documented twice with different values (100 global, 10 for `fetch_orders`) | Silent under-fetch; a reconciler that reads one page thinks the customer has 10 orders |
| G7 | Pagination metadata is in **response headers** | An HTTP wrapper that returns only the body cannot tell first page from last |
| G8 | `fee` is a rate whose unit is never stated (`0.02` - 2% or 0.02%?) | A 100x error in every fee estimate. Must be measured against a real fill, not assumed |
| G9 | Mutation responses are `{message, status, code}` with a **human-readable string** as the only signal (`"Cancellation accepted"`) | Any code that branches on that string is broken by a copy-edit on CoinDCX's side. Branch on `code`, then re-query |
| G10 | `margin/*` appears in no rate-limit table | An unmeasured limit is discovered in production, during a fan-out |

## Design

### How margin would be adapted, if it is ever enabled

Not v1. Recorded so the decision does not have to be re-derived.

```
CloseMarginPosition(account, margin_order_id):
  1. read  = POST /exchange/v1/margin/order  {id, details:true}      # mandatory, F5
  2. switch read[0].status:
       init | partial_entry | triggered -> POST /margin/cancel {id}
       open | partial_close             -> POST /margin/exit   {id}
       close | cancelled | rejected     -> no-op, already terminal
       else                             -> refuse, alarm (unknown status)
  3. re-read after a bounded delay; the mutation response proves nothing (G9)
  4. terminal only when status in {close, cancelled, rejected}
```

Cost: **2-3 round trips per account per close**, versus 1 for a futures `positions/exit`. At 20 accounts that is 40-60 sequential-ish calls against an unmeasured rate limit (G10).

### The idempotency gap, stated precisely

| | Spot | Margin |
|---|---|---|
| Client-supplied id on create | `client_order_id` | **none** |
| Lookup by client id | `orders/status`, `status_multiple` | **impossible** |
| Duplicate submission | Docs state reuse is rejected | Nothing prevents it |
| Recovery after a lost `create` response | Query by `client_order_id`, resolve definitively | Guess by scanning `fetch_orders` for a similar order in a time window |

That last cell is the whole argument. "A similar order in a time window" is not a guarantee - if a customer legitimately places two identical orders seconds apart, the scan cannot tell them from a duplicate, and the failure mode is placing a second real-money position.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| `margin/create` response lost; order may or may not exist | None available - no client id to query by | **Do not use margin for automated fan-out.** If ever used: single-flight per (account, market) with a lock held across the call, plus a mandatory human-reviewed reconciliation before the next order on that market | One duplicate leveraged position per occurrence; unbounded if retried |
| `exit` called on an order in `init` (or `cancel` on one in `open`) | Business rejection in the response body | Read status first (Design step 1); never dispatch a close from a cached status | Position stays open while the UI claims it closed |
| 200 on `cancel`/`exit` treated as done | Re-query shows the order still live | Never report terminal state from a mutation response (G9) | Customer believes they are flat when they are not |
| `interest_amount` ignored in P&L | Our P&L diverges from the exchange's `pnl`, growing with holding time | Ledger line per accrual; reconcile against `pnl` | Every margin P&L figure is wrong |
| Exhaustive status switch meets `"initial"` | Runtime throw in the adapter | Treat unknown statuses as `UNKNOWN` and alarm, never throw (G4) | Reconciler crashes and stops reconciling - worst possible failure mode |
| BTC-only margin markets discovered late | `markets_details` inspection | Do the F8 measurement before scheduling any margin work | A whole phase of wasted work |
| Rate limit hit on an unmeasured endpoint | 429s mid-fan-out | Measure before enabling; budget conservatively (see `08-fanout-execution-engine.md`) | Partial group execution |

## Open questions for Anand

1. **Does the product need leverage at all?** The brief never mentions it. Margin and futures both exist mainly to provide it. If the answer is no, margin can be closed permanently and CLOSE POSITION is served by a plain full-quantity spot SELL, which is much simpler and safer. Recommended default: **no leverage in v1.**
2. **Is "close the position" about spot holdings or leveraged positions?** The brief says several accounts in a group can hold a position in the same coin at different sizes - which is equally true of plain spot holdings. If it means spot, futures and margin are both out of scope for v1 and the whole product gets simpler. Recommended default: **treat it as spot holdings**; confirm before any futures work is scheduled.

## Phase hints

- **No phase implements margin.** This document exists so that the option is costed and the decision is recorded, not so it gets built.
- The **exchange-adapter phase** must define the per-product status map as a translation table from day one (F2, G4), even while only spot is wired, or margin/futures cannot be added later without touching the core.
- The **market-metadata phase** should carry out the F8 measurement (`markets_details`, margin-enabled markets, their `base_currency` values) as a small, cheap task while it is already reading that endpoint. That closes the biggest unknown here for near-zero cost.
- Any phase that adds a **second CoinDCX product** must adopt the Design section's read-then-dispatch pattern and the never-trust-a-mutation-response rule (G9); both belong in the adapter contract, not in per-product code.

## Sources

- `_sources/coindcx-docs.txt` lines **4348-6146** - the entire Margin Order section: enums, 11 endpoint definitions, parameter tables and response samples.
- `_sources/coindcx-docs.txt` lines **6147-6229** - the shared Pagination section.
- `_sources/coindcx-docs.txt` lines **715-766** - SPOT API Rate Limits, checked for margin entries; none present.
- Cross-references: `01-coindcx-spot-rest.md` (`client_order_id`, `ecode: "I"`, base/target naming inversion, market metadata fields), `04-coindcx-futures-positions-wallets-rest.md` (the futures position/exit alternative), `06-coindcx-auth-ratelimits-errors-tos.md` (signing, timestamp units, error codes).
- No live API calls were made against `/exchange/v1/margin/*` for this document. Every claim is from the docs dump; everything marked UNVERIFIED needs either a live call or a support answer.




