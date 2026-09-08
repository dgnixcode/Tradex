# 07 - API key storage and signing security

Status: 2026-09-03 | track: execution core | scope: how customer CoinDCX credentials are captured, stored, used to sign, rotated and destroyed - and an honest account of which defences are actually available to us.

## Verdict

- **There is no exchange-side blast-radius control available to a platform like ours. This is the finding that reshapes the whole document.** CoinDCX's own FAQ states *"Since all API users have the same level of permissions, API keys are interchangeable"* and *"Are there Read Only APIs available for CoinDCX Public APIs - No, we currently don't have Read Only APIs."* There is no trade-only scope, no withdrawal toggle, no read-only key. And IP binding - the one control that exists - *"will bind the API key to the IP of the device from which the key is generated"*. A customer creating a key in their home browser binds it to their home IP, which would block our servers outright. There is no UI to bind a key to an IP you nominate. **So the usual advice - "require a trade-only key with withdrawals disabled and an IP allowlist" - is not implementable here.** Our own encryption and access control is not a defence in depth; it is the entire defence.
- **The mitigating fact is real but must not be oversold.** The documented API capability set is *"Place Limit Orders, Place Market Orders, Funds Balance, Account Details"*, and there is no withdrawal endpoint anywhere in the API reference. A stolen key therefore cannot send funds to an attacker's address directly. What it *can* do: trade the account to destruction (a few market orders into an illiquid INR pair will do it), and call `wallets/transfer` and `wallets/sub_account_transfer` to move balances between the victim's own wallets and sub-accounts. Total loss is achievable without a withdrawal endpoint. "Keys cannot withdraw" is a reason to sleep slightly better, not a reason to relax the crypto.
- **Envelope encryption, per-credential DEK, AES-256-GCM, AAD bound to identity.** Root key in a managed KMS; a fresh 256-bit DEK per stored credential, wrapped by KMS; the AAD carries `tenant_id | account_id | credential_id | version` so a ciphertext row physically cannot be replayed under another account's identity even by someone with full database write access. Recommend a managed KMS over self-hosted Vault: for a 1-2 developer team, Vault's operational burden (unsealing, HA, its own backup story) is a bigger risk than the threat it removes.
- **Split the signer, but stage it.** A separate signing process that alone holds KMS decrypt permission is the right end state, because it turns "app server compromised" from "all credentials exfiltrated" into "attacker can place trades while they retain access" - a much smaller, much more detectable loss. Build the *seam* immediately (a `CredentialSigner` port with no plaintext crossing back over it) and make it a real process boundary at the first phase that touches real money. Doing it later means touching every order path again.
- **CoinDCX shows the secret exactly once and can never re-show it.** *"The Secret key is forever hidden after you refresh the screen."* So our ciphertext is the only copy in existence. That promotes backup integrity from an ops concern to a product concern: losing either our ciphertext or the KMS key means every customer must manually re-create and re-enter every key for every account. A restore drill that does not exercise the KMS path is not a drill.
- **Ask for a dedicated key per Tradex account.** The FAQ confirms *"there are no restriction on creating Key and Secret."* One key per account we manage means revocation is surgical, per-key rate-limit budgets are meaningful, and a leak is attributable. Never let a customer paste one key into two accounts.
- **Enforce never-log mechanically, not by discipline.** A branded secret type whose `toString`/`toJSON`/`util.inspect` all redact, a logger serialiser denylist, a CI grep, and one test that pipes a known canary secret through the whole request path and asserts it appears in no log line. Four cheap mechanisms; reviewer attention is not one of them.

## Decisions

