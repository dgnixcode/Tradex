# Phase-13 go-live gates (what could not be proven offline)

Phase 13's offline-verifiable core shipped (alerts, telemetry, deploy safety,
no-decrypt guarantee, runbook index, incident-comms). These Phase-13 items are
genuinely gated on the deployed environment (AWS CMK/VPC, a wired signer + worker,
a staff identity) — the standing deferrals. Each is recorded here so the Phase-14
go-live checklist can close it; none is silently dropped.

| Item | What must happen | Blocks |
|---|---|---|
| **Restore drill (T13.6, `research/20` F4)** | Execute for real: restore Postgres to an isolated VPC → point the signer at the REAL CMK with a read-only role → decrypt one credential → sign `users/balances` → assert HTTP 200 → destroy → record result + elapsed time. A database-only restore does not count. | AWS infra + real CMK |
| **Staff-visible audit (T13.4)** | A support/staff actor is needed for "staff actions appear in the customer's view". Tradex v1 has roles owner/trader/viewer only and no tenant-less operator. Decision: introduce an operator identity at go-live, or keep support as an owner role. The audit schema already carries `actor_user_id` + `actor_process`, and the customer view is tenant-scoped, so attribution data is ready. | staff identity decision |
| **Support tooling reads (T13.5 live)** | The "support sees credential status / raw exchange statuses / decrypt-occurred" surface needs a support actor + a wired signer that records decrypts. The no-decrypt guarantee itself is already enforced (`checks/13-support-no-decrypt`, `SIGNER-ONLY-EXPOSE`). | signer wiring (Phase 14) + staff identity |
| **Production latency baseline (T13.3)** | Record the real warm (~38 ms, reused connection) vs cold (~105 ms) histogram against the live venue. Mechanics are proven offline (`checks/13-telemetry`). | live venue key (Phase 14) |
| **Decrypt-count-per-credential metric + A6 (T13.3, A6)** | Thread the signer's decrypt counter into the alert readouts once the signer runs. | signer wiring |
| **Reconciler-silence A3 (T13.2)** | A3 needs a running reconciler whose cycle timestamp exists. Today no daemon runs; the alert engine is ready and the "no monitoring ≠ no alarm" rule keeps it from false-firing. Wire the reconciler cadence and feed `reconcilerSilentCycles`. | reconciler daemon (Phase 14) |
| **Runbook review (T13.8)** | R1–R8 text is final in-repo; "reviewed" = two people have walked each once in a dry-run against the deployed environment. | dry-run on deployed env |

The restore drill and the runbook rehearsal are the two items that cannot be
faked: anything less than the real CMK path is a database-only restore, which the
spec explicitly does not count.

## Phase 15 deferrals

Phase-15 items recorded here rather than done in-repo. The first three are
reason-blocked (more typing tonight would not resolve them); the last two are
real work owed and are next in the queue, not gated:

