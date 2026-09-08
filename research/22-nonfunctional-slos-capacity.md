# 22 - SLOs, capacity and cost model

Status: 2026-09-03 | track: platform | scope: numbers with their assumptions attached - latency budget, throughput ceilings, the rate-limit arithmetic that decides platform capacity, socket and database sizing, cost, and what "degraded" means for a trading app.

## Verdict

- **One unanswered question sets the platform's capacity ceiling, and it is a two-hour experiment.** If CoinDCX's `16/sec, 960/min` limit is per **API key**, capacity scales with customers and nothing here is a constraint. If it is per **IP**, the whole platform shares 960 requests/minute, and the arithmetic in F3 caps us at roughly **2,400 idle accounts or 400 accounts with working orders** - total, across all customers. That is the difference between a business and a hobby, and it is settled by two keys, one egress IP, and read-only calls (`08` F1, `18` F1).
- **The network is not the bottleneck; connection handling is.** Measured from an Indian connection: **37.6 ms warm, 102-113 ms cold** to `api.coindcx.com` (`17` F1). Connection reuse is worth ~65 ms per call, so a 20-account fan-out on cold connections wastes **1.3 seconds** for nothing. Pooled keep-alive agents are the single highest-leverage performance decision in the system.
- **A 20-account group trade should send its last order within ~400 ms and be a p95 SLO of 1 second.** Budget in F2: gates and sizing are local and sub-millisecond, the signer's KMS decrypt is the largest per-account cost, and the exchange round trip is 38 ms. At 8-way parallelism the exchange time is ~120 ms total, not 760 ms.
- **Private sockets are per API key and that is not negotiable**, because the payloads carry no account identifier (`05`). So socket count equals account count: 2,000 accounts is 2,000 concurrent socket.io connections from our egress. Whether CoinDCX limits concurrent connections per IP is **UNVERIFIED** and is the second experiment to run.
- **Reads are the scarce resource, not writes.** `active_orders` is 300/60 s and `cancel_all` is 30/60 s against 2000/60 s for creates. The reconciler, not the trading, is what saturates a limit - which inverts the intuitive capacity model (`12` F5).
- **"Degraded" must mean something specific and pre-agreed:** read-only (no new orders, tracking continues) and cancel-only (no opens, closes allowed). Both are product states with UI, not improvised responses.
- **Infrastructure cost at 100 customers is roughly Rs 20,000-25,000/month.** Estimated, not quoted - F6 lists every line so it can be checked. The point is that infrastructure is not the constraint; the rate limit is.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Rate-limit assumption until measured | **Assume per IP** (the pessimistic case) | Being wrong in the safe direction costs some throughput; being wrong the other way means discovering a hard ceiling in production | Assume per key |
| Connection strategy | One pooled keep-alive agent per exchange host, shared across tenants | 65 ms saved per call (F2) | A connection per request |
| Fan-out parallelism | 8 in flight by default, configurable per tenant | Balances wall-clock against rate-limit burst | Sequential; unbounded |
| Reconciler cadence | Adaptive: 1 s during a fan-out, 30 s for accounts with open orders, 5 min idle sweep - all configuration | The cadence is the main consumer of the read budget (F3) | Fixed 1 s polling |
| Socket topology | One private socket per credential, in dedicated ingester processes, sharded | Per-key is forced by the protocol (`05`) | One socket for many keys (impossible) |
| Latency SLO | p50 400 ms, p95 1 s, p99 2 s from confirm to last order **sent** | Sending is what we control; filling is the exchange's | An SLO on fill time |
| Availability target | 99.5% monthly for the trading path | Realistic for a small team; 99.9% would require on-call depth we do not have (`20`) | 99.9% aspirationally |
| Degraded modes | `read_only` and `cancel_only`, both explicit product states | An improvised degraded mode is an outage with extra steps | Binary up/down |
| Data retention | 5 years for ledger, orders and audit (`15`); 90 days for candle cache; 30 days hot logs | Statutory floor versus cost | Uniform retention |
| Partitioning | Monthly partitions on `audit_event` and `ledger_entry` from the start | Audit is the largest table at ~15 GB/year (F5) | Partition later under pressure |
| Cost posture | Single-AZ until the first paying cohort, then multi-AZ Postgres | Cost discipline early, durability when it matters | Multi-AZ from day one |

