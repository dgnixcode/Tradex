// The analytics service — plan/phase-12 T12.1/T12.4/T12.6.
//
// Every number a customer sees about what happened on their trades is produced
// here (or in @tradex/metrics), from OUR records — never a venue call, never a
// current price (§6a). Realised P&L / fee drag / TDS over a window are a TWO
// PREFIX FOLD of the ledger: fold everything up to the window end, fold the
// prefix before the window start, and diff — the fold realises against each
// account's own weighted-average cost, and a re-run is byte-identical (N5/L10).
// The blotter is a cursor-paginated read of child_order; the CSV endpoint turns
// the same fill rows into text.

import type { TenantDb } from '@tradex/db';
import type { BlotterChildRow, BlotterOutcome } from '@tradex/db';
import {
  getEnabledMembers, listHeldPositions,
  accountScopeRows, childWindowRows, completedTradeRows, ledgerRowsForAccount,
  listBlotterChildren, scopeBalanceRows,
} from '@tradex/db';
import { foldLedger } from '@tradex/ledger';
import type { Holding, LedgerRow } from '@tradex/ledger';
import { addMinor, computeMetrics, fyRangeInclusive, windowLabel } from '@tradex/metrics';
import type { MetricFacts, MetricValue, Quote, WindowAmounts } from '@tradex/metrics';
import { listAccounts } from './accounts-query.js';
import type { NamedAccount } from './positions.js';

export type { MetricValue, MetricFacts, Quote, WindowAmounts } from '@tradex/metrics';

const IST_MS = (5 * 60 + 30) * 60_000;

export interface AnalyticsWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly label: string;
}

export type { BlotterChildRow, BlotterOutcome };

// ------------------------------------------------------------------ windows

/** The Indian financial year for a label like '2025-26'. */
function fyOf(label: string): { fromMs: number; toMs: number; label: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(label);
  if (m === null) return null;
  const startYear = Number(m[1]);
  const endYear = startYear + 1;
  if (String(endYear).slice(2) !== m[2]) return null;
  return { fromMs: Date.UTC(startYear, 3, 1) - IST_MS, toMs: Date.UTC(endYear, 3, 1) - IST_MS, label };
}

/**
 * Resolve a requested window. Precedence: explicit fromMs/toMs, then `fy`
 * (a label like '2025-26' or 'current'), then the current Indian FY.
 */
export function resolveWindow(
  req: { readonly fromMs?: string | null; readonly toMs?: string | null; readonly fy?: string | null },
  nowMs: number,
): AnalyticsWindow {
  const f = req.fy ?? null;
  if (f !== null && f !== '') {
    const range = f === 'current' ? fyRangeInclusive(nowMs) : fyOf(f);
    if (range !== null) return { fromMs: range.fromMs, toMs: range.toMs, label: f === 'current' ? range.label : f };
  }
  const fromMs = req.fromMs === null || req.fromMs === undefined || req.fromMs === '' ? null : Number(req.fromMs);
  const toMs = req.toMs === null || req.toMs === undefined || req.toMs === '' ? null : Number(req.toMs);
  if (fromMs !== null && toMs !== null && Number.isFinite(fromMs) && Number.isFinite(toMs)) {
    return { fromMs, toMs, label: windowLabel(fromMs, toMs) };
  }
  const cur = fyRangeInclusive(nowMs);
  return { fromMs: cur.fromMs, toMs: cur.toMs, label: cur.label };
}

// ------------------------------------------------------------------ scope

/** The accounts a scope names: one account, a group's enabled members, or all. */
export async function resolveAccounts(
  tdb: TenantDb,
  req: { readonly groupId?: string | null; readonly accountId?: string | null },
): Promise<NamedAccount[]> {
  if (req.accountId !== undefined && req.accountId !== null && req.accountId !== '') {
    const all = await listAccounts(tdb);
    const one = all.find((a) => a.id === req.accountId);
    return one === undefined ? [] : [{ accountId: one.id, accountName: one.name }];
  }
  if (req.groupId !== undefined && req.groupId !== null && req.groupId !== '') {
    const members = await getEnabledMembers(tdb, req.groupId);
    return members.map((m) => ({ accountId: m.accountId, accountName: m.accountName }));
  }
  return (await listAccounts(tdb)).map((a) => ({ accountId: a.id, accountName: a.name }));
}

