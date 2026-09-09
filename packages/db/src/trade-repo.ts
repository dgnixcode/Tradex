// Group-trade and child-order storage — plan/phase-04 T04.3, T04.5, T04.6, T04.9.
//
// A group trade and its N child orders are written in ONE transaction: a plan
// that half-exists is worse than no plan, because the confirmation screen would
// render a different set of rows than the ones the send would read (invariant U2
// is "the preview equals the plan"). So `persistPlan` inserts the parent and
// every child atomically, and `child_order`'s UNIQUE (group_trade_id, account_id,
// leg_seq) — invariant X1 — makes a duplicate leg unrepresentable even under a
// retried write.
//
// The capture-or-lose-forever fields (14 F2) are set HERE, at plan time, because
// there is no later. `decision_mid`, the fx snapshot id, the market-metadata
// version and the code version are the trade's; the per-leg basis, price, rates,
// quantities and notional are the child's. A test asserts every one is non-null
// on a planned row, and that `decision_mid` was captured before sizing — this
// repo is where "non-null" becomes true.
//
// The preview token (T04.6) is written by `markPreviewed` together with its
// expiry, and confirmation (T04.9, dry-run rung 0) is `confirmDryRun`, which only
// succeeds against an unexpired token and records that the send was suppressed.

import type {
  ChildOrderPriceSource, ChildOrderState, GroupTradeStatus, SizingMode, SupportedQuote, TradeSide,
} from './schema.js';
import type { CanonicalOrderType } from './schema.js';
import type { TenantDb } from './tenant-scope.js';

export class TradeRepoError extends Error {
  override readonly name = 'TradeRepoError';
  constructor(
    message: string,
    readonly reason:
      | 'trade_not_found' | 'no_token' | 'token_expired' | 'token_mismatch'
      | 'not_previewed' | 'already_completed' | 'already_started' | 'empty_plan',
  ) {
    super(message);
  }
}

/** The trade-level capture fields, shared by every child (14 F2). */
export interface NewGroupTrade {
  readonly groupId: string;
  readonly createdBy: string;
  readonly asset: string;
  readonly side: TradeSide;
  readonly orderType: CanonicalOrderType;
  readonly sizingMode: SizingMode;
  readonly sizingValue: string | null;
  readonly limitPrice: string | null;
  /** Captured BEFORE any sizing ran — the reference mid at plan time. */
  readonly decisionMid: string | null;
  readonly fxSnapshotId: string | null;
  readonly marketMetaVersion: string | null;
  readonly codeVersion: string;
  readonly dryRun: boolean;
}

/** One planned or skipped leg, with its full per-account provenance. */
export interface NewChildOrder {
  readonly accountId: string;
  readonly legSeq?: number | undefined;
  readonly state: ChildOrderState;

  // resolution + sizing provenance (null on a row skipped before resolution)
  readonly market?: string | null | undefined;
  readonly pair?: string | null | undefined;
  readonly marketEcode?: string | null | undefined;
  readonly quoteCurrency?: SupportedQuote | null | undefined;
  readonly currencyChoiceReason?: string | null | undefined;
  readonly basisUsed?: string | null | undefined;
  readonly basisAmountMinor?: string | null | undefined;
  readonly priceSource?: ChildOrderPriceSource | null | undefined;
  readonly priceUsed?: string | null | undefined;
  readonly feeRateAssumed?: string | null | undefined;
  readonly tdsRateApplied?: string | null | undefined;
  readonly rawQuantity?: string | null | undefined;
  readonly finalQuantity?: string | null | undefined;
  readonly notionalMinor?: string | null | undefined;
  readonly clampedFromQuantity?: string | null | undefined;

  // book snapshot this leg was priced against (T04.10 / T04.5)
  readonly bookObservedAt?: Date | null | undefined;
  readonly spreadBp?: string | null | undefined;
  readonly slippageBp?: string | null | undefined;

  // skip reason (present iff state === 'skipped')
  readonly refusalCode?: string | null | undefined;
  readonly refusalDetail?: string | null | undefined;
}

