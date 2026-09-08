# 20 - Operations, audit and runbooks

Status: 2026-09-03 | track: platform | scope: the audit trail, the alert catalogue with thresholds, the seven runbooks, backup and restore including the KMS path, deploy safety during a live fan-out, and a support workflow that never exposes a key.

## Verdict

- **The audit log is append-only, physically separate from mutable state, and retained for five years.** Both CoinDCX clause 6.6 and PMLA require five years, and PMLA requires records sufficient to *reconstruct individual transactions* (`15`). That is a schema requirement, not a logging preference: the audit store must answer "who did what, to which accounts, at which sizes, from which IP, with which credential" without joining against rows that may since have changed.
- **The alert that matters most is the one nobody thinks to add: the reconciler going quiet.** A reconciler that throws stops reconciling, and everything else looks fine (`12` R10). Alert on *absence* of reconciliation progress, not only on errors - silence is the dangerous state in this system, exactly as it is on the sockets (`05`).
- **Write the incident-comms plan before there is an incident.** 3Commas repeatedly denied the leak was theirs and then admitted it, which cost more reputationally than the breach (`16` F1). The reason they could deny it in good faith is that they could not tell. Our version of that plan starts with the question "can we prove where this key leaked from?" and our answer must be yes within hours.
- **A backup that has never been restored *through the KMS path* is not a backup.** Our ciphertext is the only copy of a customer's secret in existence, because CoinDCX shows it once and never again (`07` F8). The drill is: restore into an isolated environment, point at the real CMK, decrypt one credential, sign one read-only live request, confirm HTTP 200. Anything less proves nothing.
- **Never deploy during a live fan-out.** Workers drain; the web tier can roll. A worker killed mid-send leaves an order in `sending`, which is recoverable (`12` R8) but is an unnecessary risk to take on a schedule we control.
- **Support must be able to help without ever seeing a key.** Staff see `api_key_last4`, statuses, timestamps, refusal reasons and the execution report - never plaintext, never the full key, never a decrypt. Any workflow that requires a decrypt is a workflow to redesign.
- **Segment alerts by `ecode`.** 376 markets route through `B`, 244 through `KC`, 40 through `G` (`10` F2). A third-party venue degrading will look like a partial mystery unless the alert dimension exists from day one.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Audit store | Append-only table, no `UPDATE` or `DELETE` grant to the application role | Tamper evidence is the point | Application logs as the audit trail |
| Audit retention | **5 years minimum** | Clause 6.6 and PMLA (`15`) | 90 days, or "as long as convenient" |
| Log retention | 30 days hot, 1 year cold | Debugging window versus cost; the audit trail is separate | Treat logs as the record |
| Alert on silence | Yes - reconciler progress, socket liveness, job drain rate | Silence is the failure mode in this system | Alert only on errors |
| Paging policy | Only money-at-risk conditions page at night (F2) | Alert fatigue is how the real page gets missed | Page on everything |
| Restore drill | Quarterly, and it must sign a live read-only request | A database-only restore proves nothing (`07` F8) | Verify the backup file exists |
| Deploy during a fan-out | Blocked by a pre-deploy check | A worker killed mid-send is avoidable risk | Rely on recovery |
| Support access | Metadata only; no decrypt path exists for support | The `16` F1 lesson | A break-glass decrypt for support |
| Break-glass | Exists only for the signer role, dual-controlled, always alerts, always audited | Some incidents need it; none need it silently | No break-glass, or an unaudited one |
| Incident comms | Pre-written templates; first customer message within 2 hours of confirming customer impact | 3Commas' timeline is the counter-example | Draft it during the incident |
| Alert dimensions | tenant, account, market, **`ecode`**, process | Failures cluster by venue and by process | Global counters only |

## Findings

### F1 - The audit trail

Schema in `19` F2. What must be recorded, beyond the obvious CRUD:

| Event class | Examples | Why it is audited |
|---|---|---|
| Credential lifecycle | `credential.create`, `credential.replace`, `credential.revoke`, `credential.auth_failed` | Leak attribution (`16` L2) |
| Decrypt | `credential.decrypt` with actor, process, reason and the `child_order_id` it served | The earliest abuse signal; also proves *whether* a decrypt happened during a disputed window |
| Trading intent | `group_trade.create` with the full intent, `group_trade.confirm` with the preview id | PMLA reconstruction; and disputes turn on what was authorised |
| Per-account outcome | `child_order.sent`, `.acked`, `.terminal` with the raw exchange status | The dispute record |
| Money movement | Every `ledger_entry` is already immutable (`11` L3); the audit references it | Reconstruction duty |
| Limits and switches | `limit.change`, `trading.pause`, `trading.resume` with actor | Who turned the safety off |
| Access | login, failed login, re-auth, role change, invite | Standard, and required by AML programmes |
| Reconciliation | `divergence.detected`, `external_activity.detected`, `correction.appended` | Security events (`16` F2), not just accounting |