| Decision | Choice | Why | Rejected alternative |
|---|---|---|---|
| Exchange-side key scoping | **Not available.** Document it, tell the customer plainly, design as if the key is fully privileged | No read-only or trade-only keys exist; all keys are interchangeable (FAQ) | Require withdrawal-disabled keys - impossible, and promising it would be a lie |
| Exchange-side IP allowlist | **Not usable.** Do not build onboarding around it | Binding uses the key-generating device's IP, not one we can nominate | Instruct customers to generate keys from our server - absurd and unsafe |
| HFT trusted-IP programme | Note as a future option, not a v1 dependency | `hft-api.coindcx.com` requires a static IP registered with CoinDCX as Trusted, obtained by contacting them - potentially the only route to a real allowlist | Assume we can get it before launch |
| Root key custody | Managed KMS (AWS KMS or GCP KMS), envelope encryption | No key material on our disks; audited access; a small team can run it correctly | HashiCorp Vault (ops burden), app-level static key in env (one leak loses everything), cloud HSM (cost) |
| Cipher | AES-256-GCM, 96-bit random nonce, AAD = `tenant \| account \| credential \| version` | Authenticated, and the AAD makes rows non-transplantable | AES-CBC + separate HMAC (more moving parts), libsodium sealed boxes (no AAD binding by default) |
| DEK granularity | One DEK per credential, wrapped by KMS, stored beside the ciphertext | Rotating or shredding one credential touches one row | One DEK per tenant (wider blast radius), KMS-direct encryption of every secret (a KMS call per signature, per account, per order) |
| Signer topology | Seam now, separate process at the first real-money phase | Full separation on day one slows the build; never separating leaves the worst failure mode in place | In-process forever |
| Plaintext lifetime | Decrypt per signing operation, never cached, never on a request-scoped object that could be serialised | A cache is the thing that gets dumped in a heap snapshot or a crash report | Decrypt once and hold for the fan-out (tempting - 20 accounts, 20 decrypts) |
| Key per account | Mandatory, one CoinDCX key per Tradex account row | Surgical revocation, attributable leaks, per-key limit budgets | Allow key reuse across accounts |
| Storing the customer's exchange password or 2FA seed | **Never, under any circumstance** | We have no use for either; holding them converts a trading incident into an account takeover | Store to "help with onboarding" |

## Findings

### F1 - What CoinDCX actually offers, against what we wanted

All rows VERIFIED from CoinDCX's own documentation and help pages; sources listed at the end.

| Control we wanted | Does CoinDCX have it? | Evidence |
|---|---|---|
| Read-only key | **No** | FAQ: *"Are there Read Only APIs available … No, we currently don't have Read Only APIs."* |
| Trade-only / no-withdrawal scope | **No scopes at all** | FAQ: *"all API users have the same level of permissions, API keys are interchangeable"* |
| IP allowlist we nominate | **No** | Help: binding *"will bind the API key to the IP of the device from which the key is generated"* |
| Static trusted IP | Only via the enterprise HFT programme | Help: *"Our team members will request you for a static IP address which we will keep as our Trusted IPs for HFT"* |
| Key expiry | Not documented anywhere | UNVERIFIED - assume keys live until deleted |
| Revocation | Yes - delete, requires the account password | Help: *"Enter your account password and click Confirm"* |
| Multiple keys per user | Yes, unlimited | FAQ: *"there are no restriction on creating Key and Secret"* |
| Secret retrievable later | **No, never** | Help: *"The Secret key is forever hidden after you refresh the screen"* |
| Public key retrievable later | Yes - QR, copy icon, or read icon | Help, Managing the API Keys |
| Withdrawal endpoint in the API | **None exists** in the reference | API capability list: *"Place Limit Orders, Place Market Orders, Funds Balance, Account Details"*; no withdrawal path in the docs dump |
| Fund-moving endpoints that do exist | `wallets/transfer`, `wallets/sub_account_transfer`, futures `wallets/transfer` | `01-coindcx-spot-rest.md`, `04-coindcx-futures-positions-wallets-rest.md` |
| 2FA on key creation | Yes - email **and** SMS OTP | Help, Generation of the API Key and Secret |

The honest summary for a customer-facing security page: *"CoinDCX does not offer restricted API keys. Any key you give us can trade your account and move funds between your own CoinDCX wallets. It cannot withdraw to an external address, because CoinDCX's API has no withdrawal function. Your protection is that we encrypt your key so that our own database is useless without a key we hold separately, and that you can delete the key on CoinDCX at any moment without asking us."* That last clause matters - the customer's kill switch is on CoinDCX's side and does not depend on us being reachable or honest.

