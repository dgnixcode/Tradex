// Historical backtesting simulator for algorithmic trading strategies.

import * as indicators from './algo-indicators.js';
import type { CandleData } from './algo-indicators.js';
import { fetchHistoricalCandles } from './algo-sdk.js';
import type { AlgoPosition, AlgoTradeOptions } from './algo-sdk.js';
import { executeStrategyScript } from './algo-runner.js';

export interface BacktestTrade {
  readonly id: string;
  readonly pair: string;
  readonly side: 'long' | 'short';
  readonly entryTime: number;
  readonly exitTime: number;
  readonly entryPrice: number;
  readonly exitPrice: number;
  readonly leverage: number;
  readonly size: number;
  readonly notional: number;
  readonly pnl: number;
  readonly pnlPct: number;
  readonly exitReason: 'take_profit' | 'stop_loss' | 'signal_close' | 'end_of_data';
}

export interface EquityPoint {
  readonly time: number;
  readonly price: number;
  readonly equity: number;
  readonly drawdownPct: number;
}

export interface BacktestMetrics {
  readonly initialCapital: number;
  readonly finalCapital: number;
  readonly netProfit: number;
  readonly netProfitPct: number;
  readonly totalTrades: number;
  readonly winningTrades: number;
  readonly losingTrades: number;
  readonly winRatePct: number;
  readonly profitFactor: number;
  readonly maxDrawdownPct: number;
  readonly sharpeRatio: number;
  readonly avgTradeDurationMinutes: number;
}

export interface BacktestResult {
  readonly pair: string;
  readonly timeframe: string;
  readonly candleCount: number;
  readonly metrics: BacktestMetrics;
  readonly equityCurve: readonly EquityPoint[];
  readonly trades: readonly BacktestTrade[];
  readonly logs: readonly string[];
}

export interface RunBacktestOptions {
  readonly script: string;
  readonly pair: string;
  readonly timeframe?: string | undefined;
  readonly initialCapital?: number | undefined;
  readonly candleLimit?: number | undefined;
  readonly params?: Record<string, unknown> | undefined;
  readonly customCandles?: readonly CandleData[] | undefined;
}

interface SimulatedPosition {
  readonly id: string;
  readonly side: 'long' | 'short';
  readonly entryPrice: number;
  readonly entryTime: number;
  readonly leverage: number;
  readonly size: number;
  readonly notional: number;
  readonly marginUsed: number;
  readonly takeProfitPrice: number | null;
  readonly stopLossPrice: number | null;
}

interface SimState {
  equity: number;
  currentPos: SimulatedPosition | null;
}

/**
 * Run historical backtest on candlestick data.
 */
