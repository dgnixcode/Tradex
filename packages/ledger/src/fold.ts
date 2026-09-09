// The ledger fold — plan/phase-07 T07.2, T07.4, pure (no I/O, no clock).
//
// Replays ledger_entry rows in (occurred_at, id) order into a per-asset holding:
// qty, weighted-average cost, realised P&L from OUR OWN fills, and the separate
// fee/TDS drag sums. Entry fees are capitalised into a buy's basis; exit fees
// reduce a sell's proceeds; TDS is in NEITHER (L7). A conversion moves quantity
// and basis with ZERO realised P&L (L8). No mark price, no unrealised value —
// the books, not a valuation (§6a).
//
// Rows are pre-decomposed (one row per leg). A fill's fee/TDS rows share its
// trade row's exchange_trade_id, so the fold GROUPS by that id first and attaches
// each fee/TDS to its own buy or sell before the running projection moves.
//
// ALL arithmetic is exact via @tradex/money, floor-only. Quantity is accumulated
// at a fixed asset scale (6); the cost share of a partial sell is an INTEGER
// floor — floor(costMinor · qtySell / qtyHeld) — and a full close resets cost to
// exactly zero, so L6 holds without drift.

import { add, mul, rescale, scaledFromMinor, sub } from '@tradex/money';
import type { Scaled, Scale } from '@tradex/money';

export type LedgerKind =
  | 'trade_buy' | 'trade_sell' | 'fee' | 'tds'
  | 'conversion_in' | 'conversion_out' | 'external_adjustment' | 'correction';

export interface LedgerRow {
  readonly exchangeTradeId: string | null;
  readonly kind: LedgerKind;
  readonly asset: string;
  readonly quoteAsset: string | null;
  /** Signed minor units of `asset`. */
  readonly deltaMinor: string;
  readonly scale: Scale;
  /** Quote per one asset, exact. */
  readonly price: string | null;
  readonly feeMinor: string | null;
  readonly tdsMinor: string | null;
  /** TDS rows are always estimated until a statement confirms them (11 F4). */
  readonly estimated?: boolean | undefined;
  readonly occurredAtMs: number;
  readonly seq: number;
}

export interface Holding {
  readonly asset: string;
  readonly quoteAsset: string;
  /** Exact quantity, plain decimal. */
  readonly qty: string;
  /** Weighted-average cost basis, quote minor units. */
  readonly costTotalMinor: string;
  /** Realised P&L, quote minor units (net of exit fees). */
  readonly realisedMinor: string;
  /** Cumulative exit-fee drag, quote minor units. */
  readonly feeDragMinor: string;
  /** Cumulative TDS withheld, quote minor units. */
  readonly tdsWithheldMinor: string;
}

export const quoteScaleOf = (q: string): Scale => (q === 'INR' ? 2 : 8);

/** Quantity is accumulated at this fixed asset scale internally (money-ladder-safe). */
const QTY_SCALE = 6 as Scale;

/** Plain-decimal string with trailing zeros trimmed. */
function plain(a: Scaled): string {
  const neg = a.v < 0n;
  const digits = (neg ? -a.v : a.v).toString().padStart(a.scale + 1, '0');
  if (a.scale === 0) return `${neg ? '-' : ''}${digits}`;
  const whole = digits.slice(0, -a.scale);
  const frac = digits.slice(-a.scale).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}

/** Parse a plain decimal into a Scaled at its literal scale (widened to 18 at most). */
function natDec(s: string): Scaled {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const places = dot === -1 ? 0 : body.length - dot - 1;
  const scale: Scale = (places <= 10 ? places : 18) as Scale;
  const v = BigInt(body.replace('.', ''));
  return { v: neg ? -v : v, scale };
}

interface Acc {
  qty: Scaled; // at QTY_SCALE
  cost: Scaled; // at quote scale
  realised: Scaled;
  feeDrag: Scaled;
  tds: Scaled;
  quote: string;
  qs: Scale;
}

const zeroQty = (): Scaled => ({ v: 0n, scale: QTY_SCALE });
const zeroAt = (s: Scale): Scaled => ({ v: 0n, scale: s });

function accFor(accs: Map<string, Acc>, asset: string, quote: string): Acc {
  let a = accs.get(asset);
  if (a === undefined) {
    const qs = quoteScaleOf(quote);
    a = { qty: zeroQty(), cost: zeroAt(qs), realised: zeroAt(qs), feeDrag: zeroAt(qs), tds: zeroAt(qs), quote, qs };
    accs.set(asset, a);
  }
  return a;
}

