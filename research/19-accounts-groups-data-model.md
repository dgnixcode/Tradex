# 19 - Accounts, groups and tenancy data model

Status: 2026-09-03 | track: platform | scope: the customer-facing domain - tenants, users, roles, exchange accounts, groups, and the invariants worth enforcing in the database rather than in application code.

## Verdict

- **The onboarding form the owner described is four fields, and one of them is an unverifiable assertion.** Account name, allocated/opening balance, API key, API secret. The balance is a *sizing parameter*, not a fact about the world (`11`), and the product must show the real balance beside it and make the customer reconcile the two before saving (`07` F9, `21` F5). Storing the typed figure without that step manufactures skipped trades weeks later.
- **Validate the credential with a live call before the row goes `active`.** `users/balances` is authenticated, read-only and free of side effects (`18` F1). It proves the key, the secret, the pairing and our own signing in one round trip, and it returns the balances we need for currency detection (`10`).
- **One CoinDCX key per Tradex account, enforced by a unique index on a fingerprint.** `HMAC(pepper, api_key)` gives uniqueness without storing anything reversible (`07` F4). Reusing one key across two accounts breaks per-key rate budgeting, breaks leak attribution, and makes revocation non-surgical.
- **Groups are many-to-many with an explicit membership row, and membership overrides are deferred.** A group is a saved selection of accounts, nothing more, in v1. Per-membership weights or caps would introduce a *second* sizing basis alongside the percentage rule, and one basis is already the subtlest part of the product (`09` F4).
- **Accounts are never hard-deleted while any history references them.** Disconnect means: crypto-shred the credential, mark the account `disconnected`, keep every order, fill and ledger row. Both CoinDCX clause 6.6 and PMLA require 5-year retention (`15`), and `14` needs disconnected accounts to remain in historical P&L.
- **Build the customer model KYC-capable now, even if KYC is not collected at launch.** Fields, verification states and an audit trail, so that FIU-IND registration (`15` F5) is a policy change rather than a migration under a takedown notice.
- **Two limits exist to bound blast radius, not to be stingy:** max accounts per tenant and max accounts per group. An unbounded group is an unbounded fan-out against an unmeasured rate limit.
- **Re-authentication gates the three dangerous actions**, not everything: adding or replacing a credential, raising a cap, and any group trade above the tenant's typed-confirmation threshold.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Tenancy unit | `tenant` - an organisation, even for a single user | Roles and multi-user access arrive without a migration | User as the tenancy unit |
| Roles at v1 | `owner`, `trader`, `viewer` | Three is enough to be useful; more is speculative | Full RBAC with custom permissions |
| Allocated capital | Stored per account, in minor units, with its currency; treated as a **sizing parameter** | It is what the owner specified for percentage sizing (`09` F4) | An opening ledger credit (unverifiable), or omitting it |
| Credential validation | Live `users/balances` call before `active` | Proves key, secret, pairing and signing | Store first, discover later |
| Key uniqueness | `UNIQUE (tenant_id, fingerprint)` | Surgical revocation, attributable leaks, meaningful per-key budgets | Allow reuse |
| Funding currency | **Derived** from observed balances, re-derived on every reconciliation | A typed field goes stale on the customer's next deposit | Ask the customer to declare it |
| Group membership | Explicit join table with display order | Needed for ordering and for future overrides | Array column on the group |
| Membership overrides | **Deferred past v1**; the column exists, unused | A second sizing basis is a real complexity and risk (`09`) | Ship weights and caps in v1 |
| Account deletion | Soft: `disconnected` + credential crypto-shredded; history retained | 5-year retention (`15`); analytics need the history (`14`) | Hard delete |
| Limits | 100 accounts per tenant, 50 per group, both configurable | Bounds fan-out against an unmeasured rate limit (`08` F1) | Unbounded |
| Re-auth | Required for credential changes, cap increases, and large group trades | Proportionate; constant re-auth gets muscle-memoried | Re-auth on every action, or never |
| KYC | Fields and states present from Phase 00; collection is a policy switch | `15` F5 - registration must not need a migration | Add when required |
| Markets-ever-traded | A per-account set, appended on first fill per market | A cheap, high-quality anomaly signal for the `16` F2 attack | Not tracked |
| Audit | Every mutation of an account, group, credential or cap is an append-only audit row | `20`, and PMLA reconstruction duty | Rely on application logs |

## Findings

### F1 - Entity map

