# 08 - Group fan-out execution engine

Status: 2026-09-03 | track: execution core | scope: how one logical group trade becomes N per-account orders on CoinDCX, and how that survives timeouts, rate limits, partial failure and our own restarts.

## Verdict

- **A group trade is a set of independent outcomes, and no amount of engineering changes that.** There is no cross-account batching (`orders/create_multiple` is one key, max 10 orders, INR markets only) and no distributed transaction across 20 exchange accounts. A filled order cannot be un-filled. So "the group trade failed" is never a truthful summary - the truthful summary is "14 filled, 3 rejected for min-notional, 2 skipped for no INR market, 1 needs human review". The product must be built around that sentence appearing in the UI, not around hiding it.
- **`client_order_id` is the whole safety story, and it is spot-only.** Max length 36 characters (FAQ). Derive it deterministically from `(group_trade_id, account_id, leg)` so a retry recomputes the identical value. CoinDCX rejects reuse, which converts the dangerous case (retry after an unseen success) into a harmless rejection, and it is a first-class lookup key on `orders/status`, so an ambiguous outcome is *resolvable* rather than guessable. Futures and margin have no equivalent (`03`, `02`), which is the strongest argument for spot-only v1.
- **The binding rate limit is probably not the one in the rate-limit table, and we do not know its scope.** The per-endpoint table allows 2000 creates/60 s, but the FAQ states a global limit of **16/sec, 960/min**. If that global figure is per API key, a 20-account fan-out is trivial. If it is per **IP**, the entire platform shares 960 requests/minute, which caps us at roughly 48 twenty-account group trades per minute across all customers - before any reconciliation polling. **Measuring which it is, is the highest-value experiment in the whole project** and it must happen in the first phase that can authenticate. See `22-nonfunctional-slos-capacity.md`.
- **Never retry a create blindly. Resolve, then decide.** On timeout, connection reset or 5xx, the order may exist. The only safe move is `orders/status` by `client_order_id`; only a definitive "not found" permits a re-send, and even then only under a lock. A retry loop around `orders/create` is the single most expensive bug available in this codebase.
- **Validate before the network, refuse rather than truncate.** Every constraint that can be checked locally - balance, min notional, step size, precision, market tradable, order type allowed for that market, per-account cap, kill switch - is checked in a pure function before any HTTP call. An account that cannot legally trade is *skipped with a reason shown on the confirmation screen*, never sent and rejected. This is what makes the per-account preview table in `21-frontend-ux-spec.md` possible.
- **Durable execution: a Postgres job table with `FOR UPDATE SKIP LOCKED`, plus a transactional outbox. Not Temporal.** The workload is small, the state is naturally relational, and it is already sharing a transaction with the order rows and the ledger. Temporal is the better tool for complex long-running workflows and the wrong tool for a two-person team that needs one boring, inspectable queue whose contents can be read with SQL during an incident.
- **Signing happens in the worker at send time.** A futures order expires 10 s after its `timestamp` (`03`) and spot signing is byte-exact over the serialised body (`06`). A pre-signed payload sitting in a queue is a rejection waiting to happen.
- **Kill switches are product features, not ops tools.** Global, per-tenant, per-account and per-market, each independently flippable, each checked inside the pre-trade gate. A customer must be able to stop everything themselves without contacting us.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Group atomicity | **None.** Independent per-account outcomes, reported individually | A filled order cannot be rolled back; pretending otherwise creates a lie in the UI | All-or-nothing with compensating sells - rejected: the compensation is itself a real trade at a worse price, and it can also fail |
| Idempotency key | `client_order_id` = `"t" + base32(HMAC(secret, group_trade_id \| account_id \| leg))[0..27]`, ≤36 chars, deterministic | Recomputable on retry; reuse is rejected by CoinDCX; queryable on `orders/status` | Random UUID per attempt - rejected, a retry would place a second order |
| Retry on ambiguous create | Never retry directly. `orders/status` by `client_order_id` first; re-send only on a definitive not-found, under the account lock | The order may already exist and be filling | Bounded blind retry with jitter |
| Durable execution | Postgres job table + `SKIP LOCKED` + transactional outbox | Inspectable with SQL mid-incident; shares transactions with order and ledger writes; no new infrastructure | Temporal (operational weight, opaque during an incident), BullMQ/Redis (state that matters must not live only in Redis), in-process promises (lost on restart) |
| Concurrency within a group | Bounded parallelism, default 8 in flight, one in-flight order per (account, market) | Wall-clock matters to a trader; unbounded parallelism trips rate limits and makes the failure pattern unreadable | Fully sequential (20 accounts × RTT is too slow), unbounded (rate-limit storm) |
| Per-account serialisation | Advisory lock on `(account_id, market)` held across the HTTP call | Prevents our own duplicate placement even without a client id (mandatory for futures, cheap insurance for spot) | Optimistic, dedupe afterwards |
| Rate limiting | Token bucket per credential **and** a global bucket, both configurable, both defaulting to the FAQ's 16/s, 960/min until measured | We do not yet know whether the limit is per key or per IP; the safe default assumes the worse case | Assume per-key and find out in production |
| Pre-trade validation | Pure function, no I/O, run twice: at preview and again immediately before send | The second run catches staleness between preview and submit | Validate once at preview |
| Sizing inside the engine | No. The engine consumes a sized, legalised plan | Keeps the money arithmetic in one testable place (`09-sizing-allocation-rounding.md`) | Size per account inside the worker |
| Cancel / close fan-out | Same engine, different leg type, same reporting | One code path for partial failure, one report shape | A separate simpler path for cancels - rejected, cancels fail partially too |
| Kill switch scope | Global, tenant, account, market - all four, checked in the gate | Different incidents need different granularity; the customer needs the tenant one | A single global flag |