## Findings

### F1 - Measured inputs

Everything downstream depends on these four numbers. All measured 2026-09-04 except where noted.

| Input | Value | Source |
|---|---|---|
| Warm request to `api.coindcx.com` | **37.6 ms** TTFB | Live keep-alive reuse test (`17` F1) |
| Cold request | 102-113 ms TTFB (DNS 5-9, TCP 28-32, TLS 62-75) | Live, 5 samples |
| Documented global rate limit | **16/sec, 960/min** | CoinDCX FAQ |
| Documented per-endpoint limits | create 2000/60 s; `active_orders` 300/60 s; `cancel_all` **30/60 s** | SPOT API Rate Limits table |
| Rate-limit axis (key or IP) | **UNKNOWN** - the deciding unknown | Not documented anywhere |
| Private sockets required | One per API key | `05`, verified live |
| Socket connections per IP limit | **UNVERIFIED** | Not documented |
| KMS decrypt latency | ~10-30 ms assumed | Not measured; assumption flagged |
| Markets | 999, all active | Live `markets_details` |

Two of these are assumptions dressed as numbers and are labelled as such: KMS latency (measure it in Phase 00, it sits on the critical path) and the socket connection ceiling.

### F2 - Latency budget for a 20-account group trade

Per account, then composed at 8-way parallelism.

| Step | Cost | Measured or assumed |
|---|---|---|
| Re-run gates 1-12 (`08` F3) | < 1 ms | Pure function, no I/O |
| Claim job + write `child_order` = `sending` | 1-3 ms | Local Postgres commit, assumed |
| Signer: KMS decrypt | **10-30 ms** | **Assumed** - the largest per-account cost |
| Signer: AES-GCM open + HMAC | < 1 ms | Negligible |
| HTTP POST `orders/create` | **37.6 ms** | Measured, warm |
| Record `acked` + enqueue poll | 1-3 ms | Local commit |
| **Per account, serial** | **~50-70 ms** | |

Composed:

| Phase | Calculation | Result |
|---|---|---|
| Preview (planning) | 1 shared orderbook read (38 ms) + 20 × sizing (< 1 ms) + fx snapshot | **~60 ms** |
| Execute at 8-way | ceil(20/8) = 3 batches × ~70 ms | **~210 ms** |
| Confirm → last order sent | preview is already done; execute only | **~210-400 ms** |
| **SLO** | p50 400 ms · p95 1 s · p99 2 s | |

Two observations. The budget is dominated by **KMS decrypt**, which is the one number here that is assumed rather than measured - if it turns out to be 50 ms, a 20-account fan-out grows by ~120 ms and the case for a short-lived in-signer DEK cache (`07` F5) becomes real. And **cold connections would add 65 ms per account** - 3 batches × 65 ms ≈ 200 ms, doubling the execute phase for no reason.

Note what is *not* in this budget: fill time. A market order's fill is the exchange's business and an INR pair's 0.42% spread matters far more to the customer than 200 ms of our latency (`09` F6).

### F3 - The rate-limit arithmetic

This is the section that decides platform capacity. Both branches computed.

**Per-account request cost, steady state** (from `12` F4 cadences):

| Loop | Cadence | Calls/min per account |
|---|---|---|
| A `status_multiple` | 1 s, only during a fan-out | 60 while active, 0 otherwise |
| B `active_orders` | 30 s, only if the account has open orders | 2 if open orders, else 0 |
| C `trade_history` | 5 min, always | 0.2 |
| D `users/balances` | 5 min, always | 0.2 |
| **Idle account** | | **0.4** |
| **Account with a resting order** | | **2.4** |
| **Account in an active fan-out** | | **~62** |

**Branch 1 - limits are per API key.** Each account's key has its own 960/min. An idle account uses 0.4 of 960. An account in an active fan-out uses ~62 of 960. **No ceiling from this axis at any plausible scale.** Capacity becomes a question of our own CPU, sockets and database.