| Item | Why deferred | Blocks |
|---|---|---|
| **T15.9 socket for mark price** | Phase 11 (private sockets) is deferred out of v1 wholesale (§6a). Between socket pushes the futures view falls back to the REST mark_price which the venue itself flags as "not real-time and is only for reference" (research/04 F2). This is honest but stale; a green-lit socket wiring belongs with the Phase-11 revival. | Phase 11 revival |
| **T15.13 wallet transfer (spot ↔ futures)** | research/04 F18: *"A retried transfer moves money twice … the highest-risk call in this document"*. Not idempotent, no client key. Warrants deliberate design (per-tenant lock + cooldown + owner+reauth + hard confirm). Not something to slide in as a follow-on. | dedicated design pass |
| **Runbook/drill items from Phase 13** | See the table above — unchanged. | AWS / staff identity |
| **T15.5 fan-out enqueue — DONE** | `GroupExecutor.enqueue` materialises the SL/TP conditional legs for a futures trade and `ExecutionWorker.settle` attaches them when an entry reports `filled` (partial-success per leg; `ENTRY_DID_NOT_FILL` / `TP_SL_NOT_ATTACHED` skips otherwise). Green: `checks/15-fanout` (28 assertions), full suite 69 checks. Kept here only as a pointer for the Phase-14 wiring work: the `attachTpSl` port must be supplied by the composition root (`server.mjs` wires no venue ports yet). | composition-root wiring |
| **Second-factor enrolment is OPTIONAL — reconsider before real money** | `authorise()` (`packages/auth/src/roles.ts`) no longer denies a reauth-gated action to a user who has not enrolled 2FA; an un-enrolled user passes on the role check alone. FRESHNESS still applies in full to anyone who HAS enrolled. Reason for the relaxation: gating on enrolment made `credential.write` **unreachable** for a first-time owner (they cannot be asked for a code they have never set up), which blocked connecting the very first account. The tradeoff, plainly: without a second factor, a stolen owner password is enough to replace an API key — the highest-value action in the product. **Decide before the first real key: re-tighten, or accept it with 2FA strongly recommended in-product.** | go-live decision |
| **Futures fills → ledger — no producer** | `recordFill` is still called only by checks; nothing reads venue futures fills into `ledger_entry`. Realised P&L / fee drag / TDS (Phase 12) therefore stay empty for futures activity, so the Positions view is the only live money surface. Wants the same private-fill read that Loop D needs. | real-venue fill read (Phase 14) |
| **The futures SEND protocol (L1–L4) — specified, not built** | `research/03` specifies it in full and `futures-order-client.ts`'s own header names it ("the anti-duplicate spine lives ABOVE this adapter as a per-(account, pair) row lock + read-back via `listRecentFuturesOrders`") — but **`listRecentFuturesOrders` does not exist**, and `futures_execution_lock` has no caller. Why it cannot be shortcut: futures `orders/create` takes **no `client_order_id`**, so the venue cannot reject a duplicate for us, and there is **no order-status endpoint** — the engine's whole ambiguity ladder ("ask the venue whether my order landed") has nothing to call. The substitutes are L1 lock → L2 durable write-before-send → L3 create → L4a read back via `POST /derivatives/futures/orders` (which requires `status`, `side`, `page` AND `size` — any status you omit is invisible) → L4b match on (pair, side, order_type, total_quantity, price). Two indistinguishable matches ⇒ `NEEDS_HUMAN` + alarm + freeze; that is the honest terminal, and the L1 lock exists to make it impossible *from our side*. `research/03` is explicit that this protocol is the phase's **first** task, not order placement. Prerequisites now in place: `OrderToSend.futures`, the `BodySigner` signed-request path, `HttpDeps.attachTpSl`, the signed single-column `active_pos`, and **L4a itself** — `listFuturesOrders`/`listFuturesOrdersSigned` now exist (the header had named `listRecentFuturesOrders`, which was never written; the abstract port already declared it as `listRecentOrders`), with the status alias map (`cancelled` request spelling vs `CANCELED` response spelling, and an `unknown` fallback that alarms rather than throws) and `SubmitPortOutcome.needsHuman` as the channel L4c lands on. `checks/15-list-orders` pins the read-back, including the trap that a fresh order reports `initial` — a status in neither documented set, so a standard read-back cannot see it, which is exactly why L4 narrows by time. **The L1–L4 orchestration itself is now built** (`apps/api/src/futures/place-protocol.ts`) and pinned by `checks/15-place-protocol` (34 assertions): the lock gates the create and is released on every path including a throw; an unreadable list is `undecidable`, never `not_placed`; a near-miss on any of the four match fields does not adopt; two identical matches escalate `needs_human`; an order outside the ±5 s window (or with no timestamp) is not adopted. **Still owed for go-live: the composition root must actually wire it** — `server.mjs` supplies no venue ports, so `submit` still falls back to the rung-0 dry run. **DONE since:** the root now wires `submit`/`resolve`/`attachTpSl`/`futuresExit`/`futuresTpSl`/`afterFanOut` behind `TRADEX_SEND_MODE=send`, and the whole loop is verified end to end against the sandbox (preview → confirm → `dryRun:false` → order filled → position mirrored → exit → position gone). `FuturesExitPort` and `FuturesTpSlPort` gained a `FuturesActor` argument: their methods took bare venue ids, so the root had no way to know whose credential to sign with, and the Exit button could only ever answer *"futures execution is not configured in this build"*. `checks/15-hard-exit-service` (18 assertions) now covers the orchestrator — it had none — including the R1 guard that refuses to exit while a conditional is still untriggered. **Still open:** `moveExisting` on the SL/TP route is refused (cancel-then-create is not wired); the live signer process; the AWS KMS adapter. | dedicated phase |

Everything else in Phase 15 landed: schema (014), FuturesAdapter port,
futures-order-client + FakeFutures venue, place/positions/leverage/cancel/exit
adapter surface, SL/TP attach, hard-exit service + route + web page, anti-dup
lock, sizing gates, positions view under the §6a carve-out, alerts A19/A20/A21.

## Partial close and position increase — specified, not built

The customer asked for "exit just a few percent of position, or add more position".
`positions/exit` **cannot** do this: it closes the WHOLE position and takes only
`{timestamp, id}`. So the design is already fixed by `research/04` (F-line 510 and
the invariant table) and needs no new invention:

