// Live-state reads for the planning stage — plan/phase-04 T04.3, T04.4.
//
// The twelve gates in @tradex/sizing are pure: they take the account's live
// state as VALUES. This file is where those values come from. Each function
// turns database rows into exactly the shape `planAccount` expects, and nothing
// here decides anything — the decisions all live in the pure gate function, so
// they stay unit-testable with no database.
//
// platform_state is read through the UNSCOPED db because it is a global table
// (one singleton row, the same for every tenant). Everything else is
// tenant-scoped and read through TenantDb, so a planning run for one tenant can
// never see another's balances, limits or in-flight orders.

import type { Kysely } from 'kysely';
import type { Balance } from '@tradex/exchange';
import type { DB, PlatformMode, SupportedQuote } from './schema.js';
import type { TenantDb } from './tenant-scope.js';

export class PlanStateError extends Error {
  override readonly name = 'PlanStateError';
}

export interface PlatformFlags {
  readonly killSwitch: boolean;
  readonly mode: PlatformMode;
  readonly modeReason: string | null;
}

/** The global brake. Read unscoped: platform_state is one row for everyone. */
export async function readPlatformFlags(db: Kysely<DB>): Promise<PlatformFlags> {
  const row = await db.selectFrom('platform_state')
    .select(['global_kill_switch', 'mode', 'mode_reason'])
    .where('id', '=', 'singleton')
    .executeTakeFirst();
  // A missing singleton is treated as KILLED, not as "all clear": the safe
  // default when the brake's own state cannot be read is to refuse to trade.
  if (row === undefined) return { killSwitch: true, mode: 'read_only', modeReason: 'platform_state missing' };
  return { killSwitch: row.global_kill_switch, mode: row.mode, modeReason: row.mode_reason };
}

export interface PlatformKillSwitchDetails extends PlatformFlags {
  readonly active: boolean;
  readonly reason: string | null;
  readonly changedAt: Date | null;
  readonly changedBy: string | null;
}

/** Read full kill switch details including timestamp and operator who toggled it. */
export async function readPlatformKillSwitchDetails(db: Kysely<DB>): Promise<PlatformKillSwitchDetails> {
  const row = await db.selectFrom('platform_state')
    .select(['global_kill_switch', 'mode', 'mode_reason', 'changed_at', 'changed_by'])
    .where('id', '=', 'singleton')
    .executeTakeFirst();
  if (row === undefined) {
    return {
      active: true,
      killSwitch: true,
      mode: 'read_only',
      reason: 'platform_state missing',
      modeReason: 'platform_state missing',
      changedAt: null,
      changedBy: null,
    };
  }
  const at = row.changed_at ? new Date(row.changed_at as unknown as string | number | Date) : null;
  return {
    active: row.global_kill_switch || row.mode === 'read_only',
    killSwitch: row.global_kill_switch,
    mode: row.mode,
    reason: row.mode_reason,
    modeReason: row.mode_reason,
    changedAt: at,
    changedBy: row.changed_by,
  };
}

/**
 * Toggle the global kill switch.
 *
 * When active:
 * - mode becomes 'read_only'
 * - all order creation, position exit, adjust, and TP/SL mutations are blocked.
 */
export async function setPlatformKillSwitch(
  db: Kysely<DB>,
  active: boolean,
  reason?: string,
  changedBy?: string,
): Promise<PlatformKillSwitchDetails> {
  const mode: PlatformMode = active ? 'read_only' : 'normal';
  const modeReason = active ? (reason ?? 'emergency kill switch active') : null;
  const at = new Date();

  await db.updateTable('platform_state')
    .set({
      global_kill_switch: active,
      mode,
      mode_reason: modeReason,
      changed_at: at,
      changed_by: changedBy ?? null,
    } as never)
    .where('id' as never, '=', 'singleton' as never)
    .execute();

  return {
    active,
    killSwitch: active,
    mode,
    reason: modeReason,
    modeReason,
    changedAt: at,
    changedBy: changedBy ?? null,
  };
}

