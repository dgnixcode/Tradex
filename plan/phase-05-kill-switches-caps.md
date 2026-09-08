# Phase 05 - Kill switches, caps and degraded modes

Status: not started | goal: every switch and every cap works, proven by asserting that **no order is sent** | depends on: 04 | implements: `08`, `19`, `22` F7, `20`

## Scope

**In:** kill switches at four scopes; per-order, per-account and per-tenant-daily notional caps; the four degraded modes with automatic entry and manual exit; the customer-facing pause control; the check script that proves each blocks a send.

**Explicitly out:** the execution worker itself (Phase 06). This phase makes the *brakes* real before the engine exists - which is the point.

## Preconditions

| Precondition | How to check |
|---|---|
| Phase 04 done, rung 0 passed | 100 dry runs clean |
| Gate stubs in place from T04.4 | Gates 1-2 currently return "allow" |

## Tasks

**T05.1 - Four switch scopes**
Global (platform), tenant (customer-controlled), account, market. Each independently flippable, each checked in the gate, each with a reason string.
*Acceptance:* flipping any one blocks a planned trade with a distinct message; flipping none allows it.

**T05.2 - Notional caps**
Per-order (`tenant_limit.max_order_notional_minor`, overridable per account), per-tenant-daily (`max_daily_notional_minor`) computed over IST calendar days from `child_order.notional_minor` of non-refused children.
*Acceptance:* a trade that would cross the daily cap is refused with the remaining headroom in the message; the window boundary is IST, tested at 23:45 IST.

**T05.3 - Customer pause control**
Two clicks from anywhere. `trader` may pause **without** re-authentication; only `owner` may resume, **with** re-authentication.
*Acceptance:* role test confirms the asymmetry; a paused tenant cannot preview or confirm.

**T05.4 - Degraded modes (`22` F7)**
`normal`, `cancel_only`, `read_only`, `frozen` (per account). Automatic entry on trigger; **manual exit only**, and only after a reconciliation sweep once one exists. Each mode visible in the UI with its reason.
*Acceptance:* a table-driven test asserts which operations each mode permits; `read_only` permits neither opens nor cancels.

**T05.5 - Cap and switch audit**
Every change to a switch, a cap or a mode writes an audit event with actor, before and after.
*Acceptance:* an audit row exists for each; the row is visible in the tenant's own audit view.

**T05.6 - Wire the stubs**
Replace T04.4's gate 1 and 2 stubs with the real checks, and add the cap gates.
*Acceptance:* `checks/04-gates.check.js` extended; every gate now trips on a real condition.

## Schema delta

None new - `tenant_limit` exists from Phase 00. Add `exchange_account.max_order_notional_minor` if not already present, and a `platform_state` single-row table for the global switch and current degraded mode.

## Interfaces

| Endpoint | Notes |
|---|---|
| `POST /trading/pause`, `POST /trading/resume` | Tenant scope; asymmetric roles |
| `PATCH /limits` | Owner + re-auth |
| `POST /admin/platform-state` | Global switch and mode; internal, dual-controlled |
| `GET /trading/state` | What the UI renders: mode, reason, caps and headroom |

## Verification

`checks/05-kill-switch.check.js` - for each of the four scopes and each of the three caps, assert a planned trade is **not** sent (~70 assertions); `checks/05-degraded-modes.check.js` (~40); `checks/05-daily-cap-ist.check.js` (~25). Target: **~135 assertions**.

## Definition of done

- [ ] Each of the four switch scopes independently blocks a send, with a distinct message
- [ ] Per-order, per-account and per-tenant-daily caps each block, showing remaining headroom
- [ ] The daily window is IST, verified across a 23:45 IST boundary
- [ ] `trader` can pause without re-auth; only `owner` can resume, with re-auth
- [ ] All four degraded modes behave per the table; exit is manual
- [ ] Every switch, cap and mode change writes an audit row visible to the customer
- [ ] All gate stubs from Phase 04 are now real

## Phase risks

| Risk | Addressed by |
|---|---|
| Unbounded loss from a fat-fingered percentage | T05.2's caps - the only hard bound before Phase 06 |
| R16 exchange outage | T05.4's `read_only` mode exists before it is needed |
| Kill switch untested when needed | T05.6 and the check script assert non-sending, not just a flag value |
| Delay when speed matters | T05.3's no-re-auth-to-pause asymmetry |

## Notes for the next phase

This phase deliberately sits between "can plan" and "can send". Phase 06 is the first phase where real money can move, and it must not begin until every line above is ticked.
