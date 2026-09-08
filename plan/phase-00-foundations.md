# Phase 00 - Foundations

Status: T00.1-T00.9 DONE 2026-09-06; **T00.10 (AWS) deferred to after all phases by Anand** | goal: every correctness and security foundation in place **before** a single exchange call exists | depends on: nothing | implements: `07`, `17`, `19`, `18`, `15`, `22`

## Scope

**In:** monorepo and CI; the exact-money package; the tenant-scoped data layer and migration runner; tenancy, users, roles, limits and the partitioned audit table; the KMS CMK and envelope-encryption helpers; the `Secret` type and the four never-log mechanisms; cross-tenant tests; Mumbai infrastructure with pinned egress.

**Explicitly out:** any HTTP call to CoinDCX; any credential actually stored; the signer as a separate process (the *port* only); sizing; orders; the frontend beyond a build that compiles.

## Preconditions

| Precondition | How to check |
|---|---|
| AWS account with `ap-south-1` access | `aws sts get-caller-identity` |
| Node 24 and npm 11 | `node -v` → v24.x, `npm -v` → 11.x |
| A decision on cloud provider (Q-`17`.1) | Recorded in `DECISIONS.md` |

## Tasks

**T00.1 - Monorepo and CI**
Create the layout from `17` F4: `apps/{web,api,worker,signer}`, `packages/{money,sizing,exchange,exchange-coindcx,ledger,db,contracts}`, `checks/`. TypeScript strict, ESLint, Vitest.
*Acceptance:* `npm run typecheck && npm run lint` passes on an empty scaffold; CI runs on push and blocks merge on failure.

**T00.2 - CI correctness rules**
Three grep-based CI rules that fail the build: (a) `number` used in any type under `packages/money` or `packages/sizing`; (b) any import of `exchange-coindcx` outside itself and `apps/worker`'s adapter wiring; (c) `.expose()` called outside `apps/signer`.
*Acceptance:* each rule has a deliberately-violating fixture in a test that asserts the rule fires.

**T00.3 - `packages/money`**
`Money` (minor units + currency + scale) and `Qty` (exact decimal, market-scoped precision). `decimal.js` internally, string in and out. Indian digit grouping, lakh/crore shorthand, crypto precision from market metadata, and a hard ban on exponent notation (`21` F6).
*Acceptance:* `₹12,34,567` and `₹42.19 L` render correctly; `0.00000007` renders without exponent; `112 DOGE` renders with no decimal point at precision 0.

**T00.4 - `packages/db`: the tenant-scoping layer**
A query interface that **requires** a tenant context and throws at construction without one. All lookups composite `(tenant_id, id)`. Forward-only SQL migration runner.
*Acceptance:* a query built without a tenant context throws; a test proves tenant A cannot read tenant B's row through the layer.

**T00.5 - Migrations 001 and 008**
`tenant`, `app_user`, `tenant_limit`, `audit_event` (monthly partitions) per `DATA-MODEL` domains 1 and 7, plus the partition-maintenance function that pre-creates the next three months.
*Acceptance:* migrate up on an empty database; `audit_event` has partitions for the current and next three months; the application role has `INSERT` only on `audit_event`.
*Result (2026-09-06):* **done.** Anand supplied the `postgres` password; role `tradex` and database `tradex_dev` created, migrations 001/002/003 applied to PostgreSQL 18.6. `audit_event` is `PARTITION BY RANGE (occurred_at)` with `audit_event_2026_09` through `2026_12` plus `audit_event_overflow` as DEFAULT. `checks/01-db-live` **47 assertions, green**. `npm run checks` now loads `.env`, so a developer with a database exercises it in `verify` and one without still passes.
*Three defects surfaced by actually running it, each fixed:*
1. **`ensure_audit_partition` tested `pg_class` without a schema qualifier** — `SELECT 1 FROM pg_class WHERE relname = part` matches that name in ANY schema, so the function reported "already exists" and created nothing. Proved directly: in a second schema with `public.audit_event_2026_09` present, it said `audit_event_2026_09 already exists` and created **0** of 4 partitions. The version that costs money is the other one — this function is what the monthly scheduler calls, so **detaching an old partition into an `archive` schema leaves its name in `pg_class` forever** and every audit write for that month then lands in the DEFAULT partition, which 002's own comment calls an alarm rather than a home. Migrations are immutable here, so `003_fix_audit_partition_scope.sql` replaces the function (resolve the parent via `search_path`, create in the parent's schema, qualify the existence test) and backfills the window 002 skipped. **The Phase 01 schema delta moves to migration 004.**
2. **The migration runner reported `PENDING` for files it had just applied successfully** — the status array was built before the apply loop and never updated. Cosmetic, but it reads as a failed run.
3. **`00-tenant-isolation` scanned migration COMMENTS for forbidden column types.** `/real/` fired on the English words "a real run" in 003's comment. It was testing prose, not schema; now it strips SQL comments first, and asserts the stripper works — including that a commented `real` survives in the raw text, so the stripper stays load-bearing rather than becoming dead code.