### F2 - Threat model

Ordered by expected loss, not by likelihood.

| # | Threat | What the attacker gets | Our control |
|---|---|---|---|
| T1 | Database dump (backup theft, misconfigured snapshot, SQL injection with read) | Ciphertext and wrapped DEKs only. Useless without KMS decrypt | Envelope encryption; KMS access restricted to the signer's role |
| T2 | Application server compromise (RCE, dependency backdoor) | Whatever the process can decrypt while the attacker is resident | Separate signer process; no plaintext cache; anomaly alerts on decrypt volume |
| T3 | Insider with production database read | Same as T1 | Same as T1, plus audit of KMS decrypt calls, plus dual control on role changes |
| T4 | Insider with signer-role access | Live signing on any account | Audit every decrypt with actor + reason; alert on decrypts not attached to a customer-initiated order |
| T5 | Leakage through logs, APM, error trackers, crash dumps | Plaintext secrets in a third-party system we do not control | Branded secret type, logger denylist, canary test (F6). This is the most common real-world cause |
| T6 | Memory scraping / heap snapshot on a live process | Any plaintext currently resident | Decrypt per operation, zero the buffer after use, never store on a long-lived object |
| T7 | SSRF or a proxy that logs request bodies | Signed requests, and headers containing the API key | The key travels in `X-AUTH-APIKEY`; never route exchange calls through a logging proxy |
| T8 | Our own backup lost or KMS key destroyed | Nothing for the attacker, but total loss for us: every customer re-onboards by hand | KMS key with deletion protection + a documented, drilled restore path (F8) |
| T9 | Malicious or coerced platform operator | Trades on customer accounts | Immutable audit log the operator cannot edit; per-tenant notional caps; customer-visible activity feed |
| T10 | Customer's own key leaked elsewhere (their laptop, their other bot) | Trades that look like ours | Dedicated key per account so we can prove which key acted; surface an "unrecognised activity" signal from reconciliation |

T5 is the one that actually happens. It is also the cheapest to make impossible.

### F3 - Cryptographic design

```
KMS root key  (CMK, deletion protection on, rotation annual)
      │  wraps
      ▼
DEK  (256-bit, random, one per credential)          stored as: dek_wrapped (bytes)
      │  encrypts
      ▼
plaintext secret  ──AES-256-GCM──▶  ciphertext + 96-bit nonce + 128-bit tag
                                     AAD = tenant_id | account_id | credential_id | key_version
```

Rules:

| Rule | Reason |
|---|---|
| Nonce is random per encryption and stored alongside; never reused with the same DEK | GCM nonce reuse is catastrophic, not merely weak |
| AAD includes all four identity fields | A row copied to another account fails authentication instead of signing for the wrong customer |
| `key_version` in the AAD | Lets us re-encrypt under a new scheme without ambiguity about which scheme a row uses |
| The API **key** (public part) is encrypted too, not just the secret | It is an account identifier; a dump of keys alone tells an attacker which CoinDCX accounts we serve. Cheap to protect |
| No plaintext ever crosses back over the signer boundary | The signer returns a signature and headers, never the secret |
| Decrypt is metered and audited | An abnormal decrypt rate is the earliest signal of T2 or T4 |

### F4 - Storage schema

