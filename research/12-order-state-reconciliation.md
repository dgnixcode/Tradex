# 12 - Order state machine and reconciliation

Status: 2026-09-03 | track: books | scope: the canonical order lifecycle, how it maps onto CoinDCX's status strings, and the reconciler that guarantees no lost, duplicate or silently-diverged order.

## Verdict

- **The websocket is a latency optimisation. REST is the truth.** `05-coindcx-websockets.md` verified live that a wrong channel name is silently accepted and yields nothing forever, that `leave` is unacknowledged on spot, that an auth failure is a **silent disconnect** with no error event, and that several documented fields never arrive. Any of those failures is indistinguishable from "no activity". So every order must reach a terminal state through polling and reconciliation; the socket only makes it feel fast.
- **We can only reconcile orders we remember, because `active_orders` requires a market.** There is no "list all my open orders" call in the spot API - `active_orders` takes a mandatory market, and there is no order-history endpoint at all (`01`). The only market-agnostic view is `orders/trade_history`. Therefore: **our order row must be committed before the create call**, and `trade_history` is the sole detector of activity we have no record of.
- **Write before you send. That single ordering is what makes recovery possible.** A row in `sending` after a crash is, by definition, ambiguous - and ambiguity is resolvable because we hold the `client_order_id`. A design that writes the row after the response has no way to discover the order exists.
- **The exchange always wins, and we never edit history.** On disagreement we adopt the exchange's state and append a correcting entry recording what we previously believed. Overwriting an audit row to make the numbers agree destroys the only evidence that a divergence occurred.
- **Three status vocabularies, no shared values, and one differs by a single letter.** Spot uses `init/open/partially_filled/filled/cancelled/partially_cancelled/rejected`; margin uses a completely different set; futures sends `cancelled` in a request filter and `CANCELED` in its response. Map per product at the adapter edge, and make an unknown status an `UNKNOWN` state that alarms - never an exception that kills the reconciler.
- **Never parse socket money with `JSON.parse`.** Verified live in `05`: values arrive as decimal strings *or* as JSON numbers in exponent form (`3.1e-7`, `7.009e-9`), and `JSON.parse` has already destroyed precision by the time the value is readable. Recover them from the raw frame with a decimal-aware parser.
- **The tight rate limit is on reads, not writes.** `active_orders` is 300/60 s and `cancel_all` is 30/60 s, against 2000/60 s for creates - with an overall FAQ figure of 16/s, 960/min. The reconciler, not the trading, is what will hit a limit first, and its polling cadence must be treated as a budgeted resource.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Source of truth | REST (`orders/status`, `status_multiple`, `active_orders`, `trade_history`) | Sockets fail silently in at least four verified ways | Socket-first with REST as a fallback |
| Socket role | Latency only: it triggers an immediate poll rather than mutating state directly | A socket event is a hint that something changed, not a fact about what | Apply socket payloads as authoritative state transitions |
| Order row write ordering | **Commit before the HTTP call**, in the same transaction that reserves the `client_order_id` | It is the only way an unknown outcome is later discoverable | Write on response |
| Terminal-state authority | `orders/status` by `client_order_id` | It is the one lookup that works even when we lost the exchange id | The create response (`acked` is not `filled`) |
| Status mapping | Per-product translation table to our own canonical states, with `UNKNOWN` + alarm | Vocabularies share no values; futures differs by one letter | A single global enum |
| Divergence handling | Adopt the exchange state, append a `correction`, alarm | Preserves evidence and keeps sizing correct | Update in place |
| Polling cadence | Adaptive: 1 s while a group trade has open children, 30 s for idle accounts with open orders, 5 min sweep for everything else | Reads are the scarce budget (F5) | Fixed fast polling for everything |
| Cold-start recovery | Full sweep: every non-terminal order resolved by `client_order_id`, then `trade_history` per account from the last known fill | After downtime we cannot know what happened while we were away | Resume as if nothing happened |
| Unknown-activity detection | `orders/trade_history` with no `symbol`, per account, on the slow sweep | It is the only market-agnostic endpoint (`01`) | None - which would leave outside trading invisible |
| Replay and reorder protection | Monotonic guard on `(exchange_order_id, updated_at, filled_quantity)`; never move a terminal order | Sockets and polls interleave and can deliver stale views | Last-write-wins |
| Clock discipline | NTP mandatory on every host; alarm on any signature or timestamp error; futures orders expire in 10 s (`03`) | Skew presents as an auth failure, which looks like a credential problem | Trust the system clock |
| Stuck-order escalation | `needs_human` after the resolve ladder exhausts; freeze the account, page an operator | An unresolved real-money order must never be left to a retry loop | Keep retrying |

