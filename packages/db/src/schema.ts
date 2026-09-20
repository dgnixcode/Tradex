// The database shape for migrations 001-004 — plan/phase-00 T00.5, phase-02 T02.1.
// Mirrors DATA-MODEL.md domains 1, 2, 3 and 7. Later migrations extend this.
//
// Note every money and id column is `string`, not `number`. That is not a
// stylistic choice: `pg` returns `numeric`, `decimal` and `int8` as strings so a
// value cannot be destroyed by a double, and these types must say so or the
// first `Number(...)` will look reasonable in review.

import type { ColumnType, Generated } from 'kysely';

/** `timestamptz` — written as Date, read as Date. */
type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** `numeric(38,0)` — always a string in and out. */
type Numeric = ColumnType<string, string, string>;
/** A `numeric(38,0)` the venue may not have reported yet. */
type NumericOrNull = ColumnType<string | null, string | null, string | null>;
/** `bigserial` — generated, and read as a string because int8 exceeds 2^53. */
type BigSerial = Generated<string>;

export type TenantStatus = 'active' | 'suspended' | 'closed';
export type KycStatus = 'not_collected' | 'pending' | 'verified' | 'rejected';
export type UserRole = 'owner' | 'trader' | 'viewer';
export type PlatformMode = 'normal' | 'cancel_only' | 'read_only';

export interface TenantTable {
  id: Generated<string>;
  name: string;
  valuation_currency: 'INR' | 'USDT';
  kyc_status: KycStatus;
  kyc_verified_at: Timestamp | null;
  gstin: string | null;
  status: TenantStatus;
  created_at: Generated<Timestamp>;
  closed_at: Timestamp | null;
}

export interface AppUserTable {
  id: Generated<string>;
  tenant_id: string;
  email: string;
  password_hash: string;
  totp_secret_ct: Uint8Array | null;
  totp_enabled: Generated<boolean>;
  role: UserRole;
  last_login_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  disabled_at: Timestamp | null;
  is_master: Generated<boolean>;
}

export interface TenantLimitTable {
  tenant_id: string;
  max_accounts: Generated<number>;
  max_accounts_per_group: Generated<number>;
  max_groups: Generated<number>;
  max_order_notional_minor: Numeric;
  max_daily_notional_minor: Numeric;
  typed_confirm_above_minor: Numeric;
  trading_paused: Generated<boolean>;
  paused_at: Timestamp | null;
  paused_reason: string | null;
}

/** Single row, id fixed to 'singleton'. The global brake (plan/phase-05). */
export interface PlatformStateTable {
  id: string;
  global_kill_switch: Generated<boolean>;
  mode: Generated<PlatformMode>;
  mode_reason: string | null;
  changed_at: Generated<Timestamp>;
  changed_by: string | null;
}

/** The market-scope switch (phase 05). GLOBAL — a halted market is halted for every tenant. */
export interface MarketStateTable {
  market: string;
  mode: Generated<'normal' | 'cancel_only' | 'read_only'>;
  reason: string | null;
  changed_at: Generated<Timestamp>;
  changed_by: string | null;
}

/** Append-only. The application role holds INSERT and SELECT only. */
export interface AuditEventTable {
  id: BigSerial;
  tenant_id: string;
  actor_user_id: string | null;
  actor_process: string;
  action: string;
  subject_type: string;
  subject_id: string;
  before: unknown | null;
  after: unknown | null;
  ip: string | null;
  user_agent: string | null;
  occurred_at: Generated<Timestamp>;
}

export interface SchemaMigrationTable {
  version: string;
  applied_at: Generated<Timestamp>;
  checksum: string;
}

/**
 * A server-side session a signed cookie points at (migration 009). GLOBAL on
 * purpose: a session is read to DISCOVER the tenant, so it carries user_id, not
 * tenant_id, and the tenant is reached through app_user. `token_hash` is
 * sha256(raw token) — the raw token lives only in the cookie, never here.
 */
export interface SessionTable {
  id: Generated<string>;
  user_id: string;
  token_hash: Uint8Array;
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
  reauth_at: Timestamp | null;
  revoked_at: Timestamp | null;
}