**T00.6 - KMS CMK and envelope helpers**
CMK in `ap-south-1` with deletion protection and a multi-region replica. `wrapDek`, `unwrapDek`, `sealSecret(plaintext, aad)`, `openSecret(ct, nonce, tag, aad)` using AES-256-GCM with AAD = `tenant|account|credential|version`.
*Acceptance:* round-trip works; opening with a mismatched AAD **fails**; a test proves a ciphertext row moved to another `account_id` cannot be opened. **Also record the measured KMS decrypt latency** - it is the largest assumed number in `22` F2.

**T00.7 - The `Secret` type and never-log enforcement**
`Secret<T>` whose `toString`, `toJSON` and `util.inspect.custom` all return `[redacted]`, with a single `expose()`. A logger serialiser that masks fields named `secret`, `api_secret`, `signature`, `authorization`, `x-auth-*` and any high-entropy hex of secret length. The same serialiser is used by the audit writer.
*Acceptance:* interpolating, `JSON.stringify`-ing and `console.log`-ing a `Secret` all yield `[redacted]`; a log line containing a masked field name shows the mask.

**T00.8 - The secret canary check**
A sentinel value flows through logger, error serialisation, an HTTP error response and an audit write. Assert it appears **nowhere**. This is the first test in the project (`07` F6, `16` L1).
*Acceptance:* `checks/00-secret-canary.check.js` passes and fails when the serialiser is deliberately disabled.

**T00.9 - Auth, roles and 2FA**
Email/password with a modern KDF; TOTP for our own 2FA (never the exchange's); the `owner`/`trader`/`viewer` matrix from `19` F4 enforced **server-side**; re-auth required for credential and cap changes; pausing requires no re-auth.
*Acceptance:* a role test per endpoint; `viewer` receives 403 on every write; `trader` can pause but not resume.

**T00.10 - Infrastructure**
Mumbai VPC, managed Postgres with PITR, Redis, **pinned NAT egress IP**, IAM roles where only the future signer role has KMS decrypt. Infrastructure as code.
*Acceptance:* the egress IP is stable across two deploys and recorded; an IAM assertion test proves the `api` role cannot call `kms:Decrypt`.

## Schema delta

Migrations 001, 003 (empty shells for `market_metadata` and `fx_snapshot`), 008. Tables: `tenant`, `app_user`, `tenant_limit`, `audit_event`.

## Interfaces

| Interface | Shape |
|---|---|
| `CredentialSigner` (port only) | `sign(credentialId, exactBody): Promise<{headers, body}>` - **never returns plaintext** |
| `Db.forTenant(tenantId)` | The only way to obtain a query builder |
| `audit(event)` | Append-only; payloads pass the redaction serialiser |

## Verification

`checks/00-money-and-precision.check.js` (~120 assertions), `checks/00-tenant-isolation.check.js` (~30), `checks/00-secret-canary.check.js` (~15), `checks/00-envelope-aad.check.js` (~20). Target: **~185 assertions**.

## Definition of done

- [ ] `npm run typecheck`, `lint` and all four check scripts pass in CI
- [ ] The three CI correctness rules each fire on their violating fixture
- [ ] A `Secret` cannot be printed, serialised or inspected in plaintext
- [ ] The canary sentinel appears in zero logs, zero error bodies, zero audit rows
- [ ] AAD mismatch causes decryption to fail
- [ ] `audit_event` is partitioned with three months pre-created and `INSERT`-only grants
- [ ] A query without a tenant context throws
- [ ] The `api` IAM role cannot call `kms:Decrypt`
- [ ] The static egress IP is recorded in the repo
- [ ] Measured KMS decrypt latency is recorded

## Phase risks

| Risk | Addressed by |
|---|---|
| R11 secret in a log | T00.7, T00.8 - four independent mechanisms |
| R15 cross-tenant leak | T00.4, cross-tenant tests while there is one resource type |
| R18 restore without KMS | T00.6 CMK protection and replica; the drill itself is Phase 13 |
| R22 audit growth | T00.5 partitioning from the first migration |
| R01 key exfiltration | T00.6 envelope design with AAD binding |

## Notes for the next phase

The signer is a **port with an in-process implementation**. Phase 06 splits it into its own process; no order path should ever be written against a direct decrypt. `market_metadata` and `fx_snapshot` exist as empty shells so Phase 01 adds rows rather than tables.