## Findings

### F1 - The rate-limit picture, and the experiment that settles it

Two limits are documented, and they disagree by two orders of magnitude. Both VERIFIED from the docs.

| Source | Limit |
|---|---|
| SPOT API Rate Limits table | Create Order **2000 / 60 s**; Create Order Multiple 2000/60 s; Order Status 2000/60 s; Multiple Order Status 2000/60 s; Cancel 2000/60 s; Edit Price 2000/60 s; **Active Order 300 / 60 s**; Cancel Multiple by ID 300/60 s; **Cancel All 30 / 60 s** |
| FAQ, *"What are the rate limits applicable on CoinDCX APIs"* | **16/sec, 960/min** |

Two observations that matter more than the numbers:

1. **The reads are tighter than the writes.** `active_orders` at 300/60 s (5/s) and `cancel_all` at 30/60 s (one every two seconds) are the scarce resources - not order creation. That inverts the intuitive budget: reconciliation polling, not trading, is what will hit a limit first. A reconciler that polls `active_orders` per account every 5 s consumes 0.2 req/s per account, so 25 accounts saturates the 5/s allowance **if the limit is per IP**.
2. **The scope is unknown and it changes the business.** The FAQ phrases it as *"too many API calls which leads to rate limit for a user"*, which hints per-user, but "user" and "key" and "IP" are not distinguished anywhere.

The experiment, to run in the first authenticated phase:

```
Given two API keys, K1 and K2, on two different CoinDCX accounts, from ONE egress IP:
  1. Drive K1 with a harmless authenticated read (users/balances) at 20 req/s for 10 s. Record when 429 starts.
  2. The instant K1 is throttled, issue a single request on K2 from the same IP.
       K2 succeeds  -> the limit is per key. Capacity scales with customers. Good.
       K2 is 429'd  -> the limit is per IP. The platform shares 960/min. Redesign capacity now.
  3. Repeat step 2 from a second egress IP with K1 to confirm the axis.
```

Until it is run, the token bucket defaults to the pessimistic reading: one global bucket at 16/s and 960/min, with per-credential buckets nested inside it. Making the buckets configuration rather than code means the answer changes a number, not a design.

### F2 - Failure classification

Every outcome of an exchange call falls into exactly one of these. The retry column is the important one and it is not negotiable.

| Class | Signals | Order may exist? | Retry? | Action |
|---|---|---|---|---|
| Accepted | 2xx with an order id | Yes, definitely | n/a | Record, move to tracking |
| Business rejection | 400/422 with a validation message (min notional, precision, order type not allowed, insufficient balance) | No | **Never** | Record the reason against the account, show it in the report |
| Auth failure | 401 | No | **Never** | Increment `auth_error_count`; block the account after 3; notify the customer (`07`) |
| Rate limited | 429 | No | Yes, after the bucket refills | Re-queue with backoff; never tight-loop |
| Server error | 500, 503 | **Unknown** | Not directly | Resolve by `orders/status`, then decide |
| Timeout / reset | no response | **Unknown** | Not directly | Resolve by `orders/status`, then decide |
| Signature / timestamp error | 401 with a signing message; futures `timestamp` older than 10 s | No | Yes, re-sign | Re-sign at send time; alarm if it recurs (clock skew) |
| Not found | 404 | No | No | Programming error - alarm |

