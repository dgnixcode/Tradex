// Account storage — plan/phase-02 T02.1, T02.5, T02.6.
//
// The account row is created BEFORE its credential, because the credential
// references it and the credential's AAD binds to the account id. It is created
// only AFTER the venue probe has succeeded, so a failed connect leaves nothing
// behind — there is no stranded `pending_validation` row to retry or clean up.
// `pending_validation` therefore means "the key is proven, waiting to be switched
// on", not "something went wrong".
//
// The sizing basis (`allocated_capital_minor` + `allocated_currency`) is the
// EXCHANGE's figure, not the customer's: `recordVenueBasis` writes it the moment
// the venue is read. Nothing a client sends can move it — which matters because
// every percentage-of-capital order is sized from it.
//
// The rest of the venue read lands in two more writes, split along the line the
// read falls on: `recordObservedBalances` (balances + funding currencies) at
// validate, and `activateAllocation` (the reconciled-against stamp and the status
// flip) at confirm. Neither accepts a figure from a caller — both take an id.

import { sql } from 'kysely';
import type { Balance } from '@tradex/exchange';
import type { AccountStatus, SupportedQuote } from './schema.js';
import type { TenantDb } from './tenant-scope.js';

export class AccountRepoError extends Error {
  override readonly name = 'AccountRepoError';
}

export interface NewAccount {
  readonly name: string;
  /**
   * The sizing basis, in the currency the account funds with. NULL at create:
   * `insertAccount` runs inside the onboarding sequence, before `recordVenueBasis`
   * writes the figure the exchange reported, so the row is briefly basis-less. The
   * two are always set together (migration 015's `exchange_account_basis_pair`
   * CHECK), and an account cannot be activated while they are null (migration 016).
   */
  readonly allocatedCapitalMinor: string | null;
  readonly allocatedCurrency: SupportedQuote | null;
}