export interface PasswordResetTokenTable {
  id: Generated<string>;
  user_id: string;
  token_hash: Uint8Array;
  created_at: Generated<Timestamp>;
  expires_at: Timestamp;
  used_at: Timestamp | null;
}

export type InquiryStatus = 'new' | 'contacted' | 'onboarded' | 'archived';

export interface ConsultationInquiryTable {
  id: Generated<string>;
  name: string;
  email: string;
  phone: string;
  capital: string;
  exchange: string;
  method: string;
  notes: string | null;
  status: Generated<InquiryStatus>;
  created_at: Generated<Timestamp>;
  contacted_at: Timestamp | null;
  contacted_by: string | null;
}

export interface PlatformBrandingTable {
  id: Generated<string>;
  name: string;
  logo: string | null;
  email: string;
  phone: string;
  whatsapp: string;
  address: string;
  hours: string;
  updated_at: Generated<Timestamp>;
  updated_by: string | null;
}

export interface LoginIpAttemptTable {
  ip: string;
  failed_attempts: Generated<number>;
  last_attempt_at: Generated<Timestamp>;
  blocked_until: Timestamp | null;
  created_at: Generated<Timestamp>;
}

// ------------------------------------------------- domains 2 and 3 (migration 004)

export type SupportedQuote = 'INR' | 'USDT';
export type AccountStatus = 'pending_validation' | 'active' | 'suspended' | 'disconnected';
export type CredentialStatus = 'pending_validation' | 'active' | 'revoked' | 'failed_auth';

export interface ExchangeAccountTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  exchange: Generated<'coindcx'>;
  /**
   * The percentage-sizing basis (09 F4) — the free balance the EXCHANGE reported
   * when the account was connected, not a figure the customer typed. NULL while
   * the account is `pending_validation` and the venue has not answered yet
   * (migration 015). The two are always set together.
   */
  allocated_capital_minor: NumericOrNull;
  allocated_currency: SupportedQuote | null;
  /** The venue's figure, stamped at the moment of activation. */
  allocated_confirmed_against_minor: Numeric | null;
  allocated_confirmed_at: Timestamp | null;
  /** DERIVED from observed balances, never from user input (T02.6). */
  funding_currencies: Generated<SupportedQuote[]>;
  status: Generated<AccountStatus>;
  /** Per-account order-cap override (phase 05). NULL = fall back to tenant_limit. */
  max_order_notional_minor: Numeric | null;
  /** Account-frozen scope (phase 05). Both halves travel together. */
  frozen_at: Timestamp | null;
  frozen_reason: string | null;
  created_at: Generated<Timestamp>;
  disconnected_at: Timestamp | null;
}

/**
 * Nothing readable. Both the key and the secret are AES-256-GCM ciphertext under
 * a per-credential DEK, and the DEK is wrapped by the KMS CMK. `api_key_last4`
 * and `fingerprint` are the only fields usable without KMS, and neither reverses.
 */
export interface ExchangeCredentialTable {
  id: Generated<string>;
  tenant_id: string;
  account_id: string;
  exchange: Generated<'coindcx'>;
  key_version: Generated<number>;
  kms_key_arn: string;
  /** NULL after revocation: that is the crypto-shred, and the row stays for audit. */
  dek_wrapped: Uint8Array | null;
  api_key_ct: Uint8Array;
  api_key_nonce: Uint8Array;
  api_key_tag: Uint8Array;
  api_secret_ct: Uint8Array;
  api_secret_nonce: Uint8Array;
  api_secret_tag: Uint8Array;
  api_key_last4: string;
  /** HMAC(pepper, api_key). Detects a duplicate key without storing the key. */
  fingerprint: Uint8Array;
  status: Generated<CredentialStatus>;
  validated_at: Timestamp | null;
  last_auth_error_at: Timestamp | null;
  auth_error_count: Generated<number>;
  created_at: Generated<Timestamp>;
  revoked_at: Timestamp | null;
}

/** Current state, updated in place. A sell sizes against `free` alone (11 F1). */
export interface AccountBalanceTable {
  tenant_id: string;
  account_id: string;
  /** Any held currency, including BTC and ETH — not just the quote currencies. */
  currency: string;
  free_minor: Numeric;
  locked_minor: Generated<Numeric>;
  /** Stored per row: a reader that infers scale from the currency is wrong once. */
  scale: number;
  observed_at: Timestamp;
}

