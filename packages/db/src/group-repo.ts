// Group storage — plan/phase-04 T04.2 · DATA-MODEL.md domain 3.
//
// A group is a named subset of a tenant's accounts; a group trade fans out
// across its enabled members. Two limits from tenant_limit are enforced here:
// max_groups per tenant and max_accounts_per_group. Both are COUNT-then-INSERT,
// which is a write-skew race under READ COMMITTED — two concurrent adds each read
// 49 and each insert, giving 51. So each limited insert first takes a row lock on
// the thing being counted against (the tenant_limit row for group creation, the
// account_group row for membership), which serialises concurrent writers and
// makes the count exact rather than hopeful. This is the same discipline the
// billing write-skews in this codebase were fixed with.
//
// The PRIMARY KEY (group_id, account_id) is the backstop for the one race a lock
// would still leave open if two workers added the SAME account: the database
// rejects the second insert. The pre-check here exists to turn that into a
// friendly message, not to be the guard.
//
// weight_bp and max_notional_minor are written only if supplied and are UNUSED by
// any sizing path in v1 (09 F4); they exist so per-account weighting becomes a
// flag later, not a migration on a live trading table.

import type { SupportedQuote } from './schema.js';
import type { TenantDb } from './tenant-scope.js';

export class GroupRepoError extends Error {
  override readonly name = 'GroupRepoError';
  constructor(
    message: string,
    /** A stable, UI-safe reason so a caller can branch without string-matching. */
    readonly reason:
      | 'blank_name' | 'group_limit_reached' | 'member_limit_reached'
      | 'duplicate_member' | 'group_not_found' | 'account_not_live' | 'no_limit_row'
      | 'account_already_in_group' | 'cannot_archive_default_group',
  ) {
    super(message);
  }
}

/** Standard name of the permanent system group containing all connected accounts. */
export const DEFAULT_GROUP_NAME = 'Default (All Accounts)';

/**
 * Ensures the system master 'Default (All Accounts)' group exists and contains all active accounts.
 * Returns the default group's id.
 */
export async function ensureDefaultGroup(tdb: TenantDb): Promise<string> {
  return tdb.transaction(async (tx) => {
    // 1. Find or create the default group
    const defaultGroup = await tx.selectFrom('account_group')
      .select(['id', 'name'])
      .where('name' as never, '=', DEFAULT_GROUP_NAME as never)
      .where('archived_at' as never, 'is', null as never)
      .executeTakeFirst() as { id: string; name: string } | undefined;

    let defaultGroupId: string;
    if (defaultGroup === undefined) {
      const inserted = await tx.insertInto('account_group', {
        name: DEFAULT_GROUP_NAME,
        description: 'Master system group containing all connected exchange accounts.',
        created_by: null,
      })
        .returning('id')
        .executeTakeFirst();
      if (inserted === undefined) throw new GroupRepoError('failed to create default group', 'group_not_found');
      defaultGroupId = (inserted as { id: string }).id;
    } else {
      defaultGroupId = defaultGroup.id;
    }

    // 2. Fetch all active exchange accounts
    const activeAccounts = await tx.selectFrom('exchange_account')
      .select('id')
      .where('status' as never, '<>', 'disconnected' as never)
      .execute() as ReadonlyArray<{ id: string }>;

    if (activeAccounts.length > 0) {
      // 3. Fetch existing members of the default group
      const existingMembers = await tx.selectFrom('group_member')
        .select('account_id as accountId')
        .where('group_id' as never, '=', defaultGroupId as never)
        .execute() as ReadonlyArray<{ accountId: string }>;

      const memberSet = new Set(existingMembers.map((m) => m.accountId));
      const missingAccounts = activeAccounts.filter((a) => !memberSet.has(a.id));

      // 4. Enroll any missing accounts into the default group
      for (const missing of missingAccounts) {
        await tx.insertInto('group_member', {
          group_id: defaultGroupId,
          account_id: missing.id,
          display_order: 0,
          enabled: true,
          weight_bp: null,
          max_notional_minor: null,
        })
          .onConflict((oc) => oc.columns(['tenant_id', 'group_id', 'account_id']).doNothing() as never)
          .execute();
      }
    }

    return defaultGroupId;
  });
}

export interface NewGroup {
  readonly name: string;
  readonly description?: string | undefined;
  readonly createdBy?: string | undefined;
}

/**
 * Create a group, refusing once the tenant is at its `max_groups` cap. The
 * tenant_limit row is locked FOR UPDATE first, so two concurrent creations
 * cannot both pass the count check.
 */
