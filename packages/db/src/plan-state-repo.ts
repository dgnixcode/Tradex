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
}

/** The global brake. Read unscoped: platform_state is one row for everyone. */
export async function readPlatformFlags(db: Kysely<DB>): Promise<PlatformFlags> {
  const row = await db.selectFrom('platform_state')
    .select(['global_kill_switch', 'mode'])
    .where('id', '=', 'singleton')
    .executeTakeFirst();
  // A missing singleton is treated as KILLED, not as "all clear": the safe
  // default when the brake's own state cannot be read is to refuse to trade.
  if (row === undefined) return { killSwitch: true, mode: 'read_only' };
  return { killSwitch: row.global_kill_switch, mode: row.mode };
}

export interface TenantCaps {
  readonly perOrderNotionalMinor: string;
  readonly dailyNotionalMinor: string;
  readonly typedConfirmAboveMinor: string;
  readonly tradingPaused: boolean;
}

/** The tenant's caps and its own kill switch, from tenant_limit. */
export async function readTenantCaps(tdb: TenantDb): Promise<TenantCaps> {
  const row = await tdb.selectFrom('tenant_limit')
    .select(['max_order_notional_minor', 'max_daily_notional_minor', 'typed_confirm_above_minor', 'trading_paused'])
    .executeTakeFirst();
  if (row === undefined) throw new PlanStateError('this tenant has no tenant_limit row — it was not provisioned');
  const r = row as {
    max_order_notional_minor: string; max_daily_notional_minor: string;
    typed_confirm_above_minor: string; trading_paused: boolean;
  };
  return {
    perOrderNotionalMinor: r.max_order_notional_minor,
    dailyNotionalMinor: r.max_daily_notional_minor,
    typedConfirmAboveMinor: r.typed_confirm_above_minor,
    tradingPaused: r.trading_paused,
  };
}

export interface AccountState {
  readonly accountId: string;
  readonly status: string;
  /** null when the account has no credential row at all. */
  readonly credentialStatus: string | null;
}

/**
 * The account and credential status for a set of accounts, in one query. A LEFT
 * JOIN so an account with no credential yet still returns a row (with a null
 * credential status) rather than vanishing — gate 3 then names it.
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
    ])
    .where('exchange_account.id' as never, 'in', accountIds as never)
    .execute();
  const out = new Map<string, AccountState>();
  for (const row of rows as ReadonlyArray<{ accountId: string; status: string; credentialStatus: string | null }>) {
    out.set(row.accountId, { accountId: row.accountId, status: row.status, credentialStatus: row.credentialStatus });
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
    .select(['notional_minor', 'state'])
    .where('account_id' as never, '=', accountId as never)
    .where('quote_currency' as never, '=', quote as never)
    .where('created_at' as never, '>=', new Date(sinceMs) as never)
    .execute();
  let sum = 0n;
  for (const row of rows as ReadonlyArray<{ notional_minor: string | null; state: string }>) {
    if (row.notional_minor === null) continue;
    if (row.state === 'skipped' || row.state === 'rejected' || row.state === 'not_placed') continue;
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
