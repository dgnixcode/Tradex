# Phase 06 - Single-account execution and reconciliation

Status: not started | goal: one real order, on real money, that **always** reaches a terminal known state - and never duplicates | depends on: 05 | implements: `08`, `12`, `07` F5, `18` F5-F6 rungs 1-3

## Scope

**In:** the execution worker and job substrate; the reaper; `client_order_id` derivation; write-before-send; the `ambiguous` state and the resolve ladder; the signer as a **separate process**; reconciler Loops A and C; fill ingestion; the clock-skew guard; rollout rungs 1, 2 and 3.

**Explicitly out:** group fan-out (Phase 08) - this phase sends to **one account at a time**, even if a group has more. Also out: the full ledger fold and P&L (Phase 07), Loops B and D, cancel and close (Phase 09), sockets (Phase 11).

## Preconditions

| Precondition | How to check |
|---|---|
| Phase 05 fully done | Every kill switch and cap provably blocks a send |
| Rung 0 passed | 100 clean dry runs |
| A dedicated test account funded with **Rs 2,000** | Balance visible in `GET /accounts` |
| G2 answered | Recorded in `_PROGRESS.md`; bucket defaults set |
| NTP configured on all signing hosts | Startup offset check passes |

## Tasks

**T06.1 - Job substrate and reaper**
`execution_job` claimed with `FOR UPDATE SKIP LOCKED`. The reaper runs **on every process start** and on a schedule, clearing locks older than 5 minutes and re-queuing them as `kind = 'resolve'` - **never** as `'place'`.
*Acceptance:* a test kills a worker holding a `place` job and asserts the reaper enqueues `resolve`; a test asserts two workers never claim the same job.

**T06.2 - `client_order_id` derivation**
`"t" + base32(HMAC(pepper, group_trade_id‖account_id‖leg_seq))[0..27]` - 27 characters, inside the 36-character limit. Deterministic; reserved in the same transaction that writes `sending`.
*Acceptance:* the same inputs produce the same id twice; the value is ≤ 36 chars; `UNIQUE (client_order_id)` rejects a second insert.

**T06.3 - Write-before-send**
Acquire the advisory lock on `(account_id, market)`, re-run the gates, reserve the `coid`, write `sending`, **commit**, then sign and POST.
*Acceptance:* a test that crashes the process between the commit and the POST leaves a `sending` row; a code review checklist item asserts no path writes after the response.

**T06.4 - Signer as a separate process**
Split `apps/signer` out. Only its IAM role holds `kms:Decrypt`. It receives `(credentialId, exactBody)` and returns headers; plaintext never crosses back.
*Acceptance:* an IAM assertion test proves `api` and `worker` roles cannot decrypt; the signer's response type has no plaintext field.

**T06.5 - Send and classify**
POST `orders/create` with the exact signed bytes. Classify the outcome per `08` F2: `acked`, `rejected` (never retried), `ambiguous` on timeout/5xx/reset, distinct handling for signature and timestamp errors.
*Acceptance:* each class is exercised against the fake exchange; a business rejection is provably never retried.

**T06.6 - The resolve ladder (`12` F3)**
On `ambiguous`: `orders/status` by `coid` at 250 ms, 1 s, 3 s, 8 s, 20 s. A first not-found within 2 s of send is retried, not trusted. Exhaustion → `needs_human`, account frozen, alarm.
*Acceptance:* the four fault scenarios from `18` F5 - lost response with the order accepted, lost response with it not accepted, duplicate `coid`, worker killed mid-send - all pass with **zero duplicate orders**.

**T06.7 - Reconciler Loop A**
`orders/status_multiple`, up to 10 `coid`s per call, adaptive cadence (1 s during a trade, then backing off), advancing children to terminal states. Status mapping per `12` F1 with an alias map covering `cancelled`/`canceled`/casings, and an `UNKNOWN` state that **alarms and never throws**.
*Acceptance:* an unrecognised status produces `unknown` plus an alarm and the reconciler continues (invariant **R10**).