export async function createGroup(tdb: TenantDb, group: NewGroup): Promise<string> {
  const name = group.name.trim();
  if (name === '') throw new GroupRepoError('a group needs a name', 'blank_name');
  if (name.toLowerCase() === DEFAULT_GROUP_NAME.toLowerCase()) {
    throw new GroupRepoError(`"${DEFAULT_GROUP_NAME}" is reserved for the master system group`, 'blank_name');
  }

  return tdb.transaction(async (tx) => {
    const limitRow = await tx.selectFrom('tenant_limit')
      .select('max_groups')
      .forUpdate()
      .executeTakeFirst();
    if (limitRow === undefined) {
      throw new GroupRepoError('this tenant has no tenant_limit row — it was not provisioned', 'no_limit_row');
    }
    const maxGroups = (limitRow as { max_groups: number }).max_groups;

    const countRow = await tx.selectFrom('account_group')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('archived_at' as never, 'is', null as never)
      .executeTakeFirstOrThrow();
    const current = Number((countRow as { n: string }).n);
    if (current >= maxGroups) {
      throw new GroupRepoError(
        `this tenant already has ${current} of its ${maxGroups} allowed groups; archive one or ask to raise the limit`,
        'group_limit_reached',
      );
    }

    const inserted = await tx.insertInto('account_group', {
      name,
      description: group.description ?? null,
      created_by: group.createdBy ?? null,
    })
      .returning('id')
      .executeTakeFirst();
    if (inserted === undefined) throw new GroupRepoError('the group insert returned no id', 'group_not_found');
    return (inserted as { id: string }).id;
  });
}

/** Rename a group or change its description. Missing or archived → group_not_found. */
export async function updateGroup(
  tdb: TenantDb,
  groupId: string,
  patch: { name?: string; description?: string | null },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (name === '') throw new GroupRepoError('a group needs a name', 'blank_name');
    if (name.toLowerCase() === DEFAULT_GROUP_NAME.toLowerCase()) {
      throw new GroupRepoError(`"${DEFAULT_GROUP_NAME}" is reserved for the master system group`, 'blank_name');
    }
    set['name'] = name;
  }
  if (patch.description !== undefined) set['description'] = patch.description;
  if (Object.keys(set).length === 0) return;

  const updated = await tdb.updateTable('account_group')
    .set(set as never)
    .where('id' as never, '=', groupId as never)
    .where('archived_at' as never, 'is', null as never)
    .returning('id' as unknown as never)
    .executeTakeFirst();
  if (updated === undefined) throw new GroupRepoError(`group ${groupId} was not found`, 'group_not_found');
}

/** Archive a group. Membership rows stay (ON DELETE RESTRICT and audit continuity). */
export async function archiveGroup(tdb: TenantDb, groupId: string, atMs?: number): Promise<void> {
  const target = await tdb.byId('account_group', groupId)
    .select(['id', 'name'])
    .where('archived_at' as never, 'is', null as never)
    .executeTakeFirst() as { id: string; name: string } | undefined;
  if (target === undefined) {
    throw new GroupRepoError(`group ${groupId} was not found or is already archived`, 'group_not_found');
  }
  if (target.name === DEFAULT_GROUP_NAME) {
    throw new GroupRepoError('the master default group cannot be archived', 'cannot_archive_default_group');
  }

  const at = new Date(atMs ?? Date.now());
  const updated = await tdb.updateTable('account_group')
    .set({ archived_at: at } as never)
    .where('id' as never, '=', groupId as never)
    .where('archived_at' as never, 'is', null as never)
    .returning('id' as unknown as never)
    .executeTakeFirst();
  if (updated === undefined) throw new GroupRepoError(`group ${groupId} was not found or is already archived`, 'group_not_found');
}

export interface MemberInput {
  readonly groupId: string;
  readonly accountId: string;
  readonly displayOrder?: number | undefined;
  readonly enabled?: boolean | undefined;
  /** Created but UNUSED in v1. */
  readonly weightBp?: number | undefined;
  readonly maxNotionalMinor?: string | undefined;
  /** If true, cleanly reassigns the account from any previous custom strategy group. */
  readonly reassign?: boolean | undefined;
}

/**
 * Add an account to a group, enforcing that an account can belong to at most
 * ONE custom strategy group (in addition to the permanent master Default group).
 * If reassign is true and the account belongs to another custom group, it is
 * atomically transferred to the new group.
 */
