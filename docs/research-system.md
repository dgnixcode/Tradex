# Tradex research system

Full TradingAgents research is available at `/app/research`. AI provider settings
are at `/app/settings?tab=ai`. It is independent of the trade execution
engine. Python research subprocesses receive instrument identifiers and provider credentials;
they never receive exchange keys, database credentials, holdings, or trade ports.

## What is implemented

- Authenticated research API, shared TypeScript contracts, a React research desk,
  saved report history, cancellation, JSON/Markdown export, and evidence inspection.
- PostgreSQL queue with atomic claims, worker discovery, lease fencing, hard process
  timeouts, terminal crash recovery, and a database-enforced running-job limit per tenant.
- Idempotent submissions, a rolling 24-hour workspace quota, pending-job quotas,
  and audit events. Owners/traders may create/cancel; viewers may read.
- Supporting evidence collectors: Yahoo daily prices, RSI/SMA calculations,
  CoinGecko identity, supply, market cap, fully diluted valuation and reported volume,
  and DefiLlama TVL for chains matching the exact CoinGecko asset identity.
- A TradingAgents adapter pinned to commit
  `1394a3f72aa4393e1a98f51b382434c4b4c2d972`. It adds analyst reports, bull/bear debate,
  risk review and a research conclusion. Crypto excludes the company-financials analyst.
  All applicable analysts, thesis/scenarios, both debates and the final conclusion
  must complete before a report is published. Snapshot report submissions are rejected;
  existing snapshot reports are excluded from the desk's history.
- Dedicated write-only AI settings for OpenAI, Anthropic and Google Gemini. Workspace
  owners save provider keys and two model IDs. Keys use AES-256-GCM encryption with
  tenant/provider/configuration identity authentication and a separate research root.
  GET/PUT/DELETE responses return metadata only, with `Cache-Control: no-store`.
- A **Test models** button checks both selected models through the pinned
  TradingAgents provider clients. It accepts a transient pasted key or decrypts
  only the same-provider saved key for the current workspace. The owner-only POST
  `/api/settings/research-ai/test` returns fixed per-role outcomes, never provider
  responses, generated text, exceptions or credentials, and uses `Cache-Control: no-store`.
- Retrieved evidence is stored as canonical JSON with provider URLs, observation and
  retrieval timestamps, and a SHA-256 hash. The worker validates hashes, instrument
  identity, source references and report shape before publishing.

## Local startup

Use Node 24+, Python 3.11+, and PostgreSQL. The existing application setup and login
remain the same. Review pending migrations before applying them and rebuild:

```powershell
npm run typecheck
npm run db:status
npm run db:migrate
npm run -w @tradex/web build
```

`db:migrate` applies every pending migration, including changes outside research.
Roll these out with the matching API version; migrations `037_research_jobs.sql`
and `038_research_ai_settings.sql` add research jobs and encrypted AI settings.
Coordinate the API restart with existing trading services.

Set `TRADEX_RESEARCH_ENABLED=1` in the API's environment. Set a securely generated,
persistent `TRADEX_RESEARCH_ROOT_KEY` (32 bytes encoded as 64 hex characters) on the
API and worker. Keep the root in a secret manager for deployment; it must be different
from the exchange credential root and must survive process restarts. There is no
ephemeral fallback. A managed KMS adapter and root-rotation tooling are future work.

Install the pinned framework in a dedicated environment:

```powershell
python -m venv .research-venv
.research-venv/Scripts/python.exe -m pip install -r apps/research-engine/requirements-lock.txt
```

Configure the worker interpreter:

```text
TRADEX_RESEARCH_PYTHON=C:/absolute/path/to/Tradex/.research-venv/Scripts/python.exe
```

Start the usual API and a separate worker:

```powershell
npm run api
# In a second terminal:
npm run research:worker
```