**T06.8 - Reconciler Loop C**
`orders/trade_history` with **no `symbol`**, per account, from the last ingested fill, paged to exhaustion. Fills matched to our orders by `exchange_order_id`; unmatched fills raise `EXTERNAL_ACTIVITY` as a **security** event.
*Acceptance:* a fill placed manually on CoinDCX during the test is detected and raised.

**T06.9 - Fill ingestion**
Each fill writes its ledger entries idempotently under `UNIQUE (account_id, exchange_trade_id, kind, occurred_at)`. Read the real `fee` from the first fill and cache it per account, replacing the 0.5% assumption.
*Acceptance:* re-ingesting the same page adds zero rows; the cached fee rate is used by subsequent sizing.

**T06.10 - Clock discipline**
NTP required; startup refuses above 1 s offset; a metric on measured offset; alarm on the **first** signature or timestamp error, classified distinctly from a 401.
*Acceptance:* a simulated 15 s skew produces a signature-class error and an alarm, not a credential error.

**T06.11 - Rungs 1, 2 and 3**
Rung 1: one order, Rs 100 cap hard-coded, reaching `filled`. Rung 2: ten orders including a cancel and a partial fill. Rung 3: Rs 1,000.
*Acceptance:* each rung's pass condition from `18` F6 met and evidence recorded in this file.

## Schema delta

None new. `child_order` gains populated `client_order_id`, `exchange_order_id`, `exchange_status_raw`, fill columns; `ledger_entry` starts receiving rows (Phase 07 owns the fold).

## Interfaces

| Interface | Notes |
|---|---|
| `ExchangeAdapter.placeOrder(cred, req)` | Now implemented |
| `ExchangeAdapter.getOrderByClientId(cred, coid)` | The resolve primitive |
| `Signer` over a process boundary | Headers only |
| `Reconciler.loopA(accountId)` / `.loopC(accountId)` | Idempotent, resumable |

## Verification

`checks/06-engine-simulation.check.js` (the ten `18` F5 scenarios, ~180), `checks/06-worker-kill.check.js` (**R8**, ~40), `checks/06-coid-derivation.check.js` (~30), `checks/06-loop-a-mapping.check.js` (all statuses + unknown, ~60), `checks/06-loop-c-external.check.js` (~35), `checks/06-fill-idempotency.check.js` (~40), `checks/06-clock-skew.check.js` (~20). Target: **~405 assertions**.

## Definition of done

- [ ] Rungs 1, 2 and 3 passed on real money, with evidence recorded
- [ ] Zero duplicate orders across all ten simulation scenarios
- [ ] A worker killed mid-send never produces a second order
- [ ] The reconciler survives an unknown status (alarms, continues)
- [ ] A manually-placed CoinDCX fill is detected by Loop C
- [ ] Re-ingesting a `trade_history` page adds no ledger rows
- [ ] The signer is a separate process; `api` and `worker` cannot decrypt
- [ ] A business rejection is never retried
- [ ] The real fee rate is read from a fill and replaces the assumption
- [ ] A 15 s clock skew produces a signature-class alarm

## Phase risks

| Risk | Addressed by |
|---|---|
| R02 duplicate order | T06.1-T06.3, T06.6 - four independent mechanisms |
| R06 reconciler silence | T06.7's `UNKNOWN`-not-throw; alert A3 lands in Phase 13 |
| R01 key exfiltration | T06.4's process split - the largest single reduction available |
| R13 clock skew | T06.10 |
| R23 fee assumption | T06.9 replaces it with a measured value |

## Notes for the next phase

The ledger receives rows but nothing folds them yet - Phase 07 builds the projection and P&L. Loop B and Loop D are absent. Only one account trades at a time; the parallelism, fairness and reporting of a real fan-out are Phase 08.
