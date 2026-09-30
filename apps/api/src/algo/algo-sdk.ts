// Strategy SDK runtime interfaces, market data helpers, and strategy templates.

import * as indicators from './algo-indicators.js';
import type { CandleData } from './algo-indicators.js';
import { getFuturesRtPrices, findRtPrice, normalizeFuturesPair } from '../futures/rt-prices.js';

export type { CandleData };

export interface AlgoPosition {
  readonly id: string;
  readonly accountId: string;
  readonly pair: string;
  readonly side: 'long' | 'short';
  readonly size: number;
  readonly entryPrice: number;
  readonly markPrice: number;
  readonly leverage: number;
  readonly unrealizedPnl: number;
  readonly marginCurrency: 'INR' | 'USDT';
}

export interface AlgoTradeOptions {
  readonly asset?: string | undefined;
  readonly pair?: string | undefined;
  readonly orderType?: 'market' | 'limit' | undefined;
  readonly limitPrice?: number | string | undefined;
  readonly sizingMode?: 'exact_qty' | 'exact_quote' | 'pct_basis' | 'pct_holding' | undefined;
  readonly size?: number | string | undefined;
  readonly percentBp?: number | undefined;
  readonly leverage?: number | string | undefined;
  readonly marginCurrency?: 'INR' | 'USDT' | undefined;
  readonly stopLossPrice?: number | string | undefined;
  readonly takeProfitPrice?: number | string | undefined;
  readonly trailingStopLoss?: boolean | undefined;
  readonly trailingDistanceBp?: number | undefined;
  readonly trailingStepBp?: number | undefined;
}

export interface AlgoTradeResult {
  readonly success: boolean;
  readonly orderId?: string | undefined;
  readonly groupTradeId?: string | undefined;
  readonly message?: string | undefined;
  readonly plannedCount?: number | undefined;
  readonly skippedCount?: number | undefined;
  readonly dryRun?: boolean | undefined;
  readonly price?: number | undefined;
  readonly quantity?: number | undefined;
}

export interface AlgoCloseResult {
  readonly success: boolean;
  readonly pair: string;
  readonly exitedCount: number;
  readonly message?: string | undefined;
}

export interface AlgoContext {
  readonly market: {
    readonly getPrice: (pair: string) => Promise<number>;
    readonly getCandles: (pair: string, timeframe?: string, limit?: number) => Promise<CandleData[]>;
  };
  readonly positions: {
    readonly get: (pair: string) => Promise<AlgoPosition | null>;
    readonly list: () => Promise<AlgoPosition[]>;
  };
  readonly account: {
    readonly getBalance: () => Promise<{ freeMargin: number; totalEquity: number; currency: string }>;
  };
  readonly indicators: typeof indicators;
  readonly trade: {
    readonly buy: (options: AlgoTradeOptions) => Promise<AlgoTradeResult>;
    readonly sell: (options: AlgoTradeOptions) => Promise<AlgoTradeResult>;
    readonly close: (pair: string) => Promise<AlgoCloseResult>;
    readonly closeAll: () => Promise<AlgoCloseResult[]>;
  };
  readonly log: (message: string, data?: unknown) => void;
  readonly params: Record<string, unknown>;
}

// In-memory cache for historical candle data to respect exchange rate limits
const candleCache = new Map<string, { data: CandleData[]; expiresAt: number }>();
const CANDLE_CACHE_TTL_MS = 15_000; // 15 seconds

/**
 * Fetch historical OHLCV candlestick data from CoinDCX.
 */