export async function addMember(tdb: TenantDb, member: MemberInput): Promise<void> {
  await tdb.transaction(async (tx) => {
    // Lock the group row: this both proves the group exists in this tenant and is
    // not archived, and serialises every concurrent membership add to it.
    const group = await tx.byId('account_group', member.groupId)
      .select(['id', 'name'])
      .where('archived_at' as never, 'is', null as never)
      .forUpdate()
      .executeTakeFirst() as { id: string; name: string } | undefined;
    if (group === undefined) {
      throw new GroupRepoError(`group ${member.groupId} was not found or is archived`, 'group_not_found');
    }

    // The account must be live in this tenant. The composite FK would reject a
    // cross-tenant account, but a disconnected one is a clearer message here.
    const account = await tx.byId('exchange_account', member.accountId)
      .select(['id', 'name'])
      .where('status' as never, '<>', 'disconnected' as never)
      .executeTakeFirst() as { id: string; name: string } | undefined;
    if (account === undefined) {
      throw new GroupRepoError(`account ${member.accountId} was not found or is disconnected`, 'account_not_live');
    }

    const alreadyInThis = await tx.selectFrom('group_member')
      .select('account_id')
      .where('group_id' as never, '=', member.groupId as never)
      .where('account_id' as never, '=', member.accountId as never)
      .executeTakeFirst();
    if (alreadyInThis !== undefined) {
      throw new GroupRepoError(
        `account "${account.name}" is already a member of this group`,
        'duplicate_member',
      );
    }

    // Single Custom Strategy Group Rule:
    // If the target group is a custom strategy group (NOT the master Default group),
    // check if the account already belongs to another active custom strategy group.
    if (group.name !== DEFAULT_GROUP_NAME) {
      const existingCustomGroup = await tx.selectFrom('group_member')
        .innerJoin('account_group', 'account_group.id', 'group_member.group_id')
        .select(['account_group.id as groupId', 'account_group.name as groupName'])
        .where('group_member.account_id' as never, '=', member.accountId as never)
        .where('account_group.archived_at' as never, 'is', null as never)
        .where('account_group.name' as never, '<>', DEFAULT_GROUP_NAME as never)
        .where('account_group.id' as never, '<>', member.groupId as never)
        .executeTakeFirst() as { groupId: string; groupName: string } | undefined;

      if (existingCustomGroup !== undefined) {
        if (member.reassign !== true) {
          throw new GroupRepoError(
            `Account "${account.name}" is already assigned to group "${existingCustomGroup.groupName}". An account can belong to only one custom strategy group.`,
            'account_already_in_group',
          );
        }
        // If reassign is true, cleanly remove from previous custom group
        await tx.deleteFrom('group_member')
          .where('group_id' as never, '=', existingCustomGroup.groupId as never)
          .where('account_id' as never, '=', member.accountId as never)
          .execute();
      }

      // Check max_accounts_per_group limit for custom groups
      const limitRow = await tx.selectFrom('tenant_limit')
        .select('max_accounts_per_group')
        .executeTakeFirst();
      if (limitRow === undefined) {
        throw new GroupRepoError('this tenant has no tenant_limit row — it was not provisioned', 'no_limit_row');
      }
      const maxPerGroup = (limitRow as { max_accounts_per_group: number }).max_accounts_per_group;

      const countRow = await tx.selectFrom('group_member')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .where('group_id' as never, '=', member.groupId as never)
        .executeTakeFirstOrThrow();
      const current = Number((countRow as { n: string }).n);
      if (current >= maxPerGroup) {
        throw new GroupRepoError(
          `this group already has ${current} of its ${maxPerGroup} allowed accounts`,
          'member_limit_reached',
        );
      }
    }

    await tx.insertInto('group_member', {
      group_id: member.groupId,
      account_id: member.accountId,
      display_order: member.displayOrder ?? 0,
      enabled: member.enabled ?? true,
      weight_bp: member.weightBp ?? null,
      max_notional_minor: member.maxNotionalMinor ?? null,
    }).execute();
  });
}

/** Remove an account from a group. Idempotent-ish: absent membership is not an error. */
export async function removeMember(tdb: TenantDb, groupId: string, accountId: string): Promise<void> {
  const group = await tdb.byId('account_group', groupId)
    .select(['id', 'name'])
    .executeTakeFirst() as { id: string; name: string } | undefined;
  if (group?.name === DEFAULT_GROUP_NAME) {
    throw new GroupRepoError('accounts cannot be removed from the master default group; disconnect the account to remove it', 'cannot_archive_default_group');
  }

  await tdb.deleteFrom('group_member')
    .where('group_id' as never, '=', groupId as never)
    .where('account_id' as never, '=', accountId as never)
    .execute();
}