## Findings

### F1 - Canonical states, and the mapping

Our states (from `08-fanout-execution-engine.md`) and what each CoinDCX spot status maps to. Spot vocabulary VERIFIED from the docs' Order section enum table.

| Our state | Terminal | CoinDCX spot status | Meaning |
|---|---|---|---|
| `planned` | no | - | Sized and legalised, not yet sent |
| `skipped` | **yes** | - | A gate refused it; never sent |
| `sending` | no | - | Committed, HTTP call in flight |
| `ambiguous` | no | - | No usable response; outcome unknown |
| `not_placed` | **yes** | - | Resolve proved the order does not exist |
| `acked` | no | `init` | Accepted, not yet working |
| `open` | no | `open` | Working on the book |
| `partially_filled` | no | `partially_filled` | Partly executed, remainder working |
| `filled` | **yes** | `filled` | Fully executed |
| `cancelled` | **yes** | `cancelled` | Cancelled with no fill |
| `partially_cancelled` | **yes** | `partially_cancelled` | Partly filled, remainder cancelled |
| `rejected` | **yes** | `rejected` | Refused by the exchange |
| `unknown` | no | *anything unrecognised* | Alarm, do not throw, do not advance |
| `needs_human` | no | - | Resolve exhausted; account frozen |

The docs classify these explicitly: open-equivalent (*"can undergo further change"*) is `init`, `open`, `partially_filled`; settled (*"could not undergo any change"*) is `filled`, `partially_cancelled`, `cancelled`, `rejected`.

One documented contradiction to carry: the Terminology section calls `init` open-equivalent, but the FAQ says an order *"can be cancelled only when its in open or partially_filled status"* - so `init` may not be cancellable. UNVERIFIED; only reachable for stop-variant orders, which v1 does not use. Treat `init` as cancellable-with-retry-on-refusal.

Fill quantities, not status strings, are authoritative for how much executed. `cancelled` and `partially_cancelled` overlap in the docs' prose, so read `filled_quantity` and `remaining_quantity` rather than inferring from the label.

### F2 - The two channels, and what each is good for

| | Socket (`05`) | REST poll |
|---|---|---|
| Latency | Sub-second | One poll interval |
| Reliability | **Fails silently**: wrong channel accepted and silent, auth failure = bare disconnect, documented fields absent | Explicit HTTP status and body |
| Attribution | Payloads carry **no account identifier**, so one connection per API key is mandatory | Per-key request, unambiguous |
| Money precision | Values arrive as strings *or* exponent-form JSON numbers; `JSON.parse` destroys them | Same care needed, but a single well-tested client path |
| Cost | One TCP connection per account, held open | Counts against the read rate limit |
| Role in Tradex | **Trigger**: on any `order-update` or `trade-update`, enqueue an immediate poll for the affected account | **Authority**: the poll result is what mutates state |

Treating the socket as a trigger rather than a source has a pleasant property: correctness no longer depends on socket reliability at all. If every socket dies, the system degrades to poll-interval latency and stays correct - which is exactly the failure mode you want from a component that fails silently.

Two socket guarantees verified in `05` are still worth exploiting as drop detectors: spot depth `vs` is a gapless per-market sequence, and the spot candle `x` flag flips exactly once per bar. Both let us notice a dead-but-open connection quickly, which the socket layer itself will not tell us.

### F3 - The resolve ladder (ambiguous outcomes)

Identical in spirit to `08` F6, restated here as the reconciler's contract:

```
resolve(order):                      # order.state == 'ambiguous' or 'sending' after restart
  attempts at 250ms, 1s, 3s, 8s, 20s:
      r = POST /exchange/v1/orders/status { client_order_id }
      found        -> adopt id + status, map via F1                       DONE
      not_found    -> if first observation AND age < 2s: retry
                      else: state = not_placed (re-send permitted)        DONE
      429/5xx/tmo  -> retry
  state = needs_human; freeze account; page                                DONE
```