export interface PersistedPlan {
  readonly groupTradeId: string;
  readonly childOrderIds: readonly string[];
}

/**
 * Write a group trade and all its child orders in one transaction. The trade
 * starts `draft`; `markPreviewed` moves it to `previewed` with a token. Returns
 * the ids so the caller can read the plan back for the preview payload.
 */
export async function persistPlan(
  tdb: TenantDb,
  trade: NewGroupTrade,
  children: readonly NewChildOrder[],
  atMs?: number,
): Promise<PersistedPlan> {
  if (children.length === 0) {
    throw new TradeRepoError('a group trade must fan out to at least one account', 'empty_plan');
  }
  const at = new Date(atMs ?? Date.now());

  return tdb.transaction(async (tx) => {
    const tradeRow = await tx.insertInto('group_trade', {
      group_id: trade.groupId,
      created_by: trade.createdBy,
      asset: trade.asset,
      side: trade.side,
      order_type: trade.orderType,
      sizing_mode: trade.sizingMode,
      sizing_value: trade.sizingValue,
      limit_price: trade.limitPrice,
      status: 'draft',
      decision_mid: trade.decisionMid,
      fx_snapshot_id: trade.fxSnapshotId,
      market_meta_version: trade.marketMetaVersion,
      code_version: trade.codeVersion,
      dry_run: trade.dryRun,
      created_at: at,
    })
      .returning('id')
      .executeTakeFirst();
    if (tradeRow === undefined) throw new TradeRepoError('the group trade insert returned no id', 'trade_not_found');
    const groupTradeId = (tradeRow as { id: string }).id;

    const ids: string[] = [];
    for (const c of children) {
      const row = await tx.insertInto('child_order', {
        group_trade_id: groupTradeId,
        account_id: c.accountId,
        leg_seq: c.legSeq ?? 0,
        state: c.state,
        market: c.market ?? null,
        pair: c.pair ?? null,
        market_ecode: c.marketEcode ?? null,
        quote_currency: c.quoteCurrency ?? null,
        currency_choice_reason: c.currencyChoiceReason ?? null,
        basis_used: c.basisUsed ?? null,
        basis_amount_minor: c.basisAmountMinor ?? null,
        price_source: c.priceSource ?? null,
        price_used: c.priceUsed ?? null,
        fee_rate_assumed: c.feeRateAssumed ?? null,
        tds_rate_applied: c.tdsRateApplied ?? null,
        raw_quantity: c.rawQuantity ?? null,
        final_quantity: c.finalQuantity ?? null,
        notional_minor: c.notionalMinor ?? null,
        clamped_from_quantity: c.clampedFromQuantity ?? null,
        book_observed_at: c.bookObservedAt ?? null,
        spread_bp: c.spreadBp ?? null,
        slippage_bp: c.slippageBp ?? null,
        refusal_code: c.refusalCode ?? null,
        refusal_detail: c.refusalDetail ?? null,
        created_at: at,
      })
        .returning('id')
        .executeTakeFirst();
      if (row === undefined) throw new TradeRepoError('a child order insert returned no id', 'trade_not_found');
      ids.push((row as { id: string }).id);
    }
    return { groupTradeId, childOrderIds: ids };
  });
}

/**
 * Move a drafted trade to `previewed`, stamping the token and its expiry. The
 * token is the only handle that can later be confirmed (T04.6).
 */
export async function markPreviewed(
  tdb: TenantDb,
  groupTradeId: string,
  token: string,
  expiresAt: Date,
): Promise<void> {
  const updated = await tdb.updateTable('group_trade')
    .set({ status: 'previewed', preview_token: token, preview_expires_at: expiresAt } as never)
    .where('id' as never, '=', groupTradeId as never)
    .where('status' as never, '=', 'draft' as never)
    .returning('id' as unknown as never)
    .executeTakeFirst();
  if (updated === undefined) {
    throw new TradeRepoError(`group trade ${groupTradeId} was not in draft state to preview`, 'not_previewed');
  }
}