```
 tenant ──1:N── app_user ──N:M── role
   │
   ├──1:N── exchange_account ──1:1── exchange_credential   (07 F4)
   │             │                                   
   │             ├──1:N── account_balance   (per currency, 10)
   │             ├──1:N── account_market_seen  (16 F2)
   │             └──1:N── ledger_entry / child_order / holding
   │
   ├──1:N── group ──1:N── group_member ──N:1── exchange_account
   │
   ├──1:N── group_trade ──1:N── child_order
   ├──1:N── tenant_limit  (caps, kill switches)
   └──1:N── audit_event
```

Every table below carries `tenant_id NOT NULL`, and every lookup is by `(tenant_id, id)` (`17` F5).

### F2 - DDL

```sql
CREATE TABLE tenant (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  valuation_currency  text NOT NULL DEFAULT 'INR' CHECK (valuation_currency IN ('INR','USDT')),
  kyc_status          text NOT NULL DEFAULT 'not_collected'
                        CHECK (kyc_status IN ('not_collected','pending','verified','rejected')),
  kyc_verified_at     timestamptz,
  gstin               text,
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','suspended','closed')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz
);

CREATE TABLE app_user (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  email          text NOT NULL,
  password_hash  text NOT NULL,
  totp_secret_ct bytea,                    -- OUR 2FA, encrypted; never the exchange's
  totp_enabled   boolean NOT NULL DEFAULT false,
  role           text NOT NULL CHECK (role IN ('owner','trader','viewer')),
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  disabled_at    timestamptz,
  UNIQUE (email)
);

CREATE TABLE exchange_account (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenant(id),
  exchange                 text NOT NULL DEFAULT 'coindcx' CHECK (exchange IN ('coindcx')),
  name                     text NOT NULL,
  colour                   text,

  -- the owner's percentage-sizing basis (09 F4)
  allocated_capital_minor  numeric(38,0) NOT NULL CHECK (allocated_capital_minor >= 0),
  allocated_currency       text NOT NULL CHECK (allocated_currency IN ('INR','USDT')),
  allocated_set_at         timestamptz NOT NULL DEFAULT now(),
  allocated_confirmed_against_minor numeric(38,0),   -- real balance shown at confirm time

  -- derived, never typed (10)
  funding_currencies       text[] NOT NULL DEFAULT '{}',
  funding_derived_at       timestamptz,

  status                   text NOT NULL DEFAULT 'pending_validation'
                             CHECK (status IN ('pending_validation','active','paused',
                                               'credential_failed','disconnected')),
  trading_enabled          boolean NOT NULL DEFAULT true,
  max_order_notional_minor numeric(38,0),            -- per-account cap, null = tenant default
  validated_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  disconnected_at          timestamptz,

  UNIQUE (tenant_id, name)
);
CREATE INDEX ON exchange_account (tenant_id, status);
```

`allocated_confirmed_against_minor` is the real balance the customer was shown when they confirmed. It is what makes the divergence nag meaningful later: we can say *"you set Rs 5,00,000 against a balance of Rs 3,84,120 on 4 September; it is now Rs 2,10,400."*

```sql
CREATE TABLE "group" (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  name              text NOT NULL,
  description       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  archived_at       timestamptz,
  UNIQUE (tenant_id, name)
);

CREATE TABLE group_member (
  group_id       uuid NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
  account_id     uuid NOT NULL REFERENCES exchange_account(id) ON DELETE RESTRICT,
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  display_order  int  NOT NULL DEFAULT 0,
  enabled        boolean NOT NULL DEFAULT true,
  -- deferred past v1, present so enabling them is not a migration:
  weight_bp      int,                                  -- basis points, null = equal treatment
  max_notional_minor numeric(38,0),
  added_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, account_id)
);
CREATE INDEX ON group_member (account_id);

CREATE TABLE account_market_seen (
  account_id   uuid NOT NULL REFERENCES exchange_account(id),
  market       text NOT NULL,                          -- 'BTCINR'
  first_fill_at timestamptz NOT NULL,
  last_fill_at  timestamptz NOT NULL,
  fill_count    int NOT NULL DEFAULT 1,
  PRIMARY KEY (account_id, market)
);

CREATE TABLE tenant_limit (
  tenant_id                uuid PRIMARY KEY REFERENCES tenant(id),
  max_accounts             int NOT NULL DEFAULT 100,
  max_accounts_per_group   int NOT NULL DEFAULT 50,
  max_order_notional_minor numeric(38,0) NOT NULL DEFAULT 20000000,   -- Rs 2,00,000
  max_daily_notional_minor numeric(38,0) NOT NULL DEFAULT 50000000,   -- Rs 5,00,000
  typed_confirm_above_minor numeric(38,0) NOT NULL DEFAULT 20000000,
  trading_paused           boolean NOT NULL DEFAULT false,            -- the customer's kill switch
  paused_at                timestamptz,
  paused_reason            text
);

CREATE TABLE audit_event (
  id           bigserial PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  actor_user_id uuid,                                  -- null for system actions
  actor_process text NOT NULL,                         -- 'web' | 'execution-worker' | ...
  action       text NOT NULL,                          -- 'account.create', 'credential.replace', ...
  subject_type text NOT NULL,
  subject_id   text NOT NULL,
  before       jsonb,                                  -- redacted; never a secret
  after        jsonb,
  ip           inet,
  user_agent   text,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_event (tenant_id, occurred_at DESC);
CREATE INDEX ON audit_event (subject_type, subject_id, occurred_at DESC);
```

