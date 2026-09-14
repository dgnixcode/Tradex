// The operations package — plan/phase-13 T13.1/T13.3 (offline core).
//
// Pure, import-free, no clock: it takes READOUTS (numbers measured elsewhere and
// handed in) and decides which alerts fire, and it records latency samples into a
// histogram. Nothing here reads a database or calls a venue, so the whole alert
// catalogue can be exercised synthetically in a check — the "each alert fires"
// acceptance (T13.1) — and the histogram separates warm (reused connection) from
// cold samples (T13.3). Thresholds come from research/20 F2 verbatim.

export type AlertId =
  | 'A1' | 'A2' | 'A3' | 'A4' | 'A5' | 'A6' | 'A7' | 'A8' | 'A9'
  | 'A10' | 'A11' | 'A12' | 'A13' | 'A14' | 'A15' | 'A16' | 'A17' | 'A18'
  | 'A19' | 'A20' | 'A21';

export interface AlertDef {
  readonly id: AlertId;
  readonly title: string;
  readonly threshold: string;
}

export const ALERT_DEFS: readonly AlertDef[] = [
  { id: 'A1', title: 'Order failure rate', threshold: '>20% of child orders in a 5m window reach a non-fill terminal state, excluding pre-send skips' },
  { id: 'A2', title: 'Any needs_human order', threshold: 'count > 0' },
  { id: 'A3', title: 'Reconciler silent', threshold: 'no reconciliation progress for 3 consecutive cycles' },
  { id: 'A4', title: 'Reconciliation divergence', threshold: 'any unexplained balance delta above tolerance' },
  { id: 'A5', title: 'External activity detected', threshold: 'a fill with no matching client_order_id' },
  { id: 'A6', title: 'Abnormal decrypt rate', threshold: 'decrypts for one credential > 3× its 7-day p95' },
  { id: 'A7', title: 'Credential auth failures', threshold: '3 consecutive 401s on one credential' },
  { id: 'A8', title: 'Signature or timestamp error', threshold: 'any occurrence' },
  { id: 'A9', title: 'Rate-limit saturation', threshold: '429s > 1% of requests in 5m, or bucket depth < 10%' },
  { id: 'A10', title: 'Clock offset', threshold: 'NTP offset > 1 s on any signing host' },
  { id: 'A11', title: 'Job queue age', threshold: 'oldest unclaimed place job older than 10 s' },
  { id: 'A12', title: 'Socket dead-but-open', threshold: 'depth not advancing 60 s, or no candle x flip in 2 intervals' },
  { id: 'A13', title: 'Exchange 5xx cluster', threshold: '>10 5xx in 1 minute' },
  { id: 'A14', title: 'exit_only or market inactive', threshold: 'any subscribed market flips' },
  { id: 'A15', title: 'Unusual notional', threshold: 'a single group trade > 3× the tenant 30-day p95' },
  { id: 'A16', title: 'Kill switch engaged', threshold: 'any switch flipped, by anyone' },
  { id: 'A17', title: 'Worker lock reaped', threshold: 'reaper cleared a stale lock' },
  { id: 'A18', title: 'Ledger invariant violated', threshold: 'L2 fails on a periodic check' },
  { id: 'A19', title: 'Funding rate anomaly', threshold: 'funding rate exceeds 100 bp on any subscribed perp' },
  { id: 'A20', title: 'Liquidation imminent', threshold: 'a position sits within 200 bp of its liquidation price for >60 s' },
  { id: 'A21', title: 'Stale SL after exit', threshold: 'an untriggered SL exists on a pair with no active position for >30 s' },
];

/** The ten money-at-risk alerts that page at night (research/20 F2). */
export const PAGE_AT_NIGHT: ReadonlySet<AlertId> = new Set(['A1', 'A2', 'A3', 'A5', 'A6', 'A8', 'A10', 'A11', 'A15', 'A18', 'A20', 'A21']);

/**
 * The measured signals an alert is evaluated against. A `null` field means the
 * monitoring for it does not exist in this build — the alert is NOT evaluated and
 * never fires, because firing on the absence of monitoring would be a false page.
 */
