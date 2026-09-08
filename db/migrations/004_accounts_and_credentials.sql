-- 004_accounts_and_credentials.sql
-- plan/phase-02 T02.1 · DATA-MODEL.md domains 2 and 3
--
-- The phase doc calls this "migration 002". It is 004: 002 created the audit
-- partitions and 003 fixed the schema-scope bug in their maintenance function.
-- The phase-01 delta (`market_metadata`, `fx_snapshot`) becomes 005.
--
-- The phase doc's acceptance also asks to "migrate up and down cleanly". There
-- are no down migrations here by design (20 F5): a code rollback must never
-- require a schema rollback, so corrections ship forward. Read that criterion as
-- "applies cleanly to an empty database and is idempotent to re-check".
--
-- ONE DEPARTURE FROM DATA-MODEL, and it is a strengthening.
--
-- DATA-MODEL's invariant table lists "every row tenant-scoped" as enforced by
-- "`tenant_id NOT NULL` + the query layer", and calls the cross-tenant leak the
-- unrecoverable failure. But the same table's thesis is that an invariant worth
-- having is one that "holds regardless of who is typing at 2am" — and a plain
-- `tenant_id` column does not stop a row from claiming tenant A while pointing
-- at tenant B's account. Nothing in the schema would object; the row would read
-- as valid forever.
--
-- So every tenant-scoped child here carries a COMPOSITE foreign key:
--
--   FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id)
--
-- which makes a cross-tenant row unrepresentable rather than merely unwritten.
-- The cost is one extra unique index on the parent. For the one failure the
-- research calls unrecoverable, that is a cheap price.

BEGIN;

-- ---------------------------------------------------------- exchange_account
CREATE TABLE exchange_account (
  id                                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                         uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  name                              text NOT NULL CHECK (length(btrim(name)) > 0),
  exchange                          text NOT NULL DEFAULT 'coindcx'
                                      CHECK (exchange IN ('coindcx')),

  -- The percentage-sizing basis (09 F4). What the customer typed at onboarding,
  -- in the currency they funded with — NOT a live balance.
  allocated_capital_minor           numeric(38,0) NOT NULL CHECK (allocated_capital_minor >= 0),
  allocated_currency                text NOT NULL CHECK (allocated_currency IN ('INR','USDT')),
  -- The real balance displayed when they confirmed it. Kept so a divergence
  -- months later is explainable rather than an argument (T02.5).
  allocated_confirmed_against_minor numeric(38,0) CHECK (allocated_confirmed_against_minor >= 0),
  allocated_confirmed_at            timestamptz,

  -- DERIVED from observed balances, never typed (T02.6). Empty until the first
  -- successful balance read.
  funding_currencies                text[] NOT NULL DEFAULT '{}',

  status                            text NOT NULL DEFAULT 'pending_validation'
                                      CHECK (status IN ('pending_validation','active','suspended','disconnected')),
  created_at                        timestamptz NOT NULL DEFAULT now(),
  disconnected_at                   timestamptz,

  -- The parent side of every composite tenant FK below.
  CONSTRAINT exchange_account_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT exchange_account_name_unique UNIQUE (tenant_id, name),
  CONSTRAINT exchange_account_disconnected_at
    CHECK (status <> 'disconnected' OR disconnected_at IS NOT NULL),
  -- Both halves of the confirmation, or neither. A figure with no timestamp
  -- cannot be defended later.
  CONSTRAINT exchange_account_confirmed_pair
    CHECK ((allocated_confirmed_against_minor IS NULL) = (allocated_confirmed_at IS NULL)),
  -- Funding currencies are quote currencies, not holdings: BTC belongs in
  -- account_balance, never here.
  CONSTRAINT exchange_account_funding_currencies
    CHECK (funding_currencies <@ ARRAY['INR','USDT']::text[])
);
CREATE INDEX exchange_account_tenant_status_idx ON exchange_account (tenant_id, status);