### F3 - Onboarding sequence

```
1. form submit ──▶ validate shape; reject if either credential field is empty
2. compute fingerprint = HMAC(pepper, api_key)
      collision within tenant -> reject: "this key is already connected to <account name>"
3. encrypt both key and secret (07 F3); insert account + credential as pending_validation
4. live call: POST /exchange/v1/users/balances
      401 -> reject with the THREE-CAUSE message: wrong key, wrong secret, or the key
             was created with "Bind IP Address" ticked (07 F9)
      5xx/timeout -> retry twice, then leave pending_validation and let the customer retry
5. derive funding_currencies from the returned balances; store account_balance rows
6. show the reconciliation panel (21 F5): typed allocated vs real balance
      customer chooses which figure to keep -> record BOTH
      (allocated_capital_minor and allocated_confirmed_against_minor)
7. status = active, validated_at = now(); write audit_event('account.create')
```

Step 4's three-cause message is the highest-value string in the product's onboarding: an IP-bound key fails identically to a mistyped secret, and without the hint the most likely support ticket has no discoverable cause.

### F4 - Roles

| Action | owner | trader | viewer |
|---|---|---|---|
| View dashboards, positions, blotter | yes | yes | yes |
| Place a group trade | yes | yes | no |
| Cancel / close | yes | yes | no |
| Create or edit groups | yes | yes | no |
| Add / replace a credential | yes (re-auth) | no | no |
| Change allocated capital | yes (re-auth) | no | no |
| Change caps or limits | yes (re-auth) | no | no |
| Pause trading (kill switch) | yes | **yes** | no |
| Disconnect an account | yes (re-auth) | no | no |
| Invite or remove users | yes | no | no |
| View audit log | yes | yes | no |

`trader` can pause but not resume, and can pause without re-auth. Stopping should always be easier than starting.

### F5 - Invariants in the database, and why each sits there

| Invariant | Mechanism | Why not in application code |
|---|---|---|
| One live credential per account | `UNIQUE (account_id)` on `exchange_credential` | A race between two concurrent adds would create two |
| One CoinDCX key per tenant | `UNIQUE (tenant_id, fingerprint)` | Same race; and this is a security property |
| Account names unique per tenant | `UNIQUE (tenant_id, name)` | Two "Ravi main" accounts make every report ambiguous |
| Group names unique per tenant | `UNIQUE (tenant_id, name)` | Same |
| An account in a group at most once | `PRIMARY KEY (group_id, account_id)` | Duplicate membership would double-size a group trade |
| Allocated capital non-negative | `CHECK` | A negative percentage basis is nonsense that would flow into sizing |
| Account cannot be deleted with history | `ON DELETE RESTRICT` from `child_order`, `ledger_entry`, `group_member` | Retention duty (`15`) and analytics continuity (`14`) |
| Enum values constrained | `CHECK` on every status column | An unexpected status silently disables a code path |
| Every row is tenant-scoped | `tenant_id NOT NULL` + the query layer (`17` F5) | The cross-tenant leak is the unrecoverable failure |