export interface GroupTradeRow {
  readonly id: string;
  readonly groupId: string;
  readonly asset: string;
  readonly side: TradeSide;
  readonly orderType: CanonicalOrderType;
  readonly sizingMode: SizingMode;
  readonly sizingValue: string | null;
  readonly limitPrice: string | null;
  readonly status: GroupTradeStatus;
  readonly previewToken: string | null;
  readonly previewExpiresAt: Date | null;
  readonly decisionMid: string | null;
  readonly fxSnapshotId: string | null;
  readonly marketMetaVersion: string | null;
  readonly codeVersion: string | null;
  readonly dryRun: boolean;
  readonly sendSuppressed: boolean;
  readonly completedAt: Date | null;
}

/** Read a group trade header by id, scoped to the tenant. */
export async function getGroupTrade(tdb: TenantDb, groupTradeId: string): Promise<GroupTradeRow | null> {
  const row = await tdb.byId('group_trade', groupTradeId)
    .selectAll()
    .executeTakeFirst();
  if (row === undefined) return null;
  const r = row as Record<string, unknown>;
  return {
    id: r['id'] as string,
    groupId: r['group_id'] as string,
    asset: r['asset'] as string,
    side: r['side'] as TradeSide,
    orderType: r['order_type'] as CanonicalOrderType,
    sizingMode: r['sizing_mode'] as SizingMode,
    sizingValue: (r['sizing_value'] as string | null),
    limitPrice: (r['limit_price'] as string | null),
    status: r['status'] as GroupTradeStatus,
    previewToken: (r['preview_token'] as string | null),
    previewExpiresAt: r['preview_expires_at'] === null ? null : new Date(r['preview_expires_at'] as string),
    decisionMid: (r['decision_mid'] as string | null),
    fxSnapshotId: r['fx_snapshot_id'] === null ? null : String(r['fx_snapshot_id']),
    marketMetaVersion: r['market_meta_version'] === null ? null : String(r['market_meta_version']),
    codeVersion: (r['code_version'] as string | null),
    dryRun: r['dry_run'] as boolean,
    sendSuppressed: r['send_suppressed'] as boolean,
    completedAt: r['completed_at'] === null ? null : new Date(r['completed_at'] as string),
  };
}

export interface ChildOrderRow {
  readonly id: string;
  readonly accountId: string;
  readonly legSeq: number;
  readonly state: ChildOrderState;
  readonly market: string | null;
  readonly quoteCurrency: SupportedQuote | null;
  readonly currencyChoiceReason: string | null;
  readonly basisUsed: string | null;
  readonly basisAmountMinor: string | null;
  readonly priceSource: ChildOrderPriceSource | null;
  readonly priceUsed: string | null;
  readonly feeRateAssumed: string | null;
  readonly tdsRateApplied: string | null;
  readonly rawQuantity: string | null;
  readonly finalQuantity: string | null;
  readonly notionalMinor: string | null;
  readonly clampedFromQuantity: string | null;
  readonly bookObservedAt: Date | null;
  readonly spreadBp: string | null;
  readonly slippageBp: string | null;
  readonly refusalCode: string | null;
  readonly refusalDetail: string | null;
}

