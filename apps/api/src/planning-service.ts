// The planning stage — plan/phase-04 T04.3, T04.5, T04.6, T04.9, T04.10.
//
// This is the hub of the phase. It turns one customer decision — an asset, a
// side, a sizing mode, a group — into N persisted child orders, each either
// `planned` with a concrete legal quantity or `skipped` with a numbered reason,
// and returns a preview token that is the only thing a later confirm will accept.
//
// It composes, it does not compute. The arithmetic lives in @tradex/sizing
// (`planAccount`, the twelve gates, the slippage guard); the state lives in
// @tradex/db (the plan-state reads); this service is the I/O that connects them.
// Everything money is minor units in the order's quote currency.
//
// FOUR PROPERTIES THIS FILE IS RESPONSIBLE FOR:
//
//  - One order-book read per MARKET per group trade (T04.10). The asset resolves
//    to at most two markets (INR, USDT), so a 12-account group makes one or two
//    book reads, not twelve. A pre-pass resolves each member to learn which
//    distinct markets to read; the book is then shared across every account on
//    that market.
//
//  - decision_mid captured BEFORE any sizing (T04.5). The reference mid is
//    computed from the book reads, which all happen before the per-account sizing
//    loop begins — so the "captured before sizing" ordering is structural, not a
//    comment.
//
//  - The book is the only price source (T04.10). A market order is priced at the
//    touch (best ask for a buy, best bid for a sell); a limit order at the
//    customer's price. Nothing here reads a ticker.
//
//  - Nothing sends (the whole phase). The adapter's getOrderBook is the only
//    venue call; there is no placeOrder path from here.

import { randomBytes } from 'node:crypto';
import { add, cmp, div } from '@tradex/money';
import type { Balance, MarketRef, MarketRules, OrderBook } from '@tradex/exchange';
import type { Kysely } from 'kysely';
import {
  dailySpentMinor, getChildOrders, getEnabledMembers, getGroupTrade, hasInFlightOrder,
  latestMarketMetadataVersion, loadMarketRules, markPreviewed, persistPlan,
  readAccountStates, readBalances, readMarketStates, readPlatformFlags, readTenantCaps,
} from '@tradex/db';
import type { DB, SupportedQuote, TenantDb } from '@tradex/db';
import type {
  AccountState, EnabledMember, NewChildOrder, NewGroupTrade, ChildOrderRow, GroupTradeRow, MarketStateRow,
} from '@tradex/db';
import {
  GATE_CODES, GUARD_SCALE, effectiveMinQty, nat, planAccount, resolveMarket, toStr, touchPrice,
} from '@tradex/sizing';
import type { GateState, Intent, PlanAccountInput } from '@tradex/sizing';

/** How long a preview is valid. Short, because the book it was priced against ages. */
export const PREVIEW_TTL_MS = 60_000;

/** Quote-preference order for the reference market, matching market-resolution. */
const QUOTE_PREFERENCE: readonly SupportedQuote[] = ['INR', 'USDT'];

/** The twelve gates' own refusal codes. A Phase-09 dust/locked relabel only ever
 *  replaces a refusal from the sizing core, never one of these (which precedes
 *  sizing and names a more fundamental problem). */
const GATE_CODE_SET: ReadonlySet<string> = new Set(GATE_CODES as readonly string[]);

/** Child states that count as "failed" for a retry — terminal and never placed. */
const RETRYABLE_FAILED: ReadonlySet<string> = new Set(['skipped', 'rejected', 'not_placed', 'needs_human', 'unknown']);

