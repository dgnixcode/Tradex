# Phase 15 - Futures + leverage + SL/TP + hard exit

Status: CORE COMPLETE 2026-09-09 (69-check suite green; futures fills still have no ledger producer; T15.9 socket + T15.13 wallet transfer deferred to go-live) | goal: the customer trades CoinDCX perpetual futures across their group of accounts with leverage, an attached stop-loss and take-profit, and a hard "exit now" override that closes the position at market regardless of open conditional orders | depends on: 08 (execution engine), 09 (cancel + Loop B), 13 (deploy safety, alerts) | supersedes the "futures deferred" note in `00-PLAN-OVERVIEW.md:157-158` and `phase-09` §Explicitly out

## Why this is not a small extension

Three facts from `research/03` and `research/04` reshape the product, not just add fields:

1. **No `client_order_id` on futures** — `research/03` Verdict: *"the single largest correctness risk in the whole product"*. Phase 06's anti-duplicate spine (deterministic coid → duplicate-key rejection) does NOT carry over. Futures needs a substitute: per-(account, pair) advisory lock + write-before-send + read-back on ambiguity + post-send position-delta check.
2. **10-second signing window** on `orders/create` — signing must happen at send, never at enqueue. A group fan-out across N accounts must fit inside 10s or tail accounts get 401/422. Not a spot problem; the spot signed body has no expiry.
3. **§6a boundary** — a futures POSITION intrinsically has mark price, unrealised PnL, and liquidation price. `checks/07-no-mark-to-market.check.mjs` forbids those tokens in `packages/{ledger,sizing}/src` and `apps/api/src`. Reconciled by putting the futures view in a NEW package (`packages/futures-positions/`) and a NEW route (`apps/api/src/futures-positions.ts`) OUTSIDE the scan scope. Spot books stay §6a-pure.

Two additional constraints worth reading twice:
- **`positions/exit` has no idempotency key** — double-fire opens an opposite position (`research/04` F11). And it does **not** auto-cancel outstanding SL/TP; a stale SL after an exit will fire and reverse the position. Safe pattern: `cancel_all_open_orders_for_position` → `exit` → wait for socket + REST confirmation.
- **SL/TP is a separate call** (`positions/create_tpsl`), not on create; per-leg partial success at HTTP 200 (both legs can be independently accepted/rejected). Not an upsert — moving a TP is cancel-then-create. No native OCO — legs are independent conditional orders.

## Scope

**In:**
- INR-margined and USDT-margined perpetual futures on CoinDCX.
- Order types: `market`, `limit`, `stop_market`, `stop_limit`, `take_profit_market`, `take_profit_limit`.
- Leverage per (account, pair) with `positions/update_leverage`; per-tier max leverage from `dynamic_position_leverage_details`.
- Position margin type: `isolated` (INR + USDT) and `crossed` (USDT-only per `research/03` F4).
- Group fan-out: one futures trade spans a group's enabled accounts, each with its own child leg carrying the same leverage/SL/TP intent.
- Hard exit: `POST /api/futures/positions/:accountId/:market/exit` that cancels working conditional legs first, then calls `positions/exit`, then reconciles via socket + REST.
- Futures positions page with mark price, unrealised PnL, liquidation price, leverage, margin, funding countdown.
- Reduce-only orders.
- Wallet funding: spot ↔ futures transfer surface (owner + reauth).

**Explicitly out (deferred, recorded here):**
- Cross margin on INR (venue does not support it).
- `edit` order (USDT-only, use cancel + resubmit).
- Multi-instrument bracket / conditional dependencies beyond one SL + one TP per position.
- Backtesting; portfolio-margin.

## Tasks

**T15.1 — FuturesAdapter port (sibling of ExchangeAdapter)**
New `packages/exchange/src/futures-adapter.ts` with `placeFuturesOrder`, `getPositions`, `updateLeverage`, `createTpSl`, `cancelOrder`, `cancelAllForPosition`, `exitPosition`, `updatePositionMargin`, `getFuturesInstruments`. Keeps `ExchangeAdapter` untouched so ADAPTER-BOUNDARY holds.