Two documented traps sit inside this table:

- **A market order can be accepted and then rejected later.** FAQ: *"in case of market orders, the order value could go below the min notional value of the market"* after placement. So `ACKED` is not `FILLED`, and the terminal state must come from `orders/status` or the socket, never from the create response.
- **A 5xx is genuinely ambiguous.** The docs describe 500 as *"a one-off error … due to internal issues"* and 503 as downtime. Neither tells us whether the order was accepted before the failure.

### F3 - Pre-trade gates

All local, all cheap, all run before any network call - and run **twice**: once to build the preview, once immediately before send. Ordered so the cheapest and most explanatory failures come first.

| # | Gate | Refusal reason shown to the customer |
|---|---|---|
| 1 | Global kill switch off | "Trading is paused platform-wide" |
| 2 | Tenant kill switch off | "You have trading paused" |
| 3 | Account enabled, credential `active` | "Account disconnected - reconnect your API key" |
| 4 | Market exists for this account's funding currency | "No INR market for this coin on this account" |
| 5 | Market `status` is active and the order type is allowed for that market | "BTCINR does not accept stop orders" |
| 6 | Sized quantity ≥ max(`min_quantity`, 10^-`target_currency_precision`) | "Below the minimum order size for this market" |
| 7 | Notional ≥ `min_notional` | "Order value below the Rs X minimum" |
| 8 | Quantity ≤ `max_quantity` | "Above the maximum order size" |
| 9 | Free balance ≥ notional + fee headroom | "Insufficient balance - short by Rs X" |
| 10 | Per-account notional cap not exceeded | "Exceeds the Rs X cap you set on this account" |
| 11 | Per-tenant daily notional cap not exceeded | "Exceeds your daily limit" |
| 12 | No in-flight order for (account, market) | "An order is already in flight for this market" |

Gate 6 encodes a rule the docs state explicitly and that is easy to get wrong: the effective minimum is the **maximum** of `min_quantity` and the smallest value representable at `target_currency_precision`. The FAQ's own example: *"if the min_quantity returns 0.0001 and the target_currency_precision is 2, then the min quantity allowed is actually 0.01 and not 0.0001."*

### F4 - The pipeline

Four stages, each with a durable boundary. The customer sees stage 2 before stage 3 ever happens.

```
 1 INTENT      customer picks group + coin + side + sizing mode + value
               ── persisted as group_trade (status = draft)
                  nothing has been sized yet; this row is the audit anchor

 2 PLAN        for each member account: resolve market (10), size (09), legalise (09),
               run gates 1-12 (F3)
               ── persisted as N child_order rows (status = planned | skipped)
                  returned to the browser as the PREVIEW TABLE (21)
                  preview carries a freshness deadline; expiry invalidates submit

 3 EXECUTE     customer confirms -> group_trade.status = executing
               enqueue one job per planned child order
               worker: lock (account, market) -> re-run gates -> sign -> POST create
               ── each child_order transitions independently

 4 REPORT      as each child order reaches a terminal state, fold it into the
               execution report; the group_trade is done when every child is terminal
               ── group_trade.status = completed (with a per-outcome breakdown)
```

Child-order state machine:

```
  planned ──▶ sending ──▶ acked ──▶ open ──▶ partially_filled ──▶ filled      (terminal)
     │           │          │         │              │
     │           │          │         └──────────────┴──▶ cancelled           (terminal)
     │           │          │                             partially_cancelled (terminal)
     │           │          └──────────────────────────▶ rejected             (terminal)
     │           └──▶ ambiguous ──(resolve, F6)──▶ acked | not_placed | needs_human
     └──▶ skipped (terminal, with a reason)
```

`sending` is written **before** the HTTP call, inside the same transaction that reserves the `client_order_id`. That ordering is what makes recovery possible: after a crash, every row in `sending` is by definition ambiguous and gets resolved by F6. A design that writes the row after the call has no way to know an order exists.

`ambiguous` is a real, persisted state, not an exception. Naming it forces the recovery path to exist.

### F5 - Deriving `client_order_id`

Constraints: ≤36 characters (FAQ), unique per order across our whole history, deterministic from the child order's identity, and opaque enough that it leaks nothing.

```
material = group_trade_id || account_id || leg_seq        (leg_seq: 0 for the primary leg)
digest   = HMAC-SHA256(app_pepper, material)
coid     = "t" + base32_crockford(digest[0..15]).toLowerCase()     -> 1 + 26 = 27 chars
```