// ------------------------------------------------------------------ blotter

export interface BlotterRequest {
  readonly accountId?: string | null;
  readonly groupTradeId?: string | null;
  readonly market?: string | null;
  readonly outcome?: string | null;
  readonly limit?: number | null;
  readonly cursor?: string | null;
}

export function encodeCursor(createdAtMs: number, id: string): string {
  return `${createdAtMs}:${id}`;
}

export function decodeCursor(raw: string | null): { createdAtMs: number; id: string } | null {
  if (raw === null || raw === '') return null;
  const idx = raw.indexOf(':');
  if (idx <= 0) return null;
  const createdAtMs = Number(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (!Number.isFinite(createdAtMs) || id === '') return null;
  return { createdAtMs, id };
}

export async function blotterPage(tdb: TenantDb, req: BlotterRequest): Promise<{
  readonly rows: readonly BlotterChildRow[];
  readonly nextCursor: string | null;
}> {
  const page = await listBlotterChildren(tdb, {
    accountId: req.accountId ?? undefined,
    groupTradeId: req.groupTradeId ?? undefined,
    market: req.market ?? undefined,
    outcome: (req.outcome ?? undefined) as BlotterOutcome | undefined,
    limit: req.limit ?? undefined,
    cursor: decodeCursor(req.cursor ?? null) ?? undefined,
  });
  return {
    rows: page.rows,
    nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor.createdAtMs, page.nextCursor.id),
  };
}

// ------------------------------------------------------------------ realised

export interface QuoteTotal extends WindowAmounts {
  readonly quoteAsset: Quote;
}

export interface FillLine {
  readonly occurredAtMs: number;
  readonly accountId: string;
  readonly accountName: string;
  readonly kind: string;
  readonly asset: string;
  readonly quoteAsset: string | null;
  readonly amountMinor: string;
  readonly price: string | null;
  readonly feeMinor: string | null;
  readonly tdsMinor: string | null;
  readonly estimated: boolean;
}

export interface AnalyticsReport {
  readonly window: AnalyticsWindow;
  readonly accountCount: number;
  readonly approximate: boolean;
  readonly totals: readonly QuoteTotal[];
  readonly metrics: readonly MetricValue[];
  /** The in-window ledger journal (fills, fees, TDS, adjustments). */
  readonly fills: readonly FillLine[];
}

type LedgerDbRow = Awaited<ReturnType<typeof ledgerRowsForAccount>>[number];

const toLedgerRow = (r: LedgerDbRow): LedgerRow => r as unknown as LedgerRow;

const ZERO_WIN: WindowAmounts = { realised: '0', feeDrag: '0', tds: '0' };

function addWin(a: WindowAmounts, b: WindowAmounts): WindowAmounts {
  return {
    realised: addMinor(a.realised, b.realised),
    feeDrag: addMinor(a.feeDrag, b.feeDrag),
    tds: addMinor(a.tds, b.tds),
  };
}

/** Fold-prefix diff realised/fee/TDS for one account across [fromMs, toMs). */
function foldDelta(rowsUpToTo: readonly LedgerDbRow[], fromMs: number): Map<Quote, WindowAmounts> {
  const end = foldLedger(rowsUpToTo.map(toLedgerRow));
  const startRows = rowsUpToTo.filter((r) => r.occurredAtMs < fromMs);
  const start = foldLedger(startRows.map(toLedgerRow));
  const startByAsset = new Map(start.map((h) => [h.asset, h]));
  const byQuote = new Map<Quote, WindowAmounts>();
  for (const h of end) {
    const q = h.quoteAsset as Quote;
    const s = startByAsset.get(h.asset);
    const prior: Holding = s ?? { asset: h.asset, quoteAsset: h.quoteAsset, qty: '0', costTotalMinor: '0', realisedMinor: '0', feeDragMinor: '0', tdsWithheldMinor: '0' };
    const cur = byQuote.get(q) ?? { realised: '0', feeDrag: '0', tds: '0' };
    byQuote.set(q, {
      realised: addMinor(cur.realised, (BigInt(h.realisedMinor) - BigInt(prior.realisedMinor)).toString()),
      feeDrag: addMinor(cur.feeDrag, (BigInt(h.feeDragMinor) - BigInt(prior.feeDragMinor)).toString()),
      tds: addMinor(cur.tds, (BigInt(h.tdsWithheldMinor) - BigInt(prior.tdsWithheldMinor)).toString()),
    });
  }
  return byQuote;
}