export interface AlertReadouts {
  /** A1 — share of legs (0-100) in a 5m window that failed to fill. */
  readonly orderFailPct?: number | null;
  /** A2 — how many child orders are in needs_human/unknown. */
  readonly needsHuman?: number | null;
  /** A3 — consecutive reconciliation cycles with no progress. */
  readonly reconcilerSilentCycles?: number | null;
  /** A4 — an unexplained balance delta sits above the tolerance. */
  readonly divergenceAboveTolerance?: boolean | null;
  /** A5 — fills observed with no matching client_order_id. */
  readonly externalFillsNoCoid?: number | null;
  /** A6 — this credential's decrypt rate ÷ its own 7-day p95. */
  readonly decryptRateRatio?: number | null;
  /** A7 — consecutive 401s on one credential. */
  readonly credential401s?: number | null;
  /** A8 — signature or timestamp errors this window. */
  readonly signatureErrors?: number | null;
  /** A9 — share (0-100) of requests answered 429 in 5m. */
  readonly rateLimit429Pct?: number | null;
  /** A9 — the rate-limit bucket depth (0-100). */
  readonly rateBucketPct?: number | null;
  /** A10 — NTP offset in ms on any signing host. */
  readonly clockOffsetMs?: number | null;
  /** A11 — age in ms of the oldest unclaimed place job. */
  readonly oldestPlaceJobMs?: number | null;
  /** A12 — seconds the depth feed has been stalled. */
  readonly depthStalledSec?: number | null;
  /** A12 — the candle x flip did not happen in 2 intervals. */
  readonly candleStalled?: boolean | null;
  /** A13 — 5xx responses in the last minute. */
  readonly fivexxPerMin?: number | null;
  /** A14 — any subscribed market is exit_only / inactive. */
  readonly marketInactive?: boolean | null;
  /** A15 — a group trade's notional ÷ the tenant's own 30-day p95. */
  readonly groupNotionalRatio?: number | null;
  /** A16 — the global/account/market kill switch is engaged. */
  readonly killSwitchOn?: boolean | null;
  /** A17 — the reaper cleared a stale worker lock. */
  readonly workerLocksReaped?: number | null;
  /** A18 — the periodic ledger L2 invariant check found a violation. */
  readonly ledgerInvariantBroken?: boolean | null;
  /** A19 — funding rate on any subscribed perp, in bp (absolute value). */
  readonly maxFundingRateBp?: number | null;
  /** A20 — the tightest liquidation buffer across live positions, in bp. */
  readonly minLiquidationBufferBp?: number | null;
  /** A20 — how long the tightest buffer has been under 200 bp, in seconds. */
  readonly liquidationBufferUnderForSec?: number | null;
  /** A21 — untriggered SL orders on pairs whose position is flat. */
  readonly staleSlAfterExitFor?: number | null;
}

export interface FiredAlert {
  readonly id: AlertId;
  readonly reason: string;
  /** true = money-at-risk, pages at night. */
  readonly page: boolean;
}

const gte = (n: number | null | undefined, at: number): boolean => n !== null && n !== undefined && n >= at;
const gt = (n: number | null | undefined, at: number): boolean => n !== null && n !== undefined && n > at;
const is = (b: boolean | null | undefined): boolean => b === true;

