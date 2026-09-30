// Comprehensive test suite for algorithmic trading engine: indicators, runner, and backtester.

import { describe, it, expect } from 'vitest';
import * as indicators from './algo-indicators.js';
import { executeStrategyScript } from './algo-runner.js';
import { runBacktest } from './algo-backtest.js';
import type { AlgoContext, CandleData } from './algo-sdk.js';

describe('Algo Indicators', () => {
  it('calculates SMA accurately', () => {
    const data = [10, 20, 30, 40, 50];
    const res = indicators.sma(data, 3);
    expect(res[0]).toBeNull();
    expect(res[1]).toBeNull();
    expect(res[2]).toBe(20); // (10+20+30)/3
    expect(res[3]).toBe(30); // (20+30+40)/3
    expect(res[4]).toBe(40); // (30+40+50)/3
  });

  it('calculates EMA with proper multiplier', () => {
    const data = [10, 20, 30, 40, 50];
    const res = indicators.ema(data, 3);
    expect(res[0]).toBeNull();
    expect(res[1]).toBeNull();
    expect(res[2]).toBe(20);
    // multiplier = 2 / (3 + 1) = 0.5. (40 - 20) * 0.5 + 20 = 30
    expect(res[3]).toBe(30);
    // (50 - 30) * 0.5 + 30 = 40
    expect(res[4]).toBe(40);
  });

  it('calculates RSI values between 0 and 100', () => {
    const prices = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84,
      46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.0, 46.03, 46.41,
    ];
    const res = indicators.rsi(prices, 14);
    expect(res[13]).toBeNull();
    const rsiVal = res[14];
    expect(rsiVal).not.toBeNull();
    expect(rsiVal!).toBeGreaterThan(0);
    expect(rsiVal!).toBeLessThan(100);
  });

  it('calculates Bollinger Bands with middle, upper, and lower bands', () => {
    const prices = [10, 11, 12, 11, 10, 11, 12, 13, 12, 11, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const bb = indicators.bollingerBands(prices, 5, 2);
    expect(bb.middle[4]).toBe(10.8);
    expect(bb.upper[4]!).toBeGreaterThan(bb.middle[4]!);
    expect(bb.lower[4]!).toBeLessThan(bb.middle[4]!);
  });

  it('calculates ATR correctly', () => {
    const candles = [
      { open: 10, high: 12, low: 9, close: 11, volume: 100, time: 1000 },
      { open: 11, high: 13, low: 10, close: 12, volume: 100, time: 2000 },
      { open: 12, high: 14, low: 11, close: 13, volume: 100, time: 3000 },
    ];
    const atr = indicators.atr(candles, 2);
    expect(atr[0]).toBeNull();
    expect(atr[1]).toBe(3); // tr1=3, tr2=3 -> avg=3
  });
});

describe('Algo Runner Sandbox', () => {
  it('executes a valid strategy script and logs output', async () => {
    const script = `
      export default async function run(ctx) {
        ctx.log("Strategy tick received");
        const price = await ctx.market.getPrice("B-BTC_USDT");
        ctx.log("Market price: " + price);
        if (price > 50000) {
          await ctx.trade.buy({ pair: "B-BTC_USDT", size: 1 });
        }
      }
    `;

    let buyCalled = false;
    const mockContext: AlgoContext = {
      market: {
        getPrice: async () => 60000,
        getCandles: async () => [],
      },
      positions: {
        get: async () => null,
        list: async () => [],
      },
      account: {
        getBalance: async () => ({ freeMargin: 10000, totalEquity: 10000, currency: 'USDT' }),
      },
      indicators,
      trade: {
        buy: async () => {
          buyCalled = true;
          return { success: true, price: 60000 };
        },
        sell: async () => ({ success: true }),
        close: async () => ({ success: true, pair: 'B-BTC_USDT', exitedCount: 1 }),
        closeAll: async () => [],
      },
      log: () => {},
      params: {},
    };

    const res = await executeStrategyScript(script, mockContext, 2000);
    expect(res.success).toBe(true);
    expect(buyCalled).toBe(true);
    expect(res.logs.some((l) => l.message.includes('Market price: 60000'))).toBe(true);
    expect(res.actionsTaken.length).toBe(1);
  });

  it('fails gracefully on script syntax or runtime errors', async () => {
    const badScript = `
      export default async function run(ctx) {
        throw new Error("Deliberate strategy runtime failure");
      }
    `;

    const mockContext: AlgoContext = {
      market: { getPrice: async () => 100, getCandles: async () => [] },
      positions: { get: async () => null, list: async () => [] },
      account: { getBalance: async () => ({ freeMargin: 0, totalEquity: 0, currency: 'USDT' }) },
      indicators,
      trade: {
        buy: async () => ({ success: true }),
        sell: async () => ({ success: true }),
        close: async () => ({ success: true, pair: '', exitedCount: 0 }),
        closeAll: async () => [],
      },
      log: () => {},
      params: {},
    };

    const res = await executeStrategyScript(badScript, mockContext, 2000);
    expect(res.success).toBe(false);
    expect(res.error).toContain('Deliberate strategy runtime failure');
  });
});

describe('Algo Backtesting', () => {
  it('simulates strategy over candlestick data and generates metrics', async () => {
    // Generate synthetic upward trending candles
    const candles: CandleData[] = [];
    let price = 50000;
    const now = Date.now();

    for (let i = 0; i < 60; i++) {
      const open = price;
      const change = (i % 3 === 0 ? -1 : 1) * (50 + i * 2);
      const close = open + change;
      const high = Math.max(open, close) + 20;
      const low = Math.min(open, close) - 20;
      price = close;

      candles.push({
        open,
        high,
        low,
        close,
        volume: 100,
        time: now + i * 300_000,
      });
    }

    const simpleStrategy = `
      export default async function run({ market, positions, trade, log, params }) {
        const pos = await positions.get(params.pair);
        const price = await market.getPrice(params.pair);
        if (!pos) {
          await trade.buy({ pair: params.pair, percentBp: 2000, leverage: 5 });
        }
      }
    `;

    const result = await runBacktest({
      script: simpleStrategy,
      pair: 'B-BTC_USDT',
      timeframe: '5m',
      initialCapital: 10000,
      customCandles: candles,
    });

    expect(result.candleCount).toBe(60);
    expect(result.metrics.initialCapital).toBe(10000);
    expect(result.equityCurve.length).toBeGreaterThan(30);
    expect(result.trades.length).toBeGreaterThan(0);
  });
});