/**
 * Realised P&L / fee drag / TDS over [fromMs, toMs) across the named accounts,
 * plus the metric facts and the in-window ledger journal. The fold runs once per
 * account up to toMs; the start prefix is the same rows filtered in memory, so a
 * re-run of the same window is deterministic (N5/L10).
 */
export async function analyticsReport(
  tdb: TenantDb,
  named: readonly NamedAccount[],
  win: AnalyticsWindow,
): Promise<AnalyticsReport> {
  const byQuote = new Map<Quote, WindowAmounts>();
  const fills: FillLine[] = [];
  let unclassified = 0;

  for (const account of named) {
    const rows = await ledgerRowsForAccount(tdb, account.accountId, { toMs: win.toMs });
    const accountDelta = foldDelta(rows, win.fromMs);
    for (const [q, w] of accountDelta) {
      byQuote.set(q, addWin(byQuote.get(q) ?? ZERO_WIN, w));
    }

    // The in-window journal. Cash legs (asset === quote) are the currency side of
    // a trade, not an asset fill — excluded so a 'fill' is an asset movement.
    for (const r of rows) {
      if (r.occurredAtMs < win.fromMs) continue;
      const isCash = r.kind.startsWith('trade') && r.asset === r.quoteAsset;
      if (isCash) continue;
      if (r.kind === 'external_adjustment') unclassified += 1;
      fills.push({
        occurredAtMs: r.occurredAtMs,
        accountId: account.accountId,
        accountName: account.accountName,
        kind: r.kind,
        asset: r.asset,
        quoteAsset: r.quoteAsset,
        amountMinor: r.deltaMinor,
        price: r.price,
        feeMinor: r.feeMinor,
        tdsMinor: r.tdsMinor,
        estimated: r.estimated,
      });
    }
  }

  const totals: QuoteTotal[] = (['INR', 'USDT'] as const).map((q) => {
    const w = byQuote.get(q) ?? ZERO_WIN;
    return { quoteAsset: q, realised: w.realised, feeDrag: w.feeDrag, tds: w.tds };
  });

  const facts = await buildMetricFacts(tdb, named, win.fromMs, win.toMs, totals, unclassified);

  return {
    window: win,
    accountCount: named.length,
    approximate: unclassified > 0,
    totals,
    metrics: computeMetrics(facts),
    fills,
  };
}

const CSV_COLUMNS = ['occurred_at', 'account', 'kind', 'asset', 'quote', 'amount_minor', 'price', 'fee_minor', 'tds_minor', 'estimated'];

