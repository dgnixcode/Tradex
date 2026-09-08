# 17 - Architecture and stack

Status: 2026-09-03 | track: platform | scope: the stores, services, hosting and boundaries - chosen for a very small team building a real-money system with no exchange sandbox to hide behind.

## Verdict

- **Postgres for everything that is money. Not MongoDB.** The ledger needs exact decimal arithmetic, multi-row transactions, foreign keys, check constraints and unique indexes that are enforced by the database rather than hoped for in application code. `numeric` gives exactness; `UNIQUE (account_id, exchange_trade_id, kind)` is what makes fill ingestion idempotent (`11` F3); `FOR UPDATE SKIP LOCKED` is the job queue (`08` F10). Mongo can hold non-money documents - notification templates, UI preferences, cached market metadata - but no ledger row, no order row, no credential.
- **TypeScript across the whole stack. No Go service in v1.** The performance requirement is a 20-account fan-out in a couple of seconds against a 38 ms round trip - nothing here is CPU-bound. A second language would cost the team a duplicated money type, a duplicated exchange adapter and a duplicated test harness, in exchange for latency we do not need.
- **A modular monolith with separate worker processes, one deployable, several process types.** Web API, execution worker, reconciler, market-data ingester and scheduler share one codebase and one database, and run as distinct processes so a stuck fan-out cannot block an HTTP request and a deploy can drain workers independently. Microservices would add network boundaries exactly where we most want a transaction.
- **The signer is the one genuine process boundary, and it arrives with the first real-money phase.** Only the signer holds KMS decrypt permission; it returns signed bytes and never plaintext (`07` F5). Build the port immediately, split the process before real money.
- **Host in Mumbai. The latency is measured, not assumed.** From an Indian connection, `api.coindcx.com` answers in **~38 ms on a warm keep-alive connection** and ~105 ms cold (DNS 5-9 ms, TCP connect ~28 ms, TLS complete ~64 ms, TTFB ~104 ms). Connection reuse is therefore worth ~65 ms per call - which over a 20-account fan-out is more than a second. An agent pool with keep-alive is not an optimisation, it is the design.
- **A static egress IP is worth having, but *not* for an exchange allowlist.** CoinDCX's IP binding attaches to the key-generating device's IP and is unusable for us (`07` F1). The reasons to pin egress anyway: the rate limit may be per-IP (`08` F1), the enterprise HFT programme requires a registered static IP, and predictable egress is needed to reason about either. Do not build onboarding around an allowlist we cannot use.
- **Redis is a cache and a rate-limit bucket. Nothing authoritative ever lives only in Redis.** Token buckets, market metadata, candle slices, session lookups - all reconstructible. Order state, ledger entries, job state and credentials are Postgres, always.
- **The exchange adapter boundary exists from day one, for a legal reason rather than an architectural one.** CoinDCX may terminate access without notice or reason (`15` F1 clause 5.2). One `ExchangeAdapter` interface, one CoinDCX implementation, no CoinDCX types above it.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Money store | **PostgreSQL 16+** | Exact `numeric`, real constraints, transactions across ledger + order + job, `SKIP LOCKED` queue | MongoDB - no cross-document constraints, decimal handling that invites float bugs, and the ledger invariants (`11` L1-L11) would become application-only |
| Document store | Optional Mongo or Postgres `jsonb` for non-money documents | Avoid a second database until something needs it | Mongo as primary |
| Language | TypeScript end to end, Node 24 | Team familiarity; no CPU-bound path; one money type, one adapter, one harness | A Go execution service |
| Shape | Modular monolith, multiple process types, one deployable | Transactions where we need them; independent scaling and draining where we need that | Microservices; a single process doing everything |
| Job queue | Postgres table + `FOR UPDATE SKIP LOCKED` (`08` F10) | Inspectable with SQL during an incident; shares transactions with order rows | Temporal, BullMQ/Redis, in-process |
| Cache / buckets | Redis, strictly non-authoritative | Rate-limit buckets and hot reads | Redis as a store of record |
| Credential signing | Separate process from the first real-money phase; port from day one | Turns "app compromised" into a smaller, more detectable loss (`07`) | In-process forever |
| HTTP client | One pooled agent per exchange host, keep-alive on, HTTP/1.1 | Measured 38 ms warm versus 105 ms cold | A fresh connection per request |
| Hosting region | **Mumbai (`ap-south-1`)** | Measured latency, and Indian data residency for DPDP (`15` F7) | Singapore or a US region |
| Egress | Pinned static egress (NAT gateway or equivalent) | Per-IP rate limits and the HFT route (`07`, `08` F1) - **not** for a key allowlist | Dynamic egress |
| Secrets | Managed KMS for the root key; environment config for non-secrets | `07` F3 | Self-hosted Vault; secrets in env |
| Multi-tenancy | `tenant_id` on every row, enforced in one data-access layer with mandatory scoping | A single choke point is auditable; scattered `where` clauses are not | Postgres RLS as the only control, or per-tenant databases |
| Migrations | Plain forward-only SQL files, checked in, run on deploy | Auditable and boring | An ORM's implicit sync |
| ORM | Query builder or raw SQL with typed results; no full ORM for money paths | Money queries must be readable in review and in an incident | A full ORM with lazy loading |
| **HTTP framework** | **Fastify 5.12.3** (MIT, 15 deps) - *closed 2026-09-05, D52* | Schema validation and serialisation built in; **pino is its native logger**, and our redaction serialiser is a correctness requirement rather than a nicety | Express 5.2.1 (MIT, 28 deps) - fine and more familiar, but the logger integration is the deciding factor |
| **Query layer** | **Kysely 0.29.5** (MIT, **0 deps**) - *closed 2026-09-05, D53* | Fully typed against our schema, compiles to SQL legible in a code review, and has a raw escape hatch for `FOR UPDATE SKIP LOCKED` | Prisma / TypeORM (a full ORM over money paths), raw `pg` only (no type safety over ~20 money columns) |
| **Driver** | **pg 8.23.0** | Returns `numeric`, `decimal` and `int8` as **strings** by default - exactly what we want. See the trap in `DATA-MODEL.md` | Any driver that coerces `numeric` to `number` |
| **Logging** | **pino 10.3.1** | The serialiser hook is where never-log enforcement lives (`07` F6) | winston, console |
| **Validation** | **zod 4.5.4** (0 deps) | Request schemas and exchange-response schemas; an unknown status must be caught, not thrown on | ajv directly, hand-rolled guards |
| **Money library** | **decimal.js 10.6.0** (0 deps) behind our own `Money`/`Qty` wrapper | Exact arithmetic; the wrapper forbids construction from a `number`, CI-enforced | big.js (narrower), native BigInt only (awkward for market-scoped scales) |
| **Tests** | **Vitest 5.0.0** + **fast-check 4.9.0** | fast-check runs the ~200,000-case sizing suite over all 999 markets | Jest, hand-written cases only |
| **Frontend** | **React 19.2.8**, **Vite 8.2.2**, **TanStack Query 5.102.8**, React Router | No SSR need behind a login; polling and invalidation *is* the data pattern | Next.js, Svelte |
| **TypeScript** | **7.0.2**, strict | - | - |
| Browser live updates | One SSE stream per authenticated user from our server | Never per-account, never to CoinDCX (`13` V4) | Browser sockets to the exchange |
| Frontend | React + TypeScript + Vite (`21`) | Matches the team; no SSR need behind a login | Next.js |
| CI | Typecheck, lint, unit, property and check-script suites on every push; no deploy without green | `18` | Manual verification |
| Environments | `local`, `staging` (fake exchange), `production` (real keys, hard caps) | There is **no CoinDCX sandbox** (`18` F1) | A "test" environment pointed at real money |