Two rules that make it trustworthy: the application role has `INSERT` only, and `before`/`after` payloads are written through the same redaction serialiser as the logs (`07` F6) so a secret cannot reach an audit row.

### F2 - Alert catalogue

Thresholds are starting points, to be tuned once the `08` F1 rate-limit answer and real traffic exist.

| # | Alert | Condition | Page at night? |
|---|---|---|---|
| A1 | Order failure rate | >20% of child orders in a 5-minute window reach a non-fill terminal state, excluding pre-send skips | **Yes** |
| A2 | Any `needs_human` order | count > 0 | **Yes** - a real-money order in an unknown state |
| A3 | Reconciler silent | No reconciliation progress for 3 consecutive cycles | **Yes** - the safety net may be off |
| A4 | Reconciliation divergence | Any unexplained balance delta above tolerance (`11` F6) | Yes if > 1% of account value, else morning |
| A5 | External activity detected | A fill with no matching `client_order_id` (`12` Loop C) | **Yes** - possible key compromise |
| A6 | Abnormal decrypt rate | Decrypts for one credential > 3× its 7-day p95 | **Yes** |
| A7 | Credential auth failures | 3 consecutive 401s on one credential | No - notify the customer |
| A8 | Signature or timestamp error | **Any occurrence** | **Yes** - clock skew fails everything at once (`12` F7) |
| A9 | Rate-limit saturation | 429s > 1% of requests in 5 minutes, or bucket depth < 10% | Yes during market hours |
| A10 | Clock offset | NTP offset > 1s on any signing host | **Yes** |
| A11 | Job queue age | Oldest unclaimed `place` job older than 10s | **Yes** |
| A12 | Socket dead-but-open | Depth `vs` not advancing for 60s on a subscribed market, or no candle `x` flip in 2 intervals (`05`) | No - charts degrade only |
| A13 | Exchange 5xx cluster | >10 5xx in 1 minute | Yes |
| A14 | `exit_only` or market inactive | Any subscribed market flips (`03` G14) | Morning - it fails cleanly at the gate |
| A15 | Unusual notional | A single group trade > 3× the tenant's 30-day p95 | **Yes** |
| A16 | Kill switch engaged | Any switch flipped, by anyone | Notify, do not page |
| A17 | Worker lock reaped | Reaper cleared a stale lock | No - but count it; a rising rate means crashes |
| A18 | Ledger invariant violated | `L2` fails on a periodic check | **Yes** - the books are wrong |

A3, A8 and A18 are the three most valuable and the three least likely to be added by default. Each is a case where the system is broken while appearing healthy.

### F3 - Runbooks

Each is numbered steps, written to be followed at 3am by whoever is on call.

**R1 - Customer key compromised (external activity detected, A5)**
1. Engage the **account** kill switch immediately. Do not wait to confirm.
2. Snapshot: the unknown fills, the account's `account_market_seen` set, our decrypt audit for that credential over 30 days.
3. Determine whether the decrypt count is consistent with our own orders. If there are decrypts with no matching `child_order`, escalate to R2 (our breach).
4. Contact the customer with the specific fills and the exact question: *"did you place these?"*
5. If not theirs: instruct them to delete the key on CoinDCX immediately (their action, not ours - `07` F1), then replace it in Tradex.
6. Mark the credential `revoked`; crypto-shred `dek_wrapped`.
7. Preserve everything for 5 years. Write the incident record.

**R2 - Our systems compromised**
1. Engage the **global** kill switch.
2. Rotate the KMS CMK's access policy: remove the signer role's decrypt permission. Trading stops; nothing is lost.
3. Snapshot decrypt audit for all credentials; identify the exposure window.
4. Notify every customer whose credential was decrypted in that window - and, per the 3Commas lesson, notify without asserting that the leak was not ours until we can prove it (`16` L5).
5. Instruct all affected customers to delete their keys on CoinDCX. That is the only action that actually stops the bleeding.
6. DPDP breach process (`15` F7); CoinDCX security notification per clause 8.
7. Post-mortem published to customers.