| Requirement | Rule |
|---|---|
| Reduce size | `qty = min(requested, abs(active_pos))`, rounded **DOWN** to `quantity_increment`; refuse if that lands below `min_quantity` or `min_notional`. **Rounding up here is how you accidentally go short** |
| 100% | Promote to `positions/exit` — one atomic venue call, rather than an opposite order racing fills and funding |
| Post-trade | Assert `sign(active_pos)` is unchanged or zero |
| Increase | An ordinary same-direction order through the existing L1-L4 protocol, so it inherits the lock and the read-back. The venue merges the fill and re-averages the entry itself |

**The mine this sits on, now defused.** The adapter was sending `reduce_only` on
every futures create, a field `research/04` proves by exhaustive grep does NOT
exist in the futures API and which `research/03`'s create contract does not list.
Either the venue ignores it — leaving a reducing order sized above the position
free to **close it and open the opposite one**, which research calls the worst case
in the document — or it rejects unknown fields, failing every order. FakeVenue
compounded it by accepting and echoing the field, so the sandbox would have
confirmed the fiction. The field is no longer transmitted, its type is documented
as retired, and `checks/15-list-orders` now asserts on the signed BYTES that the
create body does not carry it. **The guard that actually works is the clamp above,
and that is not built yet.**

**Newly found, and it is the real blocker: the rounding metadata has no source.**
The clamp above needs `quantity_increment` / `min_quantity` / `min_notional` for the
pair. `FuturesInstrument` (`packages/exchange/src/futures-adapter.ts:42`) carries
exactly those fields, and `ExchangeAdapter.listFuturesInstruments` declares a way to
get them — but **nothing implements or calls it, and there is no `futures_instrument`
table.** `market_metadata` is the SPOT catalogue (997-999 rows, `venue_symbol`,
`step`), and a futures instrument is a different thing with a different `pair` form
and a `contract_size` that spot has no concept of.

So the step must be fetched live: `GET /exchange/v1/derivatives/futures/data/instrument?pair=...&margin_currency_short_name=...`
(public, unsigned — research/03 line 37), one call before a rare user action. Build
order: (1) `fetchFuturesInstrument` in the adapter, (2) an `adjustPosition` port that
fetches it, computes `min(pct, 100%)` of `abs(active_pos)` rounded DOWN to the step,
refuses below the floor, promotes 100% to `positions/exit`, and asserts the position
sign did not flip; (3) the route; (4) 25/50/75/100 + "add" controls on Positions;
(5) a check pinning the rounding direction and the 100% promotion.

## Going live WITHOUT a managed KMS — what was built, and the decisions taken

Three guards used to stop a live boot. Each is now a deliberate, printed choice
rather than a wall, and the ones that remain are requirements, not obstacles.

| Guard | Now |
|---|---|
| `LocalKms` refuses production | Set `TRADEX_ALLOW_LOCAL_KMS=1`. It prints what it costs on every boot: the root key lives in an environment variable, so anyone holding it AND a database dump can decrypt every customer API key |
| `TRADEX_LOCAL_ROOT_KEY` unset (ephemeral) | **Refuses to send.** An ephemeral key makes every sealed credential unrecoverable on restart, so every account would have to reconnect |
| Real-venue sending with no signer | **Satisfied, not relaxed.** `npm run signer` runs `apps/signer/server.mjs` — a separate process, the only holder of KMS decrypt rights, which returns `{apiKey, signature}` and never the secret. `TRADEX_SIGNER_URL` points the API at it. Invariant X12 is intact; verified end to end (a real fan-out through the process, `placed: 1`, signer log showing the decrypts) |
| `TRADEX_SIGNER_TOKEN` | Optional. Without it the signer is an unauthenticated decryption oracle for anything that can reach the port — on a private network the topology is the control, otherwise SET IT |

**Defect found while proving it: a throw from the submit port stranded the leg.**
The `sending` reservation is committed before the send (write-before-send), so when
the port threw — a signer refusal, a transport failure, a bug — the child sat
`sending` forever, unsettled, and blocked its (account, market) with
`ORDER_IN_FLIGHT` for every future trade. Observed for real: one signer
misconfiguration froze an account mid-session. `placeOne` now catches it and
settles `ambiguous` — never `rejected`, because "we asked the venue and do not know"
must not be recorded as "the order does not exist", which is the claim that abandons
a live position. Ambiguous enqueues a resolve job, which the sweep then re-checks.

**Still owed:** a check pinning that catch (the fix is verified by hand, not by the
suite); `moveExisting` on the SL/TP route; futures fills → ledger.