/** Empty until Phase 07. The anomaly signal for the 16 F2 attack shape. */
export interface AccountMarketSeenTable {
  tenant_id: string;
  account_id: string;
  market: string;
  first_fill_at: Timestamp;
  last_fill_at: Timestamp;
  fill_count: Generated<number>;
}

// -------------------------------------------------- domain 5 (migration 011)

export type LedgerKind =
  | 'trade_buy' | 'trade_sell' | 'fee' | 'tds'
  | 'conversion_in' | 'conversion_out' | 'external_adjustment' | 'correction';

/** One leg of a fill — append-only, partitioned monthly by occurred_at (T07.1). */
export interface LedgerEntryTable {
  id: BigSerial;
  tenant_id: string;
  account_id: string;
  kind: LedgerKind;
  asset: string;
  quote_asset: string | null;
  /** Signed minor units of `asset`. */
  delta_minor: Numeric;
  scale: number;
  price: string | null;
  child_order_id: string | null;
  exchange_trade_id: string | null;
  fee_minor: Numeric | null;
  tds_minor: Numeric | null;
  estimated: Generated<boolean>;
  occurred_at: Timestamp;
  recorded_at: Generated<Timestamp>;
}

/** The DERIVED projection — qty/cost/realised in minor units; rebuilt, never the source. */
export interface HoldingTable {
  tenant_id: string;
  account_id: string;
  asset: string;
  qty: string;
  cost_total_minor: Numeric;
  realised_pnl_minor: Numeric;
  fee_drag_minor: Numeric;
  tds_withheld_minor: Numeric;
  quote_asset: SupportedQuote;
  rebuilt_at: Timestamp;
}

// -------------------------------------------------------- domain 6 (migration 005)

/**
 * A versioned snapshot of `markets_details`, one row per market per version.
 * Insert-only, enforced by a trigger: an order records the version it was
 * legalised against, and if that version can be edited then every past order
 * silently re-legalises against today's numbers (X10, L10).
 *
 * The venue decimals are `text`, not `numeric`, and deliberately so — see the
 * migration header. A `numeric(38,18)` column re-renders 566.6666666666666 as
 * 566.666666666600000000, losing the venue's own literal, and the number of
 * decimal places is itself information the sizing layer reads.
 */
export interface MarketMetadataTable {
  version: string;
  venue_symbol: string;
  /** OUR naming: `asset` is what CoinDCX calls the target currency. */
  asset: string;
  quote: SupportedQuote;
  /** The venue's status string, verbatim, for forensics. */
  status: string;
  /** Derived from `status`; a CHECK keeps the two consistent. */
  tradable: boolean;
  quantity_step: string;
  quantity_precision: number;
  price_precision: number;
  min_quantity: string;
  max_quantity: string;
  /** Documented by the venue but absent from every live row (09 F6). */
  min_market_quantity: string | null;
  /** Depth-derived and moving; the binding cap on a market order. */
  max_market_quantity: string | null;
  min_notional_minor: Numeric;
  min_price: string;
  max_price: string;
  order_types: ('market' | 'limit')[];
  venue_code: string;
  observed_at: Timestamp;
  source: string;
  ingested_at: Generated<Timestamp>;
}

export type FxSource =
  | 'coindcx_ticker_last'
  | 'coindcx_ticker_bid'
  | 'coindcx_ticker_ask'
  | 'coindcx_orderbook_mid';

/**
 * An immutable rate sample. Insert-only, enforced by a trigger, because a stored
 * rate is never refreshed (10 F4): re-resolving one makes last month's P&L move.
 * The `cross_*` columns record the BTCUSDT x USDTINR versus BTCINR check, with a
 * CHECK constraint that `cross_alarmed` agrees with the stored drift.
 */
export interface FxSnapshotTable {
  id: BigSerial;
  base: string;
  quote: string;
  /** Units of `quote` per one `base`. Plain decimal, exactly as observed. */
  rate: string;
  source: FxSource;
  observed_at: Timestamp;
  cross_base_rate: string | null;
  cross_quote_rate: string | null;
  /** Signed integer basis points. */
  cross_drift_bp: Numeric | null;
  cross_threshold_bp: Numeric | null;
  cross_alarmed: boolean | null;
  created_at: Generated<Timestamp>;
}

