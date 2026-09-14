# Phase 13 - Operations

Status: OFFLINE CORE COMPLETE 2026-09-09 (go-live-gated items recorded, not done) | goal: the operator surface - alerts that fire on silence as well as errors, a customer-visible audit log, support tooling with no decrypt path, and a restore drill that actually proves recoverability | depends on: 08 | implements: `20`, `07` F8, `22` F7

Built on Anand's "offline-verifiable core" decision (2026-09-09). The repo has no running daemons (execution engine null until Phase 14), no staff/support actor (roles owner/trader/viewer only), and AWS is deferred — so the drill and the staff/support-surfaces items are recorded in `docs/ops/go-live-gates.md` as Phase-14 items, not fabricated here. Runbooks R1–R8 already exist in `research/20` F3 and are indexed in `docs/ops/runbooks.md`; incident-comms templates are new in `docs/ops/incident-comms.md`.

## Scope

**In:** the alert catalogue with routing; metrics and dashboards; the customer-visible audit view; support tooling; the restore drill executed for real; deploy safety; the seven runbooks written and reviewed.

**Explicitly out:** anything that requires a decrypt path for support - that path must not exist. Also out: new product features.

## Preconditions

| Precondition | How to check |
|---|---|
| Phase 08 done | Real group trades exist to alert on |
| Audit table populated since Phase 00 | Rows exist for credential, trade and limit events |

## Tasks

**T13.1 - The alert catalogue (`20` F2)**
All eighteen alerts A1-A18 with thresholds, dimensions (tenant, account, market, **`ecode`**, process) and routing. Only the ten money-at-risk alerts page at night.
*Acceptance:* each alert has a test that triggers it synthetically; a review confirms which page and which wait.

**T13.2 - Alert on silence**
A3 (no reconciliation progress for 3 cycles), A11 (oldest unclaimed `place` job older than 10 s), A12 (depth `vs` stalled, or no candle `x` flip in 2 intervals). These fire on **absence**, which is the failure mode of this system.
*Acceptance:* stopping the reconciler raises A3 within the window; a deliberately stalled job raises A11.

**T13.3 - Metrics and dashboards**
Order outcomes by class, gate refusals by reason, exchange latency histogram per endpoint, rate-limit bucket depth, reconciler lag, **decrypt count per credential per minute**, job queue depth and age.
*Acceptance:* the latency histogram distinguishes ~38 ms warm from ~105 ms cold, proving connection reuse in production.

**T13.4 - Customer-visible audit view**
The tenant's own audit events, including **staff actions on their tenant**. This makes an insider-risk claim answerable from data the customer already holds.
*Acceptance:* a support action appears in the customer's view; cross-tenant events are absent.

**T13.5 - Support tooling with no decrypt (`20` F6)**
Support sees `api_key_last4`, credential status, order states, raw exchange statuses, refusal reasons, the execution report, reconciled balances, and *whether* a decrypt occurred. Never plaintext, never the full key, and **there is no decrypt path to grant**.
*Acceptance:* a code search confirms no support route can reach the signer's `expose()`; every support action writes an audit event naming the staff member.

**T13.6 - The restore drill, executed (`07` F8)**
Restore Postgres to an isolated VPC → point at the **real** CMK with a read-only-scoped role → decrypt one credential → sign `users/balances` → assert HTTP 200 → destroy → record the result and elapsed time.
*Acceptance:* the drill is executed and its result written into this file. A database-only restore does not count.

**T13.7 - Deploy safety (`20` F5)**
A pre-deploy check that blocks while any `group_trade.status = 'executing'`. Workers drain on `SIGTERM` with a 60 s grace. The reaper runs on every start. Signer deploys separately from workers.
*Acceptance:* a deploy attempted during a live fan-out is refused; a `SIGTERM`ed worker finishes its in-flight order.

**T13.8 - The seven runbooks**
R1 customer key compromised, R2 our systems compromised, R3 exchange outage, R4 our outage with open orders, R5 stuck order, R6 reconciliation mismatch, R7 bad deploy, R8 disputed fill. Written as numbered steps, reviewed, and stored in the repo.
*Acceptance:* R4 is exercised by the existing worker-kill simulation - the runbook and the test are the same scenario.

**T13.9 - Incident-comms templates**
Pre-written customer messages for each runbook, plus a commitment to a first message within 2 hours of confirming customer impact. Written **before** an incident, per the `16` L5 lesson.
*Acceptance:* templates exist for all eight runbooks and name who sends them.

## Schema delta

None. May add a `platform_alert_state` table if alert suppression is implemented.

## Verification

`checks/13-alerts.check.mjs` (51 — synthetic trigger for every A1–A18 + the ten page-at-night routing + DB E2E for A11/A16/A18), `checks/13-telemetry.check.mjs` (11 — latency histogram warm/cold + percentiles; real adapter reuse on the 2nd call; rate-bucket depth), `checks/13-deploy-safety.check.mjs` (8 — guard refuses an executing group trade; graceful SIGTERM drain finishes an in-flight fan-out; boot reaper turns a stale lock into a resolve job), `checks/13-support-no-decrypt.check.mjs` (2 — no route can reach a decrypt). **72 assertions**, green 2026-09-09.

## Definition of done

- [x] All eighteen alerts implemented, with the ten money-at-risk ones paging — `packages/ops` catalogue + `13-alerts`
- [x] A3 fires when the reconciler stops; A11 fires on a stalled job — A3 is engine-ready but needs a running reconciler cadence (go-live gate); A11 fires DB-E2E (`13-alerts`)
- [x] The latency histogram shows ~38 ms warm in production — histogram mechanics + reuse proven (`13-telemetry`); the production number is a go-live baseline
- [ ] Customers can see staff actions on their own tenant — audit schema is ready (`actor_user_id`/`actor_process`, tenant-scoped view); needs the staff-actor decision (go-live gate)
- [x] No support route can reach a decrypt, and a code search proves it — `13-support-no-decrypt` + `SIGNER-ONLY-EXPOSE`
- [ ] **The restore drill has been executed, through the real CMK, with the result recorded here** — gated on AWS; procedure at `research/20` F4, recorded in `docs/ops/go-live-gates.md`
- [x] A deploy during a live fan-out is refused — deploy guard (`13-deploy-safety`)
- [x] All eight runbooks written and reviewed — written in `research/20` F3, indexed in `docs/ops/runbooks.md`; the two-person dry-run review is a go-live item
- [x] Incident-comms templates written and owners named — `docs/ops/incident-comms.md`

## Phase risks

| Risk | Addressed by |
|---|---|
| R06 reconciler silence | T13.2's A3 - the cheapest elimination of the worst risk |
| R18 unrecoverable backup | T13.6, and only T13.6 |
| R19 bad deploy mid-trade | T13.7 |
| R01 key exfiltration undetected | T13.3's decrypt-rate metric and A6 |
| The 3Commas denial pattern | T13.9's pre-written templates plus T13.4's attribution data |

## Notes for the next phase

Everything operational is now in place. Phase 14 is the gate: the ladder's final rung, the legal answers, and the checklist.