```sql
CREATE TABLE exchange_credential (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  account_id         uuid NOT NULL REFERENCES exchange_account(id) ON DELETE RESTRICT,
  exchange           text NOT NULL CHECK (exchange IN ('coindcx')),

  -- envelope
  key_version        smallint NOT NULL DEFAULT 1,
  dek_wrapped        bytea NOT NULL,          -- DEK encrypted by the KMS CMK
  kms_key_arn        text  NOT NULL,          -- which CMK wrapped it, for rotation
  api_key_ct         bytea NOT NULL,          -- AES-256-GCM
  api_key_nonce      bytea NOT NULL,
  api_key_tag        bytea NOT NULL,
  api_secret_ct      bytea NOT NULL,
  api_secret_nonce   bytea NOT NULL,
  api_secret_tag     bytea NOT NULL,

  -- non-secret metadata, safe to read anywhere
  api_key_last4      text  NOT NULL,          -- for the UI: "…a91f". Never the full key
  fingerprint        bytea NOT NULL,          -- HMAC(pepper, api_key): detects reuse without storing the key
  status             text  NOT NULL DEFAULT 'active'
                       CHECK (status IN ('pending_validation','active','revoked','failed_auth')),
  validated_at       timestamptz,
  last_auth_error_at timestamptz,
  auth_error_count   int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,

  UNIQUE (account_id),                        -- exactly one live credential per account
  UNIQUE (tenant_id, fingerprint)             -- one CoinDCX key may not back two accounts
);

CREATE INDEX ON exchange_credential (tenant_id, status);
```

Two fields carry more weight than they look. `fingerprint` is `HMAC-SHA256(server_pepper, api_key)` - it lets the unique constraint reject a customer pasting the same CoinDCX key into two Tradex accounts *without* storing anything reversible, and it lets support answer "is this key already in use?" without a decrypt. `api_key_last4` exists so that every UI surface has something to display and nobody is ever tempted to decrypt for cosmetic reasons.

Note what is absent: no `plaintext` column for "temporary" use, no `notes` field (free text attracts pasted secrets), and no soft-delete flag that would keep ciphertext alive after revocation - see F7.

### F5 - The signing path

```
 browser            api server                 signer                  KMS        CoinDCX
   │  submit trade      │                        │                      │            │
   ├───────────────────▶│                        │                      │            │
   │                    │ authz, pre-trade       │                      │            │
   │                    │ validation, sizing     │                      │            │
   │                    │                        │                      │            │
   │                    │ sign(cred_id, body) ──▶│                      │            │
   │                    │                        │ decrypt(dek_wrapped)─▶│            │
   │                    │                        │◀── DEK ──────────────│            │
   │                    │                        │ AES-GCM open (AAD)   │            │
   │                    │                        │ HMAC-SHA256(body)    │            │
   │                    │                        │ zero(secret, DEK)    │            │
   │                    │◀ {headers, signature}  │                      │            │
   │                    │  (no secret returned)  │                      │            │
   │                    │──────────── POST /exchange/v1/orders/create ──────────────▶│
```

Constraints this path must respect:

| Constraint | Source | Consequence |
|---|---|---|
| Sign immediately before sending | Futures orders expire 10 s after `timestamp` (`03-coindcx-futures-orders-rest.md`) | The signer must be called from the worker that owns the socket, not from an enqueueing process |
| The signed payload is byte-exact | The signature covers the serialised JSON body (`06-coindcx-auth-ratelimits-errors-tos.md`) | The signer must return the exact bytes to send, not a parsed object the caller re-serialises |
| One decrypt per order, per account | No plaintext cache (T6) | A 20-account fan-out makes 20 signer calls and 20 KMS decrypts. Budget for it: see `22-nonfunctional-slos-capacity.md` |
| KMS latency is on the critical path | Managed KMS is typically single-digit to low-tens of milliseconds | Cache the *wrapped* DEK's unwrapped form for the duration of a single fan-out **only if** measurement forces it, and record that as a deliberate weakening |

That last row is a real tension and should be settled by measurement, not preference: 20 sequential KMS calls could add meaningfully to the click-to-last-order latency. The safe optimisation is per-fan-out, in-signer, time-boxed to seconds, never per-tenant or per-session.

### F6 - Making leakage mechanically impossible

Four mechanisms, all cheap, none relying on anyone remembering:

| Mechanism | Implementation | Catches |
|---|---|---|
| Branded secret type | `class Secret { #v; toString(){return '[redacted]'} toJSON(){return '[redacted]'} [Symbol.for('nodejs.util.inspect.custom')](){return '[redacted]'} expose(){…} }` | Accidental interpolation, `JSON.stringify`, `console.log`, error serialisation |
| Logger serialiser denylist | Reject or mask any log field named `secret`, `api_secret`, `signature`, `authorization`, `x-auth-*`, and any value matching a high-entropy hex pattern of the length CoinDCX secrets use | Structured logs, request/response loggers |
| CI grep | Fail the build on `\.expose\(\)` outside the signer module, and on any literal that looks like a 64-char hex secret | New code paths that reach for plaintext |
| Canary test | Onboard a fake credential whose secret is a unique sentinel; drive a full order through the stack with logs captured; assert the sentinel appears in zero log lines, zero error payloads, zero HTTP response bodies | Everything the other three miss, including transitive dependencies |