/** What the customer asked for at the group level, before it meets any market. */
export interface PlanRequest {
  readonly groupId: string;
  readonly createdBy: string;
  readonly asset: string;
  readonly side: 'buy' | 'sell';
  readonly orderType: 'market' | 'limit';
  readonly sizingMode: Intent['mode'];
  /** Amount (minor units), quantity, or percent — depending on the mode. */
  readonly sizingValue?: string | undefined;
  /** Basis points for a percentage mode, e.g. 2000 for 20%. */
  readonly percentBp?: number | undefined;
  readonly limitPrice?: string | undefined;
  /** Slippage tolerance override; defaults to 0.5% inside the guard. */
  readonly slippageToleranceBp?: number | undefined;
  /** Retry-failed scoping (T08.7): when present, plan ONLY these still-enabled
   *  members of the group. The trade ticket never sends this — retry-failed uses
   *  it to re-plan exactly the failed accounts as a fresh trade. */
  readonly accountIds?: readonly string[] | undefined;
}

export interface PreviewRow {
  readonly childOrderId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly state: string;
  readonly market: string | null;
  readonly quoteCurrency: string | null;
  readonly finalQuantity: string | null;
  readonly priceUsed: string | null;
  readonly notionalMinor: string | null;
  readonly basisUsed: string | null;
  readonly basisAmountMinor: string | null;
  readonly currencyChoiceReason: string | null;
  readonly spreadIsWide: boolean;
  readonly refusalCode: string | null;
  readonly refusalDetail: string | null;
}

export interface PreviewResult {
  readonly groupTradeId: string;
  readonly previewToken: string;
  readonly previewExpiresAtMs: number;
  readonly plannedCount: number;
  readonly skippedCount: number;
  readonly rows: readonly PreviewRow[];
}

export interface PlanningDeps {
  /** Tenant-scoped writes and tenant-scoped reads. */
  readonly tdb: TenantDb;
  /** Unscoped db for GLOBAL data: market metadata and platform_state. */
  readonly db: Kysely<DB>;
  /** The only venue call. Injected so a fake book stands in for the check. */
  readonly getOrderBook: (market: MarketRef, depth: number) => Promise<OrderBook>;
  /** Phase-09 sell-position sizing: a FRESH free/locked holdings read used at
   *  preview for sell_all / pct_position (T09.2). When absent, preview sizes from
   *  the projected account_balance rows only (the send still re-reads). */
  readonly holdings?: ((accountId: string) => Promise<readonly Balance[]>) | undefined;
  /** The running code version, stamped on every trade for R7 quarantine (20). */
  readonly codeVersion: string;
  /** Whether this tenant is in dry-run (rung 0). True everywhere in this phase. */
  readonly dryRun?: boolean | undefined;
  /** Injected for the check: the day boundary and the clock. */
  readonly dayStartMs?: (() => number) | undefined;
  readonly now?: (() => number) | undefined;
  readonly newToken?: (() => string) | undefined;
}

const BOOK_DEPTH = 100;

/** The IST midnight at or before `nowMs`, in ms. IST is UTC+5:30, no DST. */
function istDayStart(nowMs: number): number {
  const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
  const ist = nowMs + IST_OFFSET_MS;
  const dayIndex = Math.floor(ist / 86_400_000);
  return dayIndex * 86_400_000 - IST_OFFSET_MS;
}

/** The mid of a book as a plain decimal, or null if either side is empty. */
function bookMid(book: OrderBook): string | null {
  const ask = book.asks[0];
  const bid = book.bids[0];
  if (ask === undefined || bid === undefined) return null;
  return toStr(div(add(nat(ask.price), nat(bid.price)), nat('2'), GUARD_SCALE));
}

export class PlanningService {
  constructor(private readonly deps: PlanningDeps) {}