/** Which alerts fire for a set of readouts. Empty readouts → no alert. */
export function evaluateAlerts(r: AlertReadouts): FiredAlert[] {
  const fired: FiredAlert[] = [];
  const push = (id: AlertId, reason: string): void => {
    fired.push({ id, reason, page: PAGE_AT_NIGHT.has(id) });
  };

  if (gt(r.orderFailPct, 20)) push('A1', `order failure rate ${r.orderFailPct}% > 20%`);
  if (gt(r.needsHuman, 0)) push('A2', `${r.needsHuman} order(s) stuck in needs_human`);
  if (gte(r.reconcilerSilentCycles, 3)) push('A3', `reconciler silent ${r.reconcilerSilentCycles} cycles`);
  if (is(r.divergenceAboveTolerance)) push('A4', 'unexplained balance delta above tolerance');
  if (gt(r.externalFillsNoCoid, 0)) push('A5', `${r.externalFillsNoCoid} fill(s) with no client_order_id`);
  if (gt(r.decryptRateRatio, 3)) push('A6', `decrypt rate ${r.decryptRateRatio}× its own p95`);
  if (gte(r.credential401s, 3)) push('A7', `${r.credential401s} consecutive 401s on one credential`);
  if (gt(r.signatureErrors, 0)) push('A8', `${r.signatureErrors} signature/timestamp error(s)`);
  if (gt(r.rateLimit429Pct, 1) || (r.rateBucketPct !== null && r.rateBucketPct !== undefined && r.rateBucketPct < 10)) {
    push('A9', `rate-limit saturated (429 ${r.rateLimit429Pct}% / bucket ${r.rateBucketPct}%)`);
  }
  if (gt(r.clockOffsetMs, 1000)) push('A10', `NTP offset ${r.clockOffsetMs}ms > 1s`);
  if (gt(r.oldestPlaceJobMs, 10_000)) push('A11', `oldest unclaimed place job ${Math.round((r.oldestPlaceJobMs ?? 0) / 1000)}s > 10s`);
  if (gt(r.depthStalledSec, 60) || is(r.candleStalled)) push('A12', 'depth feed stalled / candle not advancing');
  if (gt(r.fivexxPerMin, 10)) push('A13', `${r.fivexxPerMin} 5xx in the last minute`);
  if (is(r.marketInactive)) push('A14', 'a subscribed market is exit_only/inactive');
  if (gt(r.groupNotionalRatio, 3)) push('A15', `group trade notional ${r.groupNotionalRatio}× the tenant p95`);
  if (is(r.killSwitchOn)) push('A16', 'a kill switch is engaged');
  if (gt(r.workerLocksReaped, 0)) push('A17', `reaper cleared ${r.workerLocksReaped} stale lock(s)`);
  if (is(r.ledgerInvariantBroken)) push('A18', 'the ledger L2 invariant check failed');
  if (gt(r.maxFundingRateBp, 100)) push('A19', `funding rate ${r.maxFundingRateBp} bp exceeds 100 bp`);
  if (r.minLiquidationBufferBp !== null && r.minLiquidationBufferBp !== undefined
      && r.minLiquidationBufferBp < 200 && gt(r.liquidationBufferUnderForSec, 60)) {
    push('A20', `liquidation buffer ${r.minLiquidationBufferBp} bp for ${r.liquidationBufferUnderForSec}s`);
  }
  if (gt(r.staleSlAfterExitFor, 30)) push('A21', `an untriggered SL has outlived its position by ${r.staleSlAfterExitFor}s`);

  return fired;
}

// ------------------------------------------------------------------ latency

/** A latency histogram over recorded samples, with the percentiles T13.3 reads. */
export class LatencyHistogram {
  private readonly samples: number[] = [];
  private warmSamples = 0;
  private warmSumMs = 0;
  private coldSamples = 0;
  private coldSumMs = 0;

  add(ms: number, reusedConnection?: boolean | undefined): void {
    this.samples.push(ms);
    if (reusedConnection === true) {
      this.warmSamples += 1;
      this.warmSumMs += ms;
    } else if (reusedConnection === false) {
      this.coldSamples += 1;
      this.coldSumMs += ms;
    }
  }

  get count(): number { return this.samples.length; }

  mean(): number {
    return this.samples.length === 0 ? 0 : this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
  }

  /** The p-th percentile (0-100) of the recorded samples, interpolated simply. */
  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx] ?? 0;
  }

  meanWarmMs(): number {
    return this.warmSamples === 0 ? NaN : this.warmSumMs / this.warmSamples;
  }

  meanColdMs(): number {
    return this.coldSamples === 0 ? NaN : this.coldSumMs / this.coldSamples;
  }
}