**T15.2 — Adapter implementation (@tradex/exchange-coindcx)**
New file `futures-order-client.ts` reusing `send()`+`signRequest`+`readRateFeedback`. Every send path computes the 10-second deadline `deadlineMs = Math.max(0, 9500 - queueWaitMs)` and refuses to sign if the caller's overall budget is under 500 ms. `FakeVenue` extended: new `derivatives/futures/*` routes; new `positions` map with `settlePosition(id, exitPrice)` and `triggerConditional(coid, mark)` controls.

**T15.3 — Schema (migration 014)**
`group_trade` widens `order_type` CHECK; adds `is_futures`, `leverage`, `margin_currency`, `position_margin_type`, `stop_loss_price`, `take_profit_price`, `reduce_only`. `child_order` gains `leg_kind text CHECK IN ('entry','stop_loss','take_profit')`, `linked_entry_child_order_id`, `trigger_state text CHECK IN ('untriggered','triggered','expired')`, `venue_position_id`. New `child_order.state` values: `untriggered`, `sl_hit`, `tp_hit`, `liquidated`. New table `futures_position` (mirror of the venue's row; source of truth is the venue, this is the durable cache) with columns `account_id, pair, active_pos, avg_price, mark_price, mark_observed_at, liquidation_price, locked_margin, leverage, margin_type, margin_currency, take_profit_trigger, stop_loss_trigger, updated_at`.

**T15.4 — Anti-duplicate spine substitute**
`packages/db/src/futures-execution.ts`: `acquirePairLock(tenantId, accountId, pair)` → row-lock on a new `futures_execution_lock` table (or a `pg_advisory_xact_lock` on hash(accountId,pair)); a leg holds the lock across write-before-send and the follow-up read-back. On ambiguous transport failure the worker READS `positions` and the venue's recent `orders` list, compares the pre-send delta, and settles the observed truth — never resends. A new check `15-anti-dup-futures.check.mjs` proves double-submit under simulated timeout ends with ONE order at the venue.

**T15.5 — Group fan-out**
Reuse `GroupExecutor.enqueue` with two-phase per account: (1) entry `place` job, (2) SL/TP `place` jobs enqueued only after entry acks. Each conditional is a sibling `child_order` row with `leg_kind` and `linked_entry_child_order_id`. Completion predicate widens: a futures group trade is `completed` only when every account's ENTRY is filled or terminal — SL/TP resting orders keep the trade `executing` visible in Activity as "with a stop and target attached" but do NOT block completion (they're follow-on protection, not the trade).

**T15.6 — Sizing gates for futures**
New gates: `MAX_LEVERAGE` (compares requested leverage to `dynamic_position_leverage_details` at the notional tier), `ABOVE_MARGIN_CAP` (compares required margin to `tenant_limit.max_order_notional_minor` — the cap must apply to money-at-risk, not exposure; add a `max_futures_notional_minor` if that turns out to conflict with spot semantics), `LIQUIDATION_BUFFER_TOO_TIGHT` (planned entry + leverage yields a liquidation price closer than `min_liquidation_buffer_bp` from mark). Mark price is passed IN as an opaque `Scaled` from the composition root (sizing is pure; §6a survives).

**T15.7 — Hard exit**
`POST /api/futures/positions/:accountId/:market/exit` (owner or trader; reauth for `trade.cancel` re-scoped as `position.exit`, a new action). Server sequence: (a) list working conditional child_orders for this (account, pair) and cancel each via the existing `cancelChildren` port; (b) call `positions/exit` via a new `exitPosition` port; (c) enqueue a resolve job that polls `positions` until `active_pos = 0`; (d) settle child rows to `cancelled`/`liquidated` as truth resolves. A check `15-hard-exit.check.mjs` proves the sequence in that order over FakeVenue.

