# Phase 09 - Cancel, sell-all and close

Status: not started | goal: the sell side the brief asked for - percent of holding, sell-all and close-position - sized from exchange truth, plus cancel fan-out and the open-order sweep | depends on: 08 | implements: `09` F9, `08` F9, `12` Loop B

## Scope

**In:** cancel fan-out with precondition checks; percent-of-holding, sell-all and close-position sizing from the live exchange balance; the clamp-down rule; dust handling; reconciler Loop B; the positions screen.

**Explicitly out:** futures `positions/exit` (not in v1 - `ARCHITECTURE` §10); the conversion feature; analytics screens.

## Preconditions

| Precondition | How to check |
|---|---|
| Phase 08 done, rungs 4-6 passed | Evidence recorded |
| Test accounts holding a real position | Non-zero holdings from rung 4-6 buys |

## Tasks

**T09.1 - Cancel fan-out**
Cancel by id, per account. Precondition: the order is `open` or `partially_filled` - the FAQ is explicit that a `filled`, `cancelled` or `rejected` order *"cannot be cancelled"*. **Never** use `orders/cancel_all`: it is capped at 30/60 s, the tightest limit in the API, and it would cancel orders we did not place.
*Acceptance:* cancelling a `filled` order is refused locally, before any network call; a test asserts `cancel_all` appears nowhere in the codebase.

**T09.2 - Sell-all and close-position**
Quantity comes from the **exchange's** free balance read immediately before sending, not from our projection - any outside deposit, withdrawal or manual trade makes our figure wrong. Floor to `step`.
*Acceptance:* a test that mutates the holding between preview and send asserts the sent quantity reflects the fresh read.

**T09.3 - The clamp-down rule**
If the sized quantity exceeds the freshly-read holding, clamp **down** to the holding and record that the clamp happened. Clamping up is never permitted.
*Acceptance:* a clamp is recorded on the child order and shown in the report; a test asserts no code path increases a quantity.

**T09.4 - Dust and locked holdings**
A holding below `effective_min_qty` is dust: displayed, labelled unsellable, and **excluded** from sell-all without failing the trade. A holding fully locked by an open order is skipped as `HOLDING_LOCKED` with an offer to cancel first.
*Acceptance:* a sell-all across five accounts where one holds dust completes with four sells and one labelled skip.

**T09.5 - Reconciler Loop B**
`orders/active_orders` per account per market where we believe something is open. Catches an order that fell out of Loop A. Cadence 30 s for accounts with open orders, skipped entirely otherwise.
*Acceptance:* an order deliberately hidden from Loop A is recovered by Loop B within one cycle.

**T09.6 - Positions screen**
Per asset per account: quantity, weighted-average cost, mark, unrealised P&L; group roll-up with per-currency subtotals; dust flagged; open orders shown against the holding they lock.
*Acceptance:* the screen's numbers match `checks/07-ledger-invariants` output for the same account.

## Schema delta

None. `child_order` gains a `clamped_from_quantity` column for T09.3.

## Interfaces

| Endpoint | Notes |
|---|---|
| `POST /group-trades/preview` with `sizing_mode` in (`pct_position`, `sell_all`) | Fresh holding read at preview **and** at send |
| `POST /orders/cancel` (group-scoped) | Per-account precondition checked locally first |
| `GET /positions` | Per account and group roll-up |

## Verification

`checks/09-close-semantics.check.js` (~110), `checks/09-clamp-down.check.js` (~30), `checks/09-dust.check.js` (~35), `checks/09-loop-b.check.js` (~30). Target: **~205 assertions**.

## Definition of done

- [ ] Sell-all sizes from the exchange balance read immediately before send
- [ ] A clamp-down is recorded and surfaced; no path clamps up
- [ ] Dust is excluded from sell-all without failing the trade
- [ ] Cancelling a settled order is refused before any network call
- [ ] `cancel_all` appears nowhere in the codebase
- [ ] Loop B recovers an order that Loop A missed
- [ ] Positions screen numbers match the ledger check output

## Phase risks

| Risk | Addressed by |
|---|---|
| Overselling | T09.2's fresh read and T09.3's clamp-down (invariant **S2**) |
| R09 outside activity | The fresh read is the mitigation at the point it matters most |
| `cancel_all` rate-limit trap | T09.1's prohibition, enforced by a grep test |

## Notes for the next phase

Every requirement in the brief is now functional except live charts and analytics, both of which are gated on **G1** (clause 2.3(c)).