export async function fetchHistoricalCandles(
  pair: string,
  timeframe = '5m',
  limit = 100,
  baseUrl = 'https://public.coindcx.com',
): Promise<CandleData[]> {
  const normPair = normalizeFuturesPair(pair);
  const cacheKey = `${normPair}_${timeframe}_${limit}`;
  const now = Date.now();

  const cached = candleCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  let resolution = '5';
  let secondsPerCandle = 300;

  switch (timeframe.toLowerCase()) {
    case '1m':
    case '1':
      resolution = '1';
      secondsPerCandle = 60;
      break;
    case '5m':
    case '5':
      resolution = '5';
      secondsPerCandle = 300;
      break;
    case '15m':
    case '15':
      resolution = '15';
      secondsPerCandle = 900;
      break;
    case '30m':
    case '30':
      resolution = '30';
      secondsPerCandle = 1800;
      break;
    case '1h':
    case '60':
      resolution = '60';
      secondsPerCandle = 3600;
      break;
    case '4h':
    case '240':
      resolution = '240';
      secondsPerCandle = 14400;
      break;
    case '1d':
    case 'd':
      resolution = '1D';
      secondsPerCandle = 86400;
      break;
    default:
      resolution = '5';
      secondsPerCandle = 300;
  }

  const to = Math.floor(now / 1000);
  const from = to - Math.max(limit, 20) * secondsPerCandle;

  try {
    const url = `${baseUrl}/market_data/candlesticks?pair=${encodeURIComponent(normPair)}&from=${from}&to=${to}&resolution=${resolution}&pcode=f`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(6000),
    });

    if (!res.ok) {
      throw new Error(`CoinDCX candlesticks API responded with status ${res.status}`);
    }

    const json = (await res.json()) as { s?: string; data?: Array<{ open: number; high: number; low: number; close: number; volume: number; time: number }> };
    if (!json || !Array.isArray(json.data) || json.data.length === 0) {
      return [];
    }

    const candles: CandleData[] = json.data
      .map((c) => ({
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume),
        time: Number(c.time),
      }))
      .sort((a, b) => a.time - b.time);

    candleCache.set(cacheKey, { data: candles, expiresAt: now + CANDLE_CACHE_TTL_MS });
    return candles;
  } catch (err) {
    if (cached) return cached.data;
    console.warn(`[algo-sdk] failed to fetch candles for ${normPair}:`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Fetch latest price for a given futures pair.
 */
export async function fetchLatestPrice(pair: string): Promise<number> {
  const rtMap = await getFuturesRtPrices();
  const rt = findRtPrice(rtMap, pair);
  if (rt && rt.markPrice) {
    const p = parseFloat(rt.markPrice);
    if (!isNaN(p) && p > 0) return p;
  }
  if (rt && rt.lastPrice) {
    const p = parseFloat(rt.lastPrice);
    if (!isNaN(p) && p > 0) return p;
  }
  return 0;
}

export interface StrategyTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly pair: string;
  readonly timeframe: string;
  readonly scheduleInterval: '1m' | '5m' | '15m' | '1h';
  readonly defaultParams: Record<string, unknown>;
  readonly script: string;
}

export const STRATEGY_TEMPLATES: readonly StrategyTemplate[] = [
  {
    id: 'rsi_mean_reversion',
    name: 'RSI Dynamic Mean Reversion',
    description: 'Enters Long when RSI is oversold (< 30) and Short/Exit when RSI is overbought (> 70) with dynamic TP & SL.',
    pair: 'B-BTC_USDT',
    timeframe: '5m',
    scheduleInterval: '5m',
    defaultParams: {
      rsiPeriod: 14,
      oversold: 30,
      overbought: 70,
      leverage: 10,
      marginCurrency: 'USDT',
      sizePct: 10,
      takeProfitPct: 2.0,
      stopLossPct: 1.5,
    },
    script: `/**
 * RSI Mean Reversion Strategy
 * Buys when market is oversold and exits/shorts when overbought.
 */
export default async function run({ market, positions, account, indicators, trade, log, params }) {
  const pair = params.pair || "B-BTC_USDT";
  const timeframe = params.timeframe || "5m";
  const rsiPeriod = Number(params.rsiPeriod) || 14;
  const oversold = Number(params.oversold) || 30;
  const overbought = Number(params.overbought) || 70;
  const tpPct = Number(params.takeProfitPct) || 2.0;
  const slPct = Number(params.stopLossPct) || 1.5;

  log("Fetching candles and price for " + pair + " (" + timeframe + ")...");
  const candles = await market.getCandles(pair, timeframe, 100);
  if (!candles || candles.length < rsiPeriod + 2) {
    log("Insufficient candle data: " + (candles ? candles.length : 0));
    return;
  }

  const closes = candles.map(c => c.close);
  const rsiValues = indicators.rsi(closes, rsiPeriod);
  const currentRsi = rsiValues[rsiValues.length - 1];
  const currentPrice = await market.getPrice(pair);

  log("Current Price: " + currentPrice + " | RSI(" + rsiPeriod + "): " + (currentRsi ? currentRsi.toFixed(2) : "N/A"));

  if (currentRsi === null) return;

  const currentPos = await positions.get(pair);

  if (currentRsi < oversold) {
    if (!currentPos) {
      log("RSI oversold condition triggered: " + currentRsi.toFixed(2) + " < " + oversold + ". Opening LONG...");
      await trade.buy({
        pair: pair,
        orderType: "market",
        sizingMode: "pct_basis",
        percentBp: (Number(params.sizePct) || 10) * 100,
        leverage: Number(params.leverage) || 10,
        marginCurrency: params.marginCurrency || "USDT",
        takeProfitPrice: (currentPrice * (1 + tpPct / 100)).toFixed(2),
        stopLossPrice: (currentPrice * (1 - slPct / 100)).toFixed(2),
      });
    } else if (currentPos.side === "short") {
      log("RSI oversold: closing opposing short position...");
      await trade.close(pair);
    } else {
      log("Position already active (LONG). Holding.");
    }
  } else if (currentRsi > overbought) {
    if (currentPos && currentPos.side === "long") {
      log("RSI overbought condition triggered: " + currentRsi.toFixed(2) + " > " + overbought + ". Closing LONG...");
      await trade.close(pair);
    } else if (!currentPos) {
      log("RSI overbought: " + currentRsi.toFixed(2) + " > " + overbought + ". No open position to exit.");
    }
  } else {
    log("RSI in neutral zone (" + currentRsi.toFixed(2) + "). No action.");
  }
}
`,
  },
  {
    id: 'dual_ema_crossover',
    name: 'Dual EMA Trend Follower',
    description: 'Captures sustained market momentum using 9 EMA and 21 EMA crossover signals with trailing stop loss.',
    pair: 'B-ETH_USDT',
    timeframe: '15m',
    scheduleInterval: '15m',
    defaultParams: {
      fastEmaPeriod: 9,
      slowEmaPeriod: 21,
      leverage: 12,
      marginCurrency: 'USDT',
      sizePct: 15,
      trailingDistanceBp: 150,
      trailingStepBp: 30,
    },
    script: `/**
 * Dual EMA Trend Follower
 * Trades golden/death crosses with trailing protection.
 */
export default async function run({ market, positions, indicators, trade, log, params }) {
  const pair = params.pair || "B-ETH_USDT";
  const timeframe = params.timeframe || "15m";
  const fastPeriod = Number(params.fastEmaPeriod) || 9;
  const slowPeriod = Number(params.slowEmaPeriod) || 21;

  const candles = await market.getCandles(pair, timeframe, 120);
  if (!candles || candles.length < slowPeriod + 5) {
    log("Waiting for candle history...");
    return;
  }

  const closes = candles.map(c => c.close);
  const fastEma = indicators.ema(closes, fastPeriod);
  const slowEma = indicators.ema(closes, slowPeriod);

  const len = closes.length;
  const currFast = fastEma[len - 1];
  const currSlow = slowEma[len - 1];
  const prevFast = fastEma[len - 2];
  const prevSlow = slowEma[len - 2];

  log("Fast EMA(" + fastPeriod + "): " + currFast.toFixed(2) + " | Slow EMA(" + slowPeriod + "): " + currSlow.toFixed(2));

  const isBullishCross = prevFast <= prevSlow && currFast > currSlow;
  const isBearishCross = prevFast >= prevSlow && currFast < currSlow;

  const currentPos = await positions.get(pair);

  if (isBullishCross) {
    log("Bullish EMA crossover detected!");
    if (currentPos && currentPos.side === "short") {
      await trade.close(pair);
    }
    if (!currentPos || currentPos.side !== "long") {
      log("Entering LONG position with trailing stop...");
      await trade.buy({
        pair: pair,
        orderType: "market",
        sizingMode: "pct_basis",
        percentBp: (Number(params.sizePct) || 15) * 100,
        leverage: Number(params.leverage) || 12,
        marginCurrency: params.marginCurrency || "USDT",
        trailingStopLoss: true,
        trailingDistanceBp: Number(params.trailingDistanceBp) || 150,
        trailingStepBp: Number(params.trailingStepBp) || 30,
      });
    }
  } else if (isBearishCross) {
    log("Bearish EMA crossover detected!");
    if (currentPos && currentPos.side === "long") {
      log("Closing long position on trend reversal...");
      await trade.close(pair);
    }
  } else {
    log("Trend status: " + (currFast > currSlow ? "BULLISH" : "BEARISH") + " (No new crossover).");
  }
}
`,
  },
  {
    id: 'bollinger_breakout',
    name: 'Bollinger Bands Volatility Breakout',
    description: 'Detects volatility squeeze breakouts above upper band or below lower band with ATR-calculated risk stops.',
    pair: 'B-SOL_USDT',
    timeframe: '15m',
    scheduleInterval: '15m',
    defaultParams: {
      bbPeriod: 20,
      bbStdDev: 2,
      atrPeriod: 14,
      leverage: 8,
      marginCurrency: 'USDT',
      sizePct: 12,
    },
    script: `/**
 * Bollinger Bands Volatility Breakout
 */
export default async function run({ market, positions, indicators, trade, log, params }) {
  const pair = params.pair || "B-SOL_USDT";
  const timeframe = params.timeframe || "15m";
  const bbPeriod = Number(params.bbPeriod) || 20;
  const bbStdDev = Number(params.bbStdDev) || 2;
  const atrPeriod = Number(params.atrPeriod) || 14;

  const candles = await market.getCandles(pair, timeframe, 100);
  if (!candles || candles.length < bbPeriod + 5) {
    log("Insufficient data for Bollinger calculations");
    return;
  }

  const closes = candles.map(c => c.close);
  const bb = indicators.bollingerBands(closes, bbPeriod, bbStdDev);
  const atrValues = indicators.atr(candles, atrPeriod);

  const idx = closes.length - 1;
  const close = closes[idx];
  const upper = bb.upper[idx];
  const lower = bb.lower[idx];
  const middle = bb.middle[idx];
  const atr = atrValues[idx] || 1;

  log("Price: " + close + " | BB Upper: " + upper.toFixed(2) + " | Lower: " + lower.toFixed(2));

  const currentPos = await positions.get(pair);

  if (close > upper && (!currentPos || currentPos.side !== "long")) {
    log("Price broke ABOVE Upper Bollinger Band. Opening momentum LONG...");
    if (currentPos && currentPos.side === "short") {
      await trade.close(pair);
    }
    await trade.buy({
      pair: pair,
      orderType: "market",
      sizingMode: "pct_basis",
      percentBp: (Number(params.sizePct) || 12) * 100,
      leverage: Number(params.leverage) || 8,
      marginCurrency: params.marginCurrency || "USDT",
      takeProfitPrice: (close + atr * 3).toFixed(2),
      stopLossPrice: (close - atr * 1.5).toFixed(2),
    });
  } else if (close < lower && currentPos && currentPos.side === "long") {
    log("Price fell BELOW Lower Bollinger Band. Exiting position...");
    await trade.close(pair);
  } else if (currentPos && close < middle && currentPos.side === "long") {
    log("Price reverted below middle band. Securing profits...");
    await trade.close(pair);
  } else {
    log("Inside Bollinger Bands range. Monitoring.");
  }
}
`,
  },
  {
    id: 'supertrend_momentum',
    name: 'Supertrend Trend Follower',
    description: 'Enters in the direction of the ATR-based Supertrend line with adaptive trend stops.',
    pair: 'B-BTC_USDT',
    timeframe: '15m',
    scheduleInterval: '15m',
    defaultParams: {
      stPeriod: 10,
      stMultiplier: 3,
      leverage: 10,
      marginCurrency: 'USDT',
      sizePct: 15,
    },
    script: `/**
 * Supertrend Trend Following Strategy
 */
export default async function run({ market, positions, indicators, trade, log, params }) {
  const pair = params.pair || "B-BTC_USDT";
  const timeframe = params.timeframe || "15m";
  const period = Number(params.stPeriod) || 10;
  const multiplier = Number(params.stMultiplier) || 3;

  const candles = await market.getCandles(pair, timeframe, 80);
  if (!candles || candles.length < period + 5) {
    log("Loading Supertrend history...");
    return;
  }

  const st = indicators.supertrend(candles, period, multiplier);
  const len = candles.length;
  const currentTrend = st.trend[len - 1];
  const prevTrend = st.trend[len - 2];
  const stLevel = st.supertrend[len - 1];
  const currentPrice = candles[len - 1].close;

  log("Price: " + currentPrice + " | Trend: " + currentTrend + " | ST Level: " + stLevel.toFixed(2));

  const currentPos = await positions.get(pair);

  if (prevTrend === "down" && currentTrend === "up") {
    log("Supertrend flipped to BULLISH!");
    if (currentPos && currentPos.side === "short") {
      await trade.close(pair);
    }
    log("Entering LONG position...");
    await trade.buy({
      pair: pair,
      orderType: "market",
      sizingMode: "pct_basis",
      percentBp: (Number(params.sizePct) || 15) * 100,
      leverage: Number(params.leverage) || 10,
      marginCurrency: params.marginCurrency || "USDT",
      stopLossPrice: stLevel.toFixed(2),
    });
  } else if (prevTrend === "up" && currentTrend === "down") {
    log("Supertrend flipped to BEARISH!");
    if (currentPos && currentPos.side === "long") {
      log("Closing long position on trend flip...");
      await trade.close(pair);
    }
  } else {
    log("Supertrend continues in " + currentTrend + " trend.");
  }
}
`,
  },
  {
    id: 'grid_scalper',
    name: 'Grid DCA Range Scalper',
    description: 'Dollar-cost averaging range trader that accumulates positions at dips and takes target profit.',
    pair: 'B-ETH_USDT',
    timeframe: '5m',
    scheduleInterval: '5m',
    defaultParams: {
      dipThresholdPct: 1.2,
      profitTargetPct: 1.5,
      maxDcaSteps: 3,
      leverage: 5,
      marginCurrency: 'USDT',
      sizePct: 5,
    },
    script: `/**
 * Grid DCA Range Scalper
 */
export default async function run({ market, positions, trade, log, params }) {
  const pair = params.pair || "B-ETH_USDT";
  const dipPct = Number(params.dipThresholdPct) || 1.2;
  const tpPct = Number(params.profitTargetPct) || 1.5;

  const price = await market.getPrice(pair);
  log("Current Price: " + price);

  const currentPos = await positions.get(pair);

  if (!currentPos) {
    log("No active position in grid. Initializing entry...");
    await trade.buy({
      pair: pair,
      orderType: "market",
      sizingMode: "pct_basis",
      percentBp: (Number(params.sizePct) || 5) * 100,
      leverage: Number(params.leverage) || 5,
      marginCurrency: params.marginCurrency || "USDT",
      takeProfitPrice: (price * (1 + tpPct / 100)).toFixed(2),
      stopLossPrice: (price * (1 - dipPct * 3 / 100)).toFixed(2),
    });
  } else {
    const entry = currentPos.entryPrice;
    const diffPct = ((price - entry) / entry) * 100;
    log("Position active: Entry=" + entry + " | PnL=" + diffPct.toFixed(2) + "%");

    if (diffPct >= tpPct) {
      log("Profit target met (" + diffPct.toFixed(2) + "% >= " + tpPct + "%). Closing position...");
      await trade.close(pair);
    } else if (diffPct <= -dipPct) {
      log("Price dipped " + diffPct.toFixed(2) + "% below entry. Adding DCA level...");
      await trade.buy({
        pair: pair,
        orderType: "market",
        sizingMode: "pct_basis",
        percentBp: (Number(params.sizePct) || 5) * 100,
        leverage: Number(params.leverage) || 5,
        marginCurrency: params.marginCurrency || "USDT",
        takeProfitPrice: (price * (1 + tpPct / 100)).toFixed(2),
      });
    } else {
      log("Price within normal grid deviation (" + diffPct.toFixed(2) + "%). Holding.");
    }
  }
}
`,
  },
];