const csvCell = (v: string | number | boolean | null): string => {
  const s = v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The in-window ledger journal as CSV: fills, fees, TDS and adjustments. */
export function reportToCsv(report: AnalyticsReport): string {
  const head = report.window.label;
  const rows = [
    `# realised report ${head} — from our records, not a valuation`,
    `# window,${head},accounts,${report.accountCount},approximate,${report.approximate ? 'yes' : 'no'}`,
    ...report.totals.filter((t) => t.realised !== '0' || t.feeDrag !== '0' || t.tds !== '0')
      .map((t) => `# ${t.quoteAsset},realised,${t.realised},fee_drag,${t.feeDrag},tds,${t.tds}`),
    CSV_COLUMNS.join(','),
    ...report.fills.map((f) => [
      csvCell(new Date(f.occurredAtMs).toISOString()),
      csvCell(f.accountName),
      csvCell(f.kind),
      csvCell(f.asset),
      csvCell(f.quoteAsset),
      csvCell(f.amountMinor),
      csvCell(f.price),
      csvCell(f.feeMinor),
      csvCell(f.tdsMinor),
      csvCell(f.estimated),
    ].join(',')),
  ];
  return rows.join('\n');
}

// ------------------------------------------------------------------ metrics

async function buildMetricFacts(
  tdb: TenantDb,
  named: readonly NamedAccount[],
  fromMs: number,
  toMs: number,
  totals: readonly QuoteTotal[],
  unclassified: number,
): Promise<MetricFacts> {
  const ids = named.map((a) => a.accountId);
  const quotes = new Set<Quote>();
  for (const t of totals) if (t.realised !== '0' || t.feeDrag !== '0' || t.tds !== '0') quotes.add(t.quoteAsset);

  const [scopeAccounts, balances, held, children, completed] = await Promise.all([
    accountScopeRows(tdb, ids),
    scopeBalanceRows(tdb, ids),
    listHeldPositions(tdb, ids),
    childWindowRows(tdb, { fromMs, toMs }, { accountIds: ids }),
    completedTradeRows(tdb, { fromMs, toMs }),
  ]);

  const allocatedMinorByQuote: Partial<Record<Quote, string>> = {};
  const storedFreeMinorByQuote: Partial<Record<Quote, string>> = {};
  for (const a of scopeAccounts) {
    const q = a.allocatedCurrency as Quote;
    allocatedMinorByQuote[q] = addMinor(allocatedMinorByQuote[q] ?? '0', a.allocatedMinor);
    quotes.add(q);
  }
  for (const b of balances) {
    const q = b.currency as Quote;
    storedFreeMinorByQuote[q] = addMinor(storedFreeMinorByQuote[q] ?? '0', (BigInt(b.freeMinor) + BigInt(b.lockedMinor)).toString());
    quotes.add(q);
  }

  const deployedCostMinorByQuote: Partial<Record<Quote, string>> = {};
  for (const h of held) {
    deployedCostMinorByQuote[h.quoteAsset] = addMinor(deployedCostMinorByQuote[h.quoteAsset] ?? '0', h.costTotalMinor);
    quotes.add(h.quoteAsset);
  }

  const windowMinorByQuote: Partial<Record<Quote, WindowAmounts>> = {};
  for (const t of totals) {
    if (t.realised !== '0' || t.feeDrag !== '0' || t.tds !== '0') {
      windowMinorByQuote[t.quoteAsset] = { realised: t.realised, feeDrag: t.feeDrag, tds: t.tds };
    }
  }

  // M16 — expected-at-plan slippage over the window's market legs that captured a
  // decision mid. Unweighted mean in bp. Never a realised claim.
  const slippageLegs: number[] = [];
  for (const c of children) {
    if (c.orderType === 'market' && c.decisionMidCaptured && c.slippageBp !== null) {
      const bp = Number(c.slippageBp);
      if (Number.isFinite(bp)) slippageLegs.push(bp);
    }
  }
  const hasSlippageData = slippageLegs.length > 0;
  const planSlippageBp = hasSlippageData
    ? Math.floor(slippageLegs.reduce((a, b) => a + b, 0) / slippageLegs.length)
    : null;

  // M19 divergence — accounts whose confirmed basis differs from the typed one.
  const divergenceAccounts = scopeAccounts.filter(
    (a) => a.confirmedMinor !== null && a.confirmedMinor !== a.allocatedMinor,
  ).length;

  // M20 participation — accounts with planned legs in the window, as a share.
  const participantIds = new Set(children.map((c) => c.accountId));
  const participationBp = children.length === 0 || named.length === 0
    ? null
    : Math.floor((participantIds.size * 10_000) / named.length);

  // M22 — average submit→complete across completed group trades in the window.
  const completionMs = completed.reduce((acc, t) => {
    if (t.submittedAtMs === null) return acc;
    return acc + Math.max(0, t.completedAtMs - t.submittedAtMs);
  }, 0);
  const completedTrades = completed.filter((t) => t.submittedAtMs !== null).length;

  return {
    quotes: (['INR', 'USDT'] as const).filter((q) => quotes.has(q)),
    allocatedMinorByQuote,
    storedFreeMinorByQuote,
    deployedCostMinorByQuote,
    windowMinorByQuote,
    hasSlippageData,
    planSlippageBp,
    unclassifiedAdjustments: unclassified,
    divergenceAccounts,
    totalAccounts: named.length,
    participationBp,
    completionMs,
    completedTrades,
  };
}
