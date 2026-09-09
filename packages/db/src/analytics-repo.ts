// The analytics reads — plan/phase-12 T12.4/T12.6.
//
// Deliberately dumb row readers over our own records. All shaping (folding,
// aggregating, metrics) happens in the caller so the screens never compute.
// The blotter read is cursor-paginated on (created_at, id); the ledger reads feed
// the fold; the scope reads feed the minor-unit facts. Nothing here touches a
// venue or a current price (§6a).

import { sql } from 'kysely';
import type { TenantDb } from './tenant-scope.js';

// ------------------------------------------------------------------ blotter

export type BlotterOutcome =
  | 'working' | 'filled' | 'rejected' | 'skipped' | 'cancelled' | 'needs_review';

const WORKING = ['planned', 'sending', 'ambiguous', 'acked', 'open', 'partially_filled', 'unknown'];
const FILLED = ['filled'];
const REJECTED = ['rejected'];
const SKIPPED = ['skipped'];
const CANCELLED = ['cancelled', 'partially_cancelled'];
const NEEDS_REVIEW = ['needs_human'];

const OUTCOME_STATES: Record<BlotterOutcome, readonly string[]> = {
  working: WORKING, filled: FILLED, rejected: REJECTED, skipped: SKIPPED,
  cancelled: CANCELLED, needs_review: NEEDS_REVIEW,
};

/** One blotter row: everything a child order ever told us, at plan + execution. */
export interface BlotterChildRow {
  readonly id: string;
  readonly createdAtMs: number;
  readonly accountId: string;
  readonly accountName: string;
  readonly groupTradeId: string;
  readonly side: 'buy' | 'sell';
  readonly orderType: 'market' | 'limit';
  readonly market: string;
  readonly quoteCurrency: 'INR' | 'USDT' | null;
  readonly state: string;
  readonly refusalCode: string | null;
  readonly refusalDetail: string | null;
  readonly finalQuantity: string | null;
  readonly notionalMinor: string | null;
  readonly priceUsed: string | null;
  readonly slippageBp: string | null;
  readonly spreadBp: string | null;
  readonly clientOrderId: string | null;
  readonly exchangeOrderId: string | null;
  readonly sentAtMs: number | null;
  readonly terminalAtMs: number | null;
}

export interface BlotterCursor {
  readonly createdAtMs: number;
  readonly id: string;
}

export interface BlotterQuery {
  readonly limit?: number | undefined;
  readonly cursor?: BlotterCursor | undefined;
  readonly accountId?: string | undefined;
  readonly groupTradeId?: string | undefined;
  readonly market?: string | undefined;
  readonly outcome?: BlotterOutcome | undefined;
}

export interface BlotterPage {
  readonly rows: readonly BlotterChildRow[];
  /** null when this was the last page. */
  readonly nextCursor: BlotterCursor | null;
}

const asMs = (v: unknown): number | null => (v instanceof Date ? v.getTime() : typeof v === 'string' ? new Date(v).getTime() : v === null ? null : Number(v));

