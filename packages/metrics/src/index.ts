// The metric module — plan/phase-12 T12.1.
//
// The ONE place a metric number is produced. A screen never computes a money
// figure (invariant N1): it renders the MetricValue objects this module returns,
// each carrying its metric id. Every input is OUR OWN record — a minor-unit sum,
// a stored free balance, a ledger-fold prefix — never a current market price
// (§6a; the no-market-price check scans this package). Metrics whose backing does
// not exist in our records today report `status:'not_captured'` with a reason,
// never a zero (N8): zero would read as perfect execution.
//
// The module is pure: no I/O, no clock, no database. The caller assembles the
// facts (read-only scalars) and hands them in.

export type Quote = 'INR' | 'USDT';

/** Minor-unit totals for one quote over a ledger window. */
export interface WindowAmounts {
  /** Realised P&L, quote minor, within the window. */
  readonly realised: string;
  /** Exit-fee drag, quote minor, within the window. */
  readonly feeDrag: string;
  /** TDS withheld (always estimated), quote minor, within the window. */
  readonly tds: string;
}

/**
 * The read-only facts a metric may consume. Nothing here is, or can be, a
 * current price — these are balances, cost figures and ledger aggregates.
 */
export interface MetricFacts {
  /** The quotes actually in scope, so a money metric renders each currency. */
  readonly quotes: readonly Quote[];
  /** M1 — allocated capital per quote (exchange_account.allocated_capital_minor). */
  readonly allocatedMinorByQuote: Partial<Record<Quote, string>>;
  /** M2 — free balance per quote as stored (account_balance free + locked). */
  readonly storedFreeMinorByQuote: Partial<Record<Quote, string>>;
  /** M5 — deployed capital at cost per quote (holding.cost_total_minor). */
  readonly deployedCostMinorByQuote: Partial<Record<Quote, string>>;
  /** M6/M10/M11 — ledger fold deltas within the requested window, per quote. */
  readonly windowMinorByQuote: Partial<Record<Quote, WindowAmounts>>;
  /** M16 — true when ≥1 market leg in the window carried a decision_mid slippage estimate. */
  readonly hasSlippageData: boolean;
  /** M16 — the expected-at-plan slippage in bp when hasSlippageData, else null. */
  readonly planSlippageBp: number | null;
  /** M18 — how many unclassified external_adjustment rows exist in the scope. */
  readonly unclassifiedAdjustments: number;
  /** M19 — how many accounts in scope currently diverge from their typed capital. */
  readonly divergenceAccounts: number;
  /** M19/M20 — the number of accounts the scope covers. */
  readonly totalAccounts: number;
  /** M20 — share of enabled accounts that took part (bp), null when nothing planned. */
  readonly participationBp: number | null;
  /** M22 — sum of (completed_at − submitted_at) over completed group trades in scope. */
  readonly completionMs: number;
  /** M22 — how many completed group trades contributed to completionMs. */
  readonly completedTrades: number;
}

export const METRIC_LABELS = {
  M1: 'Allocated capital',
  M2: 'Free balance',
  M5: 'Deployed capital (at cost)',
  M6: 'Realised P&L',
  M10: 'Fee drag',
  M11: 'TDS withheld (estimated)',
  M12: 'Win rate',
  M13: 'Average win / loss',
  M16: 'Slippage (expected, at plan)',
  M17: 'Fill rate',
  M18: 'Unexplained deltas',
  M19: 'Group divergence',
  M20: 'Participation',
  M22: 'Time to completion',
} as const;

export type MetricId = keyof typeof METRIC_LABELS;

export type MetricUnit = 'minor' | 'bp' | 'count' | 'ms';
export type MetricStatus = 'ok' | 'not_captured';

export interface MetricValue {
  readonly metricId: MetricId;
  readonly label: string;
  readonly status: MetricStatus;
  /** The number, or null when not_captured. Minor units are plain integers. */
  readonly value: string | null;
  readonly unit: MetricUnit;
  readonly quoteAsset?: Quote | undefined;
  /** Why a metric is not captured, when it is. Never a bare zero. */
  readonly reason?: string | undefined;
  /** N3 — true when unclassified adjustments make M6/M12/M13 approximate. */
  readonly approximate: boolean;
}

export function addMinor(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString();
}

export function sumMinor(parts: ReadonlyArray<string | undefined>): string {
  let acc = 0n;
  for (const p of parts) if (p !== undefined) acc += BigInt(p);
  return acc.toString();
}

/** The metrics N3 badges as approximate when unclassified adjustments exist. */
const APPROXIMATE_IDS: ReadonlySet<MetricId> = new Set(['M6', 'M12', 'M13']);

const at = (m: Partial<Record<Quote, string>>, q: Quote): string => m[q] ?? '0';
const winAt = (m: Partial<Record<Quote, WindowAmounts>>, q: Quote): WindowAmounts =>
  m[q] ?? { realised: '0', feeDrag: '0', tds: '0' };

interface Scalar {
  readonly metricId: MetricId;
  readonly unit: MetricUnit;
  readonly status?: MetricStatus | undefined;
  readonly reason?: string | undefined;
}

/** Push one money-scaled metric row per quote actually in scope. */
function pushMoney(
  out: MetricValue[], scalar: Scalar, facts: MetricFacts, valueOf: (q: Quote) => string,
): void {
  for (const q of facts.quotes) {
    out.push({
      metricId: scalar.metricId,
      label: METRIC_LABELS[scalar.metricId],
      status: scalar.status ?? 'ok',
      value: valueOf(q),
      unit: scalar.unit,
      quoteAsset: q,
      ...(scalar.reason !== undefined ? { reason: scalar.reason } : {}),
      approximate: APPROXIMATE_IDS.has(scalar.metricId) && facts.unclassifiedAdjustments > 0,
    });
  }
}