## Findings

### F1 - Measured latency, and what it implies

From an Indian residential connection to `api.coindcx.com`, five samples plus a keep-alive reuse test, 2026-09-04. VERIFIED.

| Phase | Cold | Warm (reused connection) |
|---|---|---|
| DNS | 4.5 - 8.6 ms | 0 |
| TCP connect | 28 - 32 ms | 0 |
| TLS complete | 62 - 75 ms | 0 |
| **TTFB** | **102 - 113 ms** | **37.6 ms** |

So the network floor per authenticated call is roughly **38 ms warm**, and a cold connection costs an extra **~65 ms**. Consequences:

| Consequence | Detail |
|---|---|
| Connection pooling is mandatory | 20 accounts × 65 ms of avoidable handshake is 1.3 s of pure waste |
| One pool per exchange host, shared across tenants | Connections are per-host, not per-key; the key travels in a header |
| A 20-account fan-out at 8-way parallelism | ≈ 3 batches × ~40 ms ≈ **120 ms** of exchange time, plus signing and gates |
| The latency budget is dominated by *our* work, not the network | Which is good news: it is the part we control and can measure |
| Hosting outside India would add tens of ms per call | Mumbai is the right region on latency as well as residency |

These are measurements from one residential connection, not from a datacentre - a Mumbai-hosted server should do better. Re-measure from the chosen host before signing off `22`'s budget.

