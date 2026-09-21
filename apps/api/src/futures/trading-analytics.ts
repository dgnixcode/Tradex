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
import { getFuturesRtPrices, type FuturesRtPrice } from './rt-prices.js';

export interface TradingAnalyticsQuery {
  readonly groupId?: string | null | undefined;
  readonly accountId?: string | null | undefined;
  readonly timeframe?: 'today' | '7d' | '30d' | 'all' | 'custom' | null | undefined;
  readonly fromMs?: number | null | undefined;
  readonly toMs?: number | null | undefined;
}

export interface TradingKpis {
  readonly openPositionsCount: number;
  readonly unrealisedPnlMinor: Record<string, string>;
  readonly realizedPnlMinor: Record<string, string>;
  readonly netPnlMinor: Record<string, string>;
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
  readonly closedTradesCount: number;
  readonly winningClosedTrades: number;
  readonly losingClosedTrades: number;
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

export interface ClosedTradeAnalytics {
  readonly id: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly groupName: string | null;
  readonly pair: string;
  readonly market: string;
  readonly side: 'long' | 'short';
  readonly quantity: string;
  readonly avgEntryPrice: string;
  readonly avgExitPrice: string;
  readonly leverage: string | null;
  readonly realizedPnlMinor: string;
  readonly marginCurrency: string;
  readonly roePct: number | null;
  readonly durationMs: number | null;
  readonly openedAtMs: number | null;
  readonly closedAtMs: number;
}

export interface GroupAnalyticsRow {
  readonly groupId: string;
  readonly groupName: string;
  readonly memberCount: number;
  readonly activePositionsCount: number;
  readonly totalAllocatedMinor: Record<string, string>;
  readonly totalLockedMarginMinor: Record<string, string>;
  readonly totalUnrealisedPnlMinor: Record<string, string>;
  readonly totalRealizedPnlMinor: Record<string, string>;
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
  readonly realizedPnlMinor: Record<string, string>;
  readonly netPnlMinor: Record<string, string>;
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
  readonly isExit?: boolean;
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
  readonly timeframe: 'today' | '7d' | '30d' | 'all' | 'custom';
  readonly fromMs: number;
  readonly toMs: number;
  readonly kpis: TradingKpis;
  readonly symbols: readonly SymbolAnalytics[];
  readonly closedTrades: readonly ClosedTradeAnalytics[];
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

export function normalizeFuturesPair(pairOrMarket: string | null | undefined): string {
  if (!pairOrMarket) return '';
  const s = String(pairOrMarket).trim().toUpperCase();
  if (s.startsWith('B-') && s.includes('_')) return s;
  const clean = s.replace(/^B-/, '').trim();
  if (clean.endsWith('USDT')) {
    const base = clean.slice(0, -4).replace(/[-_]$/, '');
    return `B-${base}_USDT`;
  }
  if (clean.endsWith('INR')) {
    const base = clean.slice(0, -3).replace(/[-_]$/, '');
    return `B-${base}_INR`;
  }
  if (clean.includes('-') || clean.includes('_')) {
    const parts = clean.split(/[-_]/);
    return `B-${parts[0]}_${parts[1] || 'USDT'}`;
  }
  return `B-${clean}_USDT`;
}

export function findRtPrice(
  rtPricesMap: Map<string, FuturesRtPrice>,
  pairOrMarket: string | null | undefined,
): FuturesRtPrice | undefined {
  if (!pairOrMarket) return undefined;
  const raw = String(pairOrMarket).trim();
  if (rtPricesMap.has(raw)) return rtPricesMap.get(raw);

  const norm = normalizeFuturesPair(raw);
  if (rtPricesMap.has(norm)) return rtPricesMap.get(norm);

  // Try raw without B- prefix (e.g. TAOUSDT, SOLUSDT)
  const clean = raw.replace(/^B-/, '').replace(/[-_]/g, '').toUpperCase();
  for (const [key, val] of rtPricesMap.entries()) {
    const keyClean = key.replace(/^B-/, '').replace(/[-_]/g, '').toUpperCase();
    if (keyClean === clean) return val;
  }

  // Base asset fallback
  const base = norm.replace(/^B-/, '').split('_')[0];
  if (base) {
    for (const [key, val] of rtPricesMap.entries()) {
      if (key.startsWith(`B-${base}_`)) return val;
    }
  }
  return undefined;
}

function resolveTimeframeWindow(
  timeframe?: string | null,
  customFromMs?: number | null,
  customToMs?: number | null,
): { tf: 'today' | '7d' | '30d' | 'all' | 'custom'; fromMs: number; toMs: number } {
  const now = Date.now();
  if (timeframe === 'custom' && (customFromMs || customToMs)) {
    const from = customFromMs && customFromMs > 0 ? customFromMs : 0;
    const to = customToMs && customToMs > 0 ? customToMs : now;
    return { tf: 'custom', fromMs: from, toMs: to };
  }

  const tf = (timeframe === 'today' || timeframe === '7d' || timeframe === '30d' || timeframe === 'all' || timeframe === 'custom')
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
  const { tf, fromMs, toMs } = resolveTimeframeWindow(query.timeframe, query.fromMs, query.toMs);

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
  let targetAccounts = allAccounts.filter((a) => !a.hideFromPositions);
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
    targetAccounts = allAccounts.filter((a) => memberIds.has(a.id) && !a.hideFromPositions);
    const grp = rawGroups.find((g) => g.id === query.groupId);
    scopeType = 'group';
    scopeId = query.groupId;
    scopeName = grp?.name ?? 'Group';
  }

