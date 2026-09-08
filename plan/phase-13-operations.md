# Phase 13 - Operations

Status: not started | goal: the operator surface - alerts that fire on silence as well as errors, a customer-visible audit log, support tooling with no decrypt path, and a restore drill that actually proves recoverability | depends on: 08 | implements: `20`, `07` F8, `22` F7

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

`checks/13-alerts.check.js` (synthetic trigger per alert, ~60), `checks/13-support-no-decrypt.check.js` (~25), `checks/13-deploy-guard.check.js` (~20). Target: **~105 assertions**. Plus the restore drill, which is a recorded procedure rather than an assertion count.

## Definition of done

- [ ] All eighteen alerts implemented, with the ten money-at-risk ones paging
- [ ] A3 fires when the reconciler stops; A11 fires on a stalled job
- [ ] The latency histogram shows ~38 ms warm in production
- [ ] Customers can see staff actions on their own tenant
- [ ] No support route can reach a decrypt, and a code search proves it
- [ ] **The restore drill has been executed, through the real CMK, with the result recorded here**
- [ ] A deploy during a live fan-out is refused
- [ ] All eight runbooks written and reviewed
- [ ] Incident-comms templates written and owners named

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
