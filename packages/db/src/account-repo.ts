// Account storage — plan/phase-02 T02.1, T02.5, T02.6.
//
// The account row is created BEFORE its credential, because the credential
// references it and the credential's AAD binds to the account id. It starts
// `pending_validation` and only reaches `active` once a live balance read has
// proved the key — the same "prove before you trust" rule the credential
// follows.
//
// `confirmAllocation` is the T02.5 write: it records BOTH the figure the
// customer typed (`allocated_capital_minor`, already stored) and the real
// balance shown at confirmation (`allocated_confirmed_against_minor`), plus the
// derived funding currencies and the observed balances — all in one
// transaction, so an account never exists half-confirmed.

import { sql } from 'kysely';
import type { Balance } from '@tradex/exchange';
import type { SupportedQuote } from './schema.js';
import type { TenantDb } from './tenant-scope.js';

export class AccountRepoError extends Error {
  override readonly name = 'AccountRepoError';
}

export interface NewAccount {
  readonly name: string;
  /** What the customer typed, in the currency they funded with (09 F4). */
  readonly allocatedCapitalMinor: string;
  readonly allocatedCurrency: SupportedQuote;
}

/** Create a `pending_validation` account, returning its id. */
export async function insertAccount(tdb: TenantDb, account: NewAccount): Promise<string> {
  const name = account.name.trim();
  if (name === '') throw new AccountRepoError('an account name cannot be blank');
  if (!/^\d+$/.test(account.allocatedCapitalMinor)) {
    throw new AccountRepoError(`allocated capital must be an integer minor amount, got ${account.allocatedCapitalMinor}`);
  }
  const row = await tdb
    .insertInto('exchange_account', {
      name,
      allocated_capital_minor: account.allocatedCapitalMinor,
      allocated_currency: account.allocatedCurrency,
      status: 'pending_validation',
    })
    .returning('id')
    .executeTakeFirst();
  if (row === undefined) throw new AccountRepoError('the account insert returned no id');
  return (row as { id: string }).id;
}

export interface ConfirmAllocation {
  readonly accountId: string;
  /** The real free balance in the allocated currency, shown at confirmation. */
  readonly confirmedAgainstMinor: string;
  /**
   * If true, the sizing basis becomes the real balance; if false, the typed
   * figure stands. Either way both numbers are retained, so a later divergence
   * is explainable rather than an argument (T02.5).
   */
  readonly adoptRealAsBasis: boolean;
  readonly fundingCurrencies: readonly SupportedQuote[];
  readonly balances: readonly Balance[];
  readonly atMs?: number | undefined;
}

/**
 * Persist the reconciliation choice, the observed balances and the funding
 * currencies, and move the account to `active` — one transaction.
 *
 * The balances write is an upsert per `(account_id, currency)`: re-reading the
 * same account later must update the row in place, not accumulate duplicates
 * (DATA-MODEL: account_balance is current-only).
 */
export async function confirmAllocation(tdb: TenantDb, input: ConfirmAllocation): Promise<void> {
  const at = new Date(input.atMs ?? Date.now());
  await tdb.transaction(async (tx) => {
    const set: Record<string, unknown> = {
      allocated_confirmed_against_minor: input.confirmedAgainstMinor,
      allocated_confirmed_at: at,
      funding_currencies: [...input.fundingCurrencies],
      status: 'active',
    };
    if (input.adoptRealAsBasis) set['allocated_capital_minor'] = input.confirmedAgainstMinor;

    const updated = await tx.updateTable('exchange_account')
      .set(set as never)
      .where('id' as never, '=', input.accountId as never)
      .where('status' as never, '<>', 'disconnected' as never)
      .returning('id' as unknown as never)
      .executeTakeFirst();
    if (updated === undefined) {
      throw new AccountRepoError(`account ${input.accountId} was not found or is disconnected`);
    }

    for (const b of input.balances) {
      await tx.insertInto('account_balance', {
        account_id: input.accountId,
        currency: b.currency,
        free_minor: b.freeMinor,
        locked_minor: b.lockedMinor,
        scale: b.scale,
        observed_at: at,
      })
        .onConflict((oc) => oc.columns(['account_id', 'currency']).doUpdateSet({
          free_minor: b.freeMinor,
          locked_minor: b.lockedMinor,
          scale: b.scale,
          observed_at: at,
        } as never) as never)
        .execute();
    }
  });
}

/** True when the account exists in this tenant and is not disconnected. */
export async function accountIsLive(tdb: TenantDb, accountId: string): Promise<boolean> {
  const row = await tdb.byId('exchange_account', accountId)
    .select(sql`1`.as('one'))
    .where('status' as never, '<>', 'disconnected' as never)
    .executeTakeFirst();
  return row !== undefined;
}