Owners choose the provider, paste its key and enter provider-supported deep reasoning
and analyst model IDs in **Settings → AI Research**. Saved keys are never prefilled,
revealed, exported, logged or returned by the settings API. The password field is
cleared when submitted, including on a failed save; secrets do not enter frontend
query/mutation caches or local/session storage. For the same provider, leaving the
key field empty retains the encrypted key. Provider changes require a replacement.
The existing owner/settings permission applies; enrolled 2FA users supply a fresh code.

Choose **Test models** before running research. Each distinct model gets one short
request with a placeholder tool schema that cannot execute, a 256-token output cap,
a 15-second request timeout and no SDK retries. Selecting one model for both roles
makes one request. The isolated subprocess has a 45-second deadline and a 4 KB output
limit; interpreter resolution can take up to 10 additional seconds. Errors distinguish
authentication, model access/compatibility, quota, rate limits, connectivity, timeout,
and an inconclusive response that reaches the small token budget. Google error wrappers
are classified from their structured underlying SDK error. A passed check confirms
connection, model access and tool-schema acceptance, not research quality or data coverage.
OpenAI's client uses the Responses API; its output cap includes reasoning tokens:
<https://developers.openai.com/api/reference/resources/responses/methods/create>.

Tests never save settings, rotate configurations, create research jobs or cancel work.
Pasted keys and authenticator codes are cleared on submission; a transient tested key
must be pasted again to save it. Test outcomes stay only in component state and are
cleared when fields or settings change. The UI explains possible provider charges.
The database atomically reserves one test per workspace per minute and at most 10 per
rolling hour, shared across API replicas. Failed tests count toward these limits.
Audit reservations contain only provider/model metadata. Each API process also caps
active tests at four. These workload limits are not a guaranteed dollar ceiling.
Configure the same `TRADEX_RESEARCH_PYTHON` on the API and worker for the pinned clients.

The worker checks the pinned package without requiring a global provider key. It
loads and decrypts the matching tenant configuration only when a job is claimed.
Global provider keys are removed from the job environment; only the selected tenant
provider key is passed to Python. Neither the root key nor ciphertext reaches Python.
Replacing/removing settings cancels unfinished jobs and fences their completion.
Each accepted job references its configuration revision, so queued work cannot silently
switch provider/models. The API offers advanced research only when a worker heartbeat
is fresh (60 seconds) and the current workspace has configured AI settings.

`requirements-lock.txt` records the tested dependency set; `requirements-tradingagents.txt`
is the upstream revision pin used to regenerate it during reviewed upgrades. Run the
adapter tests with `.research-venv/Scripts/python.exe -m unittest discover
-s apps/research-engine/tests -v`; they stub graph output and make no paid calls.

`COINGECKO_DEMO_API_KEY` is optional. Provider downtime and rate limits are surfaced as
missing evidence or a failed job; values are never fabricated. Shared coin symbols
require an explicit CoinGecko ID instead of silently choosing the most popular token.

## Scaling and operational behaviour

Each worker handles one job at a time. Add replicas to increase throughput across
tenants. PostgreSQL `FOR UPDATE SKIP LOCKED` claims and a unique partial index prevent
two running jobs for the same tenant. Keep the API and workers on the same migration
and contract version. No API request waits for an analysis to complete.

Defaults are 10 submissions per workspace per rolling 24 hours and 3 pending jobs.
Set `TRADEX_RESEARCH_DAILY_LIMIT` and `TRADEX_RESEARCH_PENDING_LIMIT` on every API replica
to change them consistently. Cancellations and failures count toward the daily quota;
otherwise repeatedly cancelling could bypass provider-spend controls. An idempotent
replay returns the original job even if workers are offline.

The default job timeout is 900 seconds. `TRADEX_RESEARCH_TIMEOUT_MS` accepts 30–900
seconds. Workers heartbeat every 5 seconds and renew 45-second leases. Cancelling
fences completion immediately and the worker stops the subprocess on its next
heartbeat. A lost database heartbeat stops active work. A worker that crashes is
marked failed after its lease expires; **paid jobs are never automatically replayed**.
Queued jobs expire after 24 hours. Worker restart preserves stored jobs and reports.