/** Create a `pending_validation` account, returning its id. */
export async function insertAccount(tdb: TenantDb, account: NewAccount): Promise<string> {
  const name = account.name.trim();
  if (name === '') throw new AccountRepoError('an account name cannot be blank');
  if (account.allocatedCapitalMinor !== null && !/^\d+$/.test(account.allocatedCapitalMinor)) {
    throw new AccountRepoError(`allocated capital must be an integer minor amount, got ${account.allocatedCapitalMinor}`);
  }
  if ((account.allocatedCapitalMinor === null) !== (account.allocatedCurrency === null)) {
    throw new AccountRepoError('an allocated capital and its currency must be set together or not at all');
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

/**
 * Record the sizing basis the exchange reports, at the moment it is read.
 *
 * Called from onboarding `validate`, where the plaintext key is still in hand
 * and the balances have just been fetched. This is the ONLY writer of
 * `allocated_capital_minor`: the customer is never asked for the figure, so
 * there is no client input to trust or to diverge from the venue.
 */
export async function recordVenueBasis(
  tdb: TenantDb,
  input: { readonly accountId: string; readonly capitalMinor: string; readonly currency: SupportedQuote },
): Promise<void> {
  if (!/^\d+$/.test(input.capitalMinor)) {
    throw new AccountRepoError(`the venue basis must be an integer minor amount, got ${input.capitalMinor}`);
  }
  const updated = await tdb.updateTable('exchange_account')
    .set({ allocated_capital_minor: input.capitalMinor, allocated_currency: input.currency } as never)
    .where('id' as never, '=', input.accountId as never)
    .where('status' as never, '<>', 'disconnected' as never)
    .returning('id' as never)
    .executeTakeFirst();
  if (updated === undefined) {
    throw new AccountRepoError(`account ${input.accountId} was not found or is disconnected`);
  }
}

export interface ObservedBalances {
  readonly accountId: string;
  readonly fundingCurrencies: readonly SupportedQuote[];
  readonly balances: readonly Balance[];
  readonly atMs?: number | undefined;
}

/**
 * Persist what the exchange reported: the funding currencies and every balance it
 * returned — called from onboarding `validate`, where the venue was just read.
 *
 * This is the only writer of `funding_currencies` and `account_balance`. Recording
 * the read the moment it happens is what lets a connect that was abandoned before
 * its final confirm be finished from the account's own page instead of only being
 * deleted, and it keeps a client from stating what the account holds.
 *
 * MUST BE CALLED INSIDE A TRANSACTION — it deliberately opens none of its own.
 * Its only caller is `OnboardingService.createProvenAccount`, which runs it
 * alongside the account and credential inserts so a connect can never land
 * half-written. Opening one here would nest, and Kysely rejects a transaction
 * inside a transaction outright.
 *
 * The balances write is an upsert per `(account_id, currency)`: re-reading the
 * same account later updates the row in place rather than accumulating duplicates
 * (DATA-MODEL: account_balance is current-only).
 */
export async function recordObservedBalances(tdb: TenantDb, input: ObservedBalances): Promise<void> {
  const at = new Date(input.atMs ?? Date.now());
  const updated = await tdb.updateTable('exchange_account')
    .set({ funding_currencies: [...input.fundingCurrencies] } as never)
    .where('id' as never, '=', input.accountId as never)
    .where('status' as never, '<>', 'disconnected' as never)
    .returning('id' as never)
    .executeTakeFirst();
  if (updated === undefined) {
    throw new AccountRepoError(`account ${input.accountId} was not found or is disconnected`);
  }

  for (const b of input.balances) {
    await tdb.insertInto('account_balance', {
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
}

/**
 * Switch the account on — one statement, no argument but the id.
 *
 * Stamps the basis as the figure this activation was reconciled against
 * (`allocated_confirmed_against_minor`) and moves the status to `active`.
 *
 * The `allocated_capital_minor IS NOT NULL` guard is why there is no capital
 * argument: an account whose venue read never landed cannot be activated, and the
 * confirmed-against stamp is read straight off the row rather than accepted from
 * any caller. Migration 016's `exchange_account_active_has_basis` CHECK enforces
 * the same rule at the table, so no future path can activate an account without a
 * basis.
 */
export async function activateAllocation(tdb: TenantDb, accountId: string, atMs = Date.now()): Promise<void> {
  const updated = await tdb.updateTable('exchange_account')
    .set({
      allocated_confirmed_against_minor: sql`allocated_capital_minor`,
      allocated_confirmed_at: new Date(atMs),
      status: 'active',
    } as never)
    .where('id' as never, '=', accountId as never)
    .where('status' as never, '<>', 'disconnected' as never)
    .where(sql<boolean>`allocated_capital_minor is not null`)
    .returning('id' as never)
    .executeTakeFirst();
  if (updated === undefined) {
    throw new AccountRepoError(
      `account ${accountId} is missing, disconnected, or has no basis from the exchange`,
    );
  }
}

/** The two statuses a customer can move a live account between. */
export type AccountBrakeStatus = Extract<AccountStatus, 'active' | 'suspended'>;

/**
 * Pause or resume trading on one account, returning whether a row actually moved.
 *
 * `suspended` is the reversible brake. The sizing gates refuse any account whose
 * status is not `active` (`ACCOUNT_NOT_ACTIVE`, `packages/sizing/src/gates.ts`),
 * so a suspended account is dropped from the next plan while its key, its basis
 * and its whole history stay exactly as they were.
 *
 * It deliberately does NOT revoke the credential: revocation crypto-shreds the
 * DEK and cannot be undone. `disconnected`, which migration 004 requires
 * `disconnected_at` for, is not reachable from here at all.
 *
 * False is returned when the account is not in the expected source state, so a
 * route can answer 409 instead of reporting a success that changed nothing.
 */
export async function setAccountStatus(
  tdb: TenantDb,
  accountId: string,
  status: AccountBrakeStatus,
): Promise<boolean> {
  const from: AccountBrakeStatus = status === 'active' ? 'suspended' : 'active';
  const updated = await tdb.updateTable('exchange_account')
    .set({ status } as never)
    .where('id' as never, '=', accountId as never)
    .where('status' as never, '=', from as never)
    .returning('id' as never)
    .executeTakeFirst();
  return updated !== undefined;
}

export interface AccountHistoryCounts {
  readonly childOrders: number;
  readonly ledgerEntries: number;
}

/**
 * How much this account has actually done — the two counts that decide whether it
 * can be deleted.
 *
 * Both tables reference the account with ON DELETE RESTRICT, and `ledger_entry`
 * additionally refuses DELETE by trigger (append-only, DATA-MODEL X10/L9/L10). An
 * account that has ever traded therefore cannot be removed at all, and the caller
 * needs to know that BEFORE offering a delete that would fail.
 */
export async function accountHistoryCounts(tdb: TenantDb, accountId: string): Promise<AccountHistoryCounts> {
  const count = async (table: 'child_order' | 'ledger_entry'): Promise<number> => {
    const row = await tdb.selectFrom(table)
      .select(sql<number>`count(*)::int`.as('n'))
      .where('account_id' as never, '=', accountId as never)
      .executeTakeFirst();
    return (row as { n: number } | undefined)?.n ?? 0;
  };
  return { childOrders: await count('child_order'), ledgerEntries: await count('ledger_entry') };
}

export interface DeletedAccount {
  readonly credentials: number;
  readonly balances: number;
  readonly memberships: number;
}

/** Everything hanging off an account, in the order it is removed. */
const CHILD_TABLES = [
  'account_market_seen', 'account_balance', 'futures_execution_lock',
  'futures_position', 'holding', 'group_member', 'exchange_credential',
] as const;

/**
 * Remove an account and everything that hangs off it — one transaction.
 *
 * Refuses when the account has a trading history (see `accountHistoryCounts`). It
 * has to: every child FK is ON DELETE RESTRICT and the ledger is append-only by
 * trigger, so a hard delete of a traded account is impossible at the database
 * level. Reporting that honestly beats a partial delete, and the caller turns the
 * thrown reason into a 409 that offers deactivation instead.
 *
 * Children go before the parent because of those FKs; their relative order does
 * not matter, since none of them reference each other. Removing a `group_member`
 * row does shrink the group it belonged to — that is the point, and the route
 * reports the count so the change is never silent.
 */
export async function deleteAccount(tdb: TenantDb, accountId: string): Promise<DeletedAccount> {
  const history = await accountHistoryCounts(tdb, accountId);
  if (history.childOrders > 0 || history.ledgerEntries > 0) {
    throw new AccountRepoError(
      `this account has trading history (${history.childOrders} orders, `
      + `${history.ledgerEntries} ledger entries) and cannot be deleted — deactivate it instead`,
    );
  }

  return tdb.transaction(async (tx) => {
    // The TenantDb wrapper erases the builder's output type (it is typed
    // `DeleteQueryBuilder<DB, T, unknown>`), so the delete result arrives as `{}`.
    // The cast is the same escape hatch the rest of this file uses for that wrapper.
    const counts: Record<string, number> = {};
    for (const table of CHILD_TABLES) {
      const result = await tx.deleteFrom(table)
        .where('account_id' as never, '=', accountId as never)
        .executeTakeFirst();
      const rowCount = (result as { numDeletedRows?: bigint } | undefined)?.numDeletedRows ?? 0n;
      counts[table] = Number(rowCount);
    }

    // RETURNING rather than a row count: "did a row come back" is the more precise
    // question, and it is how the rest of this file guards a write.
    const parent = await tx.deleteFrom('exchange_account')
      .where('id' as never, '=', accountId as never)
      .returning('id' as never)
      .executeTakeFirst();
    if (parent === undefined) {
      throw new AccountRepoError(`account ${accountId} was not found`);
    }

    return {
      credentials: counts['exchange_credential'] ?? 0,
      balances: counts['account_balance'] ?? 0,
      memberships: counts['group_member'] ?? 0,
    };
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

export interface UpdateAccountParams {
  readonly name?: string | undefined;
  readonly hideFromPositions?: boolean | undefined;
}

/**
 * Update an account's mutable settings (name, hide_from_positions).
 */
export async function updateAccount(
  tdb: TenantDb,
  accountId: string,
  patch: UpdateAccountParams,
): Promise<{ id: string; name: string; hideFromPositions: boolean }> {
  const updates: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (trimmed === '') throw new AccountRepoError('an account name cannot be blank');
    updates['name'] = trimmed;
  }
  if (patch.hideFromPositions !== undefined) {
    updates['hide_from_positions'] = Boolean(patch.hideFromPositions);
  }

  if (Object.keys(updates).length === 0) {
    const row = await tdb.byId('exchange_account', accountId)
      .select(['id', 'name', 'hide_from_positions'] as never)
      .executeTakeFirst() as { id: string; name: string; hide_from_positions: boolean } | undefined;
    if (row === undefined) {
      throw new AccountRepoError(`account ${accountId} was not found`);
    }
    return { id: row.id, name: row.name, hideFromPositions: Boolean(row.hide_from_positions) };
  }

  const updated = await tdb.updateTable('exchange_account')
    .set(updates as never)
    .where('id' as never, '=', accountId as never)
    .returning(['id', 'name', 'hide_from_positions'] as never)
    .executeTakeFirst() as { id: string; name: string; hide_from_positions: boolean } | undefined;

  if (updated === undefined) {
    throw new AccountRepoError(`account ${accountId} was not found`);
  }

  return { id: updated.id, name: updated.name, hideFromPositions: Boolean(updated.hide_from_positions) };
}

/**
 * Rename an account.
 * Missing account -> AccountRepoError('account <id> was not found').
 * Blank name -> AccountRepoError('an account name cannot be blank').
 */
export async function renameAccount(
  tdb: TenantDb,
  accountId: string,
  newName: string,
): Promise<{ id: string; name: string }> {
  const res = await updateAccount(tdb, accountId, { name: newName });
  return { id: res.id, name: res.name };
}