export async function runBacktest(options: RunBacktestOptions): Promise<BacktestResult> {
  const pair = options.pair;
  const timeframe = options.timeframe ?? '5m';
  const initialCapital = options.initialCapital ?? 10_000;
  const candleLimit = options.candleLimit ?? 300;
  const params = { ...(options.params ?? {}), pair, timeframe };

  const candles = options.customCandles && options.customCandles.length > 0
    ? [...options.customCandles]
    : await fetchHistoricalCandles(pair, timeframe, candleLimit);

  if (candles.length < 25) {
    throw new Error(`Insufficient historical candles for backtesting (${candles.length} available, minimum 25 required)`);
  }

  const sim: SimState = {
    equity: initialCapital,
    currentPos: null,
  };

  let peakEquity = initialCapital;
  let maxDrawdown = 0;

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const logs: string[] = [];

  const minWarmup = 20;

  for (let i = minWarmup; i < candles.length; i++) {
    const candle = candles[i]!;
    const candleSlice = candles.slice(0, i + 1);

    // 1. Check TP/SL triggers against high/low of current candle
    if (sim.currentPos) {
      const active: SimulatedPosition = sim.currentPos;
      let exitPrice: number | null = null;
      let exitReason: BacktestTrade['exitReason'] | null = null;

      if (active.side === 'long') {
        if (active.takeProfitPrice !== null && candle.high >= active.takeProfitPrice) {
          exitPrice = active.takeProfitPrice;
          exitReason = 'take_profit';
        } else if (active.stopLossPrice !== null && candle.low <= active.stopLossPrice) {
          exitPrice = active.stopLossPrice;
          exitReason = 'stop_loss';
        }
      } else {
        if (active.takeProfitPrice !== null && candle.low <= active.takeProfitPrice) {
          exitPrice = active.takeProfitPrice;
          exitReason = 'take_profit';
        } else if (active.stopLossPrice !== null && candle.high >= active.stopLossPrice) {
          exitPrice = active.stopLossPrice;
          exitReason = 'stop_loss';
        }
      }

      if (exitPrice !== null && exitReason !== null) {
        const rawPnl = active.side === 'long'
          ? (exitPrice - active.entryPrice) * active.size
          : (active.entryPrice - exitPrice) * active.size;

        const fee = active.notional * 0.0005 + (exitPrice * active.size) * 0.0005;
        const netPnl = rawPnl - fee;
        const pnlPct = (netPnl / active.marginUsed) * 100;

        sim.equity += netPnl;

        trades.push({
          id: active.id,
          pair,
          side: active.side,
          entryTime: active.entryTime,
          exitTime: candle.time,
          entryPrice: active.entryPrice,
          exitPrice,
          leverage: active.leverage,
          size: active.size,
          notional: active.notional,
          pnl: Number(netPnl.toFixed(4)),
          pnlPct: Number(pnlPct.toFixed(2)),
          exitReason,
        });

        sim.currentPos = null;
      }
    }

    // 2. Build mock execution context for current candle
    const simulatedContext = {
      market: {
        getPrice: async () => candle.close,
        getCandles: async () => candleSlice,
      },
      positions: {
        get: async (p: string) => {
          if (p !== pair || !sim.currentPos) return null;
          const pos = sim.currentPos;
          const unrealized = pos.side === 'long'
            ? (candle.close - pos.entryPrice) * pos.size
            : (pos.entryPrice - candle.close) * pos.size;
          return {
            id: pos.id,
            accountId: 'sim-account',
            pair,
            side: pos.side,
            size: pos.size,
            entryPrice: pos.entryPrice,
            markPrice: candle.close,
            leverage: pos.leverage,
            unrealizedPnl: unrealized,
            marginCurrency: 'USDT' as const,
          } as AlgoPosition;
        },
        list: async () => {
          const pos = await simulatedContext.positions.get(pair);
          return pos ? [pos] : [];
        },
      },
      account: {
        getBalance: async () => ({
          freeMargin: Math.max(0, sim.equity - (sim.currentPos?.marginUsed ?? 0)),
          totalEquity: sim.equity,
          currency: 'USDT',
        }),
      },
      indicators,
      trade: {
        buy: async (opts: AlgoTradeOptions) => {
          if (sim.currentPos && sim.currentPos.side === 'short') {
            const shortPos = sim.currentPos;
            const rawPnl = (shortPos.entryPrice - candle.close) * shortPos.size;
            const fee = shortPos.notional * 0.0005 + (candle.close * shortPos.size) * 0.0005;
            const netPnl = rawPnl - fee;
            const pnlPct = (netPnl / shortPos.marginUsed) * 100;
            sim.equity += netPnl;
            trades.push({
              id: shortPos.id,
              pair,
              side: 'short',
              entryTime: shortPos.entryTime,
              exitTime: candle.time,
              entryPrice: shortPos.entryPrice,
              exitPrice: candle.close,
              leverage: shortPos.leverage,
              size: shortPos.size,
              notional: shortPos.notional,
              pnl: Number(netPnl.toFixed(4)),
              pnlPct: Number(pnlPct.toFixed(2)),
              exitReason: 'signal_close',
            });
            sim.currentPos = null;
          }

          if (!sim.currentPos) {
            const lev = Number(opts.leverage) || 10;
            const allocPct = (opts.percentBp ?? 1000) / 10000;
            const margin = Math.max(10, sim.equity * allocPct);
            const notional = margin * lev;
            const size = notional / candle.close;

            sim.currentPos = {
              id: `sim-order-${i}`,
              side: 'long',
              entryPrice: candle.close,
              entryTime: candle.time,
              leverage: lev,
              size,
              notional,
              marginUsed: margin,
              takeProfitPrice: opts.takeProfitPrice ? Number(opts.takeProfitPrice) : null,
              stopLossPrice: opts.stopLossPrice ? Number(opts.stopLossPrice) : null,
            };
          }

          const currentSize = sim.currentPos ? sim.currentPos.size : 0;
          return { success: true, price: candle.close, quantity: currentSize };
        },
        sell: async (opts: AlgoTradeOptions) => {
          if (sim.currentPos && sim.currentPos.side === 'long') {
            const longPos = sim.currentPos;
            const rawPnl = (candle.close - longPos.entryPrice) * longPos.size;
            const fee = longPos.notional * 0.0005 + (candle.close * longPos.size) * 0.0005;
            const netPnl = rawPnl - fee;
            const pnlPct = (netPnl / longPos.marginUsed) * 100;
            sim.equity += netPnl;
            trades.push({
              id: longPos.id,
              pair,
              side: 'long',
              entryTime: longPos.entryTime,
              exitTime: candle.time,
              entryPrice: longPos.entryPrice,
              exitPrice: candle.close,
              leverage: longPos.leverage,
              size: longPos.size,
              notional: longPos.notional,
              pnl: Number(netPnl.toFixed(4)),
              pnlPct: Number(pnlPct.toFixed(2)),
              exitReason: 'signal_close',
            });
            sim.currentPos = null;
          }

          if (!sim.currentPos) {
            const lev = Number(opts.leverage) || 10;
            const allocPct = (opts.percentBp ?? 1000) / 10000;
            const margin = Math.max(10, sim.equity * allocPct);
            const notional = margin * lev;
            const size = notional / candle.close;

            sim.currentPos = {
              id: `sim-order-${i}`,
              side: 'short',
              entryPrice: candle.close,
              entryTime: candle.time,
              leverage: lev,
              size,
              notional,
              marginUsed: margin,
              takeProfitPrice: opts.takeProfitPrice ? Number(opts.takeProfitPrice) : null,
              stopLossPrice: opts.stopLossPrice ? Number(opts.stopLossPrice) : null,
            };
          }

          const currentSize = sim.currentPos ? sim.currentPos.size : 0;
          return { success: true, price: candle.close, quantity: currentSize };
        },
        close: async () => {
          if (sim.currentPos) {
            const pos = sim.currentPos;
            const rawPnl = pos.side === 'long'
              ? (candle.close - pos.entryPrice) * pos.size
              : (pos.entryPrice - candle.close) * pos.size;
            const fee = pos.notional * 0.0005 + (candle.close * pos.size) * 0.0005;
            const netPnl = rawPnl - fee;
            const pnlPct = (netPnl / pos.marginUsed) * 100;
            sim.equity += netPnl;
            trades.push({
              id: pos.id,
              pair,
              side: pos.side,
              entryTime: pos.entryTime,
              exitTime: candle.time,
              entryPrice: pos.entryPrice,
              exitPrice: candle.close,
              leverage: pos.leverage,
              size: pos.size,
              notional: pos.notional,
              pnl: Number(netPnl.toFixed(4)),
              pnlPct: Number(pnlPct.toFixed(2)),
              exitReason: 'signal_close',
            });
            sim.currentPos = null;
            return { success: true, pair, exitedCount: 1 };
          }
          return { success: true, pair, exitedCount: 0 };
        },
        closeAll: async () => {
          const res = await simulatedContext.trade.close();
          return [res];
        },
      },
      log: (msg: string) => {
        if (logs.length < 50) logs.push(`[${new Date(candle.time).toISOString()}] ${msg}`);
      },
      params,
    };

    // 3. Execute strategy script for current candle
    await executeStrategyScript(options.script, simulatedContext, 3000);

    // 4. Record equity curve snapshot
    let currentMarkEquity = sim.equity;
    if (sim.currentPos) {
      const pos = sim.currentPos;
      const unrealized = pos.side === 'long'
        ? (candle.close - pos.entryPrice) * pos.size
        : (pos.entryPrice - candle.close) * pos.size;
      currentMarkEquity += unrealized;
    }

    if (currentMarkEquity > peakEquity) peakEquity = currentMarkEquity;
    const dd = peakEquity > 0 ? ((peakEquity - currentMarkEquity) / peakEquity) * 100 : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;

    equityCurve.push({
      time: candle.time,
      price: candle.close,
      equity: Number(currentMarkEquity.toFixed(2)),
      drawdownPct: Number(dd.toFixed(2)),
    });
  }

  // Close any trailing position at final candle close
  if (sim.currentPos && candles.length > 0) {
    const pos = sim.currentPos;
    const finalCandle = candles[candles.length - 1]!;
    const rawPnl = pos.side === 'long'
      ? (finalCandle.close - pos.entryPrice) * pos.size
      : (pos.entryPrice - finalCandle.close) * pos.size;
    const fee = pos.notional * 0.0005 + (finalCandle.close * pos.size) * 0.0005;
    const netPnl = rawPnl - fee;
    const pnlPct = (netPnl / pos.marginUsed) * 100;
    sim.equity += netPnl;
    trades.push({
      id: pos.id,
      pair,
      side: pos.side,
      entryTime: pos.entryTime,
      exitTime: finalCandle.time,
      entryPrice: pos.entryPrice,
      exitPrice: finalCandle.close,
      leverage: pos.leverage,
      size: pos.size,
      notional: pos.notional,
      pnl: Number(netPnl.toFixed(4)),
      pnlPct: Number(pnlPct.toFixed(2)),
      exitReason: 'end_of_data',
    });
    sim.currentPos = null;
  }

  // 5. Compute performance statistics
  const totalTrades = trades.length;
  const winningTrades = trades.filter((t) => t.pnl > 0).length;
  const losingTrades = trades.filter((t) => t.pnl <= 0).length;
  const winRatePct = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

  const netProfit = sim.equity - initialCapital;
  const netProfitPct = (netProfit / initialCapital) * 100;

  const totalDurationMs = trades.reduce((sum, t) => sum + (t.exitTime - t.entryTime), 0);
  const avgTradeDurationMinutes = totalTrades > 0 ? totalDurationMs / totalTrades / (60 * 1000) : 0;

  // Approximate Sharpe Ratio
  const returns = trades.map((t) => t.pnlPct);
  const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / (returns.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(totalTrades) : 0;

  return {
    pair,
    timeframe,
    candleCount: candles.length,
    metrics: {
      initialCapital,
      finalCapital: Number(sim.equity.toFixed(2)),
      netProfit: Number(netProfit.toFixed(2)),
      netProfitPct: Number(netProfitPct.toFixed(2)),
      totalTrades,
      winningTrades,
      losingTrades,
      winRatePct: Number(winRatePct.toFixed(2)),
      profitFactor: Number(profitFactor.toFixed(2)),
      maxDrawdownPct: Number(maxDrawdown.toFixed(2)),
      sharpeRatio: Number(sharpeRatio.toFixed(2)),
      avgTradeDurationMinutes: Number(avgTradeDurationMinutes.toFixed(1)),
    },
    equityCurve,
    trades,
    logs,
  };
}