**Branch 2 - limits are per IP.** All accounts share 960/min from one egress.

| Scenario | Calculation | Ceiling |
|---|---|---|
| All accounts idle | 960 / 0.4 | **2,400 accounts** |
| All accounts holding resting orders | 960 / 2.4 | **400 accounts** |
| One 20-account fan-out in flight | 20 × 62 = 1,240/min | **Exceeds the entire budget on its own** |
| 100 customers × 20 accounts, idle | 2,000 × 0.4 = 800/min | Fits, with 160/min headroom for trading |
| 100 customers × 20 accounts, 25% holding orders | 500×2.4 + 1500×0.4 = 1,800/min | **1.9× over budget** |

The third row is the one to notice: at a 1-second Loop A cadence, **a single 20-account group trade consumes more than the platform's entire per-minute allowance**. Under branch 2, Loop A must drop to ~5 s during a fan-out (20 × 12 = 240/min, a quarter of the budget) and concurrent fan-outs must be queued platform-wide.

Mitigations under branch 2, best first:

| Mitigation | Effect | Cost |
|---|---|---|
| Multiple egress IPs behind a NAT pool, requests distributed | Multiplies the ceiling by the IP count - **if** the axis is truly IP | A NAT gateway per IP; and UNVERIFIED whether CoinDCX would treat it as evasion. **Ask them first** |
| Enterprise HFT access (`07` F1) | Higher limits and a sanctioned static IP | Requires contacting CoinDCX and qualifying |
| Socket-primary, poll-on-change | Loop A becomes event-driven; polling only confirms | Sockets fail silently (`05`), so polling can be reduced but never removed |
| Slower cadences | Linear | Slower UI feedback; more time in `ambiguous` |
| Batch `status_multiple` 10 ids per call | Already assumed; helps only within one key | - |

The honest summary: **under branch 2, the first ~50 customers are comfortable and growth past a few hundred accounts requires a conversation with CoinDCX.** That is a fine place to be, provided it is known before pricing and onboarding pace are set - which is why the experiment comes before Phase 02.

### F4 - Socket capacity

Private channels require one connection per API key (`05`). So:

| Accounts | Private sockets | Est. memory | Notes |
|---|---|---|---|
| 100 | 100 | ~10-20 MB | Trivial |
| 2,000 | 2,000 | ~200-400 MB | One ingester process is enough |
| 10,000 | 10,000 | ~1-2 GB | Shard across processes; reconnect storms become the real risk |

Plus **one** market-data socket regardless of account count (`13` V5). Assumptions: 50-100 KB per socket.io connection including TLS state, and no per-IP connection cap - the latter **UNVERIFIED** and the reason this is the second experiment.

The dominant risk is not steady-state memory but a **reconnect storm**: if 2,000 sockets drop together, 2,000 simultaneous authenticated reconnections are both a thundering herd against CoinDCX and a burst against whatever connection limit exists. Mitigation: jittered exponential backoff per connection, a global reconnect rate cap, and staggered start-up.

### F5 - Database sizing

Assumptions stated per row: 100 customers, 20 accounts each, 4 trades per account per day.

| Table | Rows/day | Rows/year | Bytes/row | Size/year | 5-year |
|---|---|---|---|---|---|
| `child_order` | 8,000 | 2.9 M | ~400 | 1.2 GB | 6 GB |
| `ledger_entry` (3-4 per fill) | ~28,000 | 10 M | ~250 | 2.5 GB | 12.5 GB |
| `audit_event` (~10 per trade + access) | ~80,000 | 29 M | ~500 (jsonb) | **14.6 GB** | **73 GB** |
| `equity_snapshot` (daily + 5-min intraday) | ~60,000 | 22 M | ~120 | 2.6 GB | 13 GB |
| `account_balance` | updated in place | - | - | negligible | - |
| Candle cache (50 markets × 5 resolutions) | - | ~25 M total | ~60 | 1.5 GB | capped by 90-day TTL |
| **Total** | | | | **~22 GB/year** | **~105 GB** |

