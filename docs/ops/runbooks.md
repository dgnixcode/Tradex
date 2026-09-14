# Operations runbooks (R1–R8)

Phase-13 T13.8: each runbook is numbered steps, written to be followed at 3 am by
whoever is on call. The full text lives in `research/20-ops-audit-runbook.md` F3
(lines 77–137) — this file indexes them and records the review status so a reader
knows where each scenario lives.

| # | Scenario | Where | Reviewed |
|---|---|---|---|
| R1 | Customer key compromised (external activity, A5) | `research/20` F3 R1 | pending (go-live review) |
| R2 | Our systems compromised | `research/20` F3 R2 | pending |
| R3 | Exchange outage / degradation | `research/20` F3 R3 | pending |
| R4 | Our outage with open orders in flight | `research/20` F3 R4; exercised by the worker-kill scenario (`research/18` F5) and `checks/13-deploy-safety` | pending |
| R5 | Stuck order | `research/20` F3 R5; playbook from `research/12` F8 | pending |
| R6 | Reconciliation mismatch | `research/20` F3 R6 | pending |
| R7 | Bad deploy mid-trade | `research/20` F3 R7 | pending |
| R8 | Customer disputes a fill | `research/20` F3 R8 | pending |

R4's first step — on restart, run the reaper first so a stale lock becomes a
`resolve` job, never a second `place` — is the boot reaper wired in
`apps/api/server.mjs` and proven by `checks/13-deploy-safety`.

**Review rule:** a runbook is "reviewed" only after two people have walked it once
in a dry-run. DoD for Phase 13 records the review as a go-live-gate item (see
`docs/ops/go-live-gates.md`), because a full rehearsal needs the deployed
environment; the repo copy is final text.
