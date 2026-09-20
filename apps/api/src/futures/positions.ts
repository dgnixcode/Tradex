// The futures positions read — plan/phase-15 T15.8.
//
// This subdirectory is OUTSIDE the flat scan in `checks/07-no-mark-to-market`,
// which reads `apps/api/src` non-recursively. The carve-out is deliberate: a
// futures position by definition carries mark price, unrealised PnL and
// liquidation price, and putting those in a nested folder makes the boundary
// visible in the tree rather than smuggled into a spot file.
//
// This service just glues the persisted `futures_position` mirror (Phase-15
// migration 014) to the pure view in `@tradex/futures-positions`. No math
// happens here.

import type { DB, TenantDb } from '@tradex/db';
import { forTenant, DEFAULT_GROUP_NAME } from '@tradex/db';
import { buildFuturesViews } from '@tradex/futures-positions';
import { listAccounts } from '../accounts-query.js';
import type { FuturesPositionRow, FuturesPositionView, Quote } from '@tradex/futures-positions';
import type { Kysely } from 'kysely';
import { getFuturesRtPrices, type FuturesRtPrice } from './rt-prices.js';

export type { FuturesPositionView } from '@tradex/futures-positions';

export interface FuturesPositionsResponse {
  readonly views: readonly FuturesPositionView[];
  readonly at: string;
}

/**
 * Which account holds a venue position.
 *
 * The exit and SL/TP routes are addressed by a VENUE position id, but signing a
 * venue call needs the ACCOUNT's credential — and a venue id carries no account.
 * This is the lookup that bridges them. Null means we have never mirrored that
 * position, in which case we cannot know whose credential to use and must refuse
 * rather than guess.
 */
export async function venuePositionOwner(
  tdb: TenantDb,
  venuePositionId: string,
): Promise<{ readonly accountId: string; readonly marginCurrency: string } | null> {
  const row = await tdb.selectFrom('futures_position')
    .select(['account_id as accountId', 'margin_currency as marginCurrency'] as unknown as never)
    .where('venue_position_id' as never, '=', venuePositionId as never)
    .executeTakeFirst();
  if (row === undefined) return null;
  const r = row as unknown as { accountId: string; marginCurrency: string };
  return { accountId: r.accountId, marginCurrency: r.marginCurrency };
}

interface RawFuturesPositionRow {
  readonly accountId: string;
  readonly pair: string;
  readonly marginCurrency: string;
  readonly venuePositionId: string;
  readonly activePos: string;
  readonly avgEntryPrice: string | null;
  readonly markPrice: string | null;
  readonly markObservedAt: Date | null;
  readonly liquidationPrice: string | null;
  readonly leverage: string | null;
  readonly lockedMarginMinor: string | null;
  readonly stopLossTrigger: string | null;
  readonly takeProfitTrigger: string | null;
  readonly fundingRateBp: number | null;
  readonly settlementCurrencyAvgPrice: string | null;
  readonly openedAt: Date | null;
  readonly exchangeUpdatedAt: Date | null;
}

async function readFuturesPositions(tdb: TenantDb, accountIds: readonly string[]): Promise<readonly RawFuturesPositionRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await tdb.selectFrom('futures_position')
    .select([
      'account_id as accountId', 'pair', 'margin_currency as marginCurrency',
      'venue_position_id as venuePositionId', 'active_pos as activePos',
      'avg_entry_price as avgEntryPrice', 'mark_price as markPrice',
      'mark_observed_at as markObservedAt', 'liquidation_price as liquidationPrice',
      'leverage', 'locked_margin_minor as lockedMarginMinor',
      'stop_loss_trigger as stopLossTrigger', 'take_profit_trigger as takeProfitTrigger',
      'funding_rate_bp as fundingRateBp',
      'settlement_currency_avg_price as settlementCurrencyAvgPrice',
      'opened_at as openedAt',
      'exchange_updated_at as exchangeUpdatedAt',
    ] as unknown as never)
    .where('account_id' as never, 'in', accountIds as never)
    .execute();
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    accountId: String(r['accountId']),
    pair: String(r['pair']),
    marginCurrency: String(r['marginCurrency']),
    venuePositionId: String(r['venuePositionId']),
    activePos: String(r['activePos']),
    avgEntryPrice: r['avgEntryPrice'] === null ? null : String(r['avgEntryPrice']),
    markPrice: r['markPrice'] === null ? null : String(r['markPrice']),
    markObservedAt: r['markObservedAt'] === null ? null : new Date(String(r['markObservedAt'])),
    liquidationPrice: r['liquidationPrice'] === null ? null : String(r['liquidationPrice']),
    leverage: r['leverage'] === null ? null : String(r['leverage']),
    lockedMarginMinor: r['lockedMarginMinor'] === null ? null : String(r['lockedMarginMinor']),
    stopLossTrigger: r['stopLossTrigger'] === null ? null : String(r['stopLossTrigger']),
    takeProfitTrigger: r['takeProfitTrigger'] === null ? null : String(r['takeProfitTrigger']),
    fundingRateBp: r['fundingRateBp'] === null ? null : Number(r['fundingRateBp']),
    settlementCurrencyAvgPrice: r['settlementCurrencyAvgPrice'] === null ? null : String(r['settlementCurrencyAvgPrice']),
    openedAt: r['openedAt'] === null || r['openedAt'] === undefined ? null : new Date(String(r['openedAt'])),
    exchangeUpdatedAt: r['exchangeUpdatedAt'] === null || r['exchangeUpdatedAt'] === undefined ? null : new Date(String(r['exchangeUpdatedAt'])),
  }));
}