export async function listBlotterChildren(tdb: TenantDb, q: BlotterQuery = {}): Promise<BlotterPage> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const c = q.cursor;

  // Keyset pagination newest-first on (created_at, id) — never OFFSET, so page N
  // does not rescan N×limit rows. The child_order (tenant_id, created_at) index
  // (migration 012) keeps each page a bounded scan even at 50k rows.
  let builder = tdb.selectFrom('child_order')
    .innerJoin('group_trade', 'group_trade.id', 'child_order.group_trade_id')
    .innerJoin('exchange_account', 'exchange_account.id', 'child_order.account_id')
    .select([
      'child_order.id as id', 'child_order.created_at as createdAt',
      'child_order.account_id as accountId', 'exchange_account.name as accountName',
      'child_order.group_trade_id as groupTradeId',
      'group_trade.side as side', 'group_trade.order_type as orderType',
      'child_order.market as market', 'child_order.quote_currency as quoteCurrency',
      'child_order.state as state', 'child_order.refusal_code as refusalCode',
      'child_order.refusal_detail as refusalDetail', 'child_order.final_quantity as finalQuantity',
      'child_order.notional_minor as notionalMinor', 'child_order.price_used as priceUsed',
      'child_order.slippage_bp as slippageBp', 'child_order.spread_bp as spreadBp',
      'child_order.client_order_id as clientOrderId', 'child_order.exchange_order_id as exchangeOrderId',
      'child_order.sent_at as sentAt', 'child_order.terminal_at as terminalAt',
    ] as unknown as never)
    .orderBy('child_order.created_at', 'desc' as never)
    .orderBy('child_order.id', 'desc' as never)
    .limit(limit + 1);

  if (q.accountId !== undefined) builder = builder.where('child_order.account_id' as never, '=', q.accountId as never);
  if (q.groupTradeId !== undefined) builder = builder.where('child_order.group_trade_id' as never, '=', q.groupTradeId as never);
  if (q.market !== undefined) builder = builder.where('child_order.market' as never, '=', q.market as never);
  if (q.outcome !== undefined) {
    builder = builder.where('child_order.state' as never, 'in', OUTCOME_STATES[q.outcome] as never);
  }
  if (c !== undefined) {
    // Row comparison is exactly the keyset test for a DESC cursor: strictly older
    // in (created_at, id). Parameterised, so no injection.
    builder = builder.where(sql`(child_order.created_at, child_order.id) < (${new Date(c.createdAtMs)}, ${c.id})` as never);
  }

  const rows = (await builder.execute()) as unknown as Array<Record<string, unknown>>;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const out = page.map((r) => ({
    id: String(r['id']),
    createdAtMs: asMs(r['createdAt']) ?? 0,
    accountId: String(r['accountId']),
    accountName: r['accountName'] as string,
    groupTradeId: String(r['groupTradeId']),
    side: r['side'] as 'buy' | 'sell',
    orderType: r['orderType'] as 'market' | 'limit',
    market: r['market'] as string,
    quoteCurrency: r['quoteCurrency'] as 'INR' | 'USDT' | null,
    state: r['state'] as string,
    refusalCode: r['refusalCode'] === null ? null : String(r['refusalCode']),
    refusalDetail: r['refusalDetail'] === null ? null : String(r['refusalDetail']),
    finalQuantity: r['finalQuantity'] === null ? null : String(r['finalQuantity']),
    notionalMinor: r['notionalMinor'] === null ? null : String(r['notionalMinor']),
    priceUsed: r['priceUsed'] === null ? null : String(r['priceUsed']),
    slippageBp: r['slippageBp'] === null ? null : String(r['slippageBp']),
    spreadBp: r['spreadBp'] === null ? null : String(r['spreadBp']),
    clientOrderId: r['clientOrderId'] === null ? null : String(r['clientOrderId']),
    exchangeOrderId: r['exchangeOrderId'] === null ? null : String(r['exchangeOrderId']),
    sentAtMs: asMs(r['sentAt']),
    terminalAtMs: asMs(r['terminalAt']),
  }));
  const last = page.length > 0 ? page[page.length - 1] : undefined;
  const lastId = last === undefined ? undefined : last['id'];
  const lastAt = last === undefined ? undefined : last['createdAt'];
  return {
    rows: out,
    nextCursor: hasMore && last !== undefined && lastId !== undefined && lastAt !== undefined
      ? { createdAtMs: asMs(lastAt) ?? 0, id: String(lastId) }
      : null,
  };
}

// ------------------------------------------------------------------ ledger

export interface LedgerScopeWindow {
  readonly fromMs?: number | undefined;
  readonly toMs?: number | undefined;
}

/** Every ledger row for ONE account within a window, in fold order (seq assigned). */
export async function ledgerRowsForAccount(
  tdb: TenantDb,
  accountId: string,
  window: LedgerScopeWindow = {},
): Promise<Array<{
  readonly exchangeTradeId: string | null;
  readonly kind: string;
  readonly asset: string;
  readonly quoteAsset: string | null;
  readonly deltaMinor: string;
  readonly scale: number;
  readonly price: string | null;
  readonly feeMinor: string | null;
  readonly tdsMinor: string | null;
  readonly estimated: boolean;
  readonly occurredAtMs: number;
  readonly seq: number;
}>> {
  let builder = tdb.selectFrom('ledger_entry')
    .select([
      'exchange_trade_id as exchangeTradeId', 'kind', 'asset', 'quote_asset as quoteAsset',
      'delta_minor as deltaMinor', 'scale', 'price', 'fee_minor as feeMinor',
      'tds_minor as tdsMinor', 'estimated', 'occurred_at as occurredAt', 'id',
    ] as unknown as never)
    .where('account_id' as never, '=', accountId as never)
    .orderBy('occurred_at' as never)
    .orderBy('id' as never);
  if (window.fromMs !== undefined) builder = builder.where('occurred_at' as never, '>=', new Date(window.fromMs) as never);
  if (window.toMs !== undefined) builder = builder.where('occurred_at' as never, '<', new Date(window.toMs) as never);

  const rows = (await builder.execute()) as unknown as Array<Record<string, unknown>>;
  return rows.map((r, i) => ({
    exchangeTradeId: r['exchangeTradeId'] === null ? null : String(r['exchangeTradeId']),
    kind: r['kind'] as string,
    asset: r['asset'] as string,
    quoteAsset: r['quoteAsset'] === null ? null : String(r['quoteAsset']),
    deltaMinor: String(r['deltaMinor']),
    scale: Number(r['scale']),
    price: r['price'] === null ? null : String(r['price']),
    feeMinor: r['feeMinor'] === null ? null : String(r['feeMinor']),
    tdsMinor: r['tdsMinor'] === null ? null : String(r['tdsMinor']),
    estimated: r['estimated'] === true,
    occurredAtMs: asMs(r['occurredAt']) ?? 0,
    seq: i,
  }));
}

// ------------------------------------------------------------------ scope facts

export interface ScopeAccountRow {
  readonly accountId: string;
  readonly allocatedCurrency: string;
  readonly allocatedMinor: string;
  readonly confirmedMinor: string | null;
}