/** Enable or disable a member. A disabled member stays in the group but is skipped by the fan-out. */
export async function setMemberEnabled(
  tdb: TenantDb,
  groupId: string,
  accountId: string,
  enabled: boolean,
): Promise<void> {
  const updated = await tdb.updateTable('group_member')
    .set({ enabled } as never)
    .where('group_id' as never, '=', groupId as never)
    .where('account_id' as never, '=', accountId as never)
    .returning('account_id' as unknown as never)
    .executeTakeFirst();
  if (updated === undefined) {
    throw new GroupRepoError(`account ${accountId} is not a member of group ${groupId}`, 'duplicate_member');
  }
}

/** One line in the group picker: how many accounts, and their capital per currency. */
export interface GroupSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly memberCount: number;
  readonly enabledCount: number;
  /**
   * Combined allocated capital PER CURRENCY, minor units. Never a single total:
   * accounts fund in INR or USDT and summing across them would need an FX rate
   * and be wrong (money-units discipline). The UI shows both lines.
   */
  readonly allocatedByCurrency: Readonly<Record<SupportedQuote, string>>;
}

/**
 * Restate a minor-unit string from one scale to another, discarding anything below
 * the target scale or zero-padding if widening.
 */
function projectToScale(minor: string, from: number, to: number): string {
  if (!minor || minor === '0' || from === to) return minor || '0';
  const negative = minor.startsWith('-');
  const rawDigits = (negative ? minor.slice(1) : minor).replace(/^0+(?=\d)/, '');
  if (rawDigits === '0' || rawDigits === '') return '0';
  if (to > from) return `${negative ? '-' : ''}${rawDigits}${'0'.repeat(to - from)}`;
  const kept = rawDigits.length - (from - to);
  if (kept <= 0) return '0';
  const result = `${negative ? '-' : ''}${rawDigits.slice(0, kept).replace(/^0+(?=\d)/, '')}`;
  return result === '' || result === '-' ? '0' : result;
}

/**
 * The group picker read (T04.7). One row per non-archived group with its member
 * counts and per-currency capital. The capital is summed over ENABLED members
 * only, querying live `account_balance` records projected to tradable quote scale
 * (INR scale 2, USDT scale 8), falling back to `exchange_account.allocated_capital_minor`
 * when no balance row exists.
 */
export async function listGroups(tdb: TenantDb): Promise<readonly GroupSummary[]> {
  await ensureDefaultGroup(tdb);

  const groups = await tdb.selectFrom('account_group')
    .select(['id', 'name', 'description'])
    .where('archived_at' as never, 'is', null as never)
    .execute();

  const sortedGroups = [...groups].sort((a, b) => {
    if (a.name === DEFAULT_GROUP_NAME) return -1;
    if (b.name === DEFAULT_GROUP_NAME) return 1;
    return a.name.localeCompare(b.name);
  });

  const memberRows = await tdb.selectFrom('group_member')
    .innerJoin('exchange_account', 'exchange_account.id', 'group_member.account_id')
    .select([
      'group_member.group_id as groupId',
      'group_member.account_id as accountId',
      'group_member.enabled as enabled',
      'exchange_account.allocated_currency as currency',
      'exchange_account.allocated_capital_minor as capital',
    ])
    .execute() as ReadonlyArray<{
      groupId: string; accountId: string; enabled: boolean; currency: SupportedQuote; capital: string | null;
    }>;

  const enabledAccountIds = [...new Set(memberRows.filter((r) => r.enabled).map((r) => r.accountId))];

  const balanceMap = new Map<string, { INR?: { freeMinor: string; scale: number }; USDT?: { freeMinor: string; scale: number } }>();
  if (enabledAccountIds.length > 0) {
    const balanceRows = await tdb.selectFrom('account_balance')
      .select(['account_id', 'currency', 'free_minor', 'scale'])
      .where('account_id' as never, 'in', enabledAccountIds as never)
      .where('currency' as never, 'in', ['INR', 'USDT'] as never)
      .execute() as ReadonlyArray<{ account_id: string; currency: string; free_minor: string; scale: number }>;

    for (const b of balanceRows) {
      let acc = balanceMap.get(b.account_id);
      if (!acc) {
        acc = {};
        balanceMap.set(b.account_id, acc);
      }
      if (b.currency === 'INR' || b.currency === 'USDT') {
        acc[b.currency] = { freeMinor: b.free_minor, scale: b.scale };
      }
    }
  }

  const summaries: GroupSummary[] = [];
  for (const g of sortedGroups as ReadonlyArray<{ id: string; name: string; description: string | null }>) {
    const groupMembers = memberRows.filter((m) => m.groupId === g.id);
    const allocated: Record<SupportedQuote, bigint> = { INR: 0n, USDT: 0n };
    let enabledCount = 0;

    for (const m of groupMembers) {
      if (!m.enabled) continue;
      enabledCount += 1;

      const accBalances = balanceMap.get(m.accountId);
      let countedInr = false;
      let countedUsdt = false;

      if (accBalances?.INR) {
        const projected = projectToScale(accBalances.INR.freeMinor, accBalances.INR.scale, 2);
        allocated.INR += BigInt(projected);
        countedInr = true;
      }
      if (accBalances?.USDT) {
        const projected = projectToScale(accBalances.USDT.freeMinor, accBalances.USDT.scale, 8);
        allocated.USDT += BigInt(projected);
        countedUsdt = true;
      }

      // Fallback: if no account_balance records exist at all for this account,
      // fallback to exchange_account.allocated_capital_minor for its allocated_currency
      if (!countedInr && !countedUsdt && m.currency && m.capital) {
        allocated[m.currency] += BigInt(m.capital);
      }
    }

    summaries.push({
      id: g.id,
      name: g.name,
      description: g.description,
      memberCount: groupMembers.length,
      enabledCount,
      allocatedByCurrency: { INR: String(allocated.INR), USDT: String(allocated.USDT) },
    });
  }
  return summaries;
}