**R3 - Exchange outage or degradation**
1. Confirm scope: is it all `ecode`s or one? A13 plus per-venue error rates.
2. If total: enter **degraded read-only** mode - previews disabled, existing orders still tracked, positions and history readable.
3. Do not cancel anything automatically. Open orders may fill when the exchange returns.
4. Post a status message; customers with open orders get a direct notification.
5. On recovery: run a full reconciliation sweep for every account with non-terminal orders **before** re-enabling trading.

**R4 - Our outage with open orders in flight**
1. On restart, the scheduler must run the reaper first: every stale lock becomes a `resolve` job, never a `place` job (`08` F10).
2. Block all new placements per account until that account's `sending`/`ambiguous` orders are resolved (`12` R8).
3. Only then re-open trading, tenant by tenant.
4. Reconcile balances before publishing any P&L figure.

**R5 - Stuck order**
1. Identify the state: `sending`, `ambiguous`, `open`, or `unknown`.
2. `sending`/`ambiguous` → force a resolve cycle; if it exhausts, it is `needs_human`.
3. `unknown` → read `exchange_status_raw`; add the alias to the status map; redeploy. This is a five-minute fix by design (`12` F8).
4. `needs_human` → freeze the account, reconcile by hand against `trade_history`, append a correction, record the outcome.
5. `open` for hours is **not** an incident - it is a limit order away from the market. Confirm and close the alert.

**R6 - Reconciliation mismatch**
1. Classify: uningested fill, open-order lock, outside deposit/withdrawal, or genuinely unexplained.
2. Ingest and recompute if it is a known fill.
3. Unexplained → append `external_adjustment` (`11` F6), badge the account's metrics `approximate`, ask the customer.
4. Above the value threshold → treat as R1 until excluded.
5. Never edit a ledger row. Append a correction (`11` L3).

**R7 - Bad deploy mid-trade**
1. Do not roll back the database. Roll back the application only.
2. Check for orders in `sending` from the killed workers; force resolve.
3. If the deploy changed the sizing or legalisation code, quarantine every group trade planned under the old version - `market_meta_version` and the code version are recorded per order for exactly this reason (`14` F2).
4. Re-run the ledger invariant check (A18) before re-enabling trading.

**R8 - Customer disputes a fill**
1. Pull the audit chain: intent, preview id, per-account plan, `client_order_id`, sent body, exchange response, `exchange_status_raw`, fills, ledger entries.
2. Compare our recorded quantity with the preview the customer approved (`21` U2).
3. Fetch `trade_history` for the window as independent confirmation.
4. If our record and the exchange agree, present the chain, including the price basis and timestamp the customer was shown.
5. If they disagree, we are wrong until proven otherwise: append a correction, explain, and treat it as an A4 incident.

### F4 - Backup, restore and the KMS path

| Asset | Backup | Restore proof |
|---|---|---|
| Postgres | Managed PITR, 30-day window | Quarterly restore to an isolated environment |
| KMS CMK | Deletion protection **on**; multi-region replica; the CMK is not in the database's blast radius | Decrypt one credential from the restored data |
| Audit store | Same PITR, plus a monthly export to write-once storage | Export readable and complete |
| Config and secrets | Infrastructure as code in version control; no secrets in it | Environment rebuilt from scratch in the drill |

The quarterly drill, in full: restore Postgres to an isolated VPC → point the signer at the **real** CMK with a read-only-scoped role → decrypt one credential → sign `users/balances` → assert HTTP 200 → destroy the environment → record the result and the elapsed time. If any step is skipped the drill has not happened.

Two failure scenarios this drill is specifically designed to catch: a CMK whose key policy no longer permits the restored environment's role, and an envelope-encryption change that silently broke backward compatibility with older `key_version` rows.

### F5 - Deploy safety

| Rule | Mechanism |
|---|---|
| No deploy while any group trade is executing | Pre-deploy check queries for `group_trade.status = 'executing'`; blocks |
| Workers drain, they are not killed | `SIGTERM` → stop claiming, finish in-flight, exit; grace period 60s |
| Web tier rolls freely | It places no orders |
| Migrations are forward-only and additive within a release | A rollback of code must never require a rollback of schema |
| Signer deploys separately, and never at the same time as workers | Two moving parts at once during signing is one too many |
| The reaper runs on every start | Guarantees `12` R8 regardless of how the previous process ended |

### F6 - Support without keys

| Support can see | Support cannot see |
|---|---|
| `api_key_last4`, credential status, `validated_at`, auth-failure count | The API key, the secret, any plaintext, any decrypt |
| Every order, its state, its raw exchange status, its refusal reason | - |
| The execution report and the preview the customer approved | - |
| Balances and holdings as reconciled | - |
| Audit events for that tenant | Audit events for other tenants |
| Whether a decrypt occurred, and when | The decrypted value |