function extractBaseAsset(sym: string | null | undefined): string | null {
  if (!sym) return null;
  const matchB = sym.match(/^(?:B-|INR-)?([A-Z0-9]+)[-_](?:USDT|INR)$/i);
  if (matchB && matchB[1]) return matchB[1].toUpperCase();
  const clean = sym.replace(/[-_]/g, '').toUpperCase();
  if (clean.endsWith('USDT')) return clean.slice(0, -4);
  if (clean.endsWith('INR')) return clean.slice(0, -3);
  return clean;
}

export async function buildFuturesPositions(
  db: Kysely<DB>,
  tenantId: string,
  nowMs: number,
  rtPrices?: Map<string, FuturesRtPrice>,
): Promise<FuturesPositionsResponse> {
  const tdb = forTenant(db, tenantId);
  const accounts = await listAccounts(tdb);
  const accountIds = accounts.map((a) => a.id);
  const nameOf = new Map(accounts.map((a) => [a.id, a.name]));

  const memberships = accountIds.length > 0
    ? await tdb.selectFrom('group_member')
        .innerJoin('account_group', 'account_group.id', 'group_member.group_id')
        .select([
          'group_member.account_id as accountId',
          'account_group.name as groupName',
        ] as unknown as never)
        .where('group_member.account_id' as never, 'in', accountIds as never)
        .where('account_group.archived_at' as never, 'is', null as never)
        .orderBy('account_group.name' as never)
        .execute() as unknown as ReadonlyArray<{ accountId: string; groupName: string }>
    : [];

  const groupsByAccount = new Map<string, { custom: string | null; default: string | null }>();
  for (const m of memberships) {
    const existing = groupsByAccount.get(m.accountId) ?? { custom: null, default: null };
    if (m.groupName === DEFAULT_GROUP_NAME) {
      existing.default = m.groupName;
    } else {
      existing.custom = m.groupName;
    }
    groupsByAccount.set(m.accountId, existing);
  }

  const raw = await readFuturesPositions(tdb, accountIds);
  const prices = rtPrices ?? await getFuturesRtPrices().catch(() => new Map<string, FuturesRtPrice>());

  const filledOrders = accountIds.length > 0
    ? await tdb.selectFrom('child_order')
        .leftJoin('group_trade', 'group_trade.id', 'child_order.group_trade_id')
        .select([
          'child_order.account_id as accountId',
          'child_order.pair as pair',
          'child_order.market as market',
          'group_trade.asset as asset',
          'child_order.sent_at as sentAt',
          'child_order.created_at as createdAt',
        ] as unknown as never)
        .where('child_order.account_id' as never, 'in', accountIds as never)
        .where('child_order.leg_kind' as never, '=', 'entry' as never)
        .where('child_order.state' as never, '=', 'filled' as never)
        .orderBy('child_order.created_at' as never, 'desc' as never)
        .execute() as unknown as ReadonlyArray<{
          accountId: string;
          pair: string | null;
          market: string | null;
          asset: string | null;
          sentAt: Date | null;
          createdAt: Date;
        }>
    : [];

  const entryOrderByAccountPair = new Map<string, number>();
  for (const o of filledOrders) {
    const t = o.sentAt ? new Date(o.sentAt).getTime() : new Date(o.createdAt).getTime();
    if (o.pair) {
      const k = `${o.accountId}|${o.pair}`;
      if (!entryOrderByAccountPair.has(k)) entryOrderByAccountPair.set(k, t);
    }
    const asset = o.asset ?? extractBaseAsset(o.market) ?? extractBaseAsset(o.pair);
    if (asset) {
      const k = `${o.accountId}|${asset}`;
      if (!entryOrderByAccountPair.has(k)) entryOrderByAccountPair.set(k, t);
    }
  }

  const shaped: FuturesPositionRow[] = raw
    .filter((r) => r.marginCurrency === 'INR' || r.marginCurrency === 'USDT')
    .map((r) => {
      const live = prices.get(r.pair);
      const markPrice = live?.markPrice ?? r.markPrice;
      const markObservedAtMs = live ? nowMs : (r.markObservedAt === null ? null : r.markObservedAt.getTime());
      const grp = groupsByAccount.get(r.accountId);
      const groupName = grp?.custom ?? grp?.default ?? null;
      const asset = extractBaseAsset(r.pair);
      const orderEntryTime = (asset ? entryOrderByAccountPair.get(`${r.accountId}|${asset}`) : null)
        ?? entryOrderByAccountPair.get(`${r.accountId}|${r.pair}`);
      const entryTimeMs = (r.openedAt ? r.openedAt.getTime() : null)
        ?? orderEntryTime
        ?? (r.exchangeUpdatedAt ? r.exchangeUpdatedAt.getTime() : null);

      return {
        accountId: r.accountId,
        accountName: nameOf.get(r.accountId) ?? r.accountId.slice(0, 8),
        groupName,
        pair: r.pair,
        marginCurrency: r.marginCurrency as Quote,
        venuePositionId: r.venuePositionId,
        activePos: r.activePos,
        avgEntryPrice: r.avgEntryPrice,
        markPrice,
        markObservedAtMs,
        liquidationPrice: r.liquidationPrice,
        leverage: r.leverage,
        lockedMarginMinor: r.lockedMarginMinor,
        stopLossTrigger: r.stopLossTrigger,
        takeProfitTrigger: r.takeProfitTrigger,
        fundingRateBp: r.fundingRateBp,
        settlementCurrencyAvgPrice: r.settlementCurrencyAvgPrice,
        entryTimeMs,
      };
    });
  return {
    views: buildFuturesViews(shaped, nowMs),
    at: new Date(nowMs).toISOString(),
  };
}
