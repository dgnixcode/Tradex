// Accounts query — plan/phase-02 T02.8, the read side of the accounts list.
//
// The list view shows, per account: its name, the currencies it can fund with,
// the capital the EXCHANGE reports, and its status. This is a pure read over
// `exchange_account`, tenant-scoped like everything else.
//
// There is no "typed vs real" column any more. The customer never types a figure,
// so the basis and the confirmed-against stamp are the same read of the venue and
// there is nothing left to diverge.
//
// It deliberately never touches `exchange_credential`: the list has no reason to
// see ciphertext, and not joining it means a rendering bug cannot leak a key
// field into a list payload. The credential's health surfaces as the account
// status (`suspended` when its key has failed), not as credential columns.

import { accountHistoryCounts, DEFAULT_GROUP_NAME } from '@tradex/db';
import type { SupportedQuote } from '@tradex/db';
import type { TenantDb } from '@tradex/db';

export interface AccountListItem {
  readonly id: string;
  readonly name: string;
  readonly status: 'pending_validation' | 'active' | 'suspended' | 'disconnected';
  /** 1-based permanent chronological serial number (oldest account connected = 1). */
  readonly serialNo: number;
  /** Null until the venue has been read for this account. */
  readonly allocatedCurrency: SupportedQuote | null;
  /** The free balance the exchange reported, minor units; null until read. */
  readonly allocatedCapitalMinor: string | null;
  /** When the basis above was confirmed. Null until this account was activated. */
  readonly confirmedAgainstMinor: string | null;
  readonly fundingCurrencies: readonly SupportedQuote[];
  /** Custom strategy group the account belongs to, if assigned. */
  readonly groupId: string | null;
  readonly groupName: string | null;
  /** Whether the account is hidden from the main positions page. */
  readonly hideFromPositions: boolean;
  readonly createdAt?: string | null;
}

/**
 * List a tenant's accounts in chronological order (oldest first).
 *
 * Sorting oldest first ensures permanent 1-based serial numbers (#1, #2, ...)
 * that never shift when new accounts are connected.
 *
 * A `pending_validation` account legitimately has a null basis: its row exists
 * (the sealed credential has a foreign key to it) but the venue read that fills
 * it may not have happened yet, or may have failed.
 */
export async function listAccounts(tdb: TenantDb): Promise<AccountListItem[]> {
  const rows = await tdb.selectFrom('exchange_account')
    .select([
      'id', 'name', 'status', 'allocated_currency',
      'allocated_capital_minor', 'allocated_confirmed_against_minor', 'funding_currencies',
      'hide_from_positions', 'created_at',
    ] as unknown as never)
    .orderBy('created_at', 'asc' as never)
    .orderBy('id', 'asc' as never)
    .execute();

  const memberships = await tdb.selectFrom('group_member')
    .innerJoin('account_group', 'account_group.id', 'group_member.group_id')
    .select([
      'group_member.account_id as accountId',
      'account_group.id as groupId',
      'account_group.name as groupName',
    ] as unknown as never)
    .where('account_group.archived_at' as never, 'is', null as never)
    .where('account_group.name' as never, '<>', DEFAULT_GROUP_NAME as never)
    .execute() as unknown as ReadonlyArray<{ accountId: string; groupId: string; groupName: string }>;

  const groupMap = new Map(memberships.map((m) => [m.accountId, m]));

  return (rows as unknown as Array<Record<string, unknown>>).map((r, index) => {
    const grp = groupMap.get(r['id'] as string);
    return {
      id: r['id'] as string,
      serialNo: index + 1,
      name: r['name'] as string,
      status: r['status'] as AccountListItem['status'],
      allocatedCurrency: (r['allocated_currency'] as SupportedQuote | null) ?? null,
      allocatedCapitalMinor: r['allocated_capital_minor'] === null
        ? null
        : String(r['allocated_capital_minor']),
      confirmedAgainstMinor: r['allocated_confirmed_against_minor'] === null
        ? null
        : String(r['allocated_confirmed_against_minor']),
      fundingCurrencies: (r['funding_currencies'] as SupportedQuote[]) ?? [],
      groupId: grp?.groupId ?? null,
      groupName: grp?.groupName ?? null,
      hideFromPositions: Boolean(r['hide_from_positions'] ?? false),
      createdAt: r['created_at'] ? (r['created_at'] instanceof Date ? r['created_at'].toISOString() : String(r['created_at'])) : null,
    };
  });
}