  /**
   * Plan and persist a group trade, returning the preview. The trade is written
   * `previewed` with a token and a hard expiry; confirmation is a separate call.
   */
  async preview(req: PlanRequest): Promise<PreviewResult> {
    const nowMs = (this.deps.now ?? (() => Date.now()))();
    const dayStartMs = (this.deps.dayStartMs ?? (() => istDayStart(nowMs)))();
    const newToken = this.deps.newToken ?? (() => randomBytes(24).toString('base64url'));

    let members = await getEnabledMembers(this.deps.tdb, req.groupId);
    if (members.length === 0) {
      throw new PlanningError('this group has no enabled accounts to trade', 'empty_group');
    }
    // Retry-failed scoping (T08.7): when the request names a subset, plan ONLY
    // those still-enabled members — never anyone outside it. The ticket never
    // sends this; only retry-failed does, so the old trade's placed accounts are
    // excluded from the fresh plan by construction.
    if (req.accountIds !== undefined && req.accountIds.length > 0) {
      const wanted = new Set(req.accountIds);
      members = members.filter((m) => wanted.has(m.accountId));
      if (members.length === 0) {
        throw new PlanningError('none of the failed accounts are still enabled members of this group', 'nothing_to_retry');
      }
    }

    // --- gather the shared, trade-wide state once -----------------------------
    const version = await latestMarketMetadataVersion(this.deps.db);
    if (version === null) throw new PlanningError('no market metadata has been ingested yet', 'no_market_data');
    const allRules = await loadMarketRules(this.deps.db, version);
    const candidates = allRules.filter((r) => r.market.asset === req.asset);

    const platform = await readPlatformFlags(this.deps.db);
    const caps = await readTenantCaps(this.deps.tdb);
    const accountIds = members.map((m) => m.accountId);
    const [states, balancesByAccount] = await Promise.all([
      readAccountStates(this.deps.tdb, accountIds),
      readBalances(this.deps.tdb, accountIds),
    ]);

    // Phase-09 sell position modes (sell_all / pct_position) size from a FRESH
    // exchange read, not the projected account_balance rows, which are only as
    // current as the last reconcile (T09.2 — a sell-all must reflect the venue's
    // truth). The send re-reads again immediately before submit; this preview
    // read is what the customer confirms against. A read failure refuses rather
    // than size a sell against stale numbers.
    const sellPositionMode = req.side === 'sell' && (req.sizingMode === 'sell_all' || req.sizingMode === 'pct_position');
    const holdingsReader = this.deps.holdings;
    let holdingsByAccount: ReadonlyMap<string, readonly Balance[]> | undefined;
    if (sellPositionMode && holdingsReader !== undefined) {
      const fresh = await Promise.all(accountIds.map(async (accountId) => {
        let rows: readonly Balance[];
        try {
          rows = await holdingsReader(accountId);
        } catch {
          throw new PlanningError(
            'the exchange balance could not be read; refusing to size a sell-all or close against stale figures',
            'no_market_data',
          );
        }
        return [accountId, rows] as const;
      }));
      holdingsByAccount = new Map(fresh);
    }

    // --- one book read per distinct resolved market (T04.10) ------------------
    // A pre-pass resolves each member only to discover which markets need a book;
    // it decides no plan. planAccount re-resolves as gate 4, staying the authority.
    const marketsToRead = new Map<string, MarketRef>();
    for (const m of members) {
      const balances = balancesByAccount.get(m.accountId) ?? [];
      const resolved = resolveMarket(req.asset, balances, candidates);
      if (!('code' in resolved)) marketsToRead.set(resolved.rules.venueSymbol, resolved.rules.market);
    }
    const books = new Map<string, OrderBook>();
    for (const [symbol, ref] of marketsToRead) {
      books.set(symbol, await this.deps.getOrderBook(ref, BOOK_DEPTH));
    }

    // Market-scope switches (phase 05): the operator-set mode for each market the
    // asset resolves to on any member. One read for the whole trade, like the books.
    const marketModes = await readMarketStates(this.deps.db, [...marketsToRead.keys()]);

    // decision_mid: the reference market's mid, computed from the book reads
    // ABOVE — before the sizing loop below. Prefer INR, then USDT.
    const referenceBook = this.pickReferenceBook(books, candidates);
    const decisionMid = referenceBook === null ? null : bookMid(referenceBook);

    // --- per-account planning -------------------------------------------------
    const children: NewChildOrder[] = [];
    for (const member of members) {
      children.push(await this.planMember(member, {
        req, candidates, platform, caps, states, balancesByAccount, books, marketModes, dayStartMs,
        holdingsByAccount,
      }));
    }

    const trade: NewGroupTrade = {
      groupId: req.groupId,
      createdBy: req.createdBy,
      asset: req.asset,
      side: req.side,
      orderType: req.orderType,
      sizingMode: req.sizingMode,
      sizingValue: this.sizingValueColumn(req),
      limitPrice: req.orderType === 'limit' ? (req.limitPrice ?? null) : null,
      decisionMid,
      fxSnapshotId: null, // set in Phase 05+ when a cross-currency figure is stored
      marketMetaVersion: version,
      codeVersion: this.deps.codeVersion,
      dryRun: this.deps.dryRun ?? true,
    };
    const { groupTradeId } = await persistPlan(this.deps.tdb, trade, children, nowMs);

    const token = newToken();
    const expiresAtMs = nowMs + PREVIEW_TTL_MS;
    await markPreviewed(this.deps.tdb, groupTradeId, token, new Date(expiresAtMs));

    const rows = await this.buildPreviewRows(groupTradeId, members);
    return {
      groupTradeId,
      previewToken: token,
      previewExpiresAtMs: expiresAtMs,
      plannedCount: rows.filter((r) => r.state === 'planned').length,
      skippedCount: rows.filter((r) => r.state === 'skipped').length,
      rows,
    };
  }

