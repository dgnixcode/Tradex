// Futures positions view — plan/phase-15 T15.8.
//
// This package lives OUTSIDE the §6a scan (checks/07-no-mark-to-market covers
// packages/{ledger,sizing}/src and apps/api/src). A futures position by
// definition carries mark price, unrealised PnL, and liquidation price; the
// spot ledger has none of those and must never grow them. Putting the view in
// its own package rather than smuggling a mark_price reference into an
// existing directory is the deliberate, reviewable seam.
//
// Pure. Reads shaped rows the caller assembled from `futures_position` (a
// mirror of the venue's REST answer) and returns a display object. No I/O,
// no clock, no imports beyond @tradex/money.

export type Quote = 'INR' | 'USDT';

export interface FuturesPositionRow {
  readonly accountId: string;
  readonly accountName: string;
  readonly pair: string;
  readonly marginCurrency: Quote;
  readonly venuePositionId: string;
  /** Signed base quantity — positive long, negative short, zero flat. */
  readonly activePos: string;
  readonly avgEntryPrice: string | null;
  readonly markPrice: string | null;
  readonly markObservedAtMs: number | null;
  readonly liquidationPrice: string | null;
  readonly leverage: string | null;
  readonly lockedMarginMinor: string | null;
  readonly stopLossTrigger: string | null;
  readonly takeProfitTrigger: string | null;
  readonly fundingRateBp: number | null;
  readonly settlementCurrencyAvgPrice?: string | null;
  readonly groupName?: string | null;
  readonly entryTimeMs?: number | null;
  readonly hideFromPositions?: boolean;
}

export interface FuturesPositionView {
  readonly venuePositionId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly groupName?: string | null;
  readonly hideFromPositions?: boolean;
  readonly pair: string;
  readonly marginCurrency: Quote;
  readonly side: 'long' | 'short' | 'flat';
  readonly quantity: string;
  readonly avgEntryPrice: string | null;
  readonly markPrice: string | null;
  readonly liquidationPrice: string | null;
  /** Unrealised PnL in quote minor units — signed. */
  readonly unrealisedPnlMinor: string | null;
  /** Distance from mark to liquidation, in bp of mark. Null when either is absent. */
  readonly liqBufferBp: number | null;
  readonly leverage: string | null;
  readonly lockedMarginMinor: string | null;
  readonly stopLossTrigger: string | null;
  readonly takeProfitTrigger: string | null;
  readonly fundingRateBp: number | null;
  readonly settlementCurrencyAvgPrice?: string | null;
  readonly markStaleForMs: number | null;
  readonly entryTimeMs?: number | null;
}

const parseDecimal = (s: string): { v: bigint; scale: number } => {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const whole = dot === -1 ? body : body.slice(0, dot);
  const frac = dot === -1 ? '' : body.slice(dot + 1);
  const v = BigInt((whole + frac) || '0');
  return { v: neg ? -v : v, scale: frac.length };
};

const align = (a: { v: bigint; scale: number }, b: { v: bigint; scale: number }): { av: bigint; bv: bigint; scale: number } => {
  if (a.scale === b.scale) return { av: a.v, bv: b.v, scale: a.scale };
  if (a.scale < b.scale) return { av: a.v * 10n ** BigInt(b.scale - a.scale), bv: b.v, scale: b.scale };
  return { av: a.v, bv: b.v * 10n ** BigInt(a.scale - b.scale), scale: a.scale };
};

const QUOTE_SCALE: Record<Quote, number> = { INR: 2, USDT: 8 };

/**
 * Compose the position view. Unrealised PnL = qty × (mark − avg_entry), in
 * quote minor units. Signed by convention: positive when the position is
 * profitable. Rendered as a plain integer string in quote minor.
 */
