# Phase 04 - Groups, planning and the preview

Status: not started | goal: a group trade can be planned and previewed per account - and deliberately **cannot be sent**. This is rollout rung 0 | depends on: 02, 03 | implements: `19`, `08` F3-F4, `21` F2-F3, `14` F2

## Scope

**In:** groups and membership; `group_trade` and `child_order`; the planning stage (resolve → size → legalise → gates 1-12); the capture-or-lose-forever fields; the preview with a hard expiry; the trade ticket and confirmation UI; dry-run mode.

**Explicitly out:** sending anything to CoinDCX. The adapter's placement methods stay unimplemented. Also out: kill switches (Phase 05), the execution worker (Phase 06), sell-all and close (Phase 09).

## Preconditions

| Precondition | How to check |
|---|---|
| Phases 02 and 03 done | Definitions of done ticked |
| At least two accounts connected in a test tenant | `GET /accounts` returns two `active` rows |
| Sizing suite green | `checks/03-sizing-999-markets.check.js` passes |

## Tasks

**T04.1 - Migrations 004 and 005**
`group`, `group_member`, `group_trade`, `child_order`, `execution_job` per `DATA-MODEL` domain 4. Including `UNIQUE (group_trade_id, account_id, leg_seq)` and `UNIQUE (client_order_id)` - invariant **X1** in the schema from the start.
*Acceptance:* both unique constraints provably reject duplicates; `execution_job` exists but nothing enqueues yet.

**T04.2 - Groups**
CRUD, many-to-many membership with `display_order`, `enabled`, limits from `tenant_limit` (100 per tenant, 50 per group). `weight_bp` and `max_notional_minor` are created and **left unused**.
*Acceptance:* adding the same account twice is rejected by the primary key; exceeding either limit returns a clear error.

**T04.3 - The planning stage**
For a group trade: one shared orderbook read per market, then per account resolve → size → legalise → gates. Persist N `child_order` rows as `planned` or `skipped` with reasons.
*Acceptance:* a 12-account group produces 12 rows; skipped rows carry a refusal code and a message containing numbers.

**T04.4 - Gates 1-12 (`08` F3)**
The live-state gates composed around Phase 03's pure core: kill switches (stubbed until Phase 05), account and credential status, market resolution, order-type allowed, effective minimum, min notional, maximum, balance with fee headroom, per-account cap, per-tenant daily cap, no in-flight order for `(account, market)`.
*Acceptance:* each gate has a test that trips only it; refusal reasons are distinct and ordered cheapest-first.

**T04.5 - Capture-or-lose-forever fields (`14` F2)**
At plan time persist: `decision_mid`, `fx_snapshot_id`, `market_meta_version`, `code_version`, and per child `basis_used`, `basis_amount_minor`, `price_source`, `price_used`, `fee_rate_assumed`, `tds_rate_applied`, `raw_quantity`, `final_quantity`, `notional_minor`, `refusal_code`. Also the spread at submit, from the same orderbook read.
*Acceptance:* a test asserts every one of these is non-null on a planned trade; a test asserts `decision_mid` is captured before any sizing occurs.

**T04.6 - Preview and expiry**
Return a `preview_token` with `preview_expires_at`. The token is the only thing that can later be confirmed. Server-side rejection of an expired token.
*Acceptance:* confirming an expired preview returns a specific error; the countdown value the UI shows matches the server's.

**T04.7 - Trade ticket UI (`21` F2)**
Group picker showing account count and combined allocated capital; asset typeahead over the 649 tradable assets showing which quote markets exist; side; type filtered by the market's `order_types`; the four sizing modes with the basis named inline; limit price with bid/ask helpers; the spread warning with measured spread and round-trip estimate. **No submit button** - the only action is `Preview N accounts`.
*Acceptance:* no code path submits a trade from this screen; the spread warning renders live values; sizing fields default to empty (`15` F6).