const TRADE_KINDS: ReadonlySet<LedgerKind> = new Set(['trade_buy', 'trade_sell', 'conversion_in', 'conversion_out']);

/** The cost basis attributable to a quantity sold, floored as an integer. */
function costShare(a: Acc, qtySell: bigint, held: bigint): bigint {
  if (held <= 0n) return 0n;
  return (a.cost.v * qtySell) / held;
}

export function foldLedger(rows: readonly LedgerRow[]): readonly Holding[] {
  const ordered = [...rows].sort((x, y) =>
    x.occurredAtMs === y.occurredAtMs ? x.seq - y.seq : x.occurredAtMs - y.occurredAtMs);

  const byFill = new Map<string, LedgerRow[]>();
  const order: string[] = [];
  for (const row of ordered) {
    const key = row.exchangeTradeId ?? `${row.occurredAtMs}:${row.seq}`;
    if (!byFill.has(key)) order.push(key);
    const list = byFill.get(key) ?? [];
    list.push(row);
    byFill.set(key, list);
  }

  const accs = new Map<string, Acc>();
  const assetOrder: string[] = [];
  const seen = new Set<string>();

  for (const key of order) {
    const group = byFill.get(key) ?? [];
    const trade = group.find((r) => TRADE_KINDS.has(r.kind));
    if (trade === undefined) continue;
    // A fill's CASH leg (asset === quote) carries the currency movement; the fold
    // tracks crypto holdings, not the cash it paid or received, so skip it here.
    if (trade.asset === trade.quoteAsset) continue;
    const quote = trade.quoteAsset ?? 'INR';
    const a = accFor(accs, trade.asset, quote);
    if (!seen.has(trade.asset)) { seen.add(trade.asset); assetOrder.push(trade.asset); }

    const price = trade.price !== null && trade.price !== '' ? natDec(trade.price) : null;
    const qtySigned = scaledFromMinor(trade.deltaMinor, trade.scale);
    const fee = scaledFromMinor(group.find((r) => r.kind === 'fee')?.feeMinor ?? '0', a.qs);
    const tds = scaledFromMinor(group.find((r) => r.kind === 'tds')?.tdsMinor ?? '0', a.qs);
    a.tds = add(a.tds, tds); // scale-safe: both quote minor
    if (price === null) continue;

    if (trade.kind === 'trade_buy' || trade.kind === 'conversion_in') {
      const val = mul(qtySigned, price, a.qs);
      a.qty = add(a.qty, rescale(qtySigned, QTY_SCALE));
      a.cost = add(a.cost, add(val, fee)); // entry fee capitalised; TDS is not
      continue;
    }

    // Sell or conversion-out. qty leaves; qtySell >= 0.
    const absQty = qtySigned.v < 0n ? { v: -qtySigned.v, scale: qtySigned.scale } : qtySigned;
    const qtySell = rescale(absQty, QTY_SCALE);
    const qtySellBig = qtySell.v;
    const heldBig = a.qty.v;
    if (qtySellBig > heldBig) continue; // defensively ignore an over-sell

    if (trade.kind === 'conversion_out') {
      const costOut = costShare(a, qtySellBig, heldBig);
      a.qty = sub(a.qty, qtySell);
      a.cost = sub(a.cost, { v: costOut, scale: a.qs }); // realised stays ZERO (L8)
      continue;
    }

    // A real sell.
    const proceeds = mul(qtySell, price, a.qs);
    const costOut = costShare(a, qtySellBig, heldBig);
    a.feeDrag = add(a.feeDrag, fee); // exit fee reduces proceeds (drag recorded separately)
    const net = sub(sub(proceeds, { v: costOut, scale: a.qs }), fee); // TDS never here
    a.realised = add(a.realised, net);

    a.qty = sub(a.qty, qtySell);
    if (a.qty.v === 0n) {
      a.cost = zeroAt(a.qs); // fully closed → cost resets to zero (L6)
    } else {
      a.cost = sub(a.cost, { v: costOut, scale: a.qs });
    }
  }

  return assetOrder.map((asset) => {
    const a = accs.get(asset) as Acc;
    return {
      asset,
      quoteAsset: a.quote,
      qty: plain(a.qty),
      costTotalMinor: String(a.cost.v),
      realisedMinor: String(a.realised.v),
      feeDragMinor: String(a.feeDrag.v),
      tdsWithheldMinor: String(a.tds.v),
    };
  });
}
