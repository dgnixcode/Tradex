# Execution status after confirmation

The review page previously waited for the entire confirmation POST to finish
before navigating to progress. The backend may have sent orders while it was
still draining, polling or mirroring accounts. A slow or lost response left the
user on an unchanged review page. Progress also depended entirely on SSE and
discarded the final report's rows.

The frontend now verifies saved status before enabling confirmation and checks
the same trade's read-only report every second after submission. Once execution
has started, it moves directly to progress without waiting for the POST response.
Network/server failures retain the submission lock; there is no automatic resend.
Known validation refusals allow correction. Confirmed dry runs remain explicit.

Progress reads the durable report on mount and every 1.5 seconds while unresolved,
alongside SSE. It consumes final report rows and recovers missing stream events.
It distinguishes fills, placed limit orders awaiting fills, failures, and outcomes
requiring review. Completed reports stop polling. A delayed confirmation response
cannot pull an operator back after they leave the trade. Status refreshes only
issue GET requests; explicit retry still creates a fresh preview for failed legs.

Deployment changes only frontend source/assets. Build into a staging directory,
publish hashed assets without removing existing assets, then atomically replace
index.html. Existing browser sessions keep their current assets until refreshed.
No backend restart, database migration, trade/position mutation, or live order
test is required. Backend confirmation, concurrency and send semantics are unchanged.

Regression tests simulate pending/lost responses, duplicate-click prevention,
reopened accepted trades, dry runs, stream loss and stalls, report-read outages,
partial groups, uncertain outcomes, limit-order fills, and delayed navigation.
Validation passed: frontend type check/production build, all 63 UI tests, and
8 architecture rules. No real exchange orders were used.