/** Read the child orders of a trade, in a stable order (the confirmation table). */
export async function getChildOrders(tdb: TenantDb, groupTradeId: string): Promise<readonly ChildOrderRow[]> {
  const rows = await tdb.selectFrom('child_order')
    .selectAll()
    .where('group_trade_id' as never, '=', groupTradeId as never)
    .orderBy('leg_seq' as never)
    .orderBy('account_id' as never)
    .execute();
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r['id'] as string,
    accountId: r['account_id'] as string,
    legSeq: r['leg_seq'] as number,
    state: r['state'] as ChildOrderState,
    market: (r['market'] as string | null),
    quoteCurrency: (r['quote_currency'] as SupportedQuote | null),
    currencyChoiceReason: (r['currency_choice_reason'] as string | null),
    basisUsed: (r['basis_used'] as string | null),
    basisAmountMinor: (r['basis_amount_minor'] as string | null),
    priceSource: (r['price_source'] as ChildOrderPriceSource | null),
    priceUsed: (r['price_used'] as string | null),
    feeRateAssumed: (r['fee_rate_assumed'] as string | null),
    tdsRateApplied: (r['tds_rate_applied'] as string | null),
    rawQuantity: (r['raw_quantity'] as string | null),
    finalQuantity: (r['final_quantity'] as string | null),
    notionalMinor: (r['notional_minor'] as string | null),
    clampedFromQuantity: (r['clamped_from_quantity'] as string | null),
    bookObservedAt: r['book_observed_at'] === null ? null : new Date(r['book_observed_at'] as string),
    spreadBp: (r['spread_bp'] as string | null),
    slippageBp: (r['slippage_bp'] as string | null),
    refusalCode: (r['refusal_code'] as string | null),
    refusalDetail: (r['refusal_detail'] as string | null),
  }));
}

/** One child row as the execution report needs it (post-send provenance included). */
export interface ExecutionChildRow {
  readonly accountId: string;
  readonly state: ChildOrderState;
  readonly market: string | null;
  readonly finalQuantity: string | null;
  readonly notionalMinor: string | null;
  readonly refusalCode: string | null;
  readonly refusalDetail: string | null;
  readonly clientOrderId: string | null;
  readonly exchangeOrderId: string | null;
}

/** A group trade plus its children in execution shape, or null when it does not exist. */
export interface ExecutionSnapshot {
  readonly id: string;
  readonly status: GroupTradeStatus;
  readonly dryRun: boolean;
  readonly rows: readonly ExecutionChildRow[];
}

/** Read a trade's status and its children for the execution report / confirm response. */
export async function getExecutionSnapshot(
  tdb: TenantDb,
  groupTradeId: string,
): Promise<ExecutionSnapshot | null> {
  const t = await tdb.byId('group_trade', groupTradeId)
    .select(['status', 'dry_run'] as never)
    .executeTakeFirst();
  if (t === undefined) return null;
  const tr = t as { status: GroupTradeStatus; dry_run: boolean };
  const rows = await tdb.selectFrom('child_order')
    .select([
      'account_id', 'state', 'market', 'final_quantity', 'notional_minor',
      'refusal_code', 'refusal_detail', 'client_order_id', 'exchange_order_id',
    ] as never)
    .where('group_trade_id' as never, '=', groupTradeId as never)
    .orderBy('leg_seq' as never)
    .orderBy('account_id' as never)
    .execute();
  return {
    id: groupTradeId,
    status: tr.status,
    dryRun: tr.dry_run,
    rows: (rows as Record<string, unknown>[]).map((r) => ({
      accountId: r['account_id'] as string,
      state: r['state'] as ChildOrderState,
      market: (r['market'] as string | null),
      finalQuantity: (r['final_quantity'] as string | null),
      notionalMinor: (r['notional_minor'] as string | null),
      refusalCode: (r['refusal_code'] as string | null),
      refusalDetail: (r['refusal_detail'] as string | null),
      clientOrderId: (r['client_order_id'] as string | null),
      exchangeOrderId: (r['exchange_order_id'] as string | null),
    })),
  };
}

/**
 * Confirm a previewed trade in dry-run mode (rung 0): validate the token, check
 * it has not expired, and mark the trade `completed` with the send suppressed.
 * Nothing is sent — this is the whole point of the phase. The check against the
 * server's own `preview_expires_at` is what makes an expired preview
 * unconfirmable regardless of what the client believes the countdown said.
 */