The 2-second floor on the first not-found is the anti-race: a create accepted milliseconds ago may not yet be visible to a status read, and treating that as "not placed" is how a genuine duplicate gets born.

### F4 - The reconciler

Three loops at different cadences, each with a distinct job.

**Loop A - active order tracking (fast, per group trade).** For each account with non-terminal children: `orders/status_multiple` with up to 10 `client_order_id`s per call. Map, advance, record fills. Runs at 1 s while a group trade is in flight, then backs off.

**Loop B - open-order sweep (per account, per known market).** `orders/active_orders` for each market where we believe the account has something open. Catches an order that fell out of Loop A - for example one whose socket update never arrived and whose status poll was throttled. Cadence 30 s per account with open orders; skipped entirely for accounts with none.

**Loop C - divergence sweep (slow, global).** `orders/trade_history` with **no `symbol`**, per account, from the last ingested fill timestamp. This is the only detector for:

| What it catches | Why nothing else can |
|---|---|
| A fill on an order we never recorded | `active_orders` needs a market we do not know to ask about |
| Trading the customer did directly on CoinDCX | We have no record to poll by |
| A conversion the customer performed in the app | Arrives as a `USDTINR` fill (`11` F1) |
| Activity from a key leaked elsewhere | Same as above, and it is the earliest signal of compromise (`07` T10) |

Cadence 5 minutes per account, paged until exhausted (limit 500). Anything found becomes a ledger entry and, if it maps to no order of ours, an `EXTERNAL_ACTIVITY` alert.

```
reconcile_account(account):
  A: status_multiple(open client_order_ids, batches of 10)   -> advance states
  B: for market in markets_with_open_orders(account):
        active_orders(market)                                -> find orphaned-open
  C: trade_history(from = last_fill_ts, no symbol) paged     -> ingest fills,
                                                                detect unknown activity
  D: users/balances                                          -> balance-level check (11 F6)
  E: if any state changed: recompute holdings, emit events
```

Loop D is the balance reconciliation owned by `11-positions-ledger-pnl.md`; it is listed here because it shares the same schedule and the same rate-limit budget.

### F5 - The polling budget

Documented limits (`06`, `08` F1): `active_orders` **300/60 s**, `status`/`status_multiple` 2000/60 s, `trade_history` 2000/60 s, plus an overall FAQ figure of **16/s, 960/min**. Whether these are per key or per IP is the open experiment in `08` F1.

Cost of one full reconcile cycle for one account with one open order:

| Loop | Calls |
|---|---|
| A `status_multiple` | 1 |
| B `active_orders` (1 market) | 1 |
| C `trade_history` | 1 |
| D `users/balances` | 1 |
| **Total** | **4** |

If limits are **per key**, this is trivial: 4 calls per account per cycle against a 960/min allowance for that key alone.

If limits are **per IP**, the arithmetic bites. A 20-account group trade in flight, Loop A at 1 s, is 20 calls/second - already above the 16/s FAQ figure on its own, before any other customer. That would force Loop A to batch across accounts (impossible - different keys), or to slow to ~3 s, or to obtain HFT access (`07` F1). **The reconciler's design is therefore contingent on the F1 experiment**, and the cadences above must be configuration, not constants.

### F6 - Replay, reordering and the monotonic guard

Socket events and poll results interleave, so a stale view will sometimes arrive after a fresh one.

```
apply(observation):
  if order.state is terminal:                       ignore    # nothing supersedes terminal
  if observation.updated_at < order.last_observed_at: ignore
  if observation.filled_quantity < order.filled_quantity: ignore   # fills never decrease
  if observation.status maps to unknown:            state = unknown; alarm; ignore
  else: advance
```

Three independent guards, because each catches a different real case: terminality catches a late "open" after a "filled"; `updated_at` catches out-of-order delivery; monotonic `filled_quantity` catches a partial view of a progressing fill. The last one is the only defence when `updated_at` has millisecond granularity and two observations share a timestamp.

Note that `updated_at` on the margin product is a **fractional millisecond** value (`02` G2) and futures timestamps are integers - so the comparison must be done in a decimal type, not by `parseInt`.