  /** Plan one member into a child-order row, capturing all provenance (T04.5). */
  private async planMember(
    member: EnabledMember,
    ctx: {
      req: PlanRequest;
      candidates: readonly MarketRules[];
      platform: { killSwitch: boolean; mode: 'normal' | 'cancel_only' | 'read_only' };
      caps: { perOrderNotionalMinor: string; dailyNotionalMinor: string; tradingPaused: boolean };
      states: ReadonlyMap<string, AccountState>;
      balancesByAccount: ReadonlyMap<string, Balance[]>;
      /** Phase-09 fresh holdings, present only for sell position modes. */
      holdingsByAccount?: ReadonlyMap<string, readonly Balance[]> | undefined;
      books: ReadonlyMap<string, OrderBook>;
      marketModes: Readonly<Record<string, MarketStateRow>>;
      dayStartMs: number;
    },
  ): Promise<NewChildOrder> {
    const { req } = ctx;
    const balances = ctx.balancesByAccount.get(member.accountId) ?? [];
    const state = ctx.states.get(member.accountId);
    const intent = this.buildIntent(req);

    // The book this member would trade on, if it resolves. A member that refuses
    // at gate 4 never reads it, so an empty placeholder is safe there.
    const resolved = resolveMarket(req.asset, balances, ctx.candidates);
    const resolvedSymbol = 'code' in resolved ? null : resolved.rules.venueSymbol;
    const book = resolvedSymbol !== null ? ctx.books.get(resolvedSymbol) : undefined;
    const effectiveBook: OrderBook = book ?? {
      market: { asset: req.asset, quote: 'INR' }, asks: [], bids: [], observedAtMs: ctx.dayStartMs,
    };

    // Phase-09: when the request is a sell position mode and a FRESH holdings read
    // is available, the sell sizes from that fresh asset holding (T09.2), never a
    // stale projection. The quote rows stay from the projection (they gate funding);
    // only the base-asset row is overridden with the venue's free/locked truth.
    const sellPositionMode = req.side === 'sell' && (req.sizingMode === 'sell_all' || req.sizingMode === 'pct_position');
    let effectiveBalances: readonly Balance[] = balances;
    let freshHolding: { free: string; locked: string } | null = null;
    if (sellPositionMode && ctx.holdingsByAccount !== undefined && !('code' in resolved)) {
      const fresh = ctx.holdingsByAccount.get(member.accountId);
      const assetRow = fresh?.find((b) => b.currency === req.asset);
      if (assetRow !== undefined) {
        freshHolding = { free: minorToPlain(assetRow.freeMinor, assetRow.scale), locked: minorToPlain(assetRow.lockedMinor, assetRow.scale) };
        effectiveBalances = balances.map((b) => (b.currency === req.asset
          ? { ...b, freeMinor: assetRow.freeMinor, lockedMinor: assetRow.lockedMinor, scale: assetRow.scale }
          : b));
        if (!effectiveBalances.some((b) => b.currency === req.asset)) {
          effectiveBalances = [...effectiveBalances, { currency: req.asset, freeMinor: assetRow.freeMinor, lockedMinor: assetRow.lockedMinor, scale: assetRow.scale }];
        }
      } else {
        // The venue holds none of the asset — that absence IS the truth.
        freshHolding = { free: '0', locked: '0' };
        effectiveBalances = balances.filter((b) => b.currency !== req.asset);
      }
    }

    // The daily-spend basis (gate 11), in the market's quote currency.
    const quote: SupportedQuote = resolvedSymbol !== null && !('code' in resolved)
      ? resolved.rules.market.quote : 'INR';
    const dailySpent = resolvedSymbol !== null
      ? await dailySpentMinor(this.deps.tdb, member.accountId, quote, ctx.dayStartMs)
      : '0';
    const inFlight = resolvedSymbol !== null
      ? await hasInFlightOrder(this.deps.tdb, member.accountId, resolvedSymbol)
      : false;

    const { price, priceSource } = this.priceFor(req, intent.side, effectiveBook);

    // Phase-05 cap wiring: the effective per-order bound is the account's own
    // override when one is set, else the tenant's. The gate is told which one so
    // its refusal names it. The account-frozen scope comes straight off the row.
    const accountOverride = state?.maxOrderNotionalMinor ?? null;
    const effectiveOrderCap = accountOverride ?? ctx.caps.perOrderNotionalMinor;

    const gateState: GateState = {
      platformKillSwitch: ctx.platform.killSwitch,
      platformMode: ctx.platform.mode,
      tenantTradingPaused: ctx.caps.tradingPaused,
      marketModes: ctx.marketModes,
      accountStatus: state?.status ?? 'missing',
      credentialStatus: state?.credentialStatus ?? null,
      accountFrozenReason: state?.frozenReason ?? null,
      balances: effectiveBalances,
      candidateMarkets: ctx.candidates,
      allocatedCapitalMinor: member.allocatedCapitalMinor,
      freeQuoteMinor: freeQuoteMinorOf(effectiveBalances, quote),
      equityQuoteMinor: freeQuoteMinorOf(effectiveBalances, quote), // equity == free until holdings are valued (Phase 07)
      positionQuantity: positionQuantityOf(effectiveBalances, req.asset),
      book: effectiveBook,
      ...(req.slippageToleranceBp !== undefined ? { slippageToleranceBp: req.slippageToleranceBp } : {}),
      perOrderCapMinor: effectiveOrderCap,
      perOrderCapIsAccount: accountOverride !== null,
      dailyCapMinor: ctx.caps.dailyNotionalMinor,
      dailySpentMinor: dailySpent,
      hasInFlightForMarket: inFlight,
    };

    const planInput: PlanAccountInput = { intent, price, priceSource, state: gateState };
    const outcome = planAccount(planInput);

    if (!outcome.planned) {
      // Phase-09 dust / locked labels (T09.4): when a fresh holding explains the
      // refusal, name the cause precisely. Only refusals that came from the
      // sizing core are relabelled — an early gate (paused, frozen, caps, …)
      // keeps its own, more fundamental, reason.
      let refusal = outcome.refusal;
      if (freshHolding !== null && !GATE_CODE_SET.has(refusal.code) && !('code' in resolved)) {
        const effMin = effectiveMinQty(resolved.rules, req.orderType);
        const free0 = cmp(nat(freshHolding.free), nat('0')) === 0;
        const lockedGt0 = cmp(nat(freshHolding.locked), nat('0')) > 0;
        if (free0 && lockedGt0) {
          refusal = {
            code: 'HOLDING_LOCKED',
            message: `the holding of ${req.asset} is fully locked by an open order (${freshHolding.locked}) — cancel it first to sell`,
          };
        } else if (free0) {
          refusal = { code: 'NO_HOLDING', message: `this account holds none of ${req.asset} free to sell` };
        } else if (cmp(nat(freshHolding.free), effMin) < 0) {
          refusal = {
            code: 'DUST',
            message: `this account holds only ${freshHolding.free} of ${req.asset}, below the market's effective minimum of ${toStr(effMin)} — dust is not sellable`,
          };
        }
      }
      return {
        accountId: member.accountId,
        state: 'skipped',
        refusalCode: refusal.code,
        refusalDetail: refusal.message,
        // Resolution provenance is recorded even on a skip when it got that far.
        ...(resolvedSymbol !== null && !('code' in resolved)
          ? {
            market: resolvedSymbol,
            quoteCurrency: resolved.rules.market.quote,
            marketEcode: resolved.rules.venueCode,
            currencyChoiceReason: resolved.currencyChoiceReason,
          }
          : {}),
      };
    }

    const s = outcome.sized;
    return {
      accountId: member.accountId,
      state: 'planned',
      market: s.market,
      marketEcode: 'code' in resolved ? null : resolved.rules.venueCode,
      quoteCurrency: outcome.chosenQuote as SupportedQuote,
      currencyChoiceReason: outcome.currencyChoiceReason,
      basisUsed: s.basisUsed,
      basisAmountMinor: s.basisAmountMinor,
      priceSource: mapPriceSource(s.priceSource),
      priceUsed: s.priceUsed,
      feeRateAssumed: s.feeRateAssumed,
      tdsRateApplied: s.tdsRateApplied,
      rawQuantity: s.rawQuantity,
      finalQuantity: s.finalQuantity,
      notionalMinor: s.notionalMinor,
      bookObservedAt: new Date(effectiveBook.observedAtMs),
      spreadBp: outcome.spreadBp,
      slippageBp: outcome.slippageBp,
    };
  }