-- ------------------------------------------------------- exchange_credential
-- Nothing readable lives here. The API key and secret are each AES-256-GCM
-- ciphertext under a per-credential DEK, and the DEK itself is wrapped by the
-- KMS CMK. `api_key_last4` and `fingerprint` are the only fields anyone can act
-- on without KMS, and neither reverses to a key (07 F4).
CREATE TABLE exchange_credential (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  account_id         uuid NOT NULL REFERENCES exchange_account(id) ON DELETE RESTRICT,
  exchange           text NOT NULL DEFAULT 'coindcx' CHECK (exchange IN ('coindcx')),

  key_version        smallint NOT NULL DEFAULT 1 CHECK (key_version > 0),
  kms_key_arn        text  NOT NULL CHECK (length(kms_key_arn) > 0),
  -- NULLed on revoke: that is the crypto-shred. The row survives for audit.
  dek_wrapped        bytea,
  api_key_ct         bytea NOT NULL,
  api_key_nonce      bytea NOT NULL CHECK (length(api_key_nonce) = 12),
  api_key_tag        bytea NOT NULL CHECK (length(api_key_tag) = 16),
  api_secret_ct      bytea NOT NULL,
  api_secret_nonce   bytea NOT NULL CHECK (length(api_secret_nonce) = 12),
  api_secret_tag     bytea NOT NULL CHECK (length(api_secret_tag) = 16),

  api_key_last4      text  NOT NULL CHECK (length(api_key_last4) = 4),
  -- HMAC(pepper, api_key). Detects the same key added twice without storing it.
  fingerprint        bytea NOT NULL CHECK (length(fingerprint) = 32),
  status             text  NOT NULL DEFAULT 'pending_validation'
                       CHECK (status IN ('pending_validation','active','revoked','failed_auth')),
  validated_at       timestamptz,
  last_auth_error_at timestamptz,
  auth_error_count   int NOT NULL DEFAULT 0 CHECK (auth_error_count >= 0),
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,

  -- One live credential per account, and one CoinDCX key per tenant. Both are
  -- races an application check cannot win, and the second is a security property.
  CONSTRAINT exchange_credential_account_unique UNIQUE (account_id),
  CONSTRAINT exchange_credential_fingerprint_unique UNIQUE (tenant_id, fingerprint),
  -- A credential cannot be active with no key to decrypt it.
  CONSTRAINT exchange_credential_active_has_dek
    CHECK (status <> 'active' OR dek_wrapped IS NOT NULL),
  -- And revocation must actually be a shred, not a status change. Without this,
  -- "revoked" is a label and the ciphertext is still openable.
  CONSTRAINT exchange_credential_revoked_is_shredded
    CHECK (status <> 'revoked' OR (dek_wrapped IS NULL AND revoked_at IS NOT NULL)),
  CONSTRAINT exchange_credential_nonces_differ CHECK (api_key_nonce <> api_secret_nonce),
  -- The composite tenant FK: this credential's tenant and its account's tenant
  -- are the same row, enforced here rather than hoped for in the query layer.
  CONSTRAINT exchange_credential_tenant_account_fk
    FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX exchange_credential_tenant_status_idx ON exchange_credential (tenant_id, status);

-- ----------------------------------------------------------- account_balance
-- Current state only, updated in place. `scale` is stored per row rather than
-- inferred from the currency: INR is 2 and USDT is 8 today, and a reader that
-- guesses is a reader that is wrong by 10^6 the first time that changes.
--
-- Total held = free + locked. A sell sizes against `free` alone (11 F1) —
-- locked funds are already committed to an open order.
CREATE TABLE account_balance (
  tenant_id    uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  account_id   uuid NOT NULL,
  -- Any currency the account holds, including BTC and ETH. Not restricted to
  -- the quote currencies: this is a holdings table, not a funding one.
  currency     text NOT NULL CHECK (currency = upper(currency) AND length(currency) BETWEEN 2 AND 16),
  free_minor   numeric(38,0) NOT NULL CHECK (free_minor >= 0),
  locked_minor numeric(38,0) NOT NULL DEFAULT 0 CHECK (locked_minor >= 0),
  scale        smallint NOT NULL CHECK (scale BETWEEN 0 AND 18),
  observed_at  timestamptz NOT NULL,
  PRIMARY KEY (account_id, currency),
  CONSTRAINT account_balance_tenant_account_fk
    FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX account_balance_tenant_currency_idx ON account_balance (tenant_id, currency);

-- -------------------------------------------------------- account_market_seen
-- Empty until fills arrive in Phase 07. It exists now because it is the anomaly
-- signal for the 16 F2 attack shape: a stolen key trading a market this account
-- has never touched.
CREATE TABLE account_market_seen (
  tenant_id     uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  account_id    uuid NOT NULL,
  market        text NOT NULL CHECK (length(market) > 0),
  first_fill_at timestamptz NOT NULL,
  last_fill_at  timestamptz NOT NULL,
  fill_count    integer NOT NULL DEFAULT 1 CHECK (fill_count > 0),
  PRIMARY KEY (account_id, market),
  CONSTRAINT account_market_seen_ordered CHECK (last_fill_at >= first_fill_at),
  CONSTRAINT account_market_seen_tenant_account_fk
    FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account (tenant_id, id) ON DELETE RESTRICT
);

COMMIT;
