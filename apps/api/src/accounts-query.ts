// Accounts query — plan/phase-02 T02.8, the read side of the accounts list.
//
// The list view shows, per account: its name, the currencies it can fund with,
// the typed vs real capital and whether they diverge, and its status. This is a
// pure read over `exchange_account`, tenant-scoped like everything else.
//
// It deliberately never touches `exchange_credential`: the list has no reason to
// see ciphertext, and not joining it means a rendering bug cannot leak a key
// field into a list payload. The credential's health surfaces as the account
// status (`suspended` when its key has failed), not as credential columns.

import type { SupportedQuote } from '@tradex/db';
import type { TenantDb } from '@tradex/db';

export interface AccountListItem {
  readonly id: string;
  readonly name: string;
  readonly status: 'pending_validation' | 'active' | 'suspended' | 'disconnected';
  readonly allocatedCurrency: SupportedQuote;
  /** What the customer typed, minor units. */
  readonly allocatedCapitalMinor: string;
  /** The real balance recorded at confirmation, minor units; null until confirmed. */
  readonly confirmedAgainstMinor: string | null;
  /** True when the typed and confirmed figures differ — a cue to re-reconcile. */
  readonly diverges: boolean;
  readonly fundingCurrencies: readonly SupportedQuote[];
}

/**
 * List a tenant's accounts, most recent first.
 *
 * Divergence is computed from stored minor-unit strings by equality, never by
 * parsing to a number — the two figures are exact integers and a `!==` on the
 * canonical strings is the whole comparison.
 */
export async function listAccounts(tdb: TenantDb): Promise<AccountListItem[]> {
  const rows = await tdb.selectFrom('exchange_account')
    .select([
      'id', 'name', 'status', 'allocated_currency',
      'allocated_capital_minor', 'allocated_confirmed_against_minor', 'funding_currencies',
    ] as unknown as never)
    .orderBy('created_at', 'desc' as never)
    .execute();

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => {
    const typed = String(r['allocated_capital_minor']);
    const confirmed = r['allocated_confirmed_against_minor'] === null
      ? null
      : String(r['allocated_confirmed_against_minor']);
    return {
      id: r['id'] as string,
      name: r['name'] as string,
      status: r['status'] as AccountListItem['status'],
      allocatedCurrency: r['allocated_currency'] as SupportedQuote,
      allocatedCapitalMinor: typed,
      confirmedAgainstMinor: confirmed,
      diverges: confirmed !== null && confirmed !== typed,
      fundingCurrencies: (r['funding_currencies'] as SupportedQuote[]) ?? [],
    };
  });
}

/** A single account for the detail view, or null if it is not this tenant's. */
export async function getAccount(tdb: TenantDb, accountId: string): Promise<AccountListItem | null> {
  const rows = await listAccounts(tdb);
  return rows.find((a) => a.id === accountId) ?? null;
}