  /** Build the preview rows in the persisted order, joining account names. */
  private async buildPreviewRows(
    groupTradeId: string,
    members: readonly EnabledMember[],
  ): Promise<readonly PreviewRow[]> {
    const nameById = new Map(members.map((m) => [m.accountId, m.accountName]));
    const rows = await getChildOrders(this.deps.tdb, groupTradeId);
    return rows.map((r: ChildOrderRow) => toPreviewRow(r, nameById.get(r.accountId) ?? '(unknown)'));
  }

  /**
   * Reconstruct the preview payload for a persisted trade — the GET
   * /group-trades/:id read. After navigation or a reload the client holds only
   * the id, so the confirmation screen re-fetches the plan. The rows come from
   * the SAME persisted child_order rows via the SAME mapper as preview(), so U2
   * (preview equals plan) holds on a re-read exactly as it did at preview time.
   */
  async getPlan(groupTradeId: string): Promise<PreviewResult | null> {
    const trade = await getGroupTrade(this.deps.tdb, groupTradeId);
    if (trade === null) return null;
    const childRows = await getChildOrders(this.deps.tdb, groupTradeId);
    const names = await this.accountNames([...new Set(childRows.map((r) => r.accountId))]);
    const rows = childRows.map((r) => toPreviewRow(r, names.get(r.accountId) ?? '(unknown)'));
    return {
      groupTradeId: trade.id,
      // A confirmed or abandoned trade carries no live token; the client sees an
      // empty token and the confirm button is unavailable, which is correct.
      previewToken: trade.previewToken ?? '',
      previewExpiresAtMs: trade.previewExpiresAt?.getTime() ?? 0,
      plannedCount: rows.filter((r) => r.state === 'planned').length,
      skippedCount: rows.filter((r) => r.state === 'skipped').length,
      rows,
    };
  }