/** A single account for the detail view, or null if it is not this tenant's. */
export async function getAccount(tdb: TenantDb, accountId: string): Promise<AccountListItem | null> {
  const rows = await listAccounts(tdb);
  return rows.find((a) => a.id === accountId) ?? null;
}

/** One row of `account_balance` — what the exchange last said this account holds. */
export interface AccountBalanceRow {
  readonly currency: string;
  readonly freeMinor: string;
  readonly lockedMinor: string;
  /** The WALLET scale the venue reported, which is not the quote's tradable step. */
  readonly scale: number;
  readonly observedAt: string;
}

export interface AccountDetail extends AccountListItem {
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly balances: readonly AccountBalanceRow[];
  readonly groupCount: number;
  /** The leading group names, so a delete warning can name what it would change. */
  readonly groupNames: readonly string[];
  /**
   * Whether a hard delete is possible at all. Refused once the account has traded:
   * `child_order`/`ledger_entry` reference it, and the ledger additionally refuses
   * DELETE by trigger. The reason is what the page shows INSTEAD of the button.
   */
  readonly deletable: boolean;
  readonly undeletableReason: string | null;
}

/**
 * Everything the account detail page renders — one read model.
 *
 * Like `listAccounts`, this never touches `exchange_credential`: the page has no
 * reason to see ciphertext, and not joining it means a rendering bug cannot leak a
 * key field. `account_balance` is a different matter — those are the venue's own
 * figures and showing them is the point.
 */
export async function getAccountDetail(tdb: TenantDb, accountId: string): Promise<AccountDetail | null> {
  const account = await getAccount(tdb, accountId);
  if (account === null) return null;

  const times = await tdb.selectFrom('exchange_account')
    .select(['created_at', 'allocated_confirmed_at'] as unknown as never)
    .where('id' as never, '=', accountId as never)
    .executeTakeFirst();
  const stamp = times as unknown as { created_at: Date; allocated_confirmed_at: Date | null } | undefined;

  const balanceRows = await tdb.selectFrom('account_balance')
    .select(['currency', 'free_minor', 'locked_minor', 'scale', 'observed_at'] as unknown as never)
    .where('account_id' as never, '=', accountId as never)
    .orderBy('currency' as never)
    .execute();
  const balances = (balanceRows as unknown as Array<{
    currency: string; free_minor: string; locked_minor: string; scale: number; observed_at: Date;
  }>).map((r) => ({
    currency: r.currency,
    freeMinor: r.free_minor,
    lockedMinor: r.locked_minor,
    scale: r.scale,
    observedAt: new Date(r.observed_at).toISOString(),
  }));

  const groups = await tdb.selectFrom('group_member')
    .innerJoin('account_group', 'account_group.id', 'group_member.group_id')
    .select(['account_group.name as groupName'] as unknown as never)
    .where('group_member.account_id' as never, '=', accountId as never)
    .execute();
  const groupNames = (groups as unknown as Array<{ groupName: string }>).map((g) => g.groupName);

  const history = await accountHistoryCounts(tdb, accountId);
  const traded = history.childOrders > 0 || history.ledgerEntries > 0;

  return {
    ...account,
    createdAt: stamp === undefined ? new Date(0).toISOString() : new Date(stamp.created_at).toISOString(),
    confirmedAt: stamp === undefined || stamp.allocated_confirmed_at === null
      ? null
      : new Date(stamp.allocated_confirmed_at).toISOString(),
    balances,
    groupCount: groupNames.length,
    groupNames,
    deletable: !traded,
    undeletableReason: traded
      ? `This account has traded (${history.childOrders} orders, ${history.ledgerEntries} ledger `
        + 'entries). The ledger is append-only, so it cannot be deleted — deactivate it instead.'
      : null,
  };
}