Every support action that touches a tenant writes an audit event naming the staff member, and the customer can see those events in their own audit view. That last property is what makes an insider-risk claim answerable rather than argued: the customer has the same record we do.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Reconciler dead, nothing alerts | A3 on absence of progress | Alert on silence, not only errors | Total loss of the safety net, invisibly |
| Audit rows mutable | Grant review | `INSERT`-only application role | No tamper evidence when it matters most |
| Backup never restored through KMS | The drill is scheduled and recorded | F4's full procedure | Every customer re-onboards manually |
| CMK deleted | Every decrypt fails at once | Deletion protection, replica | Total, unrecoverable |
| Deploy during a fan-out | Pre-deploy check | F5 | Orders in `sending`, avoidable |
| Alert fatigue | Page volume trend | Only money-at-risk pages at night (F2) | The real page is missed |
| Incident comms improvised | - | Pre-written templates, 2-hour commitment | The 3Commas outcome |
| Support needs a decrypt to help | Any request for one | Redesign the workflow; there is no decrypt path | One exception becomes the norm |
| Alerts not segmented by `ecode` | A venue outage looks like random failures | `market_ecode` on every child order (`10`) | Hours of misdirected diagnosis |
| Secret written into an audit payload | Canary test covers logs; audit writer uses the same serialiser | Redact at the writer | The failure this whole plan is built to prevent |

## Open questions for Anand

1. **Who is on call, and with what expectation?** With a two-person team, "page at night" needs a real answer. Recommended default: **the money-at-risk alerts (A1, A2, A3, A5, A6, A8, A10, A11, A15, A18) page; everything else waits for morning** - and if nobody can be on call, then trading hours should be restricted until someone can.
2. **Do we restrict trading to hours we can support?** It bounds unattended risk substantially. Recommended default: **allow 24×7 but keep the tenant kill switch prominent**, and revisit if unattended incidents actually occur.
3. **Does the customer see their own audit log?** Recommended default: **yes.** It is cheap, it is a genuine trust feature, and it makes staff access self-policing (F6).
4. **Restore drill cadence.** Recommended default: **quarterly, plus once before go-live.** The pre-go-live one is non-negotiable; it is the only proof the credential path is recoverable at all.

## Phase hints

- **`audit_event` and the redaction serialiser are Phase 00.** Retrofitting an audit trail means the earliest, most formative actions were never recorded.
- **Alerts A2, A3, A8, A11 and A18 ship with the execution engine and reconciler**, not in a later "observability" phase. They are the ones that detect money at risk.
- **The kill switches ship before rung 1 of the rollout ladder** (`18` F6) and get their own check script.
- **R4 (our outage with open orders) is exercised by the worker-kill simulation** (`18` F5) - the runbook and the test are the same scenario.
- **The pre-go-live restore drill is a gate item**, with its result recorded in the plan.
- **Incident-comms templates are a go-live gate item**, not a backlog card.
- **Support tooling (F6) can be last** among these, but the constraint that no decrypt path exists for support must be true from the first credential.

## Sources

- `15-india-regulatory-compliance.md` - CoinDCX clause 6.6 (5-year retention), clause 8 (security notification to CoinDCX), PMLA record-reconstruction and 5-year duties, DPDP breach obligations.
- `16-competitive-benchmark.md` F1 - the 3Commas timeline: denial before admission, and the inability to attribute a leak; F2 - the contra-trade drain mechanism and our detection surface.
- `07-api-key-security.md` - F3 decrypt auditing, F7 crypto-shredding, F8 the restore-drill requirement and why a database-only restore is worthless.
- `08-fanout-execution-engine.md` - the reaper's `resolve` routing, kill-switch scopes, job queue age.
- `11-positions-ledger-pnl.md` - `external_adjustment`, append-only corrections, the `L2` invariant behind A18.
- `12-order-state-reconciliation.md` - R8 restart discipline, the stuck-order playbook behind R5, F7 clock discipline behind A8/A10.
- `10-multi-currency-inr-usdt.md` F2 - `ecode` venue segmentation.
- `05-coindcx-websockets.md` - depth `vs` and candle `x` as liveness detectors behind A12.
- `17-architecture-stack.md` - process ownership, observability, the signer's exclusive KMS role.
- `18-testing-correctness-program.md` - the worker-kill simulation that doubles as the R4 drill; the kill-switch check script.
- `19-accounts-groups-data-model.md` - `audit_event` schema, `tenant_limit` kill switches, role matrix.