export interface TenantCaps {
  readonly perOrderNotionalMinor: string;
  readonly dailyNotionalMinor: string;
  readonly typedConfirmAboveMinor: string;
  readonly tradingPaused: boolean;
  readonly pausedReason: string | null;
  readonly pausedAt: Date | null;
}

/** The tenant's caps and its own kill switch, from tenant_limit. */
export async function readTenantCaps(tdb: TenantDb): Promise<TenantCaps> {
  const row = await tdb.selectFrom('tenant_limit')
    .select(['max_order_notional_minor', 'max_daily_notional_minor', 'typed_confirm_above_minor', 'trading_paused', 'paused_reason', 'paused_at'])
    .executeTakeFirst();
  if (row === undefined) throw new PlanStateError('this tenant has no tenant_limit row — it was not provisioned');
  const r = row as {
    max_order_notional_minor: string; max_daily_notional_minor: string;
    typed_confirm_above_minor: string; trading_paused: boolean;
    paused_reason: string | null; paused_at: Date | string | null;
  };
  return {
    perOrderNotionalMinor: r.max_order_notional_minor,
    dailyNotionalMinor: r.max_daily_notional_minor,
    typedConfirmAboveMinor: r.typed_confirm_above_minor,
    tradingPaused: r.trading_paused,
    pausedReason: r.paused_reason,
    pausedAt: r.paused_at === null ? null : (r.paused_at instanceof Date ? r.paused_at : new Date(r.paused_at)),
  };
}

export interface AccountState {
  readonly accountId: string;
  readonly status: string;
  /** null when the account has no credential row at all. */
  readonly credentialStatus: string | null;
  /** Per-account order-cap override, minor units. null = fall back to the tenant cap. */
  readonly maxOrderNotionalMinor: string | null;
  /** Account-frozen reason, or null when the account is not frozen. */
  readonly frozenReason: string | null;
}

/**
 * The account and credential status for a set of accounts, in one query. A LEFT
 * JOIN so an account with no credential yet still returns a row (with a null
 * credential status) rather than vanishing — gate 3 then names it. Also carries
 * the phase-05 per-account cap override and frozen reason so the planning service
 * can compute the effective per-order cap and feed the account-frozen gate.
 */
export async function readAccountStates(
  tdb: TenantDb,
  accountIds: readonly string[],
): Promise<ReadonlyMap<string, AccountState>> {
  if (accountIds.length === 0) return new Map();
  const rows = await tdb.selectFrom('exchange_account')
    .leftJoin('exchange_credential', 'exchange_credential.account_id', 'exchange_account.id')
    .select([
      'exchange_account.id as accountId',
      'exchange_account.status as status',
      'exchange_credential.status as credentialStatus',
      'exchange_account.max_order_notional_minor as maxOrderNotionalMinor',
      'exchange_account.frozen_reason as frozenReason',
    ])
    .where('exchange_account.id' as never, 'in', accountIds as never)
    .execute();
  const out = new Map<string, AccountState>();
  for (const row of rows as ReadonlyArray<{
    accountId: string; status: string; credentialStatus: string | null;
    maxOrderNotionalMinor: string | null; frozenReason: string | null;
  }>) {
    out.set(row.accountId, {
      accountId: row.accountId,
      status: row.status,
      credentialStatus: row.credentialStatus,
      maxOrderNotionalMinor: row.maxOrderNotionalMinor,
      frozenReason: row.frozenReason,
    });
  }
  return out;
}

/** The operator-set mode of a market (phase 05), for the market-scope gate. */
export interface MarketStateRow {
  readonly mode: 'normal' | 'cancel_only' | 'read_only';
  readonly reason: string | null;
}

/**
 * Read the market_state for a set of venue symbols. GLOBAL read (market_state
 * carries no tenant_id), keyed by symbol. A symbol absent from the result simply
 * has no switch — the gate treats it as normal.
 */
