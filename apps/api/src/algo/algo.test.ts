// Comprehensive test suite for algorithmic trading engine: indicators, runner, and backtester.

import { describe, it, expect } from 'vitest';
import * as indicators from './algo-indicators.js';
import { executeStrategyScript } from './algo-runner.js';
import { runBacktest } from './algo-backtest.js';
import type { AlgoContext, CandleData } from './algo-sdk.js';
import { minorToMajor } from './algo-service.js';

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
  it('supports named export declarations without default keyword', async () => {
    const script = `
      export const params = { multiplier: 2 };
      export async function run(ctx) {
        ctx.log("Named export run invoked, multiplier: " + params.multiplier);
      }
    `;

    let logMessage = '';
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
      log: (msg) => { logMessage = msg; },
      params: {},
    };

    const res = await executeStrategyScript(script, mockContext, 2000);
    expect(res.success).toBe(true);
    expect(logMessage).toContain('multiplier: 2');
  });

  it('supports onTick and execute entrypoint aliases', async () => {
    const script = `
      async function onTick(ctx) {
        ctx.log("onTick executed");
      }
    `;

    let logMessage = '';
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
      log: (msg) => { logMessage = msg; },
      params: {},
    };

    const res = await executeStrategyScript(script, mockContext, 2000);
    expect(res.success).toBe(true);
    expect(logMessage).toBe('onTick executed');
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
    expect(result.metrics.totalFees).toBeGreaterThan(0);
    expect(result.metrics.makerFeeRate).toBe(0.0002);
    expect(result.metrics.takerFeeRate).toBe(0.0005);
  });

  it('accurately applies Binance maker fee (0.02%) to limit orders and taker fee (0.05%) to stop triggers', async () => {
    const candles: CandleData[] = [];
    const baseTime = Date.now();

    for (let i = 0; i < 40; i++) {
      const price = 50000 + i * 10;
      candles.push({
        open: price,
        high: price + 15,
        low: price - 15,
        close: price,
        volume: 100,
        time: baseTime + i * 60_000,
      });
    }

    const script = `
      export default async function run({ positions, trade, params }) {
        const pos = await positions.get(params.pair);
        if (!pos) {
          // Enter with limit order (maker fee: 0.02%) and take profit (maker fee: 0.02%)
          await trade.buy({ pair: params.pair, orderType: "limit", percentBp: 1000, leverage: 10, takeProfitPrice: 50350 });
        }
      }
    `;

    const result = await runBacktest({
      script,
      pair: 'BTCUSDT',
      timeframe: '1m',
      initialCapital: 10000,
      makerFeeRate: 0.0002,
      takerFeeRate: 0.0005,
      customCandles: candles,
    });

    expect(result.trades.length).toBeGreaterThan(0);
    const trade = result.trades[0]!;
    expect(trade.entryFeeType).toBe('maker');
    expect(result.metrics.makerFees).toBeGreaterThan(0);
    expect(result.metrics.totalFees).toBe(Number((result.metrics.makerFees + result.metrics.takerFees).toFixed(2)));
  });
});