### F2 - Why Postgres, concretely

Not a preference. Five specific invariants from other documents that Postgres enforces and a document store cannot:

| Invariant | Mechanism |
|---|---|
| Fill ingestion is idempotent (`11` L4) | `UNIQUE (account_id, exchange_trade_id, kind)` |
| One live credential per account, one CoinDCX key per tenant (`07` F4) | `UNIQUE (account_id)`, `UNIQUE (tenant_id, fingerprint)` |
| An order row and its job are written atomically (`08` F4) | One transaction across two tables |
| Money is exact (`09`) | `numeric(38,0)` minor units; no binary floating point anywhere |
| A job is claimed by exactly one worker (`08` F10) | `FOR UPDATE SKIP LOCKED` |

Plus the ledger's replayability (`11` L1) depends on a stable, gapless ordering, which `bigserial` plus `occurred_at` provides cheaply.

Where Mongo is fine: cached `markets_details` snapshots, candle slices, notification templates, UI layout preferences, and the raw exchange response bodies we keep for forensics. None of those has an invariant worth enforcing. If the team would rather not run two databases, `jsonb` covers all of it.

### F3 - Service decomposition

**Rescoped 2026-09-05:** five process types, not six. The `market-data` process existed to serve candles and depth to browsers; with charting deferred (`ARCHITECTURE` §6a) the only remaining order-book read happens inline in the planning path (`plan/phase-04` T04.10), so there is nothing for a separate process to own. It returns if charting does.

| Process | Responsibility | Must not |
|---|---|---|
| `api` | HTTP API (Fastify), auth, previews, reads, SSE fan-out to browsers | Place orders directly, hold plaintext credentials, call KMS |
| `execution-worker` | Claim `place`/`cancel` jobs, gate, sign, send, record (`08`) | Size orders (that is a pure function it calls), or poll |
| `reconciler` | Loops A-D (`12` F4), balance reconciliation (`11` F6), ledger ingestion | Place or cancel anything |
| `signer` | Decrypt a credential, HMAC a body, return headers (`07` F5) | Return plaintext, log anything sensitive, call the exchange |
| `scheduler` | Enqueue periodic work, run the lock reaper (`08` F10) | Do the work itself |
| ~~`market-data`~~ | **Deferred with charting.** Order-book reads are inline in planning | - |

Rules that keep this honest: the `web` process has **no** KMS permission; only `signer` does. Only `execution-worker` may write `child_order` state transitions arising from placement. Only `reconciler` may write transitions arising from observation. That split means a bug in one cannot fabricate the other's transitions, and the audit log shows which process caused every change.