### F7 - Clock discipline

| Fact | Source | Consequence |
|---|---|---|
| Requests carry a `timestamp` and *"the request is rejected … if this timestamp deviates too much from the server's time"*; the tolerance is unquantified for spot | `01`, `06` | Skew presents as an auth error, which looks like a bad credential |
| Futures orders are rejected after a **10-second** delay | `03` | Sign at send; a queued signed payload is a guaranteed rejection |
| A signature failure and a revoked key produce similar-looking failures | `07` | Any signature/timestamp error must alarm distinctly from a 401, or a clock problem will be misdiagnosed as a credential problem across every account at once |

Requirements: NTP on every host that signs; a startup check that refuses to start if offset exceeds 1 s; a metric on measured offset; and an alarm on the *first* signature error rather than the tenth, because clock skew fails everything simultaneously.

### F8 - The stuck-order playbook

| Symptom | First check | Action |
|---|---|---|
| `sending` for more than 60 s | Is the worker alive? Is the lock stale? | Reaper routes to `resolve`, never to `place` (`08` F10) |
| `ambiguous` after the full ladder | Does `trade_history` show a fill matching the intended quantity and price? | If yes, adopt it and append a correction; if no, `not_placed` |
| `needs_human` | Two orders matching one `client_order_id` should be impossible - check whether the customer traded manually | Freeze the account, contact the customer, reconcile by hand, record the outcome |
| `open` for hours with no fill | Is it a limit order away from the market? Is the market still active? | Show it, offer cancel; this is normal, not an incident |
| `unknown` status | Which product and which literal string? | Add the alias, redeploy the map; the alarm exists so this is a five-minute fix rather than a silent stall |
| Reconciler itself stalled | Is it throttled, or did it throw? | An `UNKNOWN` status must never throw - that is the failure that stops all reconciliation (`03` G5) |

## Design

### Invariants

| # | Invariant |
|---|---|
| R1 | Every order row is committed before its create call is made |
| R2 | No order remains non-terminal without a scheduled job to advance it |
| R3 | `filled_quantity` is monotonically non-decreasing for the life of an order |
| R4 | A terminal order is never re-opened by any observation |
| R5 | An unrecognised status produces `unknown` + alarm, never an exception |
| R6 | Exactly one exchange order exists per `client_order_id`, forever |
| R7 | Every divergence produces an appended correction; no audit row is ever updated |
| R8 | After a restart, every `sending` and `ambiguous` order is resolved before any new order is placed for that account |
| R9 | Every fill in `trade_history` is either matched to one of our orders or raised as `EXTERNAL_ACTIVITY` |
| R10 | The reconciler never throws; it records, alarms and continues |

R8 and R10 are the two that matter most. R8 prevents a restart from producing duplicates; R10 prevents one malformed payload from silently disabling the only safety net in the system.

### What is stored per order

Beyond the sizing fields in `09`: `client_order_id`, `exchange_order_id` (numeric string - `01` notes UUIDs are no longer accepted), `state`, `exchange_status_raw` (the literal string received, for forensics), `filled_quantity`, `remaining_quantity`, `cancelled_quantity`, `avg_fill_price`, `fee_amount`, `sent_at`, `last_observed_at`, `terminal_at`, `resolve_attempts`, `divergence_count`.

`exchange_status_raw` is deliberately kept alongside the mapped state. When a vocabulary changes, it is the only evidence of what actually arrived.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Socket silently dead; orders appear stuck | `vs` sequence stops advancing; no events for N seconds on a busy market | Socket is a trigger only; polling continues regardless (F2) | Latency only, not correctness |
| Socket auth failure mistaken for a network blip | Disconnect within 2 s of `join` | Classify that pattern as auth failure explicitly (`05`) | One account silently receives no live updates |
| `JSON.parse` on socket money | Quantities subtly wrong, especially small ones in exponent form | Decimal-aware extraction from the raw frame (`05`) | Fill quantities and fees, silently |
| Restart re-places a `sending` order | R6 violated; two exchange ids | Reaper routes to `resolve` (`08` F10); R8 | One duplicate real-money order |
| Reconciler throws on an unknown status | Reconciliation stops entirely; everything looks fine | R5, R10 | **Total** - the safety net is off and nothing says so |
| `active_orders` never asked for a market we forgot | An open order invisible to Loops A and B | Loop C's market-agnostic `trade_history` sweep | One order untracked until the slow sweep |
| Rate limit exhausted by Loop A during a fan-out | 429s on reads while orders are working | Adaptive cadence; configurable; F1 experiment first | Reconciliation blind exactly when it is needed most |
| Clock skew | Signature errors across all accounts at once | NTP, startup offset check, alarm on first error (F7) | Everything fails; misdiagnosed as credentials |
| Stale observation overwrites fresh state | R3/R4 violated | The three-guard `apply` (F6) | One order's displayed state regresses |
| Customer trades manually; we call it our fill | A fill with no matching `client_order_id` | R9, `EXTERNAL_ACTIVITY` alert | Attribution and P&L for that account |
| Divergence resolved by editing our row | No evidence a divergence happened | R7, append-only corrections | Audit integrity, permanently |