/** One enabled member as the planning fan-out sees it. */
export interface EnabledMember {
  readonly accountId: string;
  readonly accountName: string;
  readonly displayOrder: number;
  readonly allocatedCapitalMinor: string;
  readonly allocatedCurrency: SupportedQuote;
  readonly status: string;
}

/**
 * The fan-out input for the planning stage (T04.3): every ENABLED member of a
 * group, in display order, with the fields sizing needs. Disabled members are
 * excluded here rather than skipped later, because a disabled account is not a
 * refusal to explain — the customer chose to leave it out.
 */
export async function getEnabledMembers(tdb: TenantDb, groupId: string): Promise<readonly EnabledMember[]> {
  const rows = await tdb.selectFrom('group_member')
    .innerJoin('exchange_account', 'exchange_account.id', 'group_member.account_id')
    .select([
      'group_member.account_id as accountId',
      'exchange_account.name as accountName',
      'group_member.display_order as displayOrder',
      'exchange_account.allocated_capital_minor as allocatedCapitalMinor',
      'exchange_account.allocated_currency as allocatedCurrency',
      'exchange_account.status as status',
    ])
    .where('group_member.group_id' as never, '=', groupId as never)
    .where('group_member.enabled' as never, '=', true as never)
    .orderBy('group_member.display_order' as never)
    .orderBy('group_member.account_id' as never)
    .execute();
  return rows as ReadonlyArray<EnabledMember>;
}

/** A member as the management UI sees it — INCLUDING disabled ones. */
export interface GroupMember {
  readonly accountId: string;
  readonly accountName: string;
  readonly enabled: boolean;
  readonly displayOrder: number;
  readonly allocatedCapitalMinor: string;
  readonly allocatedCurrency: SupportedQuote;
  readonly status: string;
}

/**
 * Every member of a group, enabled or not, for the management view.
 *
 * `getEnabledMembers` deliberately drops disabled members because the fan-out
 * must not size them; managing a group is the opposite need — you must see a
 * disabled member to re-enable or remove it — so this read returns all of them
 * with the flag intact.
 */
export async function getGroupMembers(tdb: TenantDb, groupId: string): Promise<readonly GroupMember[]> {
  const rows = await tdb.selectFrom('group_member')
    .innerJoin('exchange_account', 'exchange_account.id', 'group_member.account_id')
    .select([
      'group_member.account_id as accountId',
      'exchange_account.name as accountName',
      'group_member.enabled as enabled',
      'group_member.display_order as displayOrder',
      'exchange_account.allocated_capital_minor as allocatedCapitalMinor',
      'exchange_account.allocated_currency as allocatedCurrency',
      'exchange_account.status as status',
    ])
    .where('group_member.group_id' as never, '=', groupId as never)
    .orderBy('group_member.display_order' as never)
    .orderBy('exchange_account.name' as never)
    .execute();
  return rows as ReadonlyArray<GroupMember>;
}

/** A group header (name/description), or null if it is not this tenant's or is archived. */
export interface GroupHeader {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export async function getGroupHeader(tdb: TenantDb, groupId: string): Promise<GroupHeader | null> {
  const row = await tdb.byId('account_group', groupId)
    .select(['id', 'name', 'description'] as unknown as never)
    .where('archived_at' as never, 'is', null as never)
    .executeTakeFirst();
  if (row === undefined) return null;
  const r = row as { id: string; name: string; description: string | null };
  return { id: r.id, name: r.name, description: r.description };
}