### F4 - Repo layout

```
tradex/
  apps/
    web/                 # React + Vite frontend
    api/                 # HTTP API process
    worker/              # execution-worker, reconciler, market-data, scheduler entrypoints
    signer/              # the only process with KMS decrypt
  packages/
    money/               # Decimal, minor units, currency, formatting rules (09, 21 F6)
    sizing/              # pure sizing + legalisation (09 F5) - no I/O
    exchange/            # ExchangeAdapter interface
    exchange-coindcx/    # the only place CoinDCX types exist
    ledger/              # ledger fold, holdings projection, P&L (11)
    db/                  # migrations, typed queries, tenant-scoping layer
    contracts/           # shared types between api and web
  checks/                # standalone runnable check scripts with assertion counts (18)
  research/              # this directory
  plan/                  # the phase plan
```

Two boundaries are load-bearing. `packages/money` and `packages/sizing` are **pure** - no database, no network, no clock - which is what makes them exhaustively property-testable against all 999 live markets (`18`). And `exchange-coindcx` is the only package permitted to import CoinDCX-shaped types; a CI rule enforcing that is what makes clause 5.2 survivable (`15`).

### F5 - Multi-tenancy

| Layer | Control |
|---|---|
| Schema | `tenant_id` on every tenant-scoped table, `NOT NULL`, foreign-keyed |
| Data access | One layer that requires a tenant context; a query without one throws at construction, not at runtime |
| Composite lookups | Always `(tenant_id, id)`, never `id` alone - a leaked or guessed id must not be enough |
| Defence in depth | Postgres row-level security as a second net, once the query layer is stable |
| Audit | Every write records `tenant_id`, actor and process |
| Tests | A cross-tenant access test per resource type; a fixture with two tenants and an assertion that neither can see the other |

The escalation trap worth naming: a query that filters by `child_order.id` and joins upward to fetch the tenant is *checking after the fact*. The tenant must be in the `where` clause of the primary lookup. That is exactly the class of bug that a single enforced data-access layer prevents and scattered queries do not.

### F6 - Observability

| Concern | Choice |
|---|---|
| Logs | Structured JSON, one line per event, with `tenant_id`, `account_id`, `group_trade_id`, `child_order_id`, `process` - and a **mandatory redaction serialiser** (`07` F6) |
| Metrics | Order outcomes by class, gate refusals by reason, exchange latency histogram per endpoint, rate-limit bucket depth, reconciler lag, decrypt count, job queue depth and age |
| Traces | One trace per group trade, spanning gates, signer, exchange call and state transition |
| Alerts | `20-ops-audit-runbook.md` owns thresholds and routing |
| Audit | A separate append-only store, not the log pipeline (`20`) |

The two metrics most likely to be omitted and most valuable in an incident: **job queue age** (the earliest sign a fan-out is stalling) and **decrypt count per credential per minute** (the earliest sign of key abuse, per `16` F2).

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Money stored as a float somewhere | Property tests; a CI grep banning `number` in money types | `packages/money` as the only representation | Silent, cumulative, expensive |
| A CoinDCX type leaks above the adapter | CI import rule | `exchange-coindcx` boundary | A second exchange, or clause 5.2, becomes a rewrite |
| `web` process gains KMS permission "temporarily" | IAM review; a test asserting `web` cannot decrypt | Separate signer role from the start | Undoes the entire `07` benefit |
| Cross-tenant read via a direct id lookup | Cross-tenant tests per resource | Enforced tenant scoping (F5) | Catastrophic and unrecoverable reputationally |
| Cold connections on every call | Latency histogram shows ~105 ms rather than ~38 ms | Pooled keep-alive agents (F1) | 1.3 s added to a 20-account fan-out |
| Redis treated as authoritative | State loss on a Redis restart | Nothing authoritative in Redis | Depends what was in it - potentially order state |
| Worker and web share a process | One stuck fan-out blocks HTTP | Separate process types (F3) | Whole-platform unresponsiveness |
| Migrations run implicitly by an ORM | Schema drift between environments | Forward-only checked-in SQL | Unpredictable production schema |
| Reconciler writes placement transitions | Two writers for one state machine, races | Ownership split (F3) | Corrupt order state |
| Hosting outside India | Latency and DPDP residency questions | Mumbai (F1) | Tens of ms per call, plus a compliance argument |