## Open questions for Anand

1. **How aggressive should Loop A be?** 1-second polling during a fan-out gives a near-live feel and is the largest consumer of the read budget. Recommended default: **1 s for the first 30 s of a group trade, then 5 s, then 30 s**, all configurable - and revisit once the F1 experiment tells us the limit's axis.
2. **What happens to an account with unexplained external activity?** It could be innocent (the customer traded in the app) or it could be a leaked key. Recommended default: **surface it prominently to the customer as "activity we did not initiate", keep trading enabled, and require acknowledgement**; freeze only if it repeats or is large, because a false freeze on a customer's own manual trade is very costly to trust.
3. **Do we show raw exchange statuses in the UI?** Recommended default: **no in the main flow, yes in a per-order detail drawer**, because during a dispute the literal string is what settles the argument.

## Phase hints

- The **state machine and the mapping table (F1)** ship with the spot adapter, before any order is sent. Include the `unknown` + alarm path from the first commit - retrofitting it means the first unmapped status stalls the reconciler in production.
- **Loop A and the resolve ladder ship with the first real-money order.** Non-negotiable: an order with no way to reach a terminal state is money in an unknown place.
- **Loop C (the market-agnostic `trade_history` sweep) also ships with the first real order**, because it is the only detector of activity we did not cause - which includes a leaked key.
- **Loop B** can follow one phase later; it is a safety net for a case Loops A and C between them mostly cover.
- **Cold-start recovery (R8)** must be built and *tested by killing the worker mid-fan-out* before the first real-money phase is signed off (`18`).
- The **F1 rate-limit experiment** gates the cadence choices here as much as it gates the engine's. Run it first.

## Sources

- `_sources/coindcx-docs.txt` - spot order status enum and the open-equivalent/settled classification; the FAQ's cancellable-status rule and the `init` contradiction; `active_orders` requiring a market; `status_multiple` max 10 ids; `trade_history` limit 500 and no market filter; rate limits (`active_orders` 300/60 s, `cancel_all` 30/60 s, others 2000/60 s) and the FAQ's global 16/s, 960/min; the timestamp-deviation rejection; Errors section (400/401/404/429/500/503).
- `01-coindcx-spot-rest.md` - no order-history endpoint; `client_order_id` as a lookup key; order ids are numeric strings; `/exchange/ticker` is CDN-cached.
- `05-coindcx-websockets.md` - live-verified: private channel is the constant `"coindcx"` with no account identifier in payloads; `response.data` is a stringified JSON; auth failure is a silent disconnect (packet 41); wrong channel names silently yield nothing; `leave` unacknowledged on spot; depth `vs` gapless; candle `x` flips once per bar; money arrives as strings or exponent-form numbers.
- `02`/`03` - the other two status vocabularies, `cancelled` vs `CANCELED`, fractional-millisecond timestamps, the 10-second futures signing window.
- `08-fanout-execution-engine.md` - child-order states, the write-before-send rule, the reaper's `resolve` routing, the F1 rate-limit experiment.
- `11-positions-ledger-pnl.md` - fill ingestion, balance reconciliation (Loop D), `external_adjustment`.
- `18-testing-correctness-program.md` - R1-R10 as tests, including the kill-the-worker drill.
- `20-ops-audit-runbook.md` - the stuck-order runbook and alert routing.