export async function confirmDryRun(
  tdb: TenantDb,
  groupTradeId: string,
  token: string,
  atMs?: number,
): Promise<void> {
  const at = new Date(atMs ?? Date.now());
  await tdb.transaction(async (tx) => {
    const row = await tx.byId('group_trade', groupTradeId)
      .select(['status', 'preview_token', 'preview_expires_at'])
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new TradeRepoError(`group trade ${groupTradeId} was not found`, 'trade_not_found');
    const r = row as { status: GroupTradeStatus; preview_token: string | null; preview_expires_at: Date | string | null };

    if (r.status === 'completed') throw new TradeRepoError('this trade has already been confirmed', 'already_completed');
    if (r.status !== 'previewed') throw new TradeRepoError('this trade has no active preview to confirm', 'not_previewed');
    if (r.preview_token === null || r.preview_expires_at === null) {
      throw new TradeRepoError('this trade carries no preview token', 'no_token');
    }
    if (r.preview_token !== token) throw new TradeRepoError('the preview token does not match', 'token_mismatch');

    const expires = r.preview_expires_at instanceof Date ? r.preview_expires_at : new Date(r.preview_expires_at);
    if (expires.getTime() <= at.getTime()) {
      throw new TradeRepoError('this preview has expired; re-preview to get a fresh set of quantities', 'token_expired');
    }

    await tx.updateTable('group_trade')
      .set({ status: 'completed', send_suppressed: true, completed_at: at } as never)
      .where('id' as never, '=', groupTradeId as never)
      .execute();
  });
}

// ---- plan/phase-09: cancel fan-out + completion-on-fills ---------------------
//
// A child whose order is still live at the venue and may be cancelled is one the
// venue still shows as working — `open` or `partially_filled` (the venue FAQ:
// a filled/cancelled/rejected order cannot be cancelled). The cancel fan-out
// (T09.1) acts ONLY on that set, per group trade, so it can never cancel an
// order another trade placed.
export const CANCELLABLE_STATES: ReadonlySet<string> = new Set(['open', 'partially_filled']);

/**
 * The states that keep a group trade `executing`. When NONE of a trade's
 * children are in this set — every leg is `filled`/`partially_filled` or a
 * terminal refusal/skip — the trade is `completed` (T09.7).
 */
export const WORKING_CHILD_STATES: ReadonlySet<string> =
  new Set(['planned', 'sending', 'ambiguous', 'acked', 'open']);

/** One leg a Phase-09 sweep or fan-out acts on, with the handle the venue needs. */
export interface LiveChildRow {
  readonly id: string;
  readonly groupTradeId: string;
  readonly accountId: string;
  readonly market: string | null;
  readonly state: string;
  /** The deterministic id reserved at write-before-send; null only if never sent. */
  readonly clientOrderId: string | null;
}

/**
 * The children of a group trade whose orders are still live at the venue and can
 * be cancelled (state in CANCELLABLE_STATES). Optionally narrowed to a subset of
 * accounts so a fan-out can cancel only some legs.
 */
export async function listCancellableChildren(
  tdb: TenantDb,
  groupTradeId: string,
  accountIds?: readonly string[],
): Promise<readonly LiveChildRow[]> {
  let q = tdb.selectFrom('child_order')
    .select(['id', 'group_trade_id as groupTradeId', 'account_id as accountId', 'market', 'state',
      'client_order_id as clientOrderId'] as never)
    .where('group_trade_id' as never, '=', groupTradeId as never)
    .where('state' as never, 'in', [...CANCELLABLE_STATES] as never);
  if (accountIds !== undefined && accountIds.length > 0) {
    q = q.where('account_id' as never, 'in', accountIds as never);
  }
  const rows = await q.orderBy('leg_seq' as never).orderBy('account_id' as never).execute();
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r['id'] as string,
    groupTradeId: String(r['groupTradeId']),
    accountId: String(r['accountId']),
    market: (r['market'] as string | null),
    state: r['state'] as string,
    clientOrderId: (r['clientOrderId'] as string | null),
  }));
}