## Open questions for Anand

1. **Which cloud?** AWS `ap-south-1` (Mumbai) is the default assumption here, for KMS, a managed Postgres, a pinned NAT egress IP and measured latency. GCP `asia-south1` is equivalent. Recommended default: **AWS Mumbai**, chosen mainly because KMS and pinned egress are the two things we actually depend on.
2. **One database or two?** Postgres alone with `jsonb` for documents is simpler to run; adding Mongo is familiar from the owner's other project. Recommended default: **Postgres only for v1.** One store to back up, one restore drill, one connection story.
3. **Managed Postgres or self-hosted?** Recommended default: **managed** (RDS/Cloud SQL), with PITR enabled. The restore drill in `07` F8 is only credible if the backup mechanism is not also our own code.
4. **Do we pin egress now or later?** It costs a NAT gateway. Recommended default: **now** - the per-IP rate-limit experiment (`08` F1) is meaningless from a shifting egress address, and that experiment gates capacity planning.

## Phase hints

- **Phase 00 owns `packages/money`, `packages/db` with the tenant-scoping layer, the migration runner, the redaction serialiser and the CI rules** (no floats in money, no CoinDCX types above the adapter, no `.expose()` outside the signer). All of it is pure or infrastructural, none depends on the exchange.
- **`packages/sizing` is Phase 01** and stays pure. Its property tests against all 999 markets are the highest-value tests in the plan (`18`).
- **The `signer` port ships with the first authenticated call; the process split ships before the first real-money order.**
- **The process-type split (F3) happens at the same time as the execution worker**, not later - retrofitting the ownership rules means re-auditing every state transition.
- **Pinned egress and the region choice are Phase 00 infrastructure**, because the `08` F1 experiment depends on both.
- **Cross-tenant tests are written in Phase 00** alongside the tenant-scoping layer, when there is exactly one resource type to cover, rather than fifteen.

## Sources

- Live measurement, 2026-09-04, Indian residential connection to `https://api.coindcx.com/exchange/v1/markets`: cold DNS 4.5-8.6 ms, TCP connect 28-32 ms, TLS complete 62-75 ms, TTFB 102-113 ms; **warm keep-alive TTFB 37.6 ms**.
- Local environment: Node v24.15.0, npm 11.12.1, Windows 11, git-bash; no Docker, no Python.
- `07-api-key-security.md` - KMS envelope design, the signer boundary, why the exchange IP allowlist is unusable, the restore-drill requirement.
- `08-fanout-execution-engine.md` - the Postgres job table and `SKIP LOCKED` scheduler, the per-IP rate-limit experiment, process ownership of placement.
- `09-sizing-allocation-rounding.md` - the pure sizing function and exact-decimal requirement.
- `11-positions-ledger-pnl.md` / `12-order-state-reconciliation.md` - the ledger invariants and reconciler loops that dictate the store choice and the ownership split.
- `13-charting-live-market-data.md` - the market-data process and the rule that browsers never reach CoinDCX.
- `15-india-regulatory-compliance.md` - clause 5.2 (termination without notice) behind the adapter boundary; DPDP residency behind the Mumbai choice; the 5-year retention floor.
- `18-testing-correctness-program.md` - the absence of a CoinDCX sandbox, which is why `staging` points at a fake exchange.
- `22-nonfunctional-slos-capacity.md` - consumes F1's measurements for the latency budget.