  /**
   * Retry the failed subset of an executed/abandoned trade as a FRESH trade
   * (T08.7). A brand-new group_trade row is planned — re-priced against the
   * current book — scoped ONLY to the accounts whose leg never placed. The old
   * trade and its rows are never touched, and its plan is never re-run.
   */
  async retryFailed(previousTradeId: string, actorUserId: string): Promise<PreviewResult> {
    const prev = await getGroupTrade(this.deps.tdb, previousTradeId);
    if (prev === null) throw new PlanningError('no such group trade', 'trade_not_found');
    const children = await getChildOrders(this.deps.tdb, previousTradeId);
    const failedIds = children.filter((c) => RETRYABLE_FAILED.has(c.state)).map((c) => c.accountId);
    if (failedIds.length === 0) {
      throw new PlanningError('nothing failed — every leg of this trade was placed or is still working', 'nothing_to_retry');
    }
    return this.preview(this.retryRequest(prev, failedIds, actorUserId));
  }

  /**
   * Reconstruct the original request from the persisted trade columns — the
   * inverse of sizingValueColumn(). A custom slippageToleranceBp was never
   * persisted, so a retry re-plans under the default 0.5% guard; the phase plan
   * documents this as a safety-direction difference (a retry may refuse where a
   * wide tolerance had been allowed), never a send where one would have refused.
   */
  private retryRequest(trade: GroupTradeRow, accountIds: readonly string[], createdBy: string): PlanRequest {
    const base: PlanRequest = {
      groupId: trade.groupId,
      createdBy,
      asset: trade.asset,
      side: trade.side,
      orderType: trade.orderType,
      sizingMode: trade.sizingMode,
      accountIds,
      ...(trade.orderType === 'limit' ? { limitPrice: trade.limitPrice ?? undefined } : {}),
    };
    if (trade.sizingMode.startsWith('pct_')) {
      if (trade.sizingValue === null) {
        throw new PlanningError('a percentage trade must carry its basis points', 'bad_mode');
      }
      return { ...base, percentBp: Number.parseInt(trade.sizingValue, 10) };
    }
    if (trade.sizingMode === 'sell_all') return base;
    return { ...base, sizingValue: trade.sizingValue ?? undefined };
  }