function unrealisedPnlMinor(row: FuturesPositionRow): string | null {
  if (row.markPrice === null || row.avgEntryPrice === null || row.activePos === '0') return null;
  const qty = parseDecimal(row.activePos);
  const mark = parseDecimal(row.markPrice);
  const entry = parseDecimal(row.avgEntryPrice);
  const { av: markV, bv: entryV, scale: priceScale } = align(mark, entry);
  const diff = markV - entryV; // at priceScale
  // qty is at qty.scale; multiply → scale = qty.scale + priceScale
  let raw = qty.v * diff;
  let combinedScale = qty.scale + priceScale;

  // For INR-margined positions on USDT-quoted contracts (e.g. B-ETH_USDT), convert USDT PnL to INR.
  // CoinDCX freezes the USDT->INR exchange rate at entry onto settlement_currency_avg_price (typically ~102).
  if (row.marginCurrency === 'INR' && (row.pair.endsWith('_USDT') || row.pair.includes('USDT'))) {
    const pegStr = row.settlementCurrencyAvgPrice && Number(row.settlementCurrencyAvgPrice) > 0
      ? row.settlementCurrencyAvgPrice
      : '100'; // fallback peg if not reported
    const peg = parseDecimal(pegStr);
    raw = raw * peg.v;
    combinedScale += peg.scale;
  }

  // Convert to quote-minor units (integer at quote scale).
  const target = QUOTE_SCALE[row.marginCurrency];
  if (combinedScale >= target) {
    // Floor toward negative infinity so a loss rounds against us.
    const div = 10n ** BigInt(combinedScale - target);
    const q = raw / div;
    return (raw < 0n && raw % div !== 0n ? q - 1n : q).toString();
  }
  return (raw * 10n ** BigInt(target - combinedScale)).toString();
}

/** Distance from mark to liquidation as bp of mark. Signed magnitude of |mark − liq| / mark. */
function liqBufferBp(row: FuturesPositionRow): number | null {
  if (row.markPrice === null || row.liquidationPrice === null || row.activePos === '0') return null;
  const mark = parseDecimal(row.markPrice);
  const liq = parseDecimal(row.liquidationPrice);
  const { av: markV, bv: liqV } = align(mark, liq);
  if (markV === 0n) return null;
  const diff = markV > liqV ? markV - liqV : liqV - markV;
  return Number((diff * 10_000n) / markV);
}

/** Present the row as a display view. Deterministic; no clock beyond `nowMs`. */
export function buildFuturesView(row: FuturesPositionRow, nowMs: number): FuturesPositionView {
  const quantity = row.activePos.startsWith('-') ? row.activePos.slice(1) : row.activePos;
  const side: 'long' | 'short' | 'flat' = row.activePos === '0' ? 'flat'
    : row.activePos.startsWith('-') ? 'short' : 'long';
  return {
    venuePositionId: row.venuePositionId,
    accountId: row.accountId,
    accountName: row.accountName,
    groupName: row.groupName ?? null,
    hideFromPositions: row.hideFromPositions ?? false,
    pair: row.pair,
    marginCurrency: row.marginCurrency,
    side,
    quantity,
    avgEntryPrice: row.avgEntryPrice,
    markPrice: row.markPrice,
    liquidationPrice: row.liquidationPrice,
    unrealisedPnlMinor: unrealisedPnlMinor(row),
    liqBufferBp: liqBufferBp(row),
    leverage: row.leverage,
    lockedMarginMinor: row.lockedMarginMinor,
    stopLossTrigger: row.stopLossTrigger,
    takeProfitTrigger: row.takeProfitTrigger,
    fundingRateBp: row.fundingRateBp,
    settlementCurrencyAvgPrice: row.settlementCurrencyAvgPrice ?? null,
    markStaleForMs: row.markObservedAtMs === null ? null : Math.max(0, nowMs - row.markObservedAtMs),
    entryTimeMs: row.entryTimeMs ?? null,
  };
}

export function buildFuturesViews(rows: readonly FuturesPositionRow[], nowMs: number): readonly FuturesPositionView[] {
  return rows.filter((r) => r.activePos !== '0').map((r) => buildFuturesView(r, nowMs));
}