`audit_event` is the largest table by a wide margin and it is the one with a **statutory** 5-year floor (`15`). Consequences: monthly partitioning from day one, `jsonb` payloads kept minimal (references not copies), and the monthly export to write-once storage (`20` F4) doubling as an archival path so hot storage can stay small.

Nothing here is difficult at these volumes. A single managed Postgres instance handles it comfortably; the sizing exercise exists to prove that, and to catch the audit table before it is a surprise.

### F6 - Cost model

**Estimates for AWS Mumbai (`ap-south-1`), not quotes.** UNVERIFIED - to be checked against the AWS calculator before any commitment. USD converted at ~Rs 85.

| Line | 100 customers | 1,000 customers |
|---|---|---|
| RDS Postgres (t4g.medium single-AZ → m7g.large multi-AZ) | ~Rs 6,000 | ~Rs 30,000 |
| App + worker instances (2 × t4g.small → 4 × t4g.medium) | ~Rs 2,500 | ~Rs 10,000 |
| Socket ingester instances | included above | ~Rs 5,000 |
| NAT gateway (pinned egress) + data | ~Rs 3,000 | ~Rs 6,000 |
| Load balancer | ~Rs 1,700 | ~Rs 1,700 |
| Redis (t4g.micro → small) | ~Rs 1,000 | ~Rs 3,000 |
| KMS (1 CMK + request volume) | ~Rs 200 | ~Rs 1,500 |
| Backups, S3, logs, metrics | ~Rs 2,000 | ~Rs 8,000 |
| **Total / month** | **~Rs 16,000-20,000** | **~Rs 65,000-75,000** |

At 100 customers that is roughly Rs 200 per customer per month in infrastructure - not the constraint on this business. **The constraint is the rate limit**, and no amount of infrastructure spending changes it under branch 2.

### F7 - Degraded modes

| Mode | New orders | Cancels / closes | Tracking | Reads | Trigger |
|---|---|---|---|---|---|
| `normal` | yes | yes | yes | yes | - |
| `cancel_only` | **no** | yes | yes | yes | Rate-limit saturation; partial exchange degradation; a tenant near its daily cap |
| `read_only` | no | **no** | yes | yes | Total exchange outage; our own degradation; reconciler unhealthy |
| `frozen` (per account) | no | no | yes | yes | `needs_human` order; suspected key compromise (`20` R1) |

Rules: entering a degraded mode is automatic on the trigger and **exiting is manual**, after a reconciliation sweep. Every mode is visible in the UI with the reason, because a customer who cannot place a trade and is not told why assumes the product is broken. `read_only` deliberately keeps cancels *off* - during a total exchange outage a cancel cannot be confirmed, and an unconfirmable cancel is worse than none.

### F8 - Capacity landmines

| # | Landmine | Why it bites |
|---|---|---|
| 1 | Rate limit is per IP | Caps the whole platform at hundreds of accounts (F3) |
| 2 | Loop A at 1 s during a fan-out | A single group trade exceeds the entire per-minute budget under branch 2 |
| 3 | Cold connections | 65 ms × accounts, silently doubling fan-out time |
| 4 | KMS decrypt slower than assumed | Sits on the critical path, 20× per fan-out |
| 5 | Reconnect storm across all private sockets | Thundering herd against an unknown connection limit |
| 6 | `audit_event` growth | 73 GB over the statutory 5 years, unpartitioned by default |
| 7 | Unbounded group size | 50 accounts in one group is 50 creates in one burst |
| 8 | Candle cache breadth | 999 markets × 9 resolutions is 9,000 series if cached indiscriminately |
| 9 | `max_quantity_market` re-reads | Depth-derived and moving (`09` F6), so it cannot be cached long - a per-trade read cost |
| 10 | Concurrent fan-outs across tenants | Fair queueing is required, not optional, under branch 2 |

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Discover branch 2 in production | 429s across unrelated tenants | Run the experiment before Phase 02 | Platform-wide throttling during trading |
| Loop A saturates the budget | Bucket depth alert (`20` A9) | Adaptive, configurable cadence | Reconciliation blind during a fan-out |
| Cold connections in production | Latency histogram at ~105 ms | Pooled agents, asserted by a test | Fan-out twice as slow |
| KMS on the critical path is slow | Signer latency metric | Measure in Phase 00; consider a per-fan-out DEK cache with the weakening recorded | Every trade slower |
| Reconnect storm | Simultaneous reconnect count | Jittered backoff, global reconnect cap | Possible IP-level rejection |
| `audit_event` unpartitioned | Query latency, storage cost | Monthly partitions from day one | Painful migration on a live system |
| Degraded mode improvised | - | Four named modes with automatic entry, manual exit (F7) | Confused customers, inconsistent behaviour |
| Group of 50 in one burst | Rate-limit spike | Parallelism cap independent of group size | 429s mid-group |
| Cost assumed rather than checked | Bill | Verify F6 against the AWS calculator before commitment | Budget surprise, not a technical failure |