  const targetAccountIds = new Set(targetAccounts.map((a) => a.id));

  // 3. Fetch live futures positions & real-time prices
  const rtPricesMap = await getFuturesRtPrices().catch(() => new Map<string, FuturesRtPrice>());
  const posResponse = await buildFuturesPositions(db, tenantId, nowMs, rtPricesMap);
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

  // 5. Query child orders for execution analytics and closed trades
  let rawOrders: Array<Record<string, unknown>> = [];
  if (targetAccountIds.size > 0) {
    let ordersQuery = tdb.selectFrom('child_order')
      .innerJoin('exchange_account', 'exchange_account.id', 'child_order.account_id')
      .leftJoin('group_trade', 'group_trade.id', 'child_order.group_trade_id')
      .select([
        'child_order.id as id',
        'child_order.account_id as accountId',
        'exchange_account.name as accountName',
        'child_order.pair as pair',
        'child_order.market as market',
        'child_order.state as state',
        'child_order.final_quantity as finalQuantity',
        'child_order.filled_quantity as filledQuantity',
        'child_order.price_used as priceUsed',
        'child_order.avg_fill_price as avgFillPrice',
        'child_order.notional_minor as notionalMinor',
        'child_order.quote_currency as quoteCurrency',
        'child_order.created_at as createdAt',
        'child_order.venue_position_id as venuePositionId',
        'child_order.leg_kind as legKind',
        'group_trade.side as tradeSide',
        'group_trade.order_type as orderType',
        'group_trade.sizing_mode as sizingMode',
        'group_trade.reduce_only as reduceOnly',
        'group_trade.is_futures as isFutures',
        'group_trade.margin_currency as marginCurrency',
        'group_trade.leverage as leverage',
      ] as unknown as never)
      .where('child_order.account_id' as never, 'in', Array.from(targetAccountIds) as never)
      .orderBy('child_order.created_at' as never, 'desc' as never);

    if (fromMs > 0) {
      ordersQuery = ordersQuery.where('child_order.created_at' as never, '>=', new Date(fromMs) as never);
    }
    if (toMs > 0 && toMs < nowMs) {
      ordersQuery = ordersQuery.where('child_order.created_at' as never, '<=', new Date(toMs) as never);
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

  // 6. Symbols Breakdown (partitioned by pair AND marginCurrency so units never collide)
  const symbolMap = new Map<string, {
    symbol: string;
    pair: string;
    positions: FuturesPositionView[];
    marginCurrency: string;
  }>();

  for (const p of targetPositions) {
    const rawSym = p.pair.replace(/^B-/, '').replace(/_USDT$|_INR$/, '');
    const entryKey = `${p.pair}:${p.marginCurrency}`;
    const entry = symbolMap.get(entryKey) ?? {
      symbol: rawSym,
      pair: p.pair,
      positions: [],
      marginCurrency: p.marginCurrency,
    };
    entry.positions.push(p);
    symbolMap.set(entryKey, entry);
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

  // 7. Closed Trades & Realized PnL Engine
  // Query all chronological filled orders to reconstruct entries and exits
  const allChronologicalOrders = targetAccountIds.size > 0
    ? await tdb.selectFrom('child_order')
        .innerJoin('exchange_account', 'exchange_account.id', 'child_order.account_id')
        .leftJoin('group_trade', 'group_trade.id', 'child_order.group_trade_id')
        .select([
          'child_order.id as id',
          'child_order.account_id as accountId',
          'exchange_account.name as accountName',
          'child_order.pair as pair',
          'child_order.market as market',
          'child_order.state as state',
          'child_order.final_quantity as finalQuantity',
          'child_order.filled_quantity as filledQuantity',
          'child_order.price_used as priceUsed',
          'child_order.avg_fill_price as avgFillPrice',
          'child_order.notional_minor as notionalMinor',
          'child_order.quote_currency as quoteCurrency',
          'child_order.created_at as createdAt',
          'child_order.venue_position_id as venuePositionId',
          'child_order.leg_kind as legKind',
          'group_trade.side as tradeSide',
          'group_trade.sizing_mode as sizingMode',
          'group_trade.reduce_only as reduceOnly',
          'group_trade.is_futures as isFutures',
          'group_trade.margin_currency as marginCurrency',
          'group_trade.leverage as leverage',
        ] as unknown as never)
        .where('child_order.account_id' as never, 'in', Array.from(targetAccountIds) as never)
        .where('child_order.state' as never, '=', 'filled' as never)
        .orderBy('child_order.created_at' as never, 'asc' as never)
        .execute() as unknown as Array<Record<string, unknown>>
    : [];

  interface OpenEntryItem {
    id: string;
    accountId: string;
    accountName: string;
    pair: string;
    market: string;
    side: 'buy' | 'sell';
    qty: number;
    price: number;
    createdAtMs: number;
    marginCurrency: string;
    leverage: number;
    venuePositionId: string | null;
  }

  const openQueueByAccountPair = new Map<string, OpenEntryItem[]>();
  const closedTradesList: ClosedTradeAnalytics[] = [];
  const realizedPnlByCur: Record<string, string> = {};
  const realizedPnlByAccount: Record<string, Record<string, string>> = {};
  const realizedPnlByGroup: Record<string, Record<string, string>> = {};
  let winningClosedTrades = 0;
  let losingClosedTrades = 0;

  for (const r of allChronologicalOrders) {
    const accId = String(r['accountId']);
    const accName = String(r['accountName'] ?? 'Account');
    const rawPair = (r['pair'] && String(r['pair']).trim() !== '')
      ? String(r['pair']).trim()
      : (r['market'] ? String(r['market']).trim() : '');
    const pair = normalizeFuturesPair(rawPair) || rawPair;
    const market = String(r['market'] || r['pair'] || pair);
    const side = (String(r['tradeSide'] ?? 'buy').toLowerCase() === 'sell') ? 'sell' : 'buy';
    const isExit = Boolean(
      r['reduceOnly'] === true ||
      r['sizingMode'] === 'sell_all' ||
      r['sizingMode'] === 'pct_position' ||
      r['legKind'] === 'stop_loss' ||
      r['legKind'] === 'take_profit' ||
      r['legKind'] === 'exit'
    );
    const qtyStr = (r['filledQuantity'] && r['filledQuantity'] !== '0')
      ? String(r['filledQuantity'])
      : (r['finalQuantity'] ? String(r['finalQuantity']) : '0');
    const qtyNum = Number(qtyStr);
    const priceStr = r['avgFillPrice'] ? String(r['avgFillPrice']) : (r['priceUsed'] ? String(r['priceUsed']) : '0');
    const priceNum = Number(priceStr);
    const createdAt = r['createdAt'] instanceof Date ? r['createdAt'].getTime() : new Date(String(r['createdAt'])).getTime();
    const marginCurrency = (r['marginCurrency'] as string) || (r['quoteCurrency'] as string) || 'INR';
    const leverage = r['leverage'] ? Number(r['leverage']) : 1;
    const venuePosId = r['venuePositionId'] ? String(r['venuePositionId']) : null;
    const key = `${accId}|${pair}`;

    if (!isExit) {
      // Entry order
      const queue = openQueueByAccountPair.get(key) ?? [];
      queue.push({
        id: String(r['id']),
        accountId: accId,
        accountName: accName,
        pair,
        market,
        side,
        qty: qtyNum,
        price: priceNum,
        createdAtMs: createdAt,
        marginCurrency,
        leverage,
        venuePositionId: venuePosId,
      });
      openQueueByAccountPair.set(key, queue);
    } else {
      // Exit order: match against open entry queue FIFO
      const queue = openQueueByAccountPair.get(key) ?? [];
      let remainingExitQty = qtyNum;
      while (queue.length > 0 && remainingExitQty > 0) {
        const entry = queue[0]!;
        const matchedQty = Math.min(entry.qty, remainingExitQty);
        const isLong = entry.side === 'buy';
        const dir = isLong ? 1 : -1;
        const entryPrice = entry.price;
        const exitPrice = priceNum > 0 ? priceNum : entryPrice;
        const priceDiff = (exitPrice - entryPrice) * dir;
        const pnl = matchedQty * priceDiff;

        // Scale to minor units
        const isUsdtContract = pair.includes('USDT') || pair.endsWith('USDT');
        let pnlMinorVal: string;
        if (entry.marginCurrency === 'INR' && isUsdtContract) {
          const peg = 100; // standard frozen INR/USDT settlement conversion
          pnlMinorVal = Math.round(pnl * peg * 100).toString();
        } else if (entry.marginCurrency === 'USDT') {
          pnlMinorVal = Math.round(pnl * 100_000_000).toString();
        } else {
          pnlMinorVal = Math.round(pnl * 100).toString();
        }

        const roePct = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 * entry.leverage * dir : null;
        const closedAtMs = createdAt;

        if (closedAtMs >= fromMs && closedAtMs <= toMs) {
          const grpName = accountGroupMap.get(entry.accountId) ?? null;
          closedTradesList.push({
            id: `closed-${entry.id}-${r['id']}`,
            accountId: entry.accountId,
            accountName: entry.accountName,
            groupName: grpName,
            pair: entry.pair,
            market: entry.market,
            side: isLong ? 'long' : 'short',
            quantity: matchedQty.toFixed(4).replace(/\.?0+$/, ''),
            avgEntryPrice: entryPrice > 0 ? entryPrice.toString() : '—',
            avgExitPrice: exitPrice > 0 ? exitPrice.toString() : '—',
            leverage: entry.leverage ? `${entry.leverage}x` : null,
            realizedPnlMinor: pnlMinorVal,
            marginCurrency: entry.marginCurrency,
            roePct,
            durationMs: Math.max(0, closedAtMs - entry.createdAtMs),
            openedAtMs: entry.createdAtMs,
            closedAtMs,
          });

          // Accumulate KPIs
          const cur = entry.marginCurrency;
          realizedPnlByCur[cur] = realizedPnlByCur[cur] === undefined
            ? pnlMinorVal
            : addMinorValues(realizedPnlByCur[cur]!, pnlMinorVal);

          // Per-account realized PnL
          const accPnlMap = realizedPnlByAccount[entry.accountId] ?? {};
          accPnlMap[cur] = accPnlMap[cur] === undefined
            ? pnlMinorVal
            : addMinorValues(accPnlMap[cur]!, pnlMinorVal);
          realizedPnlByAccount[entry.accountId] = accPnlMap;

          // Per-group realized PnL
          const userGrpId = rawMemberships.find((m) => m.accountId === entry.accountId)?.groupId;
          if (userGrpId) {
            const grpPnlMap = realizedPnlByGroup[userGrpId] ?? {};
            grpPnlMap[cur] = grpPnlMap[cur] === undefined
              ? pnlMinorVal
              : addMinorValues(grpPnlMap[cur]!, pnlMinorVal);
            realizedPnlByGroup[userGrpId] = grpPnlMap;
          }

          if (Number(pnlMinorVal) > 0) winningClosedTrades += 1;
          else if (Number(pnlMinorVal) < 0) losingClosedTrades += 1;
        }

        entry.qty -= matchedQty;
        remainingExitQty -= matchedQty;
        if (entry.qty <= 0.000001) {
          queue.shift();
        }
      }
    }
  }

  // Handle entries whose positions have closed at the exchange but had no direct exit order
  // (e.g. SOLUSDT exited prior to order blotter logging)
  const activePositionKeys = new Set(targetPositions.map((p) => `${p.accountId}|${normalizeFuturesPair(p.pair) || p.pair}`));
  for (const [key, queue] of openQueueByAccountPair.entries()) {
    if (!activePositionKeys.has(key)) {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        if (entry.qty <= 0.000001) continue;
        const entryPrice = entry.price;
        // Never use live real-time market tickers for closed trades (fixes fluctuating PnL/ROE on refresh).
        // Closed trades without recorded fills fall back deterministically to entry price (breakeven PnL 0).
        const exitPrice = entryPrice;
        const isLong = entry.side === 'buy';
        const pnlMinorVal = '0';
        const roePct = entryPrice > 0 ? 0 : null;
        const closedAtMs = entry.createdAtMs + 60_000; // estimated close time

        if (closedAtMs >= fromMs && closedAtMs <= toMs) {
          const grpName = accountGroupMap.get(entry.accountId) ?? null;
          closedTradesList.push({
            id: `synth-${entry.id}`,
            accountId: entry.accountId,
            accountName: entry.accountName,
            groupName: grpName,
            pair: entry.pair,
            market: entry.market,
            side: isLong ? 'long' : 'short',
            quantity: entry.qty.toFixed(4).replace(/\.?0+$/, ''),
            avgEntryPrice: entryPrice > 0 ? entryPrice.toString() : '—',
            avgExitPrice: exitPrice > 0 ? exitPrice.toString() : '—',
            leverage: entry.leverage ? `${entry.leverage}x` : null,
            realizedPnlMinor: pnlMinorVal,
            marginCurrency: entry.marginCurrency,
            roePct,
            durationMs: Math.max(0, closedAtMs - entry.createdAtMs),
            openedAtMs: entry.createdAtMs,
            closedAtMs,
          });

          const cur = entry.marginCurrency;
          realizedPnlByCur[cur] = realizedPnlByCur[cur] === undefined
            ? pnlMinorVal
            : addMinorValues(realizedPnlByCur[cur]!, pnlMinorVal);

          const accPnlMap = realizedPnlByAccount[entry.accountId] ?? {};
          accPnlMap[cur] = accPnlMap[cur] === undefined
            ? pnlMinorVal
            : addMinorValues(accPnlMap[cur]!, pnlMinorVal);
          realizedPnlByAccount[entry.accountId] = accPnlMap;

          const userGrpId = rawMemberships.find((m) => m.accountId === entry.accountId)?.groupId;
          if (userGrpId) {
            const grpPnlMap = realizedPnlByGroup[userGrpId] ?? {};
            grpPnlMap[cur] = grpPnlMap[cur] === undefined
              ? pnlMinorVal
              : addMinorValues(grpPnlMap[cur]!, pnlMinorVal);
            realizedPnlByGroup[userGrpId] = grpPnlMap;
          }

          if (Number(pnlMinorVal) > 0) winningClosedTrades += 1;
          else if (Number(pnlMinorVal) < 0) losingClosedTrades += 1;
        }
      }
    }
  }

  // Sort closed trades desc by close time
  closedTradesList.sort((a, b) => b.closedAtMs - a.closedAtMs);

  // Compute Net PnL (Realized + Unrealized) by currency
  const netPnlByCur: Record<string, string> = {};
  const allPnlCurs = new Set([...Object.keys(unrealisedPnlByCur), ...Object.keys(realizedPnlByCur)]);
  for (const cur of allPnlCurs) {
    const u = unrealisedPnlByCur[cur] ?? '0';
    const r = realizedPnlByCur[cur] ?? '0';
    netPnlByCur[cur] = addMinorValues(u, r);
  }

  const pnlPercentageByCur: Record<string, number> = {};
  for (const cur of Object.keys(unrealisedPnlByCur)) {
    const pnlVal = Number(unrealisedPnlByCur[cur]);
    const marginVal = lockedMarginByCur[cur] ? Number(lockedMarginByCur[cur]) : 0;
    if (marginVal > 0) {
      pnlPercentageByCur[cur] = (pnlVal / marginVal) * 100;
    }
  }

  // Win rate based strictly on closed/realized trades (industry standard)
  const totalClosedDecided = winningClosedTrades + losingClosedTrades;
  const winRatePct = totalClosedDecided > 0
    ? (winningClosedTrades / totalClosedDecided) * 100
    : null;

  // 8. Strategy Groups Breakdown
  const groups: GroupAnalyticsRow[] = rawGroups.map((g) => {
    const rawMemberIds = groupMembersMap.get(g.id) ?? [];
    const memberIds = rawMemberIds.filter((mId) => {
      const acc = accountsMap.get(mId);
      return acc !== undefined && !acc.hideFromPositions;
    });
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

    // Weighted ROE calculation for group
    let totalGrpMarginNum = 0;
    let totalGrpPnlNum = 0;
    for (const cur of Object.keys(unrealisedPnlMinor)) {
      totalGrpPnlNum += Number(unrealisedPnlMinor[cur]);
      totalGrpMarginNum += lockedMarginMinor[cur] ? Number(lockedMarginMinor[cur]) : 0;
    }
    const roePct = totalGrpMarginNum > 0 ? (totalGrpPnlNum / totalGrpMarginNum) * 100 : null;
    const grpRealizedPnl = realizedPnlByGroup[g.id] ?? {};

    return {
      groupId: g.id,
      groupName: g.name,
      memberCount: memberIds.length,
      activePositionsCount: grpPositions.length,
      totalAllocatedMinor: allocatedMinor,
      totalLockedMarginMinor: lockedMarginMinor,
      totalUnrealisedPnlMinor: unrealisedPnlMinor,
      totalRealizedPnlMinor: grpRealizedPnl,
      roePct,
      profitableMembersCount: profitableMembers,
      unprofitableMembersCount: unprofitableMembers,
    };
  }).sort((a, b) => b.activePositionsCount - a.activePositionsCount);

  // 9. Account Analytics & Leaderboard
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
    const aRealized = realizedPnlByAccount[a.id] ?? {};
    const aNetPnl: Record<string, string> = {};
    const aCurs = new Set([...Object.keys(pnlByCur), ...Object.keys(aRealized)]);
    for (const c of aCurs) {
      aNetPnl[c] = addMinorValues(pnlByCur[c] ?? '0', aRealized[c] ?? '0');
    }

    return {
      accountId: a.id,
      accountName: a.name,
      groupName: accountGroupMap.get(a.id) ?? a.groupName ?? null,
      status: a.status,
      allocatedCapitalMinor: a.allocatedCapitalMinor,
      allocatedCurrency: a.allocatedCurrency,
      openPositionsCount: accPositions.length,
      unrealisedPnlMinor: pnlByCur,
      realizedPnlMinor: aRealized,
      netPnlMinor: aNetPnl,
      lockedMarginMinor: marginByCur,
      roePct,
      totalOrders: ordStats.total,
      filledOrders: ordStats.filled,
      fillRatePct: aFillRate,
    };
  }).sort((a, b) => {
    if (b.openPositionsCount !== a.openPositionsCount) {
      return b.openPositionsCount - a.openPositionsCount;
    }
    const aPnl = Number(Object.values(a.netPnlMinor)[0] ?? Object.values(a.unrealisedPnlMinor)[0] ?? 0);
    const bPnl = Number(Object.values(b.netPnlMinor)[0] ?? Object.values(b.unrealisedPnlMinor)[0] ?? 0);
    return bPnl - aPnl;
  });