**T04.8 - Confirmation UI (`21` F3)**
The per-account preview table with exact quantities, price basis, estimated cost, and skipped rows with reasons and remedies. Countdown. Conditional acknowledgement checkbox when any account is skipped. Typed confirmation above the tenant threshold.
*Acceptance:* the table's rows equal the persisted `child_order` rows exactly; the acknowledgement appears only when a skip exists.

**T04.9 - Dry-run mode (rung 0)**
A tenant flag that runs the whole pipeline and suppresses the send, recording what *would* have been sent.
*Acceptance:* 100 consecutive group trades planned and dry-run with zero exceptions; the recorded would-send bodies match the preview table row for row (invariant **U2**).

**T04.10 - Order-book pricing** *(moved here from the deferred Phase 10)*
One `market_data/orderbook` read per market per group trade, shared across all accounts. Best ask prices a buy, best bid prices a sell; the snapshot and its timestamp are persisted on the trade. **Never** price from `/exchange/ticker`, which `01` verified is CDN-cached and stale by an unknown amount.
*Acceptance:* a 12-account trade makes exactly one order-book call; `price_source` and `price_used` are persisted; a test asserts no pricing path reads ticker data.

**T04.11 - Slippage guard and qualitative spread warning** *(moved here from the deferred Phase 10)*
Walk the depth for the intended quantity, compute the volume-weighted fill price, and refuse a market order when it deviates more than the tolerance (default 0.5%) from the touch, or when the spread already exceeds it. The ticket shows a **qualitative** warning - "the spread on this market is wide; a limit order is recommended" - **without displaying the derived number**, per the read/display boundary (`ARCHITECTURE` §6a).
*Acceptance:* `DOGEINR` at a measured 0.81% spread is refused at the default tolerance; `BTCUSDT` passes; the warning text contains no CoinDCX-derived price or percentage.

## Schema delta

Migrations 004 and 005.

## Interfaces

| Endpoint | Notes |
|---|---|
| `POST /groups`, `PATCH /groups/:id`, membership routes | Limits enforced |
| `POST /group-trades/preview` | Runs planning; returns rows + token + expiry; persists everything |
| `POST /group-trades/:id/confirm` | **In this phase, dry-run only** - marks `completed` with a suppressed-send record |
| `GET /group-trades/:id` | The plan, and later the report |

## Verification

`checks/04-planning.check.js` (~150), `checks/04-gates.check.js` (one trip per gate, ~60), `checks/04-preview-equals-plan.check.js` (**U2**, ~80), `checks/04-dry-run-100.check.js` (~200), `checks/04-slippage-guard.check.js` (~60), `checks/04-no-ticker-pricing.check.js` (~15). Target: **~565 assertions**.

## Definition of done

- [ ] A 12-account group plans into 12 rows with correct per-account quantities
- [ ] Every capture-or-lose field is non-null on a planned trade
- [ ] The preview table matches the persisted rows exactly (U2)
- [ ] An expired preview cannot be confirmed
- [ ] The acknowledgement checkbox appears only when accounts are skipped
- [ ] Sizing fields default to empty; nothing is pre-filled
- [ ] There is no code path from the ticket to a send
- [ ] Exactly one order-book read per market per group trade; no pricing path reads `/exchange/ticker`
- [ ] `DOGEINR` market orders refused at the 0.5% tolerance; the warning shows no derived number
- [ ] 100 consecutive dry runs complete with zero exceptions (**rung 0 passed**)

## Phase risks

| Risk | Addressed by |
|---|---|
| R03 wrong size | The preview makes it visible before it matters |
| R12 largest accounts fail first | T04.8's skip rows quote both numbers |
| R20 stale preview | T04.6's server-side expiry |
| R13 capture fields missed | T04.5 - and this is the last phase where adding them is cheap |

## Notes for the next phase

`execution_job` exists and is empty. Kill-switch gates are stubbed and must become real in Phase 05 **before** Phase 06 sends anything. The `client_order_id` column exists but nothing populates it yet - Phase 06 owns the derivation.
