// Order book mapping — plan/phase-01 T01.1, the public read the pricing layer
// depends on. `09` established that the order book, not the ticker, is the price
// source, because the ticker is CDN-cached and its numbers can belong to an
// earlier request.
//
// The venue sends each side as a JSON OBJECT keyed by price, and the keys are
// NOT in price order. Live `B-BTC_USDT`, verbatim from the wire:
//
//   "bids":{"79746":"0.04293","79748":"0.05327","79749.99":"3.80312", ...
//
// The best bid is 79749.99 and it arrives third; the first key is 79746, which
// is 3.99 USDT worse. Integer-priced levels come first in ascending order, then
// fractional ones descending — the signature of a JS object whose integer-like
// keys V8 hoisted and sorted before it was ever serialised. The venue's bug is
// baked into the wire format, and any object we parse it into reproduces it.
//
// Consequence: reading entry 0 as the best price is wrong. It happens to be
// right on 3 of the 4 books captured, which is precisely what makes it dangerous
// — it would pass a spot check and misprice a market order later. Every read
// here sorts by numeric value, and comparison is done on the decimal strings
// rather than through Number(), because Number() is the same loss of precision
// that decimal-json.ts exists to avoid.

import type { DecimalJson } from './decimal-json.js';
import { JsonParseError, parseDecimalJson, requireScalar } from './decimal-json.js';

export class OrderBookError extends Error {
  override readonly name = 'OrderBookError';
}

export interface BookLevel {
  readonly price: string;
  readonly quantity: string;
}

export interface OrderBook {
  /** Venue timestamp, exact, as sent. Milliseconds on this endpoint. */
  readonly timestamp: string;
  /** Ascending by price. `asks[0]` is the best ask. */
  readonly asks: readonly BookLevel[];
  /** Descending by price. `bids[0]` is the best bid. */
  readonly bids: readonly BookLevel[];
}

/**
 * Compare two non-negative plain decimal strings exactly.
 *
 * Integer parts by length first (more digits is larger, once leading zeros are
 * gone), then lexicographically; fractions zero-padded to equal length and
 * compared the same way. No arithmetic, so an 18-digit price is compared as
 * accurately as a 2-digit one.
 */
export function compareDecimals(a: string, b: string): number {
  if (!/^\d+(\.\d+)?$/.test(a) || !/^\d+(\.\d+)?$/.test(b)) {
    throw new OrderBookError(`cannot compare ${a} and ${b}: both must be non-negative plain decimals`);
  }
  const [aWhole = '0', aFrac = ''] = a.split('.');
  const [bWhole = '0', bFrac = ''] = b.split('.');
  const ai = aWhole.replace(/^0+(?=\d)/, '');
  const bi = bWhole.replace(/^0+(?=\d)/, '');
  if (ai.length !== bi.length) return ai.length < bi.length ? -1 : 1;
  if (ai !== bi) return ai < bi ? -1 : 1;
  const width = Math.max(aFrac.length, bFrac.length);
  const af = aFrac.padEnd(width, '0');
  const bf = bFrac.padEnd(width, '0');
  if (af === bf) return 0;
  return af < bf ? -1 : 1;
}

function readSide(raw: DecimalJson, side: string): BookLevel[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new JsonParseError(`${side} is not an object of price -> quantity`);
  }
  const levels: BookLevel[] = [];
  for (const [price, quantity] of Object.entries(raw)) {
    if (typeof quantity !== 'string') {
      throw new JsonParseError(`${side} level ${price} has a non-scalar quantity`);
    }
    if (!/^\d+(\.\d+)?$/.test(price)) {
      throw new OrderBookError(`${side} level price ${price} is not a plain decimal`);
    }
    // A zero-quantity level is a deletion in the socket protocol and noise here.
    if (/^0+(\.0+)?$/.test(quantity)) continue;
    levels.push({ price, quantity });
  }
  return levels;
}

/**
 * Parse a `market_data/orderbook` response into sorted sides.
 *
 * Throws on a crossed book (best bid >= best ask). That is not a defensive
 * flourish: a crossed book means the snapshot is inconsistent, and sizing a
 * market order against it would compute a price on the wrong side of the spread.
 */
export function mapOrderBook(responseText: string): OrderBook {
  const parsed = parseDecimalJson(responseText);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JsonParseError('orderbook did not return an object');
  }
  const row = parsed as { [key: string]: DecimalJson };

  const asks = readSide(row['asks'] ?? null, 'asks').sort((x, y) => compareDecimals(x.price, y.price));
  const bids = readSide(row['bids'] ?? null, 'bids').sort((x, y) => compareDecimals(y.price, x.price));

  const bestAsk = asks[0];
  const bestBid = bids[0];
  if (bestAsk !== undefined && bestBid !== undefined && compareDecimals(bestBid.price, bestAsk.price) >= 0) {
    throw new OrderBookError(
      `crossed book: best bid ${bestBid.price} is not below best ask ${bestAsk.price} — the snapshot is inconsistent`,
    );
  }

  return { timestamp: requireScalar(row, 'timestamp'), asks, bids };
}

/** Best ask, or null on an empty side. Never `asks[0]` of an unsorted book. */
export const bestAsk = (book: OrderBook): BookLevel | null => book.asks[0] ?? null;
export const bestBid = (book: OrderBook): BookLevel | null => book.bids[0] ?? null;
