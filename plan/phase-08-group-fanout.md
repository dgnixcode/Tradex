# Phase 08 - Group fan-out

Status: in progress — offline engine core green (08-fanout-core 11, 08-fairness 4, 08-inflight 6); **"confirm really sends" milestone DONE** (08-confirm-sends, 37 assertions); **SSE live progress (T08.6) and retry-failed (T08.7) DONE** (08-progress-stream 20, 08-retry-is-fresh 40). Remaining: T08.3 live rate-budget wiring, T08.8 grouped-cause presentation at scale; the real-money rungs 4-6 are gated on Anand's CoinDCX key and run at the Phase 14 gate (T14.0), mirroring how rungs 1-3 were deferred from Phase 06. | goal: the product's core feature - one intent, N accounts, independent per-account outcomes, honestly reported | depends on: 07 | implements: `08`, `21` F4, `14` M19-M22, `18` F6 rungs 4-6

## Milestone log

**Offline engine core (proven before the HTTP seam).** `GroupExecutor.enqueue/drain/abandonIfStale`; the worker claims via `claimJobsFair` (cross-tenant round-robin); T08.1 re-checked at SEND time (never two live orders on one `(account, market)`); `buildReport` grouped-cause presentation. Proven by `08-fanout-core` (11), `08-fairness` (4), `08-inflight` (6) — 21 assertions, all green.

**Confirm really sends (2026-09-09).** The dry-run confirm seam is wired behind a capability gate:
- `beginExecution` (db): a FOR UPDATE, token-guarded `previewed → executing` transition that clears `dry_run`/`send_suppressed`. A racing second confirm sees `already_started` → 409. `getExecutionSnapshot` reads a trade's children in execution shape.
- `HttpDeps` gains optional `submit`/`resolve`/`executionPepper`. When ALL are wired, `POST /group-trades/:id/confirm` does beginExecution → enqueue one `place` job per planned child → drain → respond with the real report (`dryRun:false`). When NONE are wired it stays the rung-0 dry-run confirm, and `NODE_ENV=production` with no engine is an explicit **503**, never a silent dry run. A partial engine (e.g. submit without resolve) is not an engine.
- `GET /group-trades/:id/report` re-reads the same report.
- Proven end to end by `08-confirm-sends` (37 assertions): owner login → preview (3 planned legs) → confirm → the FakeVenue holds exactly one open order per child with a coid + venue id, `report.placed == planned`, second confirm 409 places nothing, wrong token 403, production-no-engine 503 and the trade stays `previewed`.

**Still open:** the real-venue submit must route each child to the account's own sealed credential (the `accountId`/`tenantId` now ride on `OrderToSend` for exactly this — Phase-14 shaped); a trade does not yet auto-`completed` when its fills arrive (FakeVenue orders stay `open`) — **now owned by Phase 09 T09.7**, the first phase with a fill-capable venue.

**SSE live progress + retry-failed subset (2026-09-09).** T08.6: `ExecutionEventBus` in `group-executor` — the worker persists each settle to `child_order` FIRST (committed UPDATE) and only then publishes, so every event is a projection of durable rows, never the source of truth. `GET /group-trades/:id/stream` subscribes per `groupTradeId`, seeds each account's present state from a post-subscribe read, emits the `header`, then pushes one live `state` frame per settle and closes with `report` + `done`. The web `Execution` page opens that stream, joins the frames to the plan's account names, and announces terminal transitions into an aria `log`. Proven by `08-progress-stream` (20 assertions): a watcher present for the whole fan-out sees three `open` settles + a real report + `done`; then a second trade is held mid-send, its SSE watcher dropped, and every child still reaches the venue — **closing the page does not affect execution**.
- T08.7: `POST /group-trades/:id/retry-failed` reads the trade's failed accounts (`skipped`/`rejected`/`not_placed`/`needs_human`/`unknown` — never a still-working `planned`/`sending`/`ambiguous` leg, so a retry cannot double-send), reconstructs the request from the persisted trade columns (pct_*/quote_amount/sell-all), and plans a BRAND-NEW scoped preview. The old trade is untouched — no migration (schema delta "None" holds). Proven by `08-retry-is-fresh` (40 assertions): two scenario trades failed on disjoint subsets, retry yields a new row/token scoped to the failed accounts only, and confirming the fresh trade really places that subset under disjoint coids while the old trade's rows and venue orders stand. 404 unknown id, 409 nothing retryable, 503 no market data.

## Scope

**In:** bounded parallelism; per-account advisory locks at fan-out scale; cross-tenant fair queueing; the 60-second abandonment rule; the execution report with divergence and slippage; live progress UI; retry-failed-subset as a fresh trade; rollout rungs 4, 5 and 6.

**Explicitly out:** cancel, sell-all and close (Phase 09); sockets (Phase 11); analytics screens (Phase 12). The engine mechanics are all from Phase 06 - this phase adds concurrency, fairness and reporting.

## Preconditions

| Precondition | How to check |
|---|---|
| Phase 07 done | Ledger invariants green; Loop D reconciling |
| Rungs 1-3 passed | Evidence recorded in Phase 06 |
| **G2 answered** | Bucket configuration set from the measured axis |
| At least five funded test accounts | One deliberately funded below `min_notional` |

## Tasks

**T08.1 - Bounded parallelism**
Default 8 in flight per group trade, configurable per tenant. One in-flight order per `(account, market)`, enforced by advisory lock, not convention.
*Acceptance:* a 20-account trade issues at most 8 concurrent sends; a test attempting two concurrent orders on one `(account, market)` has the second refused.

**T08.2 - Cross-tenant fairness**
Round-robin over tenants when draining `execution_job`, so one 100-account fan-out cannot starve another tenant's 2-account trade.
*Acceptance:* with two tenants queued, a test asserts the small trade is not starved beyond a bounded delay.