## Open questions for Anand

1. **Run the rate-limit experiment before anything else is planned around capacity.** It needs two CoinDCX accounts, two keys, one egress IP, and only read-only calls. Recommended default: **Phase 01, before the engine is designed in detail.** Everything in F3 hinges on it.
2. **If the answer is per IP, do we ask CoinDCX about multiple egress IPs, or pursue HFT access?** Recommended default: **ask about both in the same conversation** - and ask before implementing an IP pool, because distributing requests across IPs to raise an effective limit could be read as circumvention.
3. **Availability target: 99.5% or 99.9%?** 99.9% is ~43 minutes of downtime a month and implies real on-call depth (`20`). Recommended default: **99.5% for v1**, stated publicly, revisited when the team grows.
4. **Do we cap concurrent fan-outs platform-wide?** Under branch 2 this is mandatory. Recommended default: **build the cap now, set it high**, so switching it down is a config change rather than a feature.

## Phase hints

- **The rate-limit experiment (`08` F1) is the first task of the first phase that can authenticate.** Its result changes the reconciler, the capacity model, pricing and onboarding pace.
- **Measure KMS decrypt latency in Phase 00**, when the envelope helpers are built. It is the largest assumed number in F2.
- **The pooled keep-alive agent belongs to the adapter phase**, with a test asserting connection reuse (observe ~38 ms, not ~105 ms).
- **Monthly partitioning on `audit_event` and `ledger_entry` is a Phase 00 schema decision**, not an optimisation.
- **Socket sharding and jittered reconnect** ship with the socket ingester; the reconnect cap is a small addition that prevents a self-inflicted outage.
- **The four degraded modes (F7) ship before the first real-money order**, because `read_only` is the response to an exchange outage and outages do not wait for a later phase.
- **Re-measure F1's latency from the chosen host** before signing off the SLO; the current numbers are from a residential connection.

## Sources

- Live measurement 2026-09-04 (`17` F1): warm keep-alive TTFB **37.6 ms**, cold 102-113 ms, from an Indian residential connection to `api.coindcx.com`.
- `_sources/coindcx-docs.txt` - FAQ global limit **16/sec, 960/min**; SPOT API Rate Limits table (`active_orders` 300/60 s, `cancel_all` 30/60 s, creates 2000/60 s); `status_multiple` max 10 ids; `trade_history` limit 500.
- `05-coindcx-websockets.md` - one private socket per API key, verified live; no account identifier in payloads; a single market-data socket serves everything.
- `08-fanout-execution-engine.md` F1 - the rate-limit experiment design; F8 parallelism and fairness.
- `09-sizing-allocation-rounding.md` F6 - live market metadata, and `max_quantity_market` being depth-derived.
- `12-order-state-reconciliation.md` F4/F5 - the four reconciler loops and their per-account call cost.
- `13-charting-live-market-data.md` - one upstream candle subscription per (pair, resolution).
- `15-india-regulatory-compliance.md` - the 5-year retention floor driving `audit_event` sizing.
- `17-architecture-stack.md` - hosting region, pooled agents, process split.
- `19-accounts-groups-data-model.md` - group size limits feeding landmine 7.
- `20-ops-audit-runbook.md` - alert thresholds referenced in the failure table; the audit export path that bounds hot storage.
- AWS Mumbai pricing in F6 is **estimated and UNVERIFIED**; check against the AWS calculator before commitment.