/** The children of a group trade that are still working, for a poll/loop-B sweep. */
export async function listWorkingChildren(
  tdb: TenantDb,
  groupTradeId: string,
): Promise<readonly LiveChildRow[]> {
  const rows = await tdb.selectFrom('child_order')
    .select(['id', 'group_trade_id as groupTradeId', 'account_id as accountId', 'market', 'state',
      'client_order_id as clientOrderId'] as never)
    .where('group_trade_id' as never, '=', groupTradeId as never)
    .where('state' as never, 'in', [...WORKING_CHILD_STATES] as never)
    .orderBy('leg_seq' as never).orderBy('account_id' as never)
    .execute();
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: r['id'] as string,
    groupTradeId: String(r['groupTradeId']),
    accountId: String(r['accountId']),
    market: (r['market'] as string | null),
    state: r['state'] as string,
    clientOrderId: (r['clientOrderId'] as string | null),
  }));
}

/**
 * Mark a group trade `completed` once EVERY child has left the working states —
 * the durable flip behind T09.7. Runs after each settle, guarded on
 * `status = 'executing'` so two concurrent settles cannot double-flip or move a
 * trade that is already terminal. Returns true when it flipped.
 */
export async function completeGroupTradeIfAllSettled(
  tdb: TenantDb,
  groupTradeId: string,
  atMs?: number,
): Promise<boolean> {
  const at = new Date(atMs ?? Date.now());
  const still = await tdb.selectFrom('child_order')
    .select('id')
    .where('group_trade_id' as never, '=', groupTradeId as never)
    .where('state' as never, 'in', [...WORKING_CHILD_STATES] as never)
    .limit(1)
    .executeTakeFirst();
  if (still !== undefined) return false;
  const updated = await tdb.updateTable('group_trade')
    .set({ status: 'completed', completed_at: at } as never)
    .where('id' as never, '=', groupTradeId as never)
    .where('status' as never, '=', 'executing' as never)
    .returning('id' as unknown as never)
    .executeTakeFirst();
  return updated !== undefined;
}

/**
 * Start a REAL execution (plan/phase-08): validate the preview token exactly as
 * confirmDryRun does, then move the trade `previewed → executing` with the send
 * NO LONGER suppressed. Confirmation (enqueuing the place jobs and draining) is
 * the caller's next step; this function is only the atomic, token-guarded gate
 * that keeps a second confirm from ever double-starting a trade. A trade already
 * `executing` throws `already_started`; a terminal one throws
 * `already_completed`; the reaper (T08.4 abandonment) is the backstop for a
 * trade that reaches `executing` but never drains.
 */
export async function beginExecution(
  tdb: TenantDb,
  groupTradeId: string,
  token: string,
  atMs?: number,
): Promise<void> {
  const at = new Date(atMs ?? Date.now());
  await tdb.transaction(async (tx) => {
    const row = await tx.byId('group_trade', groupTradeId)
      .select(['status', 'preview_token', 'preview_expires_at'])
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined) throw new TradeRepoError(`group trade ${groupTradeId} was not found`, 'trade_not_found');
    const r = row as { status: GroupTradeStatus; preview_token: string | null; preview_expires_at: Date | string | null };

    if (r.status === 'completed' || r.status === 'abandoned') {
      throw new TradeRepoError('this trade has already been confirmed or abandoned', 'already_completed');
    }
    if (r.status === 'executing') {
      throw new TradeRepoError('this trade is already executing', 'already_started');
    }
    if (r.status !== 'previewed') throw new TradeRepoError('this trade has no active preview to confirm', 'not_previewed');
    if (r.preview_token === null || r.preview_expires_at === null) {
      throw new TradeRepoError('this trade carries no preview token', 'no_token');
    }
    if (r.preview_token !== token) throw new TradeRepoError('the preview token does not match', 'token_mismatch');

    const expires = r.preview_expires_at instanceof Date ? r.preview_expires_at : new Date(r.preview_expires_at);
    if (expires.getTime() <= at.getTime()) {
      throw new TradeRepoError('this preview has expired; re-preview to get a fresh set of quantities', 'token_expired');
    }

    await tx.updateTable('group_trade')
      .set({ status: 'executing', dry_run: false, send_suppressed: false, submitted_at: at } as never)
      .where('id' as never, '=', groupTradeId as never)
      .execute();
  });
}