**T08.3 - Rate budget under fan-out**
Global and per-credential buckets applied per send; when exhausted, jobs wait **in the table**, not in memory. If G2 said per-IP, Loop A's cadence during a fan-out drops to ~5 s and concurrent fan-outs are capped platform-wide.
*Acceptance:* a 20-account trade under a deliberately tight bucket completes without 429s; queue wait is visible in the progress UI.

**T08.4 - The 60-second abandonment rule**
A group trade that cannot start within 60 s of confirmation is abandoned with every child `skipped: platform_busy` - never executed late.
*Acceptance:* with the bucket starved, the trade abandons and the UI explains why.

**T08.5 - The execution report (`08` F7)**
Group summary (requested vs placed vs filled, per currency, counts by outcome, wall-clock); per account (quantity, price basis, avg fill, slippage vs `decision_mid`, fee, TDS estimate, outcome, reason); divergence (best/worst fill and the spread in basis points); provenance (`coid`, exchange id, metadata version, fx snapshot, actor, IP).
*Acceptance:* every field populates on a real 5-account trade; **M19** divergence and **M16** slippage are non-null.

**T08.6 - Live progress UI (`21` F4)**
Per-account rows updating independently; `aria-live` announcing terminal transitions; closing the page does not affect execution.
*Acceptance:* a test closes the browser mid-fan-out and asserts all children still reach terminal states.

**T08.7 - Retry the failed subset**
A button that opens a **fresh** trade ticket pre-scoped to the failed accounts - new `group_trade_id`, re-planned, re-priced, re-previewed. Never re-runs the old plan.
*Acceptance:* a test asserts the retry produces a new `group_trade` row and a new preview token.

**T08.8 - Partial-failure presentation**
Outcomes grouped by cause with counts, expandable to per-account detail. "14 filled · 3 rejected · 2 skipped · 1 needs review" presented as a **successful** trade, not an error state.
*Acceptance:* twenty identical rejections render as one grouped cause with a count, not twenty rows.

**T08.9 - Rungs 4, 5 and 6**
Rung 4: two accounts, one group, Rs 1,000 per order. **Rung 5: five accounts with one deliberately funded below `min_notional`** - assert 4 filled, 1 skipped *before* send with the right reason. Rung 6: twenty accounts at customer caps, asserting no 429, latency inside the `22` budget, reconciler keeping up, zero `needs_human`.
*Acceptance:* each rung's pass condition met and evidence recorded here. **Rung 5 is not optional.**

## Schema delta

None. `group_trade.status` now exercises `executing` → `completed`/`abandoned`.

## Interfaces

| Endpoint | Notes |
|---|---|
| `POST /group-trades/:id/confirm` | **Now really sends** — capability-gated on the engine ports; rung-0 dry-run when absent, 503 in production |
| `GET /group-trades/:id/report` | Built — the settled report (confirm response + this route) |
| `GET /group-trades/:id/stream` | **Built** — SSE progress (T08.6): seeds present state, streams each settle, closes with `report`+`done`; page-close immunity proven |
| `POST /group-trades/:id/retry-failed` | **Built** — re-plans the failed subset as a fresh trade (T08.7); 404/409/503 |

## Verification

`npm run verify` is green (2026-09-09): typecheck, eslint, ci-rules (7 rules, 0 violations), vitest (24 files / 468 tests), and the run-all checks — **46 checks, 2,366,275 assertions** (the `04-no-submit-path` scan covers the new web page: the progress screen's only network surface is an EventSource, never a send).

The Phase-08 checks built so far:

| Check | Asserts | Proves |
|---|---|---|
| `08-fanout-core` | 11 | bounded parallelism, locks, 60-s abandonment |
| `08-fairness` | 4 | cross-tenant round-robin (T08.2) |
| `08-inflight` | 6 | never two live orders on one `(account, market)` |
| `08-confirm-sends` | 37 | the capability-gated confirm really sends (report `placed == planned`) |
| `08-progress-stream` | 20 | SSE seeds + one live event per settle + `report`/`done`; page-close immunity |
| `08-retry-is-fresh` | 40 | retry is a NEW trade scoped to the failed subset; old trade untouched |

**Still to prove (T08.3, T08.8, and the live-venue report fields)** land with the rate-budget wiring and on real money at rungs 4-6, not before.

## Definition of done

- [ ] Rungs 4, 5 and 6 passed on real money, evidence recorded
- [ ] Rung 5's deliberate partial failure skipped **before** send with the correct reason
- [ ] At most 8 concurrent sends; never two on one `(account, market)`
- [ ] A small tenant's trade is not starved by a large one
- [ ] A trade that cannot start within 60 s abandons rather than executing late
- [ ] Divergence (M19) and slippage (M16) non-null on every report
- [x] Closing the browser mid-fan-out does not affect execution
- [x] Retry produces a new `group_trade` and a fresh preview
- [ ] Twenty identical rejections render as one grouped cause
- [ ] Rung 6: no 429, latency inside budget, zero `needs_human`

## Phase risks

| Risk | Addressed by |
|---|---|
| R07 per-IP rate limit | T08.3, informed by G2; T08.4 as the safety valve |
| R02 duplicate order at scale | T08.1's locks on top of Phase 06's four mechanisms |
| R16 exchange outage mid-fan-out | Independent per-account outcomes; `read_only` from Phase 05 |
| Customer assumes all-or-nothing | T08.8's presentation, and the pre-submit acknowledgement from Phase 04 |

## Notes for the next phase

Buy and sell by amount, quantity and percentage now work across a group. The sell-side affordances the brief specifically asked for - sell-all and close-position, sized from exchange truth - are Phase 09, along with cancel fan-out and Loop B.
