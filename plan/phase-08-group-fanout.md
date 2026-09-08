# Phase 08 - Group fan-out

Status: not started | goal: the product's core feature - one intent, N accounts, independent per-account outcomes, honestly reported | depends on: 07 | implements: `08`, `21` F4, `14` M19-M22, `18` F6 rungs 4-6

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
| `POST /group-trades/:id/confirm` | Now really sends |
| `GET /group-trades/:id/report` | The settled report |
| `GET /group-trades/:id/stream` | SSE progress |
| `POST /group-trades/:id/retry-failed` | Returns a **new** draft, never re-runs the old plan |

## Verification

`checks/08-fanout-simulation.check.js` (parallelism, locks, fairness, abandonment, ~200), `checks/08-partial-failure.check.js` (~70), `checks/08-report-completeness.check.js` (~90), `checks/08-retry-is-fresh.check.js` (~25). Target: **~385 assertions**.

## Definition of done

- [ ] Rungs 4, 5 and 6 passed on real money, evidence recorded
- [ ] Rung 5's deliberate partial failure skipped **before** send with the correct reason
- [ ] At most 8 concurrent sends; never two on one `(account, market)`
- [ ] A small tenant's trade is not starved by a large one
- [ ] A trade that cannot start within 60 s abandons rather than executing late
- [ ] Divergence (M19) and slippage (M16) non-null on every report
- [ ] Closing the browser mid-fan-out does not affect execution
- [ ] Retry produces a new `group_trade` and a fresh preview
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