Limits (`max_accounts`, `max_accounts_per_group`) are deliberately *not* database constraints - they are configurable per tenant and enforced in the service, because a count constraint would require a trigger and would fight the audit trail.

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Unvalidated credential row goes live | Orders fail with 401 in a fan-out | `pending_validation` → `active` only after step 4 | One account fails mid-group, looking like our bug |
| Same key on two accounts | `UNIQUE (tenant_id, fingerprint)` | Rejected at onboarding with the conflicting name | Double-sized group trades; unattributable leaks |
| Typed allocated capital never reconciled | Skips weeks later with no obvious cause | Step 6 forces a choice and records both figures | Persistent, confusing skipped trades |
| Funding currency treated as static | Account never uses a newly funded currency | Re-derived on every reconciliation | One account under-utilised |
| Hard delete of an account | Orphaned ledger rows, or a failed retention audit | `ON DELETE RESTRICT` + soft `disconnected` | Breach of clause 6.6 and PMLA |
| Duplicate group membership | `PRIMARY KEY (group_id, account_id)` | Constraint | An account trades twice in one group trade |
| Cross-tenant account access | Two-tenant test per resource (`18` F7) | `(tenant_id, id)` lookups everywhere | Unrecoverable |
| `viewer` places a trade | Role test per endpoint | Server-side role check, not UI-only | Unauthorised real-money action |
| Kill switch requires re-auth in an emergency | Drill | Pausing needs no re-auth (F4) | Delay when speed matters most |
| KYC bolted on later | - | Fields and states exist from Phase 00 | A migration under regulatory pressure |
| Audit row contains a secret | The canary test (`07` F6) covers the log path; `before`/`after` must be redacted | Redact at the audit writer, not the reader | The `16` F1 outcome |

## Open questions for Anand

1. **Are groups shared across users in a tenant, or private to a user?** Recommended default: **shared at tenant level.** A tenant is one trading operation; two users maintaining divergent copies of "INR majors" is a foot-gun.
2. **Confirm the limits.** 100 accounts per tenant, 50 per group. Recommended default: **keep them**, and revisit after the `08` F1 rate-limit experiment - if limits turn out to be per-IP, 50 accounts in one group may already exceed what one fan-out can do inside the preview's freshness window.
3. **Should `trader` be able to change allocated capital?** It changes every future trade size without placing a trade. Recommended default: **no - owner only, with re-auth.** It is a sizing control, not a trading action.
4. **Do we collect KYC at launch, or wait for the registration answer?** Recommended default: **build the fields, collect PAN and name at signup** (cheap, expected in India, and needed the moment `15`'s answer arrives), defer document verification.

## Phase hints

- **Phase 00 owns `tenant`, `app_user`, roles, the tenant-scoping layer, `audit_event` and the KYC-capable columns.** No exchange dependency; and the cross-tenant tests are trivial to write when there is one resource type rather than fifteen.
- **`exchange_account` + `exchange_credential` + the F3 onboarding sequence** are the credential phase, and they must ship complete - a partial onboarding that skips validation creates rows that fail later in someone else's fan-out.
- **Groups are a small, independent phase** and can be built in parallel with sizing.
- **`account_market_seen`** starts collecting from the first fill; it is worthless without history, so add it in the same phase as fill ingestion (`11`).
- **`tenant_limit` and the kill switch ship before the first real-money order** (`08`, `18` F6 rung 1).
- **Membership overrides (`weight_bp`, `max_notional_minor`) stay unused in v1.** The columns exist so enabling them is a feature, not a migration.

## Sources

- The owner's brief - the four onboarding fields, groups as arbitrary subsets, up to ~20 accounts per customer.
- `07-api-key-security.md` - F4 credential schema and fingerprint, F9 onboarding validation and the three-cause auth message, F7 crypto-shredding on disconnect.
- `09-sizing-allocation-rounding.md` - F4 the allocated-capital basis and its decay, which drives `allocated_confirmed_against_minor`.
- `10-multi-currency-inr-usdt.md` - derived funding currencies, `account_balance`.
- `11-positions-ledger-pnl.md` - why the typed balance is not a ledger entry; fill ingestion feeding `account_market_seen`.
- `14-analytics-product-spec.md` - disconnected accounts must remain in historical P&L.
- `15-india-regulatory-compliance.md` - clause 6.6 and PMLA 5-year retention; the KYC-capable requirement.
- `16-competitive-benchmark.md` F2 - the markets-ever-traded anomaly signal.
- `17-architecture-stack.md` F5 - tenant scoping and the composite-lookup rule.
- `18-testing-correctness-program.md` - cross-tenant and role tests.
- `21-frontend-ux-spec.md` F5 - the add-account screen and the reconciliation panel this model backs.