// ------------------------------------------------- domain 4 (migrations 006, 007)

export type TradeSide = 'buy' | 'sell';
/** Our canonical order type — 'market'/'limit', never the venue's *_order form. */
export type CanonicalOrderType =
  | 'market' | 'limit'
  | 'stop_market' | 'stop_limit' | 'take_profit_market' | 'take_profit_limit';
export type SizingMode =
  | 'quote_amount' | 'base_quantity' | 'pct_allocated' | 'pct_equity'
  | 'pct_free' | 'pct_position' | 'sell_all';
export type GroupTradeStatus = 'draft' | 'previewed' | 'executing' | 'completed' | 'abandoned';
export type ChildOrderPriceSource = 'book_ask' | 'book_bid' | 'limit';
export type ExecutionJobKind = 'place' | 'resolve' | 'cancel' | 'poll';
/** No transition legality is encoded here or in the CHECK — application logic owns it (12 F1). */
export type ChildOrderState =
  | 'planned' | 'skipped' | 'sending' | 'ambiguous' | 'not_placed' | 'acked' | 'open'
  | 'partially_filled' | 'filled' | 'cancelled' | 'partially_cancelled'
  | 'rejected' | 'unknown' | 'needs_human'
  | 'untriggered' | 'sl_hit' | 'tp_hit' | 'liquidated';

/** Which leg of a futures group trade a child_order carries. Spot rows are always 'entry'. */
export type LegKind = 'entry' | 'stop_loss' | 'take_profit';

/** Trigger lifecycle of a conditional (SL/TP) leg. Null on non-conditional legs. */
export type TriggerState = 'untriggered' | 'triggered' | 'expired';

/** Margin currency of a futures position — venue offers both. */
export type MarginCurrency = 'INR' | 'USDT';

/** How the venue holds margin against a position (research/03 F4). */
export type PositionMarginType = 'isolated' | 'crossed';

/**
 * A named subset of a tenant's accounts. Called `account_group`, not `group`:
 * the reserved word would need quoting everywhere and is invisible to the
 * identifier parser in checks/00-tenant-isolation.check.mjs (migration 006 header).
 */
export interface AccountGroupTable {
  id: Generated<string>;
  tenant_id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: Generated<Timestamp>;
  archived_at: Timestamp | null;
}

/**
 * Many-to-many membership. Composite primary key (group_id, account_id) — no
 * `id`, like account_balance — so `byId` cannot be called on it. `weight_bp` and
 * `max_notional_minor` exist but are UNUSED in v1.
 */
export interface GroupMemberTable {
  tenant_id: string;
  group_id: string;
  account_id: string;
  display_order: Generated<number>;
  enabled: Generated<boolean>;
  weight_bp: number | null;
  max_notional_minor: Numeric | null;
  added_at: Generated<Timestamp>;
}

/**
 * One customer decision fanned out across a group. Holds the capture-or-lose
 * fields shared by all children (14 F2): `decision_mid` captured before any
 * sizing, the fx and market-metadata versions the plan was computed against, and
 * the code version. `preview_token` is the only thing that can later be confirmed.
 */
export interface GroupTradeTable {
  id: Generated<string>;
  tenant_id: string;
  group_id: string;
  created_by: string;
  asset: string;
  side: TradeSide;
  order_type: CanonicalOrderType;
  sizing_mode: SizingMode;
  sizing_value: string | null;
  limit_price: string | null;
  status: Generated<GroupTradeStatus>;
  preview_token: string | null;
  preview_expires_at: Timestamp | null;
  decision_mid: string | null;
  fx_snapshot_id: string | null;
  market_meta_version: string | null;
  code_version: string | null;
  dry_run: Generated<boolean>;
  send_suppressed: Generated<boolean>;
  submitted_at: Timestamp | null;
  completed_at: Timestamp | null;
  created_at: Generated<Timestamp>;
  submitted_from_ip: string | null;
  // phase-15 futures additions. is_futures is the top-level branch; the other
  // columns are only meaningful when it's true (schema CHECK enforces).
  is_futures: Generated<boolean>;
  leverage: string | null;
  margin_currency: MarginCurrency | null;
  quote_currency: SupportedQuote | null;
  position_margin_type: PositionMarginType | null;
  stop_loss_price: string | null;
  take_profit_price: string | null;
  trailing_stop_loss: Generated<boolean>;
  trailing_distance_bp: string | null;
  trailing_step_bp: string | null;
  reduce_only: Generated<boolean>;
}

