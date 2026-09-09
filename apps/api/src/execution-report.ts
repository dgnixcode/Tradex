// Execution report — plan/phase-08 T08.5/T08.8 (pure over the child rows).
//
// A fan-out's honest summary. Grouped by outcome so "14 filled · 3 rejected ·
// 2 skipped · 1 needs review" reads as a SUCCESSFUL trade with a partial-failure
// explanation — twenty identical rejections collapse to one cause with a count,
// never twenty rows. A pure function of the persisted child rows.

/** The child fields a report needs (a superset of what some readers expose). */
export interface ReportChild {
  readonly accountId: string;
  readonly state: string;
  readonly market: string | null;
  readonly finalQuantity: string | null;
  readonly notionalMinor: string | null;
  readonly refusalCode: string | null;
  readonly refusalDetail: string | null;
  readonly coid: string | null;
  readonly exchangeOrderId: string | null;
}

/** Which terminal-ish states count as "placed" for the summary. */
const PLACED: ReadonlySet<string> = new Set(['acked', 'open', 'partially_filled', 'filled']);

export interface ReportRow {
  readonly accountId: string;
  readonly state: string;
  readonly market: string | null;
  readonly finalQuantity: string | null;
  readonly notionalMinor: string | null;
  readonly reason: string | null;
  readonly coid: string | null;
  readonly exchangeOrderId: string | null;
}

export interface GroupedCause {
  readonly code: string;
  readonly detail: string;
  readonly count: number;
  readonly accounts: readonly string[];
}

export interface ExecutionReport {
  readonly planned: number;
  readonly placed: number;
  readonly skipped: number;
  readonly rejected: number;
  readonly needsReview: number;
  readonly rows: readonly ReportRow[];
  /** Partial failures collapsed by cause — the presentation surface (T08.8). */
  readonly groupedCauses: readonly GroupedCause[];
  /** Whether every planned leg reached a placed state (all-or-nothing is rare). */
  readonly allPlaced: boolean;
}

export function buildReport(children: readonly ReportChild[]): ExecutionReport {
  let placed = 0;
  let skipped = 0;
  let rejected = 0;
  let needsReview = 0;
  const rows: ReportRow[] = [];
  // Mutable while building; frozen on output.
  const causeByCode = new Map<string, { code: string; detail: string; count: number; accounts: string[] }>();

  for (const c of children) {
    rows.push({
      accountId: c.accountId,
      state: c.state,
      market: c.market,
      finalQuantity: c.finalQuantity,
      notionalMinor: c.notionalMinor,
      reason: c.refusalDetail,
      coid: c.coid,
      exchangeOrderId: c.exchangeOrderId,
    });
    if (PLACED.has(c.state)) placed += 1;
    else if (c.state === 'skipped') skipped += 1;
    else if (c.state === 'rejected') rejected += 1;
    else if (c.state === 'needs_human' || c.state === 'unknown') needsReview += 1;

    // Group skips + rejections by refusal code so N identical failures are one cause.
    if ((c.state === 'skipped' || c.state === 'rejected') && c.refusalCode !== null) {
      const key = `${c.state}:${c.refusalCode}`;
      let g = causeByCode.get(key);
      if (g === undefined) {
        g = { code: c.refusalCode, detail: c.refusalDetail ?? '', count: 0, accounts: [] };
        causeByCode.set(key, g);
      }
      g.count += 1;
      g.accounts.push(c.accountId);
    }
  }

  return {
    planned: children.length,
    placed,
    skipped,
    rejected,
    needsReview,
    rows,
    groupedCauses: [...causeByCode.values()],
    allPlaced: children.length > 0 && placed === children.length,
  };
}