export interface ScopeBalanceRow {
  readonly accountId: string;
  readonly currency: string;
  readonly freeMinor: string;
  readonly lockedMinor: string;
}

export async function accountScopeRows(tdb: TenantDb, accountIds: readonly string[]): Promise<ScopeAccountRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await tdb.selectFrom('exchange_account')
    .select([
      'id as accountId', 'allocated_currency as allocatedCurrency',
      'allocated_capital_minor as allocatedMinor',
      'allocated_confirmed_against_minor as confirmedMinor',
    ] as unknown as never)
    .where('id' as never, 'in', accountIds as never)
    .execute();
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    accountId: String(r['accountId']),
    allocatedCurrency: String(r['allocatedCurrency']),
    allocatedMinor: String(r['allocatedMinor']),
    confirmedMinor: r['confirmedMinor'] === null ? null : String(r['confirmedMinor']),
  }));
}

export async function scopeBalanceRows(tdb: TenantDb, accountIds: readonly string[]): Promise<ScopeBalanceRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await tdb.selectFrom('account_balance')
    .select([
      'account_id as accountId', 'currency', 'free_minor as freeMinor', 'locked_minor as lockedMinor',
    ] as unknown as never)
    .where('account_id' as never, 'in', accountIds as never)
    .execute();
  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    accountId: String(r['accountId']),
    currency: String(r['currency']),
    freeMinor: String(r['freeMinor']),
    lockedMinor: String(r['lockedMinor']),
  }));
}

export interface ChildWindowRow {
  readonly accountId: string;
  readonly groupId: string;
  readonly market: string;
  readonly side: 'buy' | 'sell';
  readonly orderType: 'market' | 'limit';
  readonly state: string;
  readonly decisionMidCaptured: boolean;
  readonly slippageBp: string | null;
  readonly notionalMinor: string | null;
  readonly createdAtMs: number;
}

/** Children planned within a window, with their trade's order shape. */
export async function childWindowRows(
  tdb: TenantDb,
  window: LedgerScopeWindow,
  scope: { readonly accountIds?: readonly string[]; readonly groupId?: string } = {},
): Promise<ChildWindowRow[]> {
  let builder = tdb.selectFrom('child_order')
    .innerJoin('group_trade', 'group_trade.id', 'child_order.group_trade_id')
    .select([
      'child_order.account_id as accountId', 'group_trade.group_id as groupId',
      'child_order.market as market', 'group_trade.side as side',
      'group_trade.order_type as orderType', 'child_order.state as state',
      'group_trade.decision_mid as decisionMid', 'child_order.slippage_bp as slippageBp',
      'child_order.notional_minor as notionalMinor', 'child_order.created_at as createdAt',
    ] as unknown as never)
    .orderBy('child_order.created_at' as never);
  if (window.fromMs !== undefined) builder = builder.where('child_order.created_at' as never, '>=', new Date(window.fromMs) as never);
  if (window.toMs !== undefined) builder = builder.where('child_order.created_at' as never, '<', new Date(window.toMs) as never);
  if (scope.groupId !== undefined) builder = builder.where('group_trade.group_id' as never, '=', scope.groupId as never);
  if (scope.accountIds !== undefined && scope.accountIds.length > 0) {
    builder = builder.where('child_order.account_id' as never, 'in', scope.accountIds as never);
  }

  const rows = (await builder.execute()) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    accountId: String(r['accountId']),
    groupId: String(r['groupId']),
    market: r['market'] as string,
    side: r['side'] as 'buy' | 'sell',
    orderType: r['orderType'] as 'market' | 'limit',
    state: r['state'] as string,
    decisionMidCaptured: r['decisionMid'] !== null,
    slippageBp: r['slippageBp'] === null ? null : String(r['slippageBp']),
    notionalMinor: r['notionalMinor'] === null ? null : String(r['notionalMinor']),
    createdAtMs: asMs(r['createdAt']) ?? 0,
  }));
}

export interface CompletedTradeRow {
  readonly groupTradeId: string;
  readonly submittedAtMs: number | null;
  readonly completedAtMs: number;
}

/** Group trades that completed within a window — the M22 duration source. */
export async function completedTradeRows(
  tdb: TenantDb,
  window: LedgerScopeWindow,
  scope: { readonly groupId?: string } = {},
): Promise<CompletedTradeRow[]> {
  let builder = tdb.selectFrom('group_trade')
    .select([
      'id as groupTradeId', 'submitted_at as submittedAt', 'completed_at as completedAt',
    ] as unknown as never)
    .where('status' as never, '=', 'completed' as never)
    .where('completed_at' as never, 'is not', null as never);
  if (scope.groupId !== undefined) builder = builder.where('group_id' as never, '=', scope.groupId as never);
  if (window.fromMs !== undefined) builder = builder.where('completed_at' as never, '>=', new Date(window.fromMs) as never);
  if (window.toMs !== undefined) builder = builder.where('completed_at' as never, '<', new Date(window.toMs) as never);

  const rows = (await builder.execute()) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    groupTradeId: String(r['groupTradeId']),
    submittedAtMs: asMs(r['submittedAt']),
    completedAtMs: asMs(r['completedAt']) ?? 0,
  }));
}