/** One row that is always not_captured, with its reason. */
function pushNotCaptured(out: MetricValue[], metricId: MetricId, unit: MetricUnit, reason: string, facts: MetricFacts): void {
  out.push({
    metricId, label: METRIC_LABELS[metricId], status: 'not_captured', value: null, unit,
    reason, approximate: APPROXIMATE_IDS.has(metricId) && facts.unclassifiedAdjustments > 0,
  });
}

/** The full metric picture for one scope+window. All 14 ids are present. */
export function computeMetrics(facts: MetricFacts): MetricValue[] {
  const out: MetricValue[] = [];

  pushMoney(out, { metricId: 'M1', unit: 'minor' }, facts, (q) => at(facts.allocatedMinorByQuote, q));
  pushMoney(out, { metricId: 'M2', unit: 'minor' }, facts, (q) => at(facts.storedFreeMinorByQuote, q));
  pushMoney(out, { metricId: 'M5', unit: 'minor' }, facts, (q) => at(facts.deployedCostMinorByQuote, q));

  // M6/M10/M11 come from the ledger fold deltas within the window (realised /
  // exit-fee drag / TDS withheld), each per quote.
  pushMoney(out, { metricId: 'M6', unit: 'minor' }, facts, (q) => winAt(facts.windowMinorByQuote, q).realised);
  pushMoney(out, { metricId: 'M10', unit: 'minor' }, facts, (q) => winAt(facts.windowMinorByQuote, q).feeDrag);
  pushMoney(out, { metricId: 'M11', unit: 'minor' }, facts, (q) => winAt(facts.windowMinorByQuote, q).tds);

  // M12/M13: win/loss needs PER-LOT realised attribution against each closed
  // position's own cost; our fold realises against the account-wide WAC, so an
  // honest number is impossible. Not captured — never a fabricated rate.
  const perLot = 'win/loss needs per-lot realised attribution, which our average-cost ledger does not record';
  pushNotCaptured(out, 'M12', 'bp', perLot, facts);
  pushNotCaptured(out, 'M13', 'minor', perLot, facts);

  // M16: expected-at-plan slippage over the window's market legs.
  if (facts.hasSlippageData && facts.planSlippageBp !== null) {
    out.push({ metricId: 'M16', label: METRIC_LABELS.M16, status: 'ok', value: String(facts.planSlippageBp), unit: 'bp', approximate: false });
  } else {
    pushNotCaptured(out, 'M16', 'bp', 'no decision-mid slippage capture in this window', facts);
  }

  // M17: a fill rate needs per-order fill quantity (the child↔ledger link), not
  // recorded yet. A leg-outcome share would mislabel itself as a fill rate.
  pushNotCaptured(out, 'M17', 'bp', 'fill quantity is not linked to orders in our records yet', facts);

  // M18: unexplained deltas = unclassified external_adjustment rows. Zero is
  // truthful here — a count, not a performance claim.
  out.push({ metricId: 'M18', label: METRIC_LABELS.M18, status: 'ok', value: String(facts.unclassifiedAdjustments), unit: 'count', approximate: false });

  // M19: how many accounts in scope diverge from the capital they typed.
  out.push({ metricId: 'M19', label: METRIC_LABELS.M19, status: 'ok', value: String(facts.divergenceAccounts), unit: 'count', approximate: false });

  // M20: share of enabled accounts that took part, in bp.
  if (facts.participationBp !== null) {
    out.push({ metricId: 'M20', label: METRIC_LABELS.M20, status: 'ok', value: String(facts.participationBp), unit: 'bp', approximate: false });
  } else {
    pushNotCaptured(out, 'M20', 'bp', 'no group trade was planned in this window', facts);
  }

  // M22: average time from submit to completion over completed group trades.
  if (facts.completedTrades > 0) {
    out.push({ metricId: 'M22', label: METRIC_LABELS.M22, status: 'ok', value: String(Math.floor(facts.completionMs / facts.completedTrades)), unit: 'ms', approximate: false });
  } else {
    pushNotCaptured(out, 'M22', 'ms', 'no completed group trade in this window', facts);
  }

  return out;
}

// ------------------------------------------------------------------ windows
// The Indian financial year runs 1 April – 31 March, IST. All boundaries are
// epoch-ms; `toMs` is exclusive.

const IST_MS = (5 * 60 + 30) * 60_000;

/** [fromMs, toMs) of the Indian financial year containing `nowMs`. */
export function fyRangeInclusive(nowMs: number): { readonly fromMs: number; readonly toMs: number; readonly label: string } {
  const ist = nowMs + IST_MS;
  const d = new Date(ist);
  const y = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const fyStart = month >= 4 ? y : y - 1;
  const fromMs = Date.UTC(fyStart, 3, 1) - IST_MS;
  const toMs = Date.UTC(fyStart + 1, 3, 1) - IST_MS;
  return { fromMs, toMs, label: `${fyStart}-${String(fyStart + 1).slice(2)}` };
}

/** A human label for an arbitrary [fromMs, toMs) window. */
export function windowLabel(fromMs: number, toMs: number): string {
  const f = new Date(fromMs).toISOString().slice(0, 10);
  const t = new Date(toMs - 1).toISOString().slice(0, 10);
  return `${f} → ${t}`;
}