export async function readMarketStates(
  db: Kysely<DB>,
  markets: readonly string[],
): Promise<Readonly<Record<string, MarketStateRow>>> {
  const out: Record<string, MarketStateRow> = {};
  if (markets.length === 0) return out;
  const rows = await db.selectFrom('market_state')
    .select(['market', 'mode', 'reason'])
    .where('market' as never, 'in', markets as never)
    .execute();
  for (const row of rows as ReadonlyArray<{ market: string; mode: 'normal' | 'cancel_only' | 'read_only'; reason: string | null }>) {
    out[row.market] = { mode: row.mode, reason: row.reason };
  }
  return out;
}

/** Every currency balance for a set of accounts, keyed by account id. */
export async function readBalances(
  tdb: TenantDb,
  accountIds: readonly string[],
): Promise<ReadonlyMap<string, Balance[]>> {
  const out = new Map<string, Balance[]>();
  if (accountIds.length === 0) return out;
  const rows = await tdb.selectFrom('account_balance')
    .select(['account_id', 'currency', 'free_minor', 'locked_minor', 'scale'])
    .where('account_id' as never, 'in', accountIds as never)
    .execute();
  for (const row of rows as unknown as ReadonlyArray<{ account_id: string; currency: string; free_minor: string; locked_minor: string; scale: number }>) {
    const list = out.get(row.account_id) ?? [];
    list.push({ currency: row.currency, freeMinor: row.free_minor, lockedMinor: row.locked_minor, scale: row.scale });
    out.set(row.account_id, list);
  }
  return out;
}

/**
 * Today's committed notional for an account in one quote currency, minor units.
 *
 * The daily-cap basis (gate 11). Summed over child orders created since the IST
 * day boundary that are NOT skipped and NOT rejected — i.e. everything that
 * counts as spend. In this dry-run phase nothing has filled, so the sum is
 * usually zero; the query is correct now and becomes load-bearing in Phase 05
 * when sends are real, reading the very same field.
 *
 * `sinceMs` is the day boundary computed by the caller (never a clock here), so
 * the IST calendar the rest of the system uses is applied in one place.
 */
export async function dailySpentMinor(
  tdb: TenantDb,
  accountId: string,
  quote: SupportedQuote,
  sinceMs: number,
): Promise<string> {
  const rows = await tdb.selectFrom('child_order')
    .leftJoin('group_trade', 'group_trade.id', 'child_order.group_trade_id')
    .select([
      'child_order.notional_minor as notional_minor',
      'child_order.state as state',
      'group_trade.status as group_trade_status',
      'group_trade.preview_expires_at as preview_expires_at',
    ])
    .where('child_order.account_id' as never, '=', accountId as never)
    .where('child_order.quote_currency' as never, '=', quote as never)
    .where('child_order.created_at' as never, '>=', new Date(sinceMs) as never)
    .execute();
  let sum = 0n;
  const now = new Date();
  for (const row of rows as ReadonlyArray<{
    notional_minor: string | null;
    state: string;
    group_trade_status: string | null;
    preview_expires_at: Date | null;
  }>) {
    if (row.notional_minor === null) continue;
    if (row.state === 'skipped' || row.state === 'rejected' || row.state === 'not_placed') continue;
    // An unconfirmed preview that has expired or been abandoned never spent anything
    if (
      row.state === 'planned' &&
      (row.group_trade_status === 'abandoned' || (row.preview_expires_at !== null && row.preview_expires_at < now))
    ) {
      continue;
    }
    sum += BigInt(row.notional_minor);
  }
  return String(sum);
}

/** The child-order states that count as "still in flight" for gate 12. */
const IN_FLIGHT_STATES = ['sending', 'ambiguous', 'acked', 'open', 'partially_filled', 'unknown', 'needs_human'] as const;

/**
 * Whether an account already has an unresolved order on a market (gate 12).
 * Backed by child_order_account_state_idx, so this is an index probe.
 */
export async function hasInFlightOrder(tdb: TenantDb, accountId: string, market: string): Promise<boolean> {
  const row = await tdb.selectFrom('child_order')
    .select('id')
    .where('account_id' as never, '=', accountId as never)
    .where('market' as never, '=', market as never)
    .where('state' as never, 'in', IN_FLIGHT_STATES as never)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}