| Property | How it is achieved |
|---|---|
| Deterministic | Same inputs, same output - a retry recomputes it |
| ≤36 chars | 27 characters, leaving headroom |
| Collision-safe | 128 bits of digest |
| Reveals nothing | HMAC with a server pepper; no tenant or account id recoverable |
| Retry-safe by construction | CoinDCX rejects a reused `client_order_id`, so an accidental second send fails closed rather than placing a duplicate |
| Queryable | It is a documented lookup key on `orders/status`, `status_multiple`, `cancel`, `cancel_by_ids`, `edit` (`01`) |

The `leg_seq` field exists so a future feature that needs two orders per account per group trade (for example an entry plus a protective stop) does not have to change the derivation.

### F6 - Resolving an ambiguous outcome

```
resolve(child_order):
  # invariant: the (account, market) lock is still held, coid is known
  for attempt in 1..5 with backoff 250ms, 1s, 3s, 8s, 20s:
      r = POST /exchange/v1/orders/status { client_order_id: coid }
      if r is a found order:
          adopt its id and status -> acked/open/filled/...     DONE
      if r is a definitive not-found:
          if attempt == 1 and elapsed_since_send < 2s:
              continue            # the exchange may not be consistent yet
          state = not_placed
          re-send is permitted (same coid, still under the lock)  DONE
      if r is 429 or 5xx or timeout:
          continue
  state = needs_human; freeze the account; alarm               DONE
```

Two subtleties worth stating because both are easy to get wrong:

- **Do not trust the first not-found.** A create that was accepted milliseconds ago may not yet be visible to a status read. Requiring either a second observation or a 2-second floor removes the race that would otherwise cause a genuine duplicate.
- **Re-sending with the same `coid` is safe and is the point.** If the first attempt did land after all, the exchange rejects the duplicate id and we learn the truth from the rejection. There is no path in which we place two orders.

For futures and margin, none of this works - there is no `coid` to query by. That gap is documented in `03-coindcx-futures-orders-rest.md` and is why v1 is spot-only.

### F7 - The execution report

The report is the product. It is what a customer looks at after pressing the button, and it is what support looks at during a dispute. It is built incrementally as children settle, never assembled at the end.

| Level | Contents |
|---|---|
| Group summary | Intent as stated (side, coin, sizing mode, value), requested vs placed vs filled totals per currency, counts by outcome, wall-clock from submit to last terminal state |
| Per account | Account name, resolved market, computed quantity, price basis used, submitted price, average fill price, filled quantity, fee, outcome, and for a non-fill the exact reason string |
| Divergence | Best and worst fill price in the group, spread between them, and each account's slippage against the decision-time mid captured at stage 2 |
| Provenance | `client_order_id`, exchange order id, the metadata version used to legalise, the FX rate snapshot, who submitted it, from which IP |

The divergence row exists because it answers the question a customer will definitely ask - *"why did account 7 get a worse price than account 3?"* - and because it cannot be reconstructed later: the decision-time mid must be captured at planning time or it is gone forever (`14-analytics-product-spec.md`).

### F8 - Concurrency, fairness and scheduling

| Concern | Rule |
|---|---|
| Within one group trade | Bounded parallelism, default 8 in flight. Configurable per tenant |
| Per (account, market) | Strictly one in-flight order. Enforced by advisory lock, not by convention |
| Across tenants | Round-robin over tenants when draining the job table, so one customer's 100-account fan-out cannot starve another's 2-account trade |
| Ordering within a group | None guaranteed, and the UI must not imply one. If a customer needs account A before account B, that is a different feature |
| Backpressure | When the global bucket is exhausted, jobs wait in the table rather than in memory; the preview's freshness deadline is what protects the customer from a stale execution |
| Deadline | A group trade that cannot start within 60 s of confirmation is abandoned with every child marked `skipped: platform_busy` rather than executed late. A trader would rather not trade than trade at an unknown price |

That last rule is a deliberate product choice and it should be surfaced: silently executing a market order two minutes after the customer pressed the button is worse than refusing.

### F9 - Cancel and close fan-out

Same engine, three differences:

| | Buy/sell fan-out | Cancel fan-out | Close/sell-all fan-out |
|---|---|---|---|
| Per-account input | Sized quantity | The child order ids to cancel | Held quantity, read fresh |
| Precondition | Gates 1-12 | Order is in `open` or `partially_filled` - the FAQ is explicit that a `filled`, `cancelled` or `rejected` order *"cannot be cancelled"* | Non-zero holding after reconciliation |
| Tempting shortcut to avoid | - | `orders/cancel_all` - it is limited to **30/60 s**, the tightest limit in the API, and it cancels orders we did not place | Selling a quantity from our own records rather than the exchange's |

