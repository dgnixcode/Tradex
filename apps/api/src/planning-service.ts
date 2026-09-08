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
import { add, div } from '@tradex/money';
import type { Balance, MarketRef, MarketRules, OrderBook } from '@tradex/exchange';
import type { Kysely } from 'kysely';
import {
  dailySpentMinor, getChildOrders, getEnabledMembers, getGroupTrade, hasInFlightOrder,
  latestMarketMetadataVersion, loadMarketRules, markPreviewed, persistPlan,
  readAccountStates, readBalances, readPlatformFlags, readTenantCaps,
} from '@tradex/db';
import type { DB, SupportedQuote, TenantDb } from '@tradex/db';
import type { EnabledMember, NewChildOrder, NewGroupTrade, ChildOrderRow, GroupTradeRow } from '@tradex/db';
import {
  GUARD_SCALE, nat, planAccount, resolveMarket, toStr, touchPrice,
} from '@tradex/sizing';
import type { GateState, Intent, PlanAccountInput } from '@tradex/sizing';

/** How long a preview is valid. Short, because the book it was priced against ages. */
export const PREVIEW_TTL_MS = 60_000;

/** Quote-preference order for the reference market, matching market-resolution. */
const QUOTE_PREFERENCE: readonly SupportedQuote[] = ['INR', 'USDT'];

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

    const members = await getEnabledMembers(this.deps.tdb, req.groupId);
    if (members.length === 0) {
      throw new PlanningError('this group has no enabled accounts to trade', 'empty_group');
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

    // decision_mid: the reference market's mid, computed from the book reads
    // ABOVE — before the sizing loop below. Prefer INR, then USDT.
    const referenceBook = this.pickReferenceBook(books, candidates);
    const decisionMid = referenceBook === null ? null : bookMid(referenceBook);

    // --- per-account planning -------------------------------------------------
    const children: NewChildOrder[] = [];
    for (const member of members) {
      children.push(await this.planMember(member, {
        req, candidates, platform, caps, states, balancesByAccount, books, dayStartMs,
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
      states: ReadonlyMap<string, { status: string; credentialStatus: string | null }>;
      balancesByAccount: ReadonlyMap<string, Balance[]>;
      books: ReadonlyMap<string, OrderBook>;
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

    const gateState: GateState = {
      platformKillSwitch: ctx.platform.killSwitch,
      platformMode: ctx.platform.mode,
      tenantTradingPaused: ctx.caps.tradingPaused,
      accountStatus: state?.status ?? 'missing',
      credentialStatus: state?.credentialStatus ?? null,
      balances,
      candidateMarkets: ctx.candidates,
      allocatedCapitalMinor: member.allocatedCapitalMinor,
      freeQuoteMinor: freeQuoteMinorOf(balances, quote),
      equityQuoteMinor: freeQuoteMinorOf(balances, quote), // equity == free until holdings are valued (Phase 07)
      positionQuantity: positionQuantityOf(balances, req.asset),
      book: effectiveBook,
      ...(req.slippageToleranceBp !== undefined ? { slippageToleranceBp: req.slippageToleranceBp } : {}),
      perOrderCapMinor: ctx.caps.perOrderNotionalMinor,
      dailyCapMinor: ctx.caps.dailyNotionalMinor,
      dailySpentMinor: dailySpent,
      hasInFlightForMarket: inFlight,
    };

    const planInput: PlanAccountInput = { intent, price, priceSource, state: gateState };
    const outcome = planAccount(planInput);

    if (!outcome.planned) {
      return {
        accountId: member.accountId,
        state: 'skipped',
        refusalCode: outcome.refusal.code,
        refusalDetail: outcome.refusal.message,
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
    readonly reason: 'empty_group' | 'no_market_data' | 'bad_mode',
  ) {
    super(message);
  }
}

/** Re-exported for the confirm flow and the checks. */
export { confirmDryRun, getGroupTrade, getChildOrders } from '@tradex/db';
export type { GroupTradeRow, ChildOrderRow };
