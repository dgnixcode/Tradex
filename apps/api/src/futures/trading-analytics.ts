// The Trading Analytics Service
//
// Computes real-time and historical trading telemetry for:
// 1. Desk-wide Platform Analytics (/app/analytics)
// 2. Strategy Group Analytics (/app/groups/:id)
// 3. Account Analytics (/app/accounts/:id)
//
// Complies with ARCHITECTURE §6a and checks/07 (lives in futures/ to handle futures mark metrics).

import type { DB } from '@tradex/db';
import { forTenant } from '@tradex/db';
import type { Kysely } from 'kysely';
import { listAccounts } from '../accounts-query.js';
import { buildFuturesPositions } from './positions.js';
import type { FuturesPositionView } from './positions.js';

export interface TradingAnalyticsQuery {
  readonly groupId?: string | null;
  readonly accountId?: string | null;
  readonly timeframe?: 'today' | '7d' | '30d' | 'all' | null;
}

export interface TradingKpis {
  readonly openPositionsCount: number;
  readonly unrealisedPnlMinor: Record<string, string>;
  readonly lockedMarginMinor: Record<string, string>;
  readonly pnlPercentage: Record<string, number>;
  readonly totalOrders: number;
  readonly filledOrders: number;
  readonly skippedOrders: number;
  readonly rejectedOrders: number;
  readonly fillRatePct: number;
  readonly totalTradedVolumeMinor: Record<string, string>;
  readonly winningPositions: number;
  readonly losingPositions: number;
  readonly winRatePct: number | null;
}

export interface SymbolAnalytics {
  readonly symbol: string;
  readonly pair: string;
  readonly positionsCount: number;
  readonly totalQuantity: string;
  readonly side: 'long' | 'short' | 'both' | 'flat';
  readonly marginCurrency: string;
  readonly unrealisedPnlMinor: string;
  readonly lockedMarginMinor: string;
  readonly roePct: number | null;
  readonly avgEntryPrice: string | null;
  readonly markPrice: string | null;
}

export interface GroupAnalyticsRow {
  readonly groupId: string;
  readonly groupName: string;
  readonly memberCount: number;
  readonly activePositionsCount: number;
  readonly totalAllocatedMinor: Record<string, string>;
  readonly totalLockedMarginMinor: Record<string, string>;
  readonly totalUnrealisedPnlMinor: Record<string, string>;
  readonly roePct: number | null;
  readonly profitableMembersCount: number;
  readonly unprofitableMembersCount: number;
}

export interface AccountAnalyticsRow {
  readonly accountId: string;
  readonly accountName: string;
  readonly groupName: string | null;
  readonly status: string;
  readonly allocatedCapitalMinor: string | null;
  readonly allocatedCurrency: string | null;
  readonly openPositionsCount: number;
  readonly unrealisedPnlMinor: Record<string, string>;
  readonly lockedMarginMinor: Record<string, string>;
  readonly roePct: number | null;
  readonly totalOrders: number;
  readonly filledOrders: number;
  readonly fillRatePct: number;
}

export interface RecentTradingOrder {
  readonly id: string;
  readonly createdAtMs: number;
  readonly accountId: string;
  readonly accountName: string;
  readonly groupName: string | null;
  readonly pair: string;
  readonly side: 'buy' | 'sell';
  readonly state: string;
  readonly filledQuantity: string | null;
  readonly avgFillPrice: string | null;
  readonly notionalMinor: string | null;
  readonly quoteCurrency: string | null;
}

export interface TradingAnalyticsReport {
  readonly scope: {
    readonly type: 'all' | 'group' | 'account';
    readonly id: string | null;
    readonly name: string | null;
  };
  readonly timeframe: 'today' | '7d' | '30d' | 'all';
  readonly fromMs: number;
  readonly toMs: number;
  readonly kpis: TradingKpis;
  readonly symbols: readonly SymbolAnalytics[];
  readonly groups: readonly GroupAnalyticsRow[];
  readonly accounts: readonly AccountAnalyticsRow[];
  readonly recentOrders: readonly RecentTradingOrder[];
  readonly at: string;
}

function addMinorValues(a: string, b: string): string {
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return a;
  }
}

