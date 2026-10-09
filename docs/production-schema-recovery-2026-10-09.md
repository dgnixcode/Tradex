# Buy preview and AI settings recovery

The production API was at `f8a0db2`, but the database stopped at migration 034.
Logs confirmed missing `child_order.position_mutation_request_id` during buy
preview and missing `research_ai_settings` during AI settings load. Forward
migrations 035–039 restore the schema expected by that API; none were edited.

Read-only verification also found historical fractional leverage (1.6×) crashing
`dailySpentMinor` at `BigInt(leverage)`. The calculation now divides by the exact
decimal ratio and rounds required margin upward, including 18 decimal places.
Notional caps and direct-action receipt accounting retain their existing behavior.

Missing database columns/tables now return an actionable 503 rather than an opaque
500. AI settings distinguish loading/failure from unconfigured credentials and
provide a retry. Queries wait for authentication; provider keys remain write-only.

After building, run `npm run db:check` and `npm run deploy:check` before activating
new code. Both checks are read-only. The latter also refuses unresolved executing
group trades; resolve their actual venue outcome before treating them as complete.
Do not delete receipts, resubmit pending historical trades, or reset their status
to make a deployment guard pass.

Recovery used a restricted server-side PostgreSQL backup and bounded database
locks (2 seconds; statements 30 seconds). No production orders or position actions
were used for validation. Historical executing records were preserved. Restart
requires an authorized maintenance window and draining actual in-flight requests.
Check queues, strategies and trailing workers separately from historical statuses.

AI credential saving additionally requires a stable, dedicated
`TRADEX_RESEARCH_ROOT_KEY`. Preserve existing encryption roots. Generate a new
research root only when no prior research key exists and no encrypted research
configuration needs that key. Keep it in restricted server configuration and
include it in secure disaster-recovery backups; never commit it to Git.

Validation: 626 backend unit tests, 50 frontend tests, type checks, frontend build,
8 architecture rules, and the 24-assertion disposable PostgreSQL/API recovery check.
That check covers the pre-035 schema failure, immutable migrations, deployment
checks, AI credential privacy, individual/group market/limit previews with dry-run
confirmation, and fractional historical leverage. Live validation is restricted
to database reads and service availability; it does not prove a real exchange fill.
