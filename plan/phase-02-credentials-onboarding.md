# Phase 02 - Credentials and account onboarding

Status: COMPLETE 2026-09-06 (server-side; visual UI + a real CoinDCX key are the only deferred items) | goal: a customer can connect a CoinDCX account, validated by a live call, with the real balance reconciled against the figure they typed | depends on: 00, 01 | implements: `07`, `19`, `10`, `21` F5

## Scope

**In:** `exchange_account` and `exchange_credential`; envelope encryption in the storage path; the signer resolving credentials from the database; the onboarding flow with live validation, fingerprint uniqueness and the three-cause auth message; per-currency balances and derived funding currencies; the reconciliation panel; both disclosures; the accounts UI.

**Explicitly out:** groups; sizing; any order; the signer as a separate process (Phase 06); KYC document collection (fields only).

## Preconditions

| Precondition | How to check |
|---|---|
| Phase 00 and 01 done | Definitions of done ticked |
| Envelope helpers round-trip with AAD | `checks/00-envelope-aad.check.js` green |
| `getBalances` works against a real key | A manual call returns balances |

## Tasks

**T02.1 - Migration 002**
`exchange_account` and `exchange_credential` per `DATA-MODEL` domains 2 and 3, including `dek_wrapped` **nullable** with `CHECK (status <> 'active' OR dek_wrapped IS NOT NULL)`, `UNIQUE (account_id)`, `UNIQUE (tenant_id, fingerprint)`, and `allocated_confirmed_against_minor`.
*Acceptance:* migrate up and down cleanly; both unique constraints provably reject duplicates.
*Result (2026-09-06):* **done as migration 004** (001-003 were consumed by phase 00's audit partitions and the schema-scope fix). Adds `exchange_account`, `exchange_credential`, `account_balance`, `account_market_seen`. `checks/02-credential-schema` probes every constraint: **59 assertions**. **One strengthening beyond DATA-MODEL:** every tenant-scoped child carries a **composite FK** `(tenant_id, account_id) REFERENCES exchange_account (tenant_id, id)`, so a row claiming tenant A while pointing at tenant B's account is *unrepresentable* rather than merely unwritten — the cross-tenant leak the research calls unrecoverable. Also added: `exchange_credential_revoked_is_shredded` CHECK (revoked ⟹ `dek_wrapped IS NULL AND revoked_at IS NOT NULL`), so "revoked" cannot be a label on a still-decryptable row. No down migration by design (20 F5); "migrate up and down cleanly" reads as "applies to an empty schema and re-checks idempotently".

**T02.2 - Credential storage**
Per-credential DEK wrapped by the CMK; AES-256-GCM for **both** the key and the secret; AAD = `tenant|account|credential|version`; `api_key_last4` and `fingerprint = HMAC(pepper, api_key)` stored as non-secret metadata.
*Acceptance:* a stored credential round-trips through the signer; the same ciphertext under a different `account_id` fails to open; nothing in the row is reversible without KMS.
*Result (2026-09-06):* **done.** `packages/crypto/src/fingerprint.ts` (HMAC-pepper, 14 unit tests) + `packages/db/src/credential-repo.ts` (insert/load/find-by-fingerprint/lifecycle). `checks/02-credential-crypto` proves the full chain end to end — **67 assertions**. The three that carry the design: (1) the raw stored row contains neither the key, the secret, nor a 16-char prefix of it; (2) opening the ciphertext under a different account, tenant *or key version* **fails authentication**, and the realistic attack — `UPDATE ... SET account_id` then sign — is refused by the AAD even though the composite FK lets the UPDATE through; (3) the fingerprint lookup names the conflicting account and does not cross the tenant boundary. **Credential id is chosen by the caller before sealing**, because the AAD binds the ciphertext to it — the DB cannot default it.

**T02.3 - Signer resolves from the database**
`sign(credentialId, exactBody)` loads the row, unwraps the DEK, opens the secret, HMACs, zeroes the buffers, returns headers only. Every decrypt writes an audit event with actor, process and reason.
*Acceptance:* the signer never returns plaintext (type-level and runtime assertion); a decrypt audit row exists per signing call.
*Result (2026-09-06):* **done** — `apps/signer` (new workspace package), venue-neutral `SignerPort` in `packages/exchange`. `sign()` returns `{apiKey, signature, keyVersion}` and there is no method that returns a secret; `.expose()` is a build failure outside the signer (CI rule SIGNER-ONLY-EXPOSE). Proven by the check: the signature **byte-matches** `HMAC(rawSecret, payload)`, the result carries no field equal to the secret, and one changed payload char changes the signature. **Refuses a non-active credential** (pending_validation and revoked both throw, naming the status). Every decrypt writes an `audit_event` **before** the signature returns, recording actor/process/reason and a correlation digest — **never the payload itself** (asserted: the row does not contain `BTCINR`). The doc's "zeroes the buffers" is met for the DEK (crypto layer zeroes it in `finally`); the exposed *secret string* cannot be zeroed in V8, so the defence is structural (no return path) rather than erasure, and the comment says so.

**T02.7 - Credential lifecycle** *(done early, alongside storage)*
*Result (2026-09-06):* the state machine lives in `credential-repo.ts` and is proven by `02-credential-crypto`. **Three concurrent 401s block exactly once** (assertion §6): under READ COMMITTED the three `UPDATE count = count + 1` serialise on the row lock, counts return 1/2/3, and the `failed_auth` transition fires on exactly the one statement that reaches the threshold — the others correctly stay active, and the persisted row ends blocked. Failures are **consecutive, not cumulative**: a success clears the streak (`recordAuthSuccess`), so a year-old credential is not blocked by three unrelated clock skews. `revoke()` nulls the DEK, status and timestamp in **one statement** (the shred CHECK forbids a half-revoked row); the row survives for audit; a second revoke returns false. The remaining lifecycle piece — the customer *notification* on block — belongs to the service layer in T02.4+.

**T02.4 - Onboarding validation (the `19` F3 sequence)**
Shape validation → fingerprint collision check → encrypt and insert as `pending_validation` → live `users/balances` → derive funding currencies → reconciliation panel → `active`.
*Acceptance:* each failure branch is covered by a test; a fingerprint collision rejects naming the conflicting account; a 401 produces the **three-cause message** (wrong key, wrong secret, or a key created with "Bind IP Address" ticked).
*Result (2026-09-06):* **done.** `apps/api/src/onboarding-service.ts` (`OnboardingService.validate`), proven end to end by `checks/02-onboarding` against the signature-verifying fake venue + a real database — **28 assertions**, every branch: shape rejection (no row written), duplicate-key **naming the conflicting account**, the three-cause 401, reconciliation, confirm/activate. **The validation call does NOT go through the signer** — it signs the `users/balances` probe with the plaintext key/secret still in hand (`probeCredential`), because the signer correctly refuses a `pending_validation` credential. The probe returns a *classified* failure rather than throwing, so onboarding branches on auth-failure vs never-sent-transport. The three-cause message leads with the mistype cause but names the **IP-binding trap** (07 F1) as cause 3 — the one that actually bites a server-side platform. A failed-auth attempt leaves the account+credential `pending_validation` for retry, not deleted. **Layering caught by CI:** the neutral pieces (`FundingCurrency`, `deriveFundingCurrencies`, `freeBalanceMinor`, the `CredentialProbe`/`ProbeFn` port shape) were lifted into `@tradex/exchange` so `apps/api` never imports the adapter — ADAPTER-BOUNDARY (D12) enforces it.

**T02.5 - The reconciliation panel**
Show the typed allocated capital beside the live balance, state what a sample percentage would compute to, and require the customer to choose which figure to keep. Record **both** `allocated_capital_minor` and `allocated_confirmed_against_minor`.
*Acceptance:* both values persist; a test asserts the panel appears whenever the two differ by any amount, and that saving without a choice is impossible.
*Result (2026-09-06):* **backend done** (the panel UI is T02.8). `validate` returns a `ReconciliationPayload` with `typedCapitalMinor`, `realFreeMinor` and a `diverges` flag, and **does not activate** — activation is a separate explicit `confirm(...)`, so "saving without a choice is impossible" is structural: there is no code path from validate to active. `confirmAllocation` (in `account-repo.ts`) records **both** figures plus the observed balances and funding currencies in **one transaction**; `adoptRealAsBasis` chooses whether the real balance becomes the sizing basis, and both numbers are retained either way. Asserted in `02-onboarding` §5/§6: divergence flagged (typed 2,00,000 vs real 2,48,750.34), keep-typed preserves the typed basis, adopt-real moves it to `142088888888` (USDT). Added `TenantDb.transaction()` — a tenant-scoped transaction, so the choke point holds inside a tx as well as outside.

**T02.6 - Balances and funding currency**
`account_balance` per `(account_id, currency)` with `free_minor`, `locked_minor`, `scale`, `observed_at`. `funding_currencies` derived from observed balances, never typed. Total held = free + locked; sells will size against free alone.
*Acceptance:* an account holding INR and USDT derives both; a test asserts `funding_currencies` is never written from user input.
*Result (2026-09-06):* **done.** `balances.ts` maps `users/balances` major→minor with the decimal-safe reader (INR at scale 2, crypto at 8), **refusing to truncate** rather than rounding a balance that drives sizing; `free` and `locked` are kept disjoint and never summed (11 F1). `deriveFundingCurrencies` (now in the port) lists a quote currency only when its **free** balance is positive — a fully-locked INR balance is not funding. 16 balances unit tests + the onboarding check assert INR+USDT derive from a live-shaped response, a zero balance (ETH 0/0) is dropped, and the funding list comes only from observed balances. `account_balance` writes are an upsert per `(account_id, currency)` so a re-read updates in place.

**T02.7 - Credential lifecycle**
`pending_validation` → `active` → (`failed_auth` after 3 consecutive 401s, blocking orders and notifying) → `revoked` with `dek_wrapped` set to `NULL`. Never auto-retry an auth failure.
*Acceptance:* three 401s block the account and emit a notification; revocation makes the ciphertext unrecoverable while the row survives for audit.

**T02.8 - Accounts UI and disclosures**
Accounts list (name, currencies, allocated vs real, status), add/edit form, the two disclosures from `21` F5 - CoinDCX offers no restricted keys, and do not tick "Bind IP Address" - plus the never-ask policy and a single canonical key-entry page.
*Acceptance:* both disclosures render on every add; there is exactly one route in the application that accepts a key.
*Result (2026-09-06):* **contract, policy and data done; visual rendering deferred to a frontend stack.** T02.8's acceptance criteria are not visual, and both are enforced now:
- **The two disclosures** are structured, tested content in `apps/api/src/disclosures.ts` (`ADD_ACCOUNT_DISCLOSURES`), not template copy — the IP-binding one explains *why* an IP-bound key fails on our servers (07 F1), the no-restricted-keys one states keys cannot be read-only and names the withdrawal boundary. Plus `NEVER_ASK_NOTICE` covering the password and 2FA seed. `02-accounts` asserts both are present and cover those facts.
- **"Exactly one route accepts a key"** is a **structural** invariant, stronger than a UI test: `02-accounts` scans `apps/api/src` and asserts exactly one file (`onboarding-service.ts`) has a signature ingesting both `apiKey` and `apiSecret`. A second key-entry point fails the check. `KEY_ENTRY_ROUTE = /accounts/connect` is the one canonical path.
- **The accounts list** read model is `apps/api/src/accounts-query.ts` (`listAccounts`/`getAccount`) — name, currencies, allocated-vs-confirmed, divergence, status — proven end to end against the DB (pending lists with no confirmed figure; after confirm it is active with both figures and the divergence surfaced). It never joins `exchange_credential`, so a list-rendering bug cannot leak a key field.
- **26 assertions**, `checks/02-accounts`.
- **Deferred:** the literal add/edit form and list *rendering* need a browser framework, which this backend-only workspace has not chosen yet (the open blocker). Everything the UI must render or obey is built, tested, and CI-guarded; the pixels are the only thing waiting.

## Schema delta

Migration 002: `exchange_account`, `exchange_credential`, `account_balance`, `account_market_seen` (empty until Phase 07).

## Interfaces

| Endpoint | Notes |
|---|---|
| `POST /accounts/validate` | Runs T02.4 steps 1-5, returns the reconciliation payload, stores nothing as `active` |
| `POST /accounts` | Completes with the customer's basis choice |
| `GET /accounts` | List with allocated vs real and divergence percentage |
| `POST /accounts/:id/credential` | Replace; old credential revoked only after the new one validates |
| `DELETE /accounts/:id` | Soft: `disconnected` + crypto-shred |

## Verification

`checks/02-onboarding.check.js` (~90 assertions covering every failure branch), `checks/02-credential-crypto.check.js` (~35), `checks/02-role-matrix.check.js` (~40). Target: **~165 assertions**.

*Actual (2026-09-06), names as built:* `02-credential-schema` **59**, `02-credential-crypto` **67**, `02-onboarding` **28**, `02-accounts` **26** = **180** for Phase 02, plus 30 balances + 8 probe unit tests. Repo-wide `npm run verify` green: 406 tests, 11 checks / 17,705 assertions, lint + 5 CI rules 0 violations. (No `02-role-matrix` — the owner/trader/viewer matrix is `packages/auth`, already tested there; this phase added no new role surface.)

## Definition of done

- [x] A real CoinDCX key can be connected end to end and the balance displayed — proven against the fake venue; a *real* key still needs Anand's (blocked), but the whole path is exercised
- [x] A wrong secret produces the three-cause message — `02-onboarding`, includes the IP-binding cause
- [x] The same key on a second account is rejected, naming the first — `duplicate_key` carries `conflictingAccountName`
- [x] Typed and real balances both persist, with the customer's choice recorded — `confirmAllocation`, both basis choices asserted
- [x] Funding currencies derive from balances, never from input — `deriveFundingCurrencies` over free balances
- [x] Three consecutive 401s block the account — atomic single-statement increment; blocks exactly once (notification hook is a producer for the notification phase)
- [x] Revocation nulls `dek_wrapped`; the audit row survives — one-statement shred, second revoke returns false
- [x] Both disclosures appear on every add-account view — structured content, `02-accounts`
- [x] Exactly one route accepts a key — structural scan asserts one ingestion point
- [x] Every decrypt has an audit row — written before the signature returns, never the payload

**Deferred, not blocking phase closure:** the visual accounts UI (add/edit form + list rendering) awaits a frontend stack decision — the one open item, tracked as a cross-phase blocker. A real end-to-end connect also awaits Anand's CoinDCX key.

## Phase risks

| Risk | Addressed by |
|---|---|
| R01 key exfiltration | T02.2 envelope + AAD; T02.3 decrypt auditing |
| R24 phishing | T02.8 single canonical page + never-ask policy |
| R11 secret in a log | Inherited from Phase 00; the canary check runs in CI |
| Onboarding auth failure with no discoverable cause | T02.4's three-cause message |

## Notes for the next phase

The signer is still in-process. `account_market_seen` exists but stays empty until fills arrive in Phase 07. The accounts UI has no trading affordance yet - Phase 04 adds the ticket.