The canary test is the only one that proves the property end to end, and it is the one to write first. `18-testing-correctness-program.md` owns it.

### F7 - Rotation, revocation and crypto-shredding

Three different operations that get confused with each other:

| Operation | What changes | Customer impact | Trigger |
|---|---|---|---|
| **CMK rotation** | New KMS key version; old ciphertext still decryptable by the versioned CMK | None | Annual, automatic |
| **Re-encryption** | Every `dek_wrapped` re-wrapped under a new CMK; ciphertext untouched | None; runs online, row by row, idempotent | CMK migration, suspected KMS compromise, `key_version` scheme change |
| **Credential replacement** | Customer deletes the key on CoinDCX, creates a new one, pastes it into Tradex | They must do it manually - we cannot rotate a key we did not create | Suspected leak, or our own incident response |

The third is the one that matters operationally and it is entirely in the customer's hands, because CoinDCX has no key-rotation API. Our job is to make it a two-minute, well-signposted flow, and to make the old credential unusable the instant the new one is validated.

Crypto-shredding on revocation: delete the row's `dek_wrapped` (not just the status flag). Without the wrapped DEK the ciphertext is unrecoverable even by us, even from a backup taken while the row was live - provided backups of the *old* row also age out. Retain only the non-secret metadata (`api_key_last4`, `fingerprint`, timestamps) for audit continuity. This is why the schema in F4 has no soft-delete-with-ciphertext-intact state: "revoked" must mean cryptographically dead, not merely flagged.

### F8 - Backup and restore, promoted to a product concern

Because CoinDCX shows the secret once and never again, our ciphertext is the only copy in the world. Two failure modes, both total:

| Loss | Consequence | Control |
|---|---|---|
| Database ciphertext lost | Every customer re-creates every key on CoinDCX and re-enters it | Standard PITR backups, plus a restore drill that actually re-signs a live request from restored data |
| KMS CMK deleted or lost | Identical consequence, and no backup helps | Deletion protection on the CMK; multi-region replica key; the CMK is *not* in the same blast radius as the database; documented break-glass |

A restore test that only checks the database comes back is meaningless. The drill must be: restore into an isolated environment, point it at the real CMK, decrypt one credential, sign one authenticated read-only request against CoinDCX, confirm HTTP 200. `20-ops-audit-runbook.md` owns the drill; this document owns the requirement.

### F9 - What onboarding must prove before it stores anything

The customer types a name, an allocated balance, a key and a secret. Before that row goes `active`, prove the key works and tell the customer what we found:

| Step | Call | Purpose | On failure |
|---|---|---|---|
| 1 | `POST /exchange/v1/users/balances` | Proves the key and secret are valid and correctly paired, and that our signing is right | Reject with the exact reason; do not store |
| 2 | Compare the returned balances against the allocated balance the customer typed | The typed figure is an assertion, not a fact (see `11-positions-ledger-pnl.md`) | Show both numbers side by side and require an explicit confirmation |
| 3 | Check `fingerprint` uniqueness | Blocks the same CoinDCX key backing two Tradex accounts | Reject: "this key is already connected to *<account name>*" |
| 4 | Record which currencies actually hold a balance (INR, USDT, others) | Drives per-account market resolution later (`10-multi-currency-inr-usdt.md`) | Warn if neither INR nor USDT is funded |
| 5 | Store, status `active`, `validated_at = now()` | | |