/**
 * One leg of a group trade: what one account will do, or why it was skipped. The
 * row the confirmation table renders one-for-one (U2). Exact decimals (prices,
 * quantities, rates) are `string` because the column is the `venue_decimal`
 * domain (text), not numeric — same reasoning as market_metadata.
 */
export interface ChildOrderTable {
  id: Generated<string>;
  tenant_id: string;
  group_trade_id: string;
  account_id: string;
  leg_seq: Generated<number>;
  market: string | null;
  pair: string | null;
  market_ecode: string | null;
  quote_currency: SupportedQuote | null;
  currency_choice_reason: string | null;
  basis_used: string | null;
  basis_amount_minor: Numeric | null;
  price_source: ChildOrderPriceSource | null;
  price_used: string | null;
  fee_rate_assumed: string | null;
  tds_rate_applied: string | null;
  raw_quantity: string | null;
  final_quantity: string | null;
  notional_minor: Numeric | null;
  clamped_from_quantity: string | null;
  book_observed_at: Timestamp | null;
  spread_bp: Numeric | null;
  slippage_bp: Numeric | null;
  state: ChildOrderState;
  refusal_code: string | null;
  refusal_detail: string | null;
  client_order_id: string | null;
  exchange_order_id: string | null;
  exchange_status_raw: string | null;
  filled_quantity: Generated<string>;
  remaining_quantity: string | null;
  cancelled_quantity: Generated<string>;
  avg_fill_price: string | null;
  fee_amount_minor: Numeric | null;
  exchange_group_id: string | null;
  sent_at: Timestamp | null;
  last_observed_at: Timestamp | null;
  terminal_at: Timestamp | null;
  resolve_attempts: Generated<number>;
  divergence_count: Generated<number>;
  created_at: Generated<Timestamp>;
  // phase-15 futures additions.
  leg_kind: Generated<LegKind>;
  linked_entry_child_order_id: string | null;
  trigger_state: TriggerState | null;
  venue_position_id: string | null;
}

/**
 * The scheduler queue. Empty until Phase 06. Listed as tenant-scoped so no
 * builder use escapes scoping, but the worker's cross-tenant claim query uses the
 * raw Kysely handle (FOR UPDATE SKIP LOCKED) — TenantDb is a choke point, not the
 * only door.
 */
export interface ExecutionJobTable {
  id: BigSerial;
  child_order_id: string;
  tenant_id: string;
  kind: ExecutionJobKind;
  run_after: Generated<Timestamp>;
  attempts: Generated<number>;
  locked_by: string | null;
  locked_at: Timestamp | null;
  last_error: string | null;
  created_at: Generated<Timestamp>;
}

/**
 * A cached mirror of the venue's futures position row. REST is the source of
 * truth (research/04 D6); this table is what the positions view reads and what
 * the reconciler refreshes. Holds mark_price / liquidation_price / margin —
 * that is exactly the §6a carve-out futures requires (recorded in the
 * 07-no-mark-to-market allowlist).
 */
export interface FuturesPositionTable {
  id: Generated<string>;
  tenant_id: string;
  account_id: string;
  pair: string;
  margin_currency: MarginCurrency;
  venue_position_id: string;
  /** Signed base quantity: positive = long, negative = short, 0 = closed. */
  active_pos: string;
  avg_entry_price: string | null;
  mark_price: string | null;
  mark_observed_at: Timestamp | null;
  liquidation_price: string | null;
  leverage: string | null;
  locked_margin_minor: Numeric | null;
  take_profit_trigger: string | null;
  stop_loss_trigger: string | null;
  margin_type: PositionMarginType | null;
  funding_rate_bp: number | null;
  settlement_currency_avg_price: string | null;
  opened_at?: Generated<Timestamp>;
  exchange_updated_at?: Timestamp | null;
  updated_at: Generated<Timestamp>;
}

