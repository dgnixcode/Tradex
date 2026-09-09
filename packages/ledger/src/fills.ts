// Fill decomposition — plan/phase-07 T07.3, the 11 F4 matrix.
//
// One venue fill → the ledger rows that record it. The matrix decides whether a
// TDS row exists (India, 2026): 0% on an INR market buy, 1% on an INR market
// sell, and 1% on BOTH legs of a C2C (USDT) trade. TDS rows are always
// `estimated = true` until a statement confirms them (11 F4).
//
//   INR buy  → asset leg + cash leg + fee             = 3 rows (no TDS)
//   C2C buy  → asset leg + cash leg + fee + tds       = 4 rows (TDS 1%)
//   INR sell → asset leg + cash leg + fee + tds       = 4 rows (TDS 1%)
//
// Entry fees are capitalised by the fold; exit fees reduce proceeds. TDS touches
// neither (L7) — the fold proves it, and this writer never puts TDS anywhere but
// its own row.

import { mul, scaledFromMinor } from '@tradex/money';
import type { Scaled, Scale } from '@tradex/money';
import type { LedgerRow } from './fold.js';
import { quoteScaleOf } from './fold.js';

export interface FillInput {
  readonly exchangeTradeId: string;
  readonly side: 'buy' | 'sell';
  readonly asset: string;
  readonly quote: 'INR' | 'USDT';
  /** Quantity of the asset, plain decimal (e.g. '0.0001'). */
  readonly qty: string;
  /** Quote per one asset, plain decimal. */
  readonly price: string;
  /** Fee in QUOTE minor units. */
  readonly feeMinor: string;
  /** Scale of the asset's quantity. Defaults to 8. */
  readonly assetScale?: Scale | undefined;
  readonly occurredAtMs: number;
  readonly seq: number;
}

/** Shift a plain decimal by `places` to the right of the point, as a bigint minor. */
function decToMinor(s: string, places: number): bigint {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const frac = dot === -1 ? '' : body.slice(dot + 1);
  const int = (dot === -1 ? body : body.slice(0, dot)) || '0';
  const padded = frac.padEnd(places, '0');
  const digits = int + padded;
  const v = BigInt(digits === '' ? '0' : digits);
  return neg ? -v : v;
}

export const TDS_BP_INR_SELL = 100; // 1%
export const TDS_BP_C2C = 100; // 1% on both legs

/** Notional of a fill in quote minor units, floored. */
export function notionalMinorOf(f: Pick<FillInput, 'qty' | 'price' | 'quote'>): bigint {
  const qs = quoteScaleOf(f.quote);
  const qty = scaledFromMinor(decToMinor(f.qty, 8), 8);
  const priceScaled = scaledFromMinor(decToMinor(f.price, pricePlaces(f.price)), pricePlaces(f.price) as Scale);
  const n = mul(qty, priceScaled, qs) as Scaled;
  return n.v;
}

const pricePlaces = (p: string): number => {
  const dot = p.indexOf('.');
  return dot === -1 ? 0 : p.length - dot - 1;
};

/**
 * The TDS basis points that apply to a fill: 1% on an INR sell, 1% on either
 * side of a C2C (USDT) trade, 0% on an INR buy.
 */
export function tdsBpOf(side: 'buy' | 'sell', quote: 'INR' | 'USDT'): number {
  if (quote === 'USDT') return TDS_BP_C2C;
  return side === 'sell' ? TDS_BP_INR_SELL : 0;
}

/** Decompose one fill into its ledger rows (3 or 4). */
export function decomposeFill(fill: FillInput): LedgerRow[] {
  const assetScale = fill.assetScale ?? 8;
  const qs = quoteScaleOf(fill.quote);
  const notional = notionalMinorOf(fill);
  const fee = BigInt(fill.feeMinor);

  const assetLeg: LedgerRow = {
    exchangeTradeId: fill.exchangeTradeId,
    kind: fill.side === 'buy' ? 'trade_buy' : 'trade_sell',
    asset: fill.asset,
    quoteAsset: fill.quote,
    deltaMinor: String(fill.side === 'buy' ? decToMinor(fill.qty, assetScale) : -decToMinor(fill.qty, assetScale)),
    scale: assetScale,
    price: fill.price,
    feeMinor: null,
    tdsMinor: null,
    occurredAtMs: fill.occurredAtMs,
    seq: fill.seq,
  };
  const cashLeg: LedgerRow = {
    exchangeTradeId: fill.exchangeTradeId,
    kind: fill.side === 'buy' ? 'trade_sell' : 'trade_buy',
    asset: fill.quote,
    quoteAsset: fill.quote,
    deltaMinor: String(fill.side === 'buy' ? -notional : notional),
    scale: qs,
    price: null,
    feeMinor: null,
    tdsMinor: null,
    occurredAtMs: fill.occurredAtMs,
    seq: fill.seq + 1,
  };
  const feeRow: LedgerRow = {
    exchangeTradeId: fill.exchangeTradeId,
    kind: 'fee',
    asset: fill.quote,
    quoteAsset: fill.quote,
    deltaMinor: '0',
    scale: qs,
    price: null,
    feeMinor: String(fee),
    tdsMinor: null,
    occurredAtMs: fill.occurredAtMs,
    seq: fill.seq + 2,
  };

  const rows: LedgerRow[] = [assetLeg, cashLeg, feeRow];
  const tdsBp = tdsBpOf(fill.side, fill.quote);
  if (tdsBp > 0) {
    const tdsMinor = (notional * BigInt(tdsBp)) / 10_000n;
    rows.push({
      exchangeTradeId: fill.exchangeTradeId,
      kind: 'tds',
      asset: fill.quote,
      quoteAsset: fill.quote,
      deltaMinor: '0',
      scale: qs,
      price: null,
      feeMinor: null,
      tdsMinor: String(tdsMinor),
      estimated: true,
      occurredAtMs: fill.occurredAtMs,
      seq: fill.seq + 3,
    });
  }
  return rows;
}