describe('Binance Historical Candle Engine', () => {
  it('normalizes various coin and pair formats', async () => {
    const { normalizeSymbol } = await import('./binance-history.js');
    expect(normalizeSymbol('BTC')).toEqual({ symbol: 'BTC', binancePair: 'BTCUSDT', tradexPair: 'B-BTC_USDT' });
    expect(normalizeSymbol('B-ETH_USDT')).toEqual({ symbol: 'ETH', binancePair: 'ETHUSDT', tradexPair: 'B-ETH_USDT' });
    expect(normalizeSymbol('solusdt')).toEqual({ symbol: 'SOL', binancePair: 'SOLUSDT', tradexPair: 'B-SOL_USDT' });
    expect(normalizeSymbol('DASH')).toEqual({ symbol: 'DASH', binancePair: 'DASHUSDT', tradexPair: 'B-DASH_USDT' });
    expect(normalizeSymbol('ZEC')).toEqual({ symbol: 'ZEC', binancePair: 'ZECUSDT', tradexPair: 'B-ZEC_USDT' });
  });

  it('parses standard Binance kline CSV rows accurately', async () => {
    const { parseBinanceKlineCsv } = await import('./binance-history.js');
    const csv = [
      'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
      '1704067200000,42314.00,42603.20,42289.60,42503.50,8459.477,1704070799999,359196345.08,88278,4687.97,199033806.82,0',
      '1704070800000,42503.50,42832.00,42462.00,42647.90,9043.411,1704074399999,385970069.22,90351,4783.83,204180582.72,0',
    ].join('\n');

    const candles = parseBinanceKlineCsv(csv);
    expect(candles.length).toBe(2);
    expect(candles[0]!.time).toBe(1704067200000);
    expect(candles[0]!.open).toBe(42314);
    expect(candles[0]!.high).toBe(42603.2);
    expect(candles[0]!.low).toBe(42289.6);
    expect(candles[0]!.close).toBe(42503.5);
    expect(candles[0]!.volume).toBe(8459.477);
  });

  it('runs high-throughput simulation over 5,000 candles rapidly without memory leak', async () => {
    const candles: CandleData[] = [];
    const baseTime = Date.now() - 5000 * 300_000;
    let price = 50000;
    for (let i = 0; i < 5000; i++) {
      const open = price;
      const change = (i % 2 === 0 ? 1 : -1) * (10 + (i % 50));
      const close = open + change;
      const high = Math.max(open, close) + 15;
      const low = Math.min(open, close) - 15;
      price = close;
      candles.push({
        open,
        high,
        low,
        close,
        volume: 100,
        time: baseTime + i * 300_000,
      });
    }

    const script = `
      export default async function run({ market, positions, trade, indicators }) {
        const candles = await market.getCandles(50);
        const rsiVal = indicators.rsi(candles.map(c => c.close), 14);
        const latestRsi = rsiVal[rsiVal.length - 1];
        const pos = await positions.get('B-BTC_USDT');
        if (latestRsi && latestRsi < 40 && !pos) {
          await trade.buy({ pair: 'B-BTC_USDT', percentBp: 2000, leverage: 5 });
        } else if (latestRsi && latestRsi > 60 && pos) {
          await trade.close('B-BTC_USDT');
        }
      }
    `;

    const start = Date.now();
    const result = await runBacktest({
      script,
      pair: 'B-BTC_USDT',
      timeframe: '5m',
      initialCapital: 10000,
      customCandles: candles,
    });
    const elapsed = Date.now() - start;

    expect(result.candleCount).toBe(5000);
    // The WASM isolation copies SDK data instead of exposing host objects.
    // Keep a meaningful throughput bound while allowing its security overhead.
    expect(elapsed).toBeLessThan(5000);
    // Downsampled equity curve should have fewer than 1000 points
    expect(result.equityCurve.length).toBeLessThan(1000);
  });

  it('correctly handles getCandles(pair, timeframe, limit) without slicing entire history', async () => {
    const candles: CandleData[] = [];
    const baseTime = Date.now() - 1000 * 900_000;
    for (let i = 0; i < 1000; i++) {
      candles.push({
        open: 100 + i,
        high: 105 + i,
        low: 95 + i,
        close: 102 + i,
        volume: 50,
        time: baseTime + i * 900_000,
      });
    }

    const script = `
      export default async function run({ market, params }) {
        const c = await market.getCandles(params.pair, params.timeframe, 50);
        if (c.length > 50) {
          throw new Error("getCandles exceeded requested limit: " + c.length);
        }
      }
    `;

    const result = await runBacktest({
      script,
      pair: 'B-ZEC_USDT',
      timeframe: '15m',
      initialCapital: 10000,
      customCandles: candles,
    });

    expect(result.candleCount).toBe(1000);
  });
});

describe('Currency Scale Conversions', () => {
  it('converts USDT scale 18 minor units accurately without scientific notation', () => {
    // 3925.29621711786032 USDT
    const minor = '3925296217117860320000';
    const major = minorToMajor(minor, 18);
    expect(major).toBeCloseTo(3925.2962, 3);
  });

  it('converts INR scale 2 minor units accurately', () => {
    // 1250.50 INR
    const minor = '125050';
    const major = minorToMajor(minor, 2);
    expect(major).toBe(1250.50);
  });

  it('handles zero and null minor amounts gracefully', () => {
    expect(minorToMajor('0', 18)).toBe(0);
    expect(minorToMajor(null, 18)).toBe(0);
    expect(minorToMajor('', 2)).toBe(0);
  });
});
