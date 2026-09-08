// The load-bearing assertion here is that the best bid is not the first key.
// It is asserted against the captured live B-BTC_USDT book, where the venue put
// 79746 first and the real best bid, 79749.99, third.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OrderBookError, bestAsk, bestBid, compareDecimals, mapOrderBook } from './order-book.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'checks', 'fixtures');
const load = (name: string): string => readFileSync(join(fixtures, `${name}.json`), 'utf8');

describe('decimal comparison, without arithmetic', () => {
  it('orders by value, not lexicographically', () => {
    // '9' > '10' as strings; the whole point is that it must not be.
    expect(compareDecimals('9', '10')).toBeLessThan(0);
    expect(compareDecimals('79750', '79749.99')).toBeGreaterThan(0);
    expect(compareDecimals('79746', '79749.99')).toBeLessThan(0);
  });

  it('treats trailing zeros and leading zeros as equal value', () => {
    expect(compareDecimals('7890000.0000000000', '7890000')).toBe(0);
    expect(compareDecimals('0.5', '00.50')).toBe(0);
    expect(compareDecimals('0', '0.000')).toBe(0);
  });

  it('stays exact past the range where a double would round', () => {
    // Both of these are the same double; only string comparison sees the gap.
    expect(compareDecimals('0.1000000000000000055511151231257827', '0.1')).toBeGreaterThan(0);
    expect(compareDecimals('9007199254740993', '9007199254740992')).toBeGreaterThan(0);
  });

  it('sorts a realistic ladder correctly', () => {
    const ladder = ['79750.7', '79746', '79750.01', '79762', '79750', '79749.99'];
    expect([...ladder].sort(compareDecimals))
      .toEqual(['79746', '79749.99', '79750', '79750.01', '79750.7', '79762']);
  });

  it('refuses input it cannot compare exactly', () => {
    for (const bad of ['1e-7', '-5', 'abc', '', '1.2.3']) {
      expect(() => compareDecimals(bad, '1'), bad).toThrow(OrderBookError);
    }
  });
});

describe('the live book, where key order lies', () => {
  it('does not take the first key as the best bid', () => {
    const raw = load('orderbook_btcusdt');
    const naive = Object.keys((JSON.parse(raw) as { bids: Record<string, string> }).bids)[0];
    const book = mapOrderBook(raw);

    expect(naive).toBe('79746'); // what the venue sent first
    expect(bestBid(book)?.price).toBe('79749.99'); // what is actually the best bid
    expect(bestBid(book)?.price).not.toBe(naive);
  });

  it('returns both sides sorted, each in its own direction', () => {
    const book = mapOrderBook(load('orderbook_btcusdt'));
    for (let i = 1; i < book.asks.length; i += 1) {
      expect(compareDecimals(book.asks[i]?.price ?? '0', book.asks[i - 1]?.price ?? '0')).toBeGreaterThan(0);
    }
    for (let i = 1; i < book.bids.length; i += 1) {
      expect(compareDecimals(book.bids[i]?.price ?? '0', book.bids[i - 1]?.price ?? '0')).toBeLessThan(0);
    }
  });

  it('keeps every price and quantity as the exact text the venue sent', () => {
    const book = mapOrderBook(load('orderbook_btcinr'));
    // Trailing zeros preserved: 7914357.7000000000, not 7914357.7.
    expect(bestAsk(book)?.price).toBe('7914357.7000000000');
    for (const level of [...book.asks, ...book.bids]) {
      expect(typeof level.price).toBe('string');
      expect(typeof level.quantity).toBe('string');
    }
  });

  it('reads both captured books without loss', () => {
    for (const name of ['orderbook_btcusdt', 'orderbook_btcinr']) {
      const book = mapOrderBook(load(name));
      expect(book.asks.length, name).toBe(50);
      expect(book.bids.length, name).toBe(50);
      expect(book.timestamp, name).toMatch(/^\d+$/);
      expect(compareDecimals(bestBid(book)?.price ?? '0', bestAsk(book)?.price ?? '0')).toBeLessThan(0);
    }
  });
});

describe('a book we cannot trust is refused, not priced against', () => {
  it('refuses a crossed book', () => {
    // A crossed snapshot is internally inconsistent. Sizing a market order
    // against it computes a price on the wrong side of the spread.
    const crossed = '{"timestamp":1,"asks":{"100":"1"},"bids":{"101":"1"}}';
    expect(() => mapOrderBook(crossed)).toThrow(/crossed book/);
  });

  it('refuses a book where bid equals ask', () => {
    expect(() => mapOrderBook('{"timestamp":1,"asks":{"100":"1"},"bids":{"100":"1"}}')).toThrow(/crossed book/);
  });

  it('accepts an empty side without inventing a level', () => {
    const book = mapOrderBook('{"timestamp":1,"asks":{},"bids":{"100":"1"}}');
    expect(bestAsk(book)).toBeNull();
    expect(bestBid(book)?.price).toBe('100');
  });

  it('drops zero-quantity levels rather than treating them as depth', () => {
    // Zero quantity is a deletion in the socket protocol; as depth it would
    // report a price that can absorb nothing.
    const book = mapOrderBook('{"timestamp":1,"asks":{"100":"0","101":"2","102":"0.000"},"bids":{}}');
    expect(book.asks.map((l) => l.price)).toEqual(['101']);
  });

  it('refuses a level whose price is not a plain decimal', () => {
    expect(() => mapOrderBook('{"timestamp":1,"asks":{"1e-7":"1"},"bids":{}}')).toThrow(/not a plain decimal/);
  });

  it('refuses a malformed envelope rather than returning an empty book', () => {
    expect(() => mapOrderBook('[]')).toThrow(/did not return an object/);
    expect(() => mapOrderBook('{"timestamp":1,"asks":[],"bids":{}}')).toThrow(/not an object of price/);
    expect(() => mapOrderBook('{"asks":{},"bids":{}}')).toThrow(/field timestamp is missing/);
  });
});