The close case has a trap worth naming: "sell all" must derive its quantity from the exchange's current free balance, not from our derived position, because any deposit, withdrawal or manual trade the customer made outside Tradex makes our figure wrong. Attempting to sell more than is held is a rejection at best. `09-sizing-allocation-rounding.md` owns the rule; the engine's job is to read fresh before it sends.

### F10 - The durable job substrate

```sql
CREATE TABLE execution_job (
  id             bigserial PRIMARY KEY,
  child_order_id uuid NOT NULL REFERENCES child_order(id),
  tenant_id      uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('place','resolve','cancel','poll')),
  run_after      timestamptz NOT NULL DEFAULT now(),
  attempts       int NOT NULL DEFAULT 0,
  locked_by      text,
  locked_at      timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON execution_job (run_after) WHERE locked_by IS NULL;
CREATE INDEX ON execution_job (tenant_id, run_after);
```

The claim query, which is the entire scheduler:

```sql
UPDATE execution_job j SET locked_by = $worker, locked_at = now(), attempts = attempts + 1
WHERE j.id IN (
  SELECT id FROM execution_job
  WHERE locked_by IS NULL AND run_after <= now()
  ORDER BY run_after
  FOR UPDATE SKIP LOCKED
  LIMIT $batch
) RETURNING *;
```

Why this and not Temporal: during an incident, the on-call question is *"what is stuck and why"*. Here that is one `SELECT`. The state lives in the same database as the orders it describes, so a job and its order are updated in one transaction and can never disagree. Temporal would add a second source of truth, its own operational surface and an opaque history to page through - real costs against a workflow that has four stages and no long-running human steps. If the workload later grows genuine long-lived workflows, revisit; the job table does not prevent that.

Restart safety: a worker holding `locked_by` that dies leaves the row locked. A reaper clears locks older than 5 minutes and, critically, routes those jobs to `kind = 'resolve'` rather than `'place'` - because a job that was in flight may already have placed an order. Re-queuing a dead `place` job as a `place` is the exact bug that produces duplicates.

## Design

### One account's happy path, in full

```
worker                          db                     signer            CoinDCX
  │ claim job (SKIP LOCKED)      │                        │                  │
  ├─────────────────────────────▶│                        │                  │
  │ acquire advisory lock (account, market)               │                  │
  ├─────────────────────────────▶│                        │                  │
  │ re-run gates 1-12 (F3)       │                        │                  │
  │ token bucket: credential + global (F1)                │                  │
  │ child_order -> sending, coid reserved  ── COMMIT ────▶│                  │
  │                              │                        │                  │
  │ sign(cred_id, exact body)  ──┼───────────────────────▶│                  │
  │◀── headers + signature ──────┼────────────────────────│                  │
  │ POST /exchange/v1/orders/create ──────────────────────┼─────────────────▶│
  │◀── 200 { id, status } ────────────────────────────────┼──────────────────│
  │ child_order -> acked, exchange id   ── COMMIT ───────▶│                  │
  │ enqueue poll job; release lock                        │                  │
```

Everything that can fail is on one of four lines, and each has exactly one defined outcome in F2. The commit before the POST is the load-bearing detail.

### Invariants this engine must uphold

Each is phrased so it can become a test in `18-testing-correctness-program.md`.