Note what we cannot do at step 1: we cannot verify the key lacks withdrawal permission, because permissions do not exist. Nor can we detect IP binding in advance - a key bound to the customer's home IP will simply fail authentication from our servers, and the failure will look identical to a mistyped secret. So the onboarding error message for an auth failure must name all three possibilities: wrong key, wrong secret, or a key that was created with **Bind IP Address** checked. Without that hint, the most likely support ticket has no discoverable cause.

### F10 - What we never store

| Never | Why |
|---|---|
| The customer's CoinDCX account password | We have no use for it. CoinDCX requires it to delete a key - that is the customer's action, not ours |
| Any 2FA secret, seed or OTP | Same, and holding it turns a trading incident into account takeover |
| Plaintext API secret at rest, anywhere - including caches, temp files, queue payloads, crash dumps | The whole point of F3 |
| The secret in a queue message | A durable queue is a durable copy of a plaintext secret. Pass `credential_id`; let the signer fetch |
| A support-visible field containing any part of the secret | Support sees `api_key_last4` and nothing more (see `20-ops-audit-runbook.md`) |

## Design

### Credential lifecycle

```
                     ┌──────────────── customer deletes key on CoinDCX ─────────────┐
                     │                                                              ▼
  (form submit) ─▶ pending_validation ─(F9 passes)─▶ active ─(auth failures ≥ N)─▶ failed_auth
                     │                                 │                              │
                     └─(F9 fails)─▶ discarded          │                              │
                       (nothing stored)                ▼                              ▼
                                            revoked (dek_wrapped deleted) ◀───────────┘
```

`failed_auth` is distinct from `revoked` on purpose: repeated 401s mean the key stopped working (deleted on CoinDCX, or IP-bound), which is a customer-notification event and a hard block on further orders for that account - but the ciphertext stays until the customer resolves it, because the alternative is destroying a credential that was merely temporarily unreachable. Threshold: block the account after 3 consecutive auth failures, notify immediately, and never retry an auth failure automatically (it cannot succeed and it looks like credential stuffing to the exchange).

## Failure modes

| Failure | Detection | Mitigation | Blast radius |
|---|---|---|---|
| Secret reaches a log or error tracker | The F6 canary test, pre-release | Branded type + logger denylist + CI grep + canary test | Every credential that passed through that code path; assume total |
| Database exfiltrated | Intrusion detection, anomalous query volume | Envelope encryption; the dump is inert without KMS | Nil for credentials, but the account list leaks unless the API key column is encrypted too (F4) |
| App server RCE | Anomalous decrypt rate; egress to unexpected hosts | Separate signer; no plaintext cache; per-tenant notional caps limit what trading can do before we notice | Live signing while the attacker is resident |
| Attacker with a stolen key trades the account to zero | Reconciliation sees fills we never ordered (`12-order-state-reconciliation.md`) | Surface "activity we did not initiate" to the customer; there is no exchange-side control to prevent it | One account, potentially its full balance |
| Ciphertext row copied to another account | AES-GCM authentication failure on decrypt | AAD binding (F3) | Nil - the attack fails closed |
| KMS CMK deleted | Every decrypt fails at once, loudly | Deletion protection, multi-region replica, drilled restore | Total: all customers re-onboard manually |
| Backup restored without the CMK | Restore drill fails at the decrypt step | The drill must include signing a live request (F8) | Discovered during an incident instead of during a drill - the real risk |
| Customer's key is IP-bound; auth fails from our servers | 401 at onboarding step 1 | Name IP binding explicitly in the error message (F9) | One account, blocked, with a confusing cause |
| Same key pasted into two accounts | `UNIQUE (tenant_id, fingerprint)` | Reject at onboarding with the conflicting account name | Nil, prevented |
| Operator signs a trade nobody asked for | Immutable audit log; customer-visible activity feed | Every decrypt records actor + reason; decrypts with no originating customer action alarm | One tenant, bounded by notional caps |
| Plaintext left in a queue payload | Code review, CI grep for secret-shaped fields in job schemas | Queue carries `credential_id` only (F10) | Every job in the queue's retention window |

## Open questions for Anand