Deep runs use two rounds each of investment and risk debate, up to eight tool rounds
per analyst, 80 model calls, 800,000 aggregate prompt characters and 6,000 output tokens
per model call. Runs cap tool rounds, debate rounds, model calls, aggregate prompt size, output
tokens and elapsed time, and disable automatic SDK retries. These are workload caps,
not a guaranteed dollar ceiling. Provider-reported token usage is saved; a money
budget requires a maintained price catalog and billing reconciliation before adding
such a claim to the UI.

Each deep run uses temporary memory/cache/report directories. Customer research
cannot read another customer's decision memory, and previous model opinions do not
silently influence later reports. Persisted learning is intentionally not enabled.
If added later, it needs tenant scope, retention policy, as-of filtering and an
evaluation demonstrating that it improves research quality.

Before large-scale deployment, use provider plans with appropriate redistribution
rights and rate allowances. Public/demo feeds are a bootstrap source, not an SLA.
Prefer a dedicated worker database role limited to `research_job`, `research_worker`, `research_ai_settings`
and the tenant status read; the Python process itself receives no database access.
Add process supervision, metrics/alerts for queue age, failure rate and provider usage,
and a report-retention policy suitable for the chosen deployment.

## Research-quality boundaries and next extensions

The product distinguishes **sourced observations** from **AI interpretations**.
Schema/hash validation proves provenance and reference integrity; it does not prove
that a provider is accurate or that an AI conclusion follows from the evidence.
Upstream narrative citations are not independently verified and remain visibly
labelled as interpretation. No numerical probability or accuracy percentage is invented.

Current missing coverage is shown per report: token unlocks/concentration,
protocol-specific on-chain adoption/revenue, exchange derivatives/liquidity,
security/governance, independently retrieved filings/earnings calls and peer valuation.
Extend the collector layer with licensed sources and the same identity/timestamp/hash
contract. Feed new evidence into the analyst context before promoting it to coverage
that supports a research thesis. Avoid adding agents that have no new evidence.

Chain TVL is labelled as ecosystem activity, not token revenue or fair value. Sources
without provider observation timestamps explicitly use retrieval-time snapshots.

Historical analysis is rejected. Current snapshots and live news cannot support a
point-in-time backtest. A historical mode requires archived inputs available as of
each analysis date, as-of memory, and explicit corporate-action/benchmark handling.

Before claiming superior research, compare a simple evidence-grounded analysis and
TradingAgents on a held-out set of coins, Indian stocks and US stocks. Score factual
errors, citation validity, missing material risks, repeatability, usefulness, latency
and measured cost. Predictive returns are a separate evaluation, including fees,
slippage and data availability; report length or agent agreement is not proof.

Research never submits an order. Future trade handoffs must create an ordinary
Tradex preview using fresh venue data and require the existing confirmation path.

## Verification

```powershell
npm run verify
npm run research:test
npm run -w @tradex/web build
# Focused real-PostgreSQL lifecycle/auth/concurrency check:
node --env-file-if-exists=.env checks/run-all.mjs 20-research
```

The research database check fails clearly if `DATABASE_URL` is absent; it does not
silently report skipped concurrency tests as success. It uses a disposable schema
through the existing test harness. Unit tests cover identity confusion, missing/stale
evidence, snapshot hashes, unsafe links, source-reference validation, environment
isolation, excessive output, timeout and process cancellation.

## Third-party software

TradingAgents is an unchanged dependency licensed under Apache-2.0:
<https://github.com/TauricResearch/TradingAgents>. Keep its license and applicable
notices when distributing it. Tradex's adapter and report/UI contracts are separate
application code. Data-provider terms are separate from the framework license.