  /** Account names for a set of ids, tenant-scoped. For rendering the plan. */
  private async accountNames(accountIds: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (accountIds.length === 0) return out;
    const rows = await this.deps.tdb.selectFrom('exchange_account')
      .select(['id', 'name'])
      .where('id' as never, 'in', accountIds as never)
      .execute();
    for (const r of rows as ReadonlyArray<{ id: string; name: string }>) out.set(r.id, r.name);
    return out;
  }

  private pickReferenceBook(
    books: ReadonlyMap<string, OrderBook>,
    candidates: readonly MarketRules[],
  ): OrderBook | null {
    for (const quote of QUOTE_PREFERENCE) {
      const market = candidates.find((c) => c.market.quote === quote);
      if (market !== undefined) {
        const book = books.get(market.venueSymbol);
        if (book !== undefined) return book;
      }
    }
    return null;
  }

  private buildIntent(req: PlanRequest): Intent {
    const common = { asset: req.asset, orderType: req.orderType,
      ...(req.orderType === 'limit' && req.limitPrice !== undefined ? { limitPrice: req.limitPrice } : {}) };
    const pct = { percent: { basisPoints: req.percentBp ?? 0 } };
    if (req.side === 'buy') {
      switch (req.sizingMode) {
        case 'quote_amount': return { ...common, side: 'buy', mode: 'quote_amount', quoteAmountMinor: req.sizingValue ?? '0' };
        case 'base_quantity': return { ...common, side: 'buy', mode: 'base_quantity', baseQuantity: req.sizingValue ?? '0' };
        case 'pct_allocated': return { ...common, side: 'buy', mode: 'pct_allocated', ...pct };
        case 'pct_equity': return { ...common, side: 'buy', mode: 'pct_equity', ...pct };
        case 'pct_free': return { ...common, side: 'buy', mode: 'pct_free', ...pct };
        default: throw new PlanningError(`sizing mode ${req.sizingMode} is not valid for a buy`, 'bad_mode');
      }
    }
    switch (req.sizingMode) {
      case 'quote_amount': return { ...common, side: 'sell', mode: 'quote_amount', quoteAmountMinor: req.sizingValue ?? '0' };
      case 'base_quantity': return { ...common, side: 'sell', mode: 'base_quantity', baseQuantity: req.sizingValue ?? '0' };
      case 'pct_position': return { ...common, side: 'sell', mode: 'pct_position', ...pct };
      case 'sell_all': return { ...common, side: 'sell', mode: 'sell_all' };
      default: throw new PlanningError(`sizing mode ${req.sizingMode} is not valid for a sell`, 'bad_mode');
    }
  }

