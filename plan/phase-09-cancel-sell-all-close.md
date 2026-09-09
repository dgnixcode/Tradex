# Phase 09 - Cancel, sell-all and close

Status: COMPLETE 2026-09-09 | goal: the sell side the brief asked for - percent of holding, sell-all and close-position - sized from exchange truth, plus cancel fan-out and the open-order sweep | depends on: 08 | implements: `09` F9, `08` F9, `12` Loop B

Engine code was landed in the repo; the five `09-*` checks below (55 assertions) plus `packages/sizing/sell-at-send.test.ts` prove it. The positions screen is the **books** (§6a): qty, weighted-average cost, realised P&L, fees, TDS — no mark (the plan's "mark, unrealised P&L" wording predates the §6a rescope; 011 creates no equity_snapshot and 07-no-mark-to-market forbids that vocabulary).

## Scope

**In:** cancel fan-out with precondition checks; percent-of-holding, sell-all and close-position sizing from the live exchange balance; the clamp-down rule; dust handling; reconciler Loop B; the positions screen; fan-out auto-completion on fills (T09.7).

**Explicitly out:** futures `positions/exit` (not in v1 - `ARCHITECTURE` §10); the conversion feature; analytics screens.

## Preconditions

| Precondition | How to check |
|---|---|
| Phase 08 code-complete | Engine + SSE progress + retry-failed proven over FakeVenue (`npm run verify`, 46 checks green) |
| A fill-capable test venue | FakeVenue extended so a test can settle an order to `filled`/`partially_filled` — Phase 08 left every order `open` forever, which is why nothing ever `completed` |
| Real-money validation deferred | Anand's CoinDCX key is supplied at the Phase 14 gate (standing deferral); live sells/closes and fills are proven there in the rungs sequence (Phase 14 T14.0), not before |

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

**T09.7 - Completion-on-fills (moved from Phase 08's open gap)**
A fan-out reaches `completed` when EVERY child is out of the working/resting states — `filled`/`partially_filled` or a terminal refusal — and stays `executing` while any leg is still `open`/`acked`/`sending`/`ambiguous`. Phase 08 could not build this: FakeVenue left every order `open` forever, so fills never existed offline. The worker's `resolve` port is the trigger (sockets are deferred — Phase 11); Phase 08's SSE `allSettled` already treats fill states as settled, so this is the durable `group_trade.status` flip on the same predicate, surfaced in the report.
*Acceptance:* with a FakeVenue that settles an order to `filled`, a two-leg fan-out confirms → both legs `filled` → `group_trade.status` auto-`completed` and the report shows it; a leg left `open` at the venue keeps the trade `executing`.

## Schema delta

None. `child_order` gains a `clamped_from_quantity` column for T09.3.

## Interfaces

| Endpoint | Notes |
|---|---|
| `POST /group-trades/preview` with `sizing_mode` in (`pct_position`, `sell_all`) | Fresh holding read at preview **and** at send |
| `POST /orders/cancel` (group-scoped) | Per-account precondition checked locally first |
| `GET /positions` | Per account and group roll-up |

## Verification

`checks/09-close-semantics.check.mjs` (10 — T09.7 completion-on-fills, T09.1 cancel-refusal + `cancel_all` grep), `checks/09-clamp-down.check.mjs` (6 — T09.3 row-recorded clamp), `checks/09-dust.check.mjs` (7 — T09.4 sell-all over a dust account), `checks/09-loop-b.check.mjs` (8 — T09.5 recovery), `checks/09-positions.check.mjs` (24 — T09.6 positions = ledger books). **55 assertions**; the sell re-derivation arithmetic itself is proven by `packages/sizing/src/sell-at-send.test.ts` (T09.2 fresh read / clamp-down / dust / locked). All green 2026-09-09.

## Definition of done

- [x] Sell-all sizes from the exchange balance read immediately before send — `sell-at-send.test.ts`; worker seam in `09-dust`
- [x] A clamp-down is recorded and surfaced; no path clamps up — `09-clamp-down`
- [x] Dust is excluded from sell-all without failing the trade — `09-dust`
- [x] Cancelling a settled order is refused before any network call — `09-close-semantics` (cancel spy proves zero venue calls)
- [x] `cancel_all` appears nowhere in the codebase — `09-close-semantics` (code-only grep)
- [x] Loop B recovers an order that Loop A missed — `09-loop-b`
- [x] Positions screen numbers match the ledger check output — `09-positions` (GET /api/positions + /app/positions); books only, no mark (§6a)
- [x] A fan-out auto-completes once every child is out of the working/resting states; an `open` leg keeps it `executing` — `09-close-semantics`

## Phase risks

| Risk | Addressed by |
|---|---|
| Overselling | T09.2's fresh read and T09.3's clamp-down (invariant **S2**) |
| R09 outside activity | The fresh read is the mitigation at the point it matters most |
| `cancel_all` rate-limit trap | T09.1's prohibition, enforced by a grep test |

## Notes for the next phase

Every requirement in the brief is now functional except live charts and analytics, both of which are gated on **G1** (clause 2.3(c)).
