// 12-metrics — plan/phase-12 T12.1: the metric module produces every number from
// injected facts (no IO), money metrics render per quote, and the honest subset
// rules hold — M12/M13/M17 are not_captured (no per-lot / fill backing), M16
// never renders 0 when no slippage data exists, and N3 badges exactly M6/M12/M13
// approximate when unclassified adjustments are present.

import { computeMetrics, fyRangeInclusive, METRIC_LABELS } from '../packages/metrics/dist/index.js';

const baseFacts = {
  quotes: ['INR', 'USDT'],
  allocatedMinorByQuote: { INR: '100000000', USDT: '0' },
  storedFreeMinorByQuote: { INR: '25000000', USDT: '0' },
  deployedCostMinorByQuote: { INR: '160000000', USDT: '0' },
  windowMinorByQuote: {
    INR: { realised: '10000000', feeDrag: '250000', tds: '100000' },
    USDT: { realised: '0', feeDrag: '0', tds: '0' },
  },
  hasSlippageData: false,
  planSlippageBp: null,
  unclassifiedAdjustments: 0,
  divergenceAccounts: 1,
  totalAccounts: 3,
  participationBp: null,
  completionMs: 0,
  completedTrades: 0,
};

const find = (rows, id, quote) => rows.find((r) => r.metricId === id && (quote === undefined || r.quoteAsset === quote));

export async function run(assert) {
  assert(METRIC_LABELS.M1 === 'Allocated capital', 'the metric labels table anchors the ids');

  const rows = computeMetrics(baseFacts);
  assert(rows.length === 20, `expected 20 metric rows (6 money × 2 quotes + 8 scalar), got ${rows.length}`);

  // Money metrics render once per quote, minor units, and equal the facts.
  const m6Inr = find(rows, 'M6', 'INR');
  const m6Usdt = find(rows, 'M6', 'USDT');
  assert(m6Inr?.status === 'ok' && m6Inr.value === '10000000' && m6Inr.unit === 'minor',
    `M6 INR must be the fold delta, got ${m6Inr?.value}`);
  assert(m6Usdt?.quoteAsset === 'USDT', 'M6 must render per quote even when the quote total is zero');
  assert(find(rows, 'M1', 'INR')?.value === '100000000', 'M1 must equal the allocated fact');
  assert(find(rows, 'M11', 'INR')?.value === '100000', 'M11 must equal the estimated TDS fact');

  // Honest subset: not_captured with a reason, never a bare zero.
  for (const id of ['M12', 'M13', 'M17']) {
    const row = find(rows, id);
    assert(row?.status === 'not_captured' && row.value === null && row.reason !== undefined && row.reason !== '',
      `${id} must be not_captured with a reason`);
  }
  const m16 = find(rows, 'M16');
  assert(m16?.status === 'not_captured' && m16.value === null,
    'M16 must be not_captured (never 0) when no slippage data exists in the window');
  const m22 = find(rows, 'M22');
  assert(m22?.status === 'not_captured' && m22.value === null, 'M22 must be not_captured with no completed trades');
  assert(find(rows, 'M18')?.value === '0', 'M18 is a count — zero is truthful here');

  // M16 becomes ok with the plan-time slippage when a window has market legs.
  const withSlippage = computeMetrics({ ...baseFacts, hasSlippageData: true, planSlippageBp: 5 });
  const m16ok = find(withSlippage, 'M16');
  assert(m16ok?.status === 'ok' && m16ok.value === '5' && m16ok.unit === 'bp', 'M16 must surface the expected slippage in bp');

  // M20 participation, in bp of the enabled accounts that took part.
  const withParticipation = computeMetrics({ ...baseFacts, participationBp: 6667 });
  assert(find(withParticipation, 'M20')?.value === '6667', 'M20 must be the participation share in bp');

  // N3: unclassified adjustments badge exactly M6/M12/M13, and nothing else.
  // M6 renders per quote, so compare the DISTINCT ids.
  const adjusted = computeMetrics({ ...baseFacts, unclassifiedAdjustments: 2 });
  const approximateIds = [...new Set(adjusted.filter((r) => r.approximate).map((r) => r.metricId))];
  const expected = new Set(['M6', 'M12', 'M13']);
  assert(approximateIds.length === expected.size && approximateIds.every((id) => expected.has(id)),
    `approximate must badge exactly M6/M12/M13, got ${approximateIds.join(',')}`);
  const clean = computeMetrics({ ...baseFacts });
  assert(clean.every((r) => r.approximate === false), 'no metric is approximate without unclassified adjustments');

  // The Indian financial-year window is 1 April → 31 March, IST, labelled YYYY-YY.
  const fy = fyRangeInclusive(Date.UTC(2026, 8, 20, 6, 0, 0)); // 20 Sep 2026, ~11:30 IST
  assert(fy.label === '2026-27', `FY label must be 2026-27, got ${fy.label}`);
  const apr = Date.UTC(2026, 3, 1);
  assert(fy.fromMs === apr - (5 * 60 + 30) * 60_000, 'the FY starts at 1 Apr IST');
  const days = (fy.toMs - fy.fromMs) / 86_400_000;
  assert(days === 365 || days === 366, `FY span must be a whole year, got ${days} days`);
}