  private priceFor(
    req: PlanRequest,
    side: 'buy' | 'sell',
    book: OrderBook,
  ): { price: string; priceSource: 'ask' | 'bid' | 'limit' } {
    if (req.orderType === 'limit') {
      return { price: req.limitPrice ?? '0', priceSource: 'limit' };
    }
    const touch = touchPrice(book, side);
    // An empty book yields '0'; the slippage guard (INSUFFICIENT_DEPTH) or
    // legalise() then refuses this member, and '0' never reaches a real order.
    if (touch === null) return { price: '0', priceSource: side === 'buy' ? 'ask' : 'bid' };
    return { price: touch.price, priceSource: side === 'buy' ? 'ask' : 'bid' };
  }

  private sizingValueColumn(req: PlanRequest): string | null {
    if (req.sizingMode === 'sell_all') return null;
    if (req.percentBp !== undefined) return String(req.percentBp);
    return req.sizingValue ?? null;
  }
}

/** Read a specific quote's free balance in minor units, or '0'. */
function freeQuoteMinorOf(balances: readonly Balance[], quote: string): string {
  const b = balances.find((x) => x.currency === quote);
  return b?.freeMinor ?? '0';
}

/** The held quantity of an asset, as a plain decimal at the balance's scale. */
function positionQuantityOf(balances: readonly Balance[], asset: string): string {
  const b = balances.find((x) => x.currency === asset);
  if (b === undefined) return '0';
  return toStr(nat(minorToPlain(b.freeMinor, b.scale)));
}

/** minor units → a plain decimal string at the given scale. */
function minorToPlain(minor: string, scale: number): string {
  if (scale === 0) return minor;
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

/** size()'s PriceSource → the child_order.price_source enum. */
function mapPriceSource(s: 'ask' | 'bid' | 'limit'): 'book_ask' | 'book_bid' | 'limit' {
  return s === 'ask' ? 'book_ask' : s === 'bid' ? 'book_bid' : 'limit';
}

/**
 * The single mapper from a persisted child_order row to a preview row, used by
 * BOTH preview() and getPlan(). Sharing it is what keeps U2 true on a re-read:
 * the confirmation screen renders the same fields whether it just previewed or
 * re-fetched after a reload, because there is exactly one place the mapping
 * lives.
 */
function toPreviewRow(r: ChildOrderRow, accountName: string): PreviewRow {
  return {
    childOrderId: r.id,
    accountId: r.accountId,
    accountName,
    state: r.state,
    market: r.market,
    quoteCurrency: r.quoteCurrency,
    finalQuantity: r.finalQuantity,
    priceUsed: r.priceUsed,
    notionalMinor: r.notionalMinor,
    basisUsed: r.basisUsed,
    basisAmountMinor: r.basisAmountMinor,
    currencyChoiceReason: r.currencyChoiceReason,
    // A wide spread is recoverable from spread_bp against the default tolerance,
    // so the qualitative warning survives a re-read without a persisted boolean.
    spreadIsWide: r.spreadBp !== null && BigInt(r.spreadBp) >= 50n,
    refusalCode: r.refusalCode,
    refusalDetail: r.refusalDetail,
  };
}

export class PlanningError extends Error {
  override readonly name = 'PlanningError';
  constructor(
    message: string,
    readonly reason: 'empty_group' | 'no_market_data' | 'bad_mode' | 'trade_not_found' | 'nothing_to_retry',
  ) {
    super(message);
  }
}

/** Re-exported for the confirm flow and the checks. */
export { confirmDryRun, getGroupTrade, getChildOrders } from '@tradex/db';
export type { GroupTradeRow, ChildOrderRow };