  // 10. Recent Orders (slice to top 20 with fallback quantities and prices)
  const recentOrders: RecentTradingOrder[] = rawOrders.slice(0, 20).map((r) => {
    const accId = String(r['accountId']);
    const isExit = Boolean(
      r['reduceOnly'] === true ||
      r['sizingMode'] === 'sell_all' ||
      r['sizingMode'] === 'pct_position' ||
      r['legKind'] === 'stop_loss' ||
      r['legKind'] === 'take_profit'
    );
    const side = (String(r['tradeSide'] ?? 'buy').toLowerCase() === 'sell') ? 'sell' : 'buy';
    const filledQty = (r['filledQuantity'] && r['filledQuantity'] !== '0')
      ? String(r['filledQuantity'])
      : (r['finalQuantity'] ? String(r['finalQuantity']) : null);
    const avgFillPrice = r['avgFillPrice'] ? String(r['avgFillPrice']) : (r['priceUsed'] ? String(r['priceUsed']) : null);

    return {
      id: String(r['id']),
      createdAtMs: r['createdAt'] instanceof Date ? r['createdAt'].getTime() : new Date(String(r['createdAt'])).getTime(),
      accountId: accId,
      accountName: String(r['accountName'] ?? 'Account'),
      groupName: accountGroupMap.get(accId) ?? null,
      pair: (r['pair'] && String(r['pair']).trim() !== '') ? String(r['pair']).trim() : String(r['market'] ?? '—'),
      side,
      isExit,
      state: String(r['state']),
      filledQuantity: filledQty,
      avgFillPrice,
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
      realizedPnlMinor: realizedPnlByCur,
      netPnlMinor: netPnlByCur,
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
      closedTradesCount: closedTradesList.length,
      winningClosedTrades,
      losingClosedTrades,
      winRatePct,
    },
    symbols,
    closedTrades: closedTradesList,
    groups,
    accounts,
    recentOrders,
    at: new Date(nowMs).toISOString(),
  };
}