function resolveTimeframeWindow(timeframe?: string | null): { tf: 'today' | '7d' | '30d' | 'all'; fromMs: number; toMs: number } {
  const now = Date.now();
  const tf = (timeframe === 'today' || timeframe === '7d' || timeframe === '30d' || timeframe === 'all')
    ? timeframe
    : 'all';

  if (tf === 'today') {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return { tf, fromMs: d.getTime(), toMs: now };
  }
  if (tf === '7d') {
    return { tf, fromMs: now - 7 * 24 * 60 * 60 * 1000, toMs: now };
  }
  if (tf === '30d') {
    return { tf, fromMs: now - 30 * 24 * 60 * 60 * 1000, toMs: now };
  }
  return { tf: 'all', fromMs: 0, toMs: now };
}

export async function buildTradingAnalytics(
  db: Kysely<DB>,
  tenantId: string,
  query: TradingAnalyticsQuery = {},
): Promise<TradingAnalyticsReport> {
  const nowMs = Date.now();
  const tdb = forTenant(db, tenantId);
  const { tf, fromMs, toMs } = resolveTimeframeWindow(query.timeframe);

  // 1. Fetch accounts and group mappings
  const allAccounts = await listAccounts(tdb);
  const accountsMap = new Map(allAccounts.map((a) => [a.id, a]));

  const rawGroups = await tdb.selectFrom('account_group')
    .select(['id', 'name', 'description'] as unknown as never)
    .where('archived_at' as never, 'is', null as never)
    .orderBy('name' as never)
    .execute() as unknown as ReadonlyArray<{ id: string; name: string; description: string | null }>;

  const rawMemberships = await tdb.selectFrom('group_member')
    .select(['group_id as groupId', 'account_id as accountId', 'enabled'] as unknown as never)
    .execute() as unknown as ReadonlyArray<{ groupId: string; accountId: string; enabled: boolean }>;

  const groupMembersMap = new Map<string, string[]>();
  const accountGroupMap = new Map<string, string>();
  for (const m of rawMemberships) {
    const list = groupMembersMap.get(m.groupId) ?? [];
    list.push(m.accountId);
    groupMembersMap.set(m.groupId, list);

    const grp = rawGroups.find((g) => g.id === m.groupId);
    if (grp) {
      accountGroupMap.set(m.accountId, grp.name);
    }
  }

  // 2. Determine target scope
  let targetAccounts = allAccounts;
  let scopeType: 'all' | 'group' | 'account' = 'all';
  let scopeId: string | null = null;
  let scopeName: string | null = null;

  if (query.accountId) {
    const single = allAccounts.find((a) => a.id === query.accountId);
    if (single) {
      targetAccounts = [single];
      scopeType = 'account';
      scopeId = single.id;
      scopeName = single.name;
    }
  } else if (query.groupId) {
    const memberIds = new Set(groupMembersMap.get(query.groupId) ?? []);
    targetAccounts = allAccounts.filter((a) => memberIds.has(a.id));
    const grp = rawGroups.find((g) => g.id === query.groupId);
    scopeType = 'group';
    scopeId = query.groupId;
    scopeName = grp?.name ?? 'Group';
  }

  const targetAccountIds = new Set(targetAccounts.map((a) => a.id));

  // 3. Fetch live futures positions
  const posResponse = await buildFuturesPositions(db, tenantId, nowMs);
  const targetPositions: FuturesPositionView[] = posResponse.views.filter(
    (p) => targetAccountIds.has(p.accountId) && p.side !== 'flat',
  );

  // 4. Compute Live KPIs
  const unrealisedPnlByCur: Record<string, string> = {};
  const lockedMarginByCur: Record<string, string> = {};
  let winningPositions = 0;
  let losingPositions = 0;

  for (const p of targetPositions) {
    const cur = p.marginCurrency;
    if (p.unrealisedPnlMinor !== null) {
      unrealisedPnlByCur[cur] = unrealisedPnlByCur[cur] === undefined
        ? p.unrealisedPnlMinor
        : addMinorValues(unrealisedPnlByCur[cur]!, p.unrealisedPnlMinor);

      const pnlVal = Number(p.unrealisedPnlMinor);
      if (pnlVal > 0) winningPositions += 1;
      else if (pnlVal < 0) losingPositions += 1;
    }

    if (p.lockedMarginMinor !== null && p.lockedMarginMinor !== '0') {
      lockedMarginByCur[cur] = lockedMarginByCur[cur] === undefined
        ? p.lockedMarginMinor
        : addMinorValues(lockedMarginByCur[cur]!, p.lockedMarginMinor);
    }
  }

  const pnlPercentageByCur: Record<string, number> = {};
  for (const cur of Object.keys(unrealisedPnlByCur)) {
    const pnlVal = Number(unrealisedPnlByCur[cur]);
    const marginVal = lockedMarginByCur[cur] ? Number(lockedMarginByCur[cur]) : 0;
    if (marginVal > 0) {
      pnlPercentageByCur[cur] = (pnlVal / marginVal) * 100;
    }
  }

  const decidedPositions = winningPositions + losingPositions;
  const winRatePct = decidedPositions > 0 ? (winningPositions / decidedPositions) * 100 : null;

  // 5. Query child orders for execution analytics
  let rawOrders: Array<Record<string, unknown>> = [];
  if (targetAccountIds.size > 0) {
    let ordersQuery = tdb.selectFrom('child_order')
      .innerJoin('exchange_account', 'exchange_account.id', 'child_order.account_id')
      .select([
        'child_order.id as id',
        'child_order.account_id as accountId',
        'exchange_account.name as accountName',
        'child_order.pair as pair',
        'child_order.market as market',
        'child_order.state as state',
        'child_order.filled_quantity as filledQuantity',
        'child_order.avg_fill_price as avgFillPrice',
        'child_order.notional_minor as notionalMinor',
        'child_order.quote_currency as quoteCurrency',
        'child_order.created_at as createdAt',
      ] as unknown as never)
      .where('child_order.account_id' as never, 'in', Array.from(targetAccountIds) as never)
      .orderBy('child_order.created_at' as never, 'desc' as never);

    if (fromMs > 0) {
      ordersQuery = ordersQuery.where('child_order.created_at' as never, '>=', new Date(fromMs) as never);
    }

    rawOrders = (await ordersQuery.limit(500).execute()) as unknown as Array<Record<string, unknown>>;
  }

  let totalOrders = 0;
  let filledOrders = 0;
  let skippedOrders = 0;
  let rejectedOrders = 0;
  const totalTradedVolumeByCur: Record<string, string> = {};
  const ordersCountByAccount: Record<string, { total: number; filled: number }> = {};

  for (const o of rawOrders) {
    totalOrders += 1;
    const accId = String(o['accountId']);
    const curStats = ordersCountByAccount[accId] ?? { total: 0, filled: 0 };
    curStats.total += 1;

    const state = String(o['state']);
    if (state === 'filled') {
      filledOrders += 1;
      curStats.filled += 1;
      const quote = (o['quoteCurrency'] as string) || 'INR';
      const notional = o['notionalMinor'] ? String(o['notionalMinor']) : null;
      if (notional && notional !== '0') {
        totalTradedVolumeByCur[quote] = totalTradedVolumeByCur[quote] === undefined
          ? notional
          : addMinorValues(totalTradedVolumeByCur[quote]!, notional);
      }
    } else if (state === 'skipped') {
      skippedOrders += 1;
    } else if (state === 'rejected') {
      rejectedOrders += 1;
    }

    ordersCountByAccount[accId] = curStats;
  }

  const fillRatePct = totalOrders > 0 ? (filledOrders / totalOrders) * 100 : 0;

  // 6. Symbols Breakdown
  const symbolMap = new Map<string, {
    symbol: string;
    pair: string;
    positions: FuturesPositionView[];
    marginCurrency: string;
  }>();

  for (const p of targetPositions) {
    const rawSym = p.pair.replace(/^B-/, '').replace(/_USDT$|_INR$/, '');
    const entry = symbolMap.get(p.pair) ?? {
      symbol: rawSym,
      pair: p.pair,
      positions: [],
      marginCurrency: p.marginCurrency,
    };
    entry.positions.push(p);
    symbolMap.set(p.pair, entry);
  }

  const symbols: SymbolAnalytics[] = Array.from(symbolMap.values()).map((entry) => {
    const posList = entry.positions;
    let totalQty = 0;
    let totalMargin = 0n;
    let totalPnl = 0n;
    let weightedRoeSum = 0;
    let totalWeight = 0;
    const sides = new Set<string>();

    for (const p of posList) {
      sides.add(p.side);
      const q = Math.abs(Number(p.quantity));
      totalQty += q;
      if (p.lockedMarginMinor) totalMargin += BigInt(p.lockedMarginMinor);
      if (p.unrealisedPnlMinor) totalPnl += BigInt(p.unrealisedPnlMinor);

      if (p.lockedMarginMinor && Number(p.lockedMarginMinor) > 0 && p.unrealisedPnlMinor) {
        const roe = (Number(p.unrealisedPnlMinor) / Number(p.lockedMarginMinor)) * 100;
        weightedRoeSum += roe * q;
        totalWeight += q;
      }
    }

    const side: 'long' | 'short' | 'both' | 'flat' = sides.size > 1 ? 'both' : (posList[0]?.side ?? 'flat');
    const roePct = totalWeight > 0 ? weightedRoeSum / totalWeight : null;

    return {
      symbol: entry.symbol,
      pair: entry.pair,
      positionsCount: posList.length,
      totalQuantity: totalQty.toFixed(4).replace(/\.?0+$/, ''),
      side,
      marginCurrency: entry.marginCurrency,
      unrealisedPnlMinor: totalPnl.toString(),
      lockedMarginMinor: totalMargin.toString(),
      roePct,
      avgEntryPrice: posList[0]?.avgEntryPrice ?? null,
      markPrice: posList[0]?.markPrice ?? null,
    };
  }).sort((a, b) => Number(b.lockedMarginMinor) - Number(a.lockedMarginMinor));

  // 7. Strategy Groups Breakdown
  const groups: GroupAnalyticsRow[] = rawGroups.map((g) => {
    const memberIds = groupMembersMap.get(g.id) ?? [];
    const memberSet = new Set(memberIds);
    const grpPositions = posResponse.views.filter((p) => memberSet.has(p.accountId) && p.side !== 'flat');

    const allocatedMinor: Record<string, string> = {};
    for (const mId of memberIds) {
      const acc = accountsMap.get(mId);
      if (acc && acc.allocatedCapitalMinor) {
        const cur = acc.allocatedCurrency || 'INR';
        allocatedMinor[cur] = allocatedMinor[cur] === undefined
          ? acc.allocatedCapitalMinor
          : addMinorValues(allocatedMinor[cur]!, acc.allocatedCapitalMinor);
      }
    }

    const lockedMarginMinor: Record<string, string> = {};
    const unrealisedPnlMinor: Record<string, string> = {};
    let profitableMembers = 0;
    let unprofitableMembers = 0;
    const memberPnlMap = new Map<string, bigint>();

    for (const p of grpPositions) {
      const cur = p.marginCurrency;
      if (p.lockedMarginMinor) {
        lockedMarginMinor[cur] = lockedMarginMinor[cur] === undefined
          ? p.lockedMarginMinor
          : addMinorValues(lockedMarginMinor[cur]!, p.lockedMarginMinor);
      }
      if (p.unrealisedPnlMinor) {
        unrealisedPnlMinor[cur] = unrealisedPnlMinor[cur] === undefined
          ? p.unrealisedPnlMinor
          : addMinorValues(unrealisedPnlMinor[cur]!, p.unrealisedPnlMinor);

        const currentPnl = memberPnlMap.get(p.accountId) ?? 0n;
        memberPnlMap.set(p.accountId, currentPnl + BigInt(p.unrealisedPnlMinor));
      }
    }

    for (const pnl of memberPnlMap.values()) {
      if (pnl > 0n) profitableMembers += 1;
      else if (pnl < 0n) unprofitableMembers += 1;
    }

    // Weighted ROE calculation
    let totalGrpMarginNum = 0;
    let totalGrpPnlNum = 0;
    for (const cur of Object.keys(unrealisedPnlMinor)) {
      totalGrpPnlNum += Number(unrealisedPnlMinor[cur]);
      totalGrpMarginNum += lockedMarginMinor[cur] ? Number(lockedMarginMinor[cur]) : 0;
    }
    const roePct = totalGrpMarginNum > 0 ? (totalGrpPnlNum / totalGrpMarginNum) * 100 : null;

    return {
      groupId: g.id,
      groupName: g.name,
      memberCount: memberIds.length,
      activePositionsCount: grpPositions.length,
      totalAllocatedMinor: allocatedMinor,
      totalLockedMarginMinor: lockedMarginMinor,
      totalUnrealisedPnlMinor: unrealisedPnlMinor,
      roePct,
      profitableMembersCount: profitableMembers,
      unprofitableMembersCount: unprofitableMembers,
    };
  }).sort((a, b) => b.activePositionsCount - a.activePositionsCount);

  // 8. Account Analytics & Leaderboard
  const accounts: AccountAnalyticsRow[] = targetAccounts.map((a) => {
    const accPositions = posResponse.views.filter((p) => p.accountId === a.id && p.side !== 'flat');
    const pnlByCur: Record<string, string> = {};
    const marginByCur: Record<string, string> = {};
    let totalMarginNum = 0;
    let totalPnlNum = 0;

    for (const p of accPositions) {
      const cur = p.marginCurrency;
      if (p.unrealisedPnlMinor) {
        pnlByCur[cur] = pnlByCur[cur] === undefined
          ? p.unrealisedPnlMinor
          : addMinorValues(pnlByCur[cur]!, p.unrealisedPnlMinor);
        totalPnlNum += Number(p.unrealisedPnlMinor);
      }
      if (p.lockedMarginMinor) {
        marginByCur[cur] = marginByCur[cur] === undefined
          ? p.lockedMarginMinor
          : addMinorValues(marginByCur[cur]!, p.lockedMarginMinor);
        totalMarginNum += Number(p.lockedMarginMinor);
      }
    }

    const roePct = totalMarginNum > 0 ? (totalPnlNum / totalMarginNum) * 100 : null;
    const ordStats = ordersCountByAccount[a.id] ?? { total: 0, filled: 0 };
    const aFillRate = ordStats.total > 0 ? (ordStats.filled / ordStats.total) * 100 : 0;

    return {
      accountId: a.id,
      accountName: a.name,
      groupName: accountGroupMap.get(a.id) ?? a.groupName ?? null,
      status: a.status,
      allocatedCapitalMinor: a.allocatedCapitalMinor,
      allocatedCurrency: a.allocatedCurrency,
      openPositionsCount: accPositions.length,
      unrealisedPnlMinor: pnlByCur,
      lockedMarginMinor: marginByCur,
      roePct,
      totalOrders: ordStats.total,
      filledOrders: ordStats.filled,
      fillRatePct: aFillRate,
    };
  }).sort((a, b) => {
    // Sort by open positions first, then by primary PnL
    if (b.openPositionsCount !== a.openPositionsCount) {
      return b.openPositionsCount - a.openPositionsCount;
    }
    const aPnl = Number(Object.values(a.unrealisedPnlMinor)[0] ?? 0);
    const bPnl = Number(Object.values(b.unrealisedPnlMinor)[0] ?? 0);
    return bPnl - aPnl;
  });

  // 9. Recent Orders (slice to top 20)
  const recentOrders: RecentTradingOrder[] = rawOrders.slice(0, 20).map((r) => {
    const accId = String(r['accountId']);
    return {
      id: String(r['id']),
      createdAtMs: r['createdAt'] instanceof Date ? r['createdAt'].getTime() : new Date(String(r['createdAt'])).getTime(),
      accountId: accId,
      accountName: String(r['accountName'] ?? 'Account'),
      groupName: accountGroupMap.get(accId) ?? null,
      pair: String(r['pair'] ?? r['market'] ?? '—'),
      side: 'buy',
      state: String(r['state']),
      filledQuantity: r['filledQuantity'] === null ? null : String(r['filledQuantity']),
      avgFillPrice: r['avgFillPrice'] === null ? null : String(r['avgFillPrice']),
      notionalMinor: r['notionalMinor'] === null ? null : String(r['notionalMinor']),
      quoteCurrency: r['quoteCurrency'] === null ? null : String(r['quoteCurrency']),
    };
  });

  return {
    scope: { type: scopeType, id: scopeId, name: scopeName },
    timeframe: tf,
    fromMs,
    toMs,
    kpis: {
      openPositionsCount: targetPositions.length,
      unrealisedPnlMinor: unrealisedPnlByCur,
      lockedMarginMinor: lockedMarginByCur,
      pnlPercentage: pnlPercentageByCur,
      totalOrders,
      filledOrders,
      skippedOrders,
      rejectedOrders,
      fillRatePct,
      totalTradedVolumeMinor: totalTradedVolumeByCur,
      winningPositions,
      losingPositions,
      winRatePct,
    },
    symbols,
    groups,
    accounts,
    recentOrders,
    at: new Date(nowMs).toISOString(),
  };
}