1. **Which cloud, and therefore which KMS?** AWS KMS and GCP KMS are equivalent for this purpose; the choice follows hosting (see `17-architecture-stack.md`). What matters here is that it must be a *managed* KMS in the same region family as the app, with deletion protection and a replica. Recommended default: **AWS KMS in `ap-south-1` (Mumbai)**, which also keeps latency to CoinDCX low.
2. **Do we tell customers plainly that CoinDCX has no restricted keys?** I recommend yes, prominently, at the point of adding an account - it is true, it is checkable, and a customer who discovers it later will assume we hid it. It also sets up the honest framing that their real kill switch is deleting the key on CoinDCX. The counter-argument is that it costs conversions. Recommended default: **say it plainly.**
3. **Is the enterprise HFT trusted-IP route worth pursuing before launch?** It appears to be the only path to a genuine IP allowlist, and it also raises rate limits - which `22-nonfunctional-slos-capacity.md` shows is the binding scaling constraint. It requires contacting CoinDCX and a static IP. Recommended default: **open the conversation early**, treat any outcome as a bonus rather than a dependency.

## Phase hints

- **Phase 00 (foundations) owns the crypto**: the KMS CMK, the envelope helpers, the `Secret` type, the logger denylist, the CI grep, and the canary test. None of it depends on any exchange behaviour, so it can be built and proven before a single API call exists.
- The `CredentialSigner` **port** ships in the same phase as the first authenticated call; the **process split** ships in the phase that first sends a real-money order. Sequencing it that way means no order path is ever written against an in-process signer and then rewritten.
- The **account-onboarding phase** implements F9 in full, including the three-cause auth error message and the typed-versus-actual balance reconciliation. Do not ship a partial version: an onboarding flow that stores an unvalidated credential creates rows that fail later, in a fan-out, on somebody else's money.
- The **restore drill** (F8) is a task in the ops phase, but the *requirement* that a drill includes signing a live request belongs in the go-live gate, not in a backlog.
- Never schedule "add key permission scoping" - it does not exist to be added. If CoinDCX ships scopes later, that is a new phase.

## Sources

- CoinDCX FAQ, in `_sources/coindcx-docs.txt` (Authentication and General API sections): no read-only APIs; all API users have identical permissions; keys are interchangeable; no restriction on the number of keys; IP-bound keys require a separate key per user.
- CoinDCX help, *Generation of the API Key and Secret* - https://coindcx.com/api/help/API%20Dashboard/Generation%20of%20Key%20and%20Secret - the Bind IP Address option binds to the generating device's IP; email and SMS OTP; the secret is hidden forever after the screen is refreshed.
- CoinDCX help, *Managing the API Keys* - https://coindcx.com/api/help/API%20Dashboard/Managing%20the%20API%20Keys - retrieve the key by QR/copy/read; deletion requires the account password; the secret is never retrievable.
- CoinDCX help, *High-Frequency Trading* - https://coindcx.com/api/help/High%20Frequency%20Trading/ - `https://hft-api.coindcx.com`, enterprise access, static IP registered as Trusted.
- CoinDCX support, *What can I do using API?* - https://support.coindcx.com/articles/permissions-access/what-can-i-do-using-api/6a7d8f01949bb8a5b6f4ac8b - capability list: place limit orders, place market orders, funds balance, account details.
- `_sources/coindcx-docs.txt` - searched for any withdrawal endpoint; none exists. The only fund-moving endpoints are `wallets/transfer`, `wallets/sub_account_transfer` and the futures wallet transfer.
- All help and support pages were fetched with `curl -sS -L -A "Mozilla/5.0"` on 2026-09-04; `WebFetch` returns 403 for both hosts.
- Cross-references: `01-coindcx-spot-rest.md`, `03-coindcx-futures-orders-rest.md` (the 10 s signing window), `06-coindcx-auth-ratelimits-errors-tos.md` (byte-exact signing), `11-positions-ledger-pnl.md` (typed vs actual balance), `17-architecture-stack.md` (hosting and KMS region), `18-testing-correctness-program.md` (canary test), `20-ops-audit-runbook.md` (restore drill, support workflow), `22-nonfunctional-slos-capacity.md` (KMS latency budget, rate limits).