**T15.8 — Futures positions view (outside §6a)**
NEW package `packages/futures-positions/` (imports only `@tradex/money` + a new `@tradex/futures-adapter` type-only import — no ledger, no sizing). NEW `apps/futures-api/` OR a subdirectory `apps/api/src/futures/` that is ADDED to the `07-no-mark-to-market` skip list (the boundary reversal is explicit and reviewed, not smuggled). Route `GET /api/futures/positions`. Web route `/app/futures` renders per-account positions with mark, unrealised PnL, liquidation, leverage, per-position "Close" + page-level "Exit all".

**T15.9 — Live socket for mark price**
`packages/exchange-coindcx/src/futures-socket.ts` — one socket per API key (venue constraint), reconnect-on-silent-disconnect (the auth-failure = silent-close trap from `research/05` F4). Position update events (`df-position-update`) update `futures_position.mark_price` and the SSE broadcast to open web streams. Sockets are Phase-11 territory but this phase needs the position view to update; wire the minimum and record the rest as go-live-gated.

**T15.10 — Trade ticket UI**
`TradeTicket.tsx` grows a `product` toggle (spot | futures perp). When `futures`: leverage slider (`1 → market.maxLeverage`), margin-currency toggle (INR/USDT — gated by the account's funded currencies), position-margin-type toggle (isolated only for INR), reduce-only checkbox (only when a position exists — via `fetchFuturesPositions`), SL price + TP price + trigger type (mark vs last). `Confirmation.tsx` adds a leverage/margin/SL/TP row of chips under each account. `Execution.tsx` and `GroupDetailReport.tsx` add `untriggered`, `pending_sl`, `pending_tp`, `sl_hit`, `tp_hit`, `liquidated` labels.

**T15.11 — Futures page + hard-exit button**
NEW `apps/web/src/routes/Futures.tsx` with per-position rows and a page-level "Exit all". Wired via new `api.ts` calls `fetchFuturesPositions`, `exitFuturesPosition`. AppSidebar adds `Futures` under Trading. Also wires the missing `cancelGroupTrade` client for existing Phase-09 cancel (which had no UI).

**T15.12 — Alert additions**
Extend `packages/ops/alerts.ts` catalogue with A19 (`funding_rate_anomaly`), A20 (`liquidation_imminent` — a position's liquidation-buffer < 2% below mark for over 60 s), A21 (`stale_sl_after_exit` — an untriggered SL exists on a pair with no active_pos for over 30 s — the R1 danger from `research/04`). Page at night: A20, A21.

**T15.13 — Wallet transfer surface**
`POST /api/futures/wallet/transfer` (owner + reauth), calls the non-idempotent `wallets/transfer` behind a per-tenant lock + a 30-second cooldown. UI on the Futures page. This is the ONE call the research names as "the highest-risk call in this document"; the cooldown + owner+reauth is the safeguard.

## Schema delta (migration 014)

`group_trade`: widen `order_type` CHECK; add `is_futures BOOL NOT NULL DEFAULT false`, `leverage NUMERIC(8,2)`, `margin_currency TEXT CHECK IN ('INR','USDT')`, `position_margin_type TEXT CHECK IN ('isolated','crossed')`, `stop_loss_price venue_decimal`, `take_profit_price venue_decimal`, `reduce_only BOOL NOT NULL DEFAULT false`. New CHECK: `is_futures=true → leverage IS NOT NULL AND margin_currency IS NOT NULL AND position_margin_type IS NOT NULL`.

`child_order`: widen `state` CHECK to include `untriggered`, `sl_hit`, `tp_hit`, `liquidated`; add `leg_kind TEXT CHECK IN ('entry','stop_loss','take_profit') DEFAULT 'entry'`, `linked_entry_child_order_id UUID`, `trigger_state TEXT CHECK IN ('untriggered','triggered','expired')`, `venue_position_id TEXT`.

New table `futures_position` (tenant-scoped, mirrored from the venue; source of truth is REST, this is our durable cache). New table `futures_execution_lock` (tenant-scoped, `(account_id, pair)` unique; acquired for the duration of a send).

## Verification

**Landed and green (69-check suite, 2026-09-09):** `15-schema` (33), `15-place-and-read` (18), `15-signing-deadline` (7), `15-sltp-attach` (16), `15-hard-exit` (19), `15-anti-dup-futures` (9), `15-liquidation-buffer` (16), `15-fanout` (28).

**Not yet written:** `15-no-double-exit` (a double `exit` call resolving to one closed position) — `futures_execution_lock` is the mechanism that would make it hold, but the `exit`-specific case has no check yet.

## Definition of done

- [x] A futures group trade fans out to N accounts with per-account SL + TP legs — `GroupExecutor.enqueue` materialises the conditional legs (`leg_kind` / `linked_entry_child_order_id` / trigger on `price_used`) and `ExecutionWorker.settle` attaches them via the injected `AttachTpSlPort` the moment an entry reports `filled`; an entry that never fills skips them with `ENTRY_DID_NOT_FILL`, and a build with no attach port skips them with `TP_SL_NOT_ATTACHED` rather than wedging the trade open — `checks/15-fanout` (28).
- [x] The 10-second signing window is never exceeded on a real send — `checks/15-signing-deadline`.
- [x] SL/TP attach handles per-leg partial success at HTTP 200 — `checks/15-sltp-attach`.
- [x] Hard exit cancels every conditional for the position first, THEN calls `positions/exit`; a stale SL cannot open an opposite position — `checks/15-hard-exit` proves the R1 danger AND the safe sequence; `apps/api/src/futures/exit-service.ts` refuses the exit if any conditional is still untriggered.
- [x] The (account, pair) lock is the anti-duplicate spine substitute for the missing coid — `checks/15-anti-dup-futures` proves atomic acquire + reaper.
- [x] The futures positions view shows mark, unrealised PnL, liquidation, leverage, margin — in NEW `packages/futures-positions/` and `apps/api/src/futures/` (both outside the 07-no-mark-to-market scan by design; that check remains green over its original scope).
- [x] Sizing refuses a leveraged order whose liquidation buffer is under the configured floor — `checks/15-liquidation-buffer` proves MAX_LEVERAGE, ABOVE_MARGIN_CAP, LIQUIDATION_BUFFER_TOO_TIGHT.
- [x] Alerts A19, A20, A21 fire under synthetic conditions; A20/A21 page at night — `checks/13-alerts` (extended).
- [x] Trade ticket IS the futures ticket (T15.10 done) — the product settled on futures-only, so no spot/futures toggle: leverage, margin currency, margin mode, optional SL/TP and reduce-only are first-class fields; the spot Positions surface and its web client were removed and `/app/positions` now serves the futures positions view.

## Phase risks

| Risk | Addressed by |
|---|---|
| No client_order_id on futures ⇒ silent duplicate order under a transport hiccup | T15.4 per-(account,pair) lock + read-back + position-delta check; `15-anti-dup-futures` |
| 10-second signing window ⇒ tail-account rejection on fan-out | T15.2 deadline injection; `15-signing-deadline` |
| Stale SL after `exit` opens an opposite position | T15.7 mandatory cancel-conditionals before exit; `15-hard-exit` |
| Double-fire `positions/exit` reverses the position | T15.4 lock protects `exit` too; `15-no-double-exit` |
| §6a boundary compromised by adding mark price into `apps/api/src` | T15.8 puts futures view in a NEW dir, added to the explicit skip list, with a review note in the check itself |
| `wallets/transfer` moves money twice | T15.13 per-tenant lock + cooldown + owner+reauth |
| Wrong leverage tier ⇒ 422 at send | T15.6 `MAX_LEVERAGE` gate reads `dynamic_position_leverage_details` at plan time |
| Live customer discovers "INR-margined" is actually settled in USDT via a peg | T15.10 UI shows both the INR figure and the USDT actually held, with the peg source & timestamp |

## Notes for the next phase

Phase 14 (go-live gate) covers spot AND futures rungs 1-6 once Phase 15 is code-complete. The real-money rungs for futures need Anand's futures wallet funded on CoinDCX plus USDT and INR balances — flag this on the go-live checklist.