| # | Invariant |
|---|---|
| I1 | For every `(group_trade_id, account_id, leg_seq)` there is at most one order on CoinDCX, forever |
| I2 | No child order is ever in a non-terminal state with no job scheduled to advance it |
| I3 | A child order in `sending` after a restart is resolved, never re-placed |
| I4 | Every child order reaches a terminal state or `needs_human`; none is abandoned |
| I5 | A group trade is `completed` only when every child is terminal |
| I6 | No exchange call is made for an account whose gates fail |
| I7 | No business rejection is ever retried |
| I8 | The sum of per-account notionals never exceeds the tenant's configured cap |
| I9 | Every terminal outcome carries a human-readable reason |
| I10 | A signed payload is sent within 2 s of being signed |

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Create response lost, order exists | Row stuck in `sending` | F6 resolve by `client_order_id`; never blind retry | One account, resolved automatically |
| Worker dies mid-fan-out | Lock older than 5 minutes | Reaper re-queues as `resolve`, not `place` (F10) | Remaining accounts delayed, none duplicated |
| Rate limit is per IP, discovered in production | Cluster of 429s across unrelated tenants | Run the F1 experiment first; global bucket on by default | Platform-wide throttling during a fan-out |
| `cancel_all` used casually | 429 at 30/60 s | Never use it; cancel by ids | Cancels fail exactly when a customer needs them most |
| Preview goes stale, customer confirms late | Freshness deadline on the preview | Re-run gates before send; abandon after 60 s (F8) | A trade at a price the customer never saw |
| One tenant's 100-account fan-out starves others | Queue age per tenant | Round-robin drain (F8) | Latency for everyone else |
| Market order accepted then rejected for min notional | Terminal state from `orders/status`, not from create | Never treat `acked` as `filled` (F2) | One account reports filled when it did not |
| Duplicate from a re-queued `place` job | I1 violated; two exchange ids for one `coid` | The reaper's `resolve` routing, plus CoinDCX rejecting reused ids | One duplicate real-money order |
| Group partially filled and the customer assumes all-or-nothing | - | The report is per account by design; the confirmation screen says so before submit (`21`) | Customer acts on a false belief about their exposure |
| Clock skew makes signatures fail | Recurring signature errors across all accounts | NTP on every host; alarm on any signature error (`06`) | Everything fails; looks like an outage |

## Open questions for Anand

1. **Is the rate limit per key or per IP?** Not a preference - an experiment (F1). But you should know the stakes: if per IP, platform throughput is roughly 48 twenty-account group trades per minute until we obtain HFT trusted-IP access, and that shapes pricing and onboarding pace. Recommended default: **assume per IP, run the experiment in the first authenticated phase, and re-plan capacity on the answer.**
2. **What is the per-tenant daily notional cap, and who sets it?** A cap is mandatory (I8) because it is the only thing that bounds a compromised session or a fat-fingered percentage. Recommended default: **customer-settable with a platform maximum**, defaulting to something conservative like Rs 5,00,000/day until they raise it deliberately.
3. **Should a customer be able to retry only the failed subset of a group trade?** It is clearly useful and it is also a second real-money action taken on stale prices. Recommended default: **yes, but as a fresh trade** - re-plan, re-price, re-preview, new `group_trade_id`. Never re-run the old plan.

## Phase hints

- **The engine is not the first phase.** It needs: credentials (`07`), market metadata and sizing (`09`), and the spot adapter (`01`). Build it after a single account can be traded end to end, because fan-out multiplies whatever is still wrong.
- The **F1 rate-limit experiment** belongs in the earliest phase that can authenticate - before capacity, pricing or the reconciler's polling interval are designed.
- **Gates (F3) ship before the engine**, as a pure function with no I/O, because the preview screen needs them and because they are the cheapest thing to test exhaustively.
- **`ambiguous` and the resolve protocol (F6) ship with the very first real-money order**, not later. An unresolvable order on day one is a customer's money in an unknown state.
- The **job table and reaper (F10)** ship with the engine; the reaper's `resolve` routing is not an optimisation and must not be deferred.
- **Kill switches** ship before the first real-money order, and the tenant-level one must be reachable by the customer in two clicks.

## Sources

- `_sources/coindcx-docs.txt` - SPOT API Rate Limits table; FAQ (global 16/sec 960/min; `client_order_id` max length 36; cancellable statuses; market orders rejected post-placement for min notional; reasons an order is not placed; min-quantity-versus-precision rule); Errors section (400, 401, 404, 429, 500, 503).
- `01-coindcx-spot-rest.md` - `client_order_id` as a lookup key across five endpoints; `orders/create` takes `total_quantity` only; `create_multiple` is one key, max 10, INR only; no spot order-history endpoint; spot status vocabulary and the open-equivalent/settled split.
- `03-coindcx-futures-orders-rest.md` - the 10 s signing window; no `client_order_id` on futures.
- `06-coindcx-auth-ratelimits-errors-tos.md` - byte-exact signing, timestamp handling.
- `07-api-key-security.md` - the signer boundary, auth-failure blocking.
- `09-sizing-allocation-rounding.md`, `10-multi-currency-inr-usdt.md` - sizing and market resolution consumed by stage 2.
- `12-order-state-reconciliation.md` - the poll/socket truth channels that drive child orders to terminal states.
- `21-frontend-ux-spec.md` - the preview table and partial-failure presentation.
- `22-nonfunctional-slos-capacity.md` - latency budget and the capacity consequences of F1.