/**
 * The anti-duplicate-order substitute for the missing `client_order_id` on
 * futures (research/03 Verdict). A leg holds the (account_id, pair) row-lock
 * across write-before-send and the read-back window; INSERT ON CONFLICT DO
 * NOTHING is the atomic race. Stale locks are reaped by the same boot reaper
 * and periodic sweep that clears execution_job locks.
 */
export interface FuturesExecutionLockTable {
  tenant_id: string;
  account_id: string;
  pair: string;
  child_order_id: string;
  acquired_at: Generated<Timestamp>;
  locked_by: string;
}

/**
 * Backend-driven stepped trailing stop loss (phase-15 additions).
 */
export interface FuturesTrailingSlTable {
  id: BigSerial;
  tenant_id: string;
  account_id: string;
  venue_position_id: string;
  pair: string;
  distance_bp: Numeric;
  step_bp: Numeric;
  high_water_mark: Numeric;
  current_sl_price: Numeric;
  status: 'active' | 'updating' | 'failed' | 'closed';
  last_evaluated_at: Timestamp;
}

export interface DB {
  session: SessionTable;
  tenant: TenantTable;
  app_user: AppUserTable;
  tenant_limit: TenantLimitTable;
  platform_state: PlatformStateTable;
  market_state: MarketStateTable;
  audit_event: AuditEventTable;
  schema_migration: SchemaMigrationTable;
  exchange_account: ExchangeAccountTable;
  exchange_credential: ExchangeCredentialTable;
  account_balance: AccountBalanceTable;
  account_market_seen: AccountMarketSeenTable;
  market_metadata: MarketMetadataTable;
  fx_snapshot: FxSnapshotTable;
  ledger_entry: LedgerEntryTable;
  holding: HoldingTable;
  account_group: AccountGroupTable;
  group_member: GroupMemberTable;
  group_trade: GroupTradeTable;
  child_order: ChildOrderTable;
  execution_job: ExecutionJobTable;
  futures_position: FuturesPositionTable;
  futures_execution_lock: FuturesExecutionLockTable;
  futures_trailing_sl: FuturesTrailingSlTable;
  password_reset_token: PasswordResetTokenTable;
  consultation_inquiry: ConsultationInquiryTable;
  platform_branding: PlatformBrandingTable;
  login_ip_attempt: LoginIpAttemptTable;
}

/**
 * Tables carrying `tenant_id`. The scoping layer refuses to build a query
 * against any of these without a tenant context — see tenant-scope.ts.
 *
 * Adding a tenant-scoped table without adding it here is the mistake that
 * produces a cross-tenant leak, so the check script in
 * checks/00-tenant-isolation.check.mjs cross-references this list against the
 * migration SQL.
 */
export const TENANT_SCOPED_TABLES = [
  'app_user',
  'tenant_limit',
  'audit_event',
  'exchange_account',
  'exchange_credential',
  'account_balance',
  'account_market_seen',
  'ledger_entry',
  'holding',
  'account_group',
  'group_member',
  'group_trade',
  'child_order',
  'execution_job',
  'futures_position',
  'futures_execution_lock',
  'futures_trailing_sl',
] as const satisfies readonly (keyof DB)[];

export type TenantScopedTable = (typeof TENANT_SCOPED_TABLES)[number];

const scoped: ReadonlySet<string> = new Set(TENANT_SCOPED_TABLES);
export const isTenantScoped = (table: string): table is TenantScopedTable => scoped.has(table);


/**
 * Tables deliberately global: reference data and the platform-wide brake.
 *
 * `market_metadata` and `fx_snapshot` are market data, identical for every
 * tenant, so scoping them would duplicate 999 rows per customer and make one
 * tenant's legalisation differ from another's for no reason. They carry no
 * `tenant_id`, which `checks/00-tenant-isolation.check.mjs` cross-references.
 */
export const GLOBAL_TABLES = [
  'tenant', 'platform_state', 'schema_migration', 'market_metadata', 'fx_snapshot', 'session', 'market_state', 'password_reset_token', 'consultation_inquiry', 'platform_branding', 'login_ip_attempt',
] as const;

/** Tables a trigger makes append-only. Probed by 03-fx-snapshot.check.mjs. */
export const APPEND_ONLY_TABLES = ['market_metadata', 'fx_snapshot'] as const satisfies readonly (keyof DB)[];
