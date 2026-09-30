// Historical backtesting simulator for algorithmic trading strategies.
// Supports institutional-grade Binance Maker (0.02%) & Taker (0.05%) fee calculation.

import type { Kysely } from 'kysely';
import type { DB } from '@tradex/db';
import * as indicators from './algo-indicators.js';
import type { CandleData } from './algo-indicators.js';
import { fetchHistoricalCandles } from './algo-sdk.js';
import type { AlgoPosition, AlgoTradeOptions } from './algo-sdk.js';
import { compileStrategyForBacktest } from './algo-runner.js';
import { loadHistoricalCandles } from './binance-history.js';

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
  readonly grossPnl: number;
  readonly netPnl: number;
  readonly pnl: number; // Matches netPnl for backward compatibility
  readonly pnlPct: number;
  readonly entryFee: number;
  readonly exitFee: number;
  readonly entryFeeType: 'maker' | 'taker';
  readonly exitFeeType: 'maker' | 'taker';
  readonly totalFees: number;
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
  readonly grossProfit: number;
  readonly grossLoss: number;
  readonly totalFees: number;
  readonly makerFees: number;
  readonly takerFees: number;
  readonly makerFeeRate: number;
  readonly takerFeeRate: number;
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
  readonly makerFeeRate?: number | undefined; // Default 0.0002 (0.02% Binance VIP 0)
  readonly takerFeeRate?: number | undefined; // Default 0.0005 (0.05% Binance VIP 0)
  readonly dataSource?: 'binance' | 'coindcx' | 'auto' | undefined;
  readonly lookbackMonths?: number | undefined;
  readonly db?: Kysely<DB> | undefined;
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
  readonly entryFee: number;
  readonly entryFeeType: 'maker' | 'taker';
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

  // Institutional default fee rates: Binance VIP 0 (0.02% maker, 0.05% taker)
  const makerFeeRate = typeof options.makerFeeRate === 'number' ? options.makerFeeRate : 0.0002;
  const takerFeeRate = typeof options.takerFeeRate === 'number' ? options.takerFeeRate : 0.0005;

  let candles: CandleData[];
  if (options.customCandles && options.customCandles.length > 0) {
    candles = [...options.customCandles];
  } else if (options.db) {
    candles = await loadHistoricalCandles(options.db, pair, timeframe, {
      limit: candleLimit,
      dataSource: options.dataSource,
      lookbackMonths: options.lookbackMonths,
    });
  } else {
    candles = await fetchHistoricalCandles(pair, timeframe, candleLimit);
  }

  if (candles.length < 25) {
    throw new Error(
      `Insufficient historical candles for backtesting (${candles.length} available, minimum 25 required)`,
    );
  }

  // Compile strategy script once to eliminate per-candle VM compilation overhead
  const strategyRunner = compileStrategyForBacktest(options.script);

  const sim: SimState = {
    equity: initialCapital,
    currentPos: null,
  };

  let peakEquity = initialCapital;
  let maxDrawdown = 0;
  let totalMakerFees = 0;
  let totalTakerFees = 0;

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  const logs: string[] = [];

  const minWarmup = 20;

  for (let i = minWarmup; i < candles.length; i++) {
    const candle = candles[i]!;

    // 1. Check TP/SL triggers against high/low of current candle
    if (sim.currentPos) {
      const active: SimulatedPosition = sim.currentPos;
      let exitPrice: number | null = null;
      let exitReason: BacktestTrade['exitReason'] | null = null;
      let exitFeeType: 'maker' | 'taker' = 'taker';

      if (active.side === 'long') {
        if (active.takeProfitPrice !== null && candle.high >= active.takeProfitPrice) {
          exitPrice = active.takeProfitPrice;
          exitReason = 'take_profit';
          exitFeeType = 'maker'; // Take-profit limit fills on book
        } else if (active.stopLossPrice !== null && candle.low <= active.stopLossPrice) {
          exitPrice = active.stopLossPrice;
          exitReason = 'stop_loss';
          exitFeeType = 'taker'; // Stop-loss triggers market order
        }
      } else {
        if (active.takeProfitPrice !== null && candle.low <= active.takeProfitPrice) {
          exitPrice = active.takeProfitPrice;
          exitReason = 'take_profit';
          exitFeeType = 'maker'; // Take-profit limit fills on book
        } else if (active.stopLossPrice !== null && candle.high >= active.stopLossPrice) {
          exitPrice = active.stopLossPrice;
          exitReason = 'stop_loss';
          exitFeeType = 'taker'; // Stop-loss triggers market order
        }
      }

      if (exitPrice !== null && exitReason !== null) {
        const exitNotional = exitPrice * active.size;
        const exitFee = exitFeeType === 'maker' ? exitNotional * makerFeeRate : exitNotional * takerFeeRate;
        const totalTradeFees = active.entryFee + exitFee;

        if (exitFeeType === 'maker') totalMakerFees += exitFee;
        else totalTakerFees += exitFee;

        const rawPnl = active.side === 'long'
          ? (exitPrice - active.entryPrice) * active.size
          : (active.entryPrice - exitPrice) * active.size;

        const netPnl = rawPnl - totalTradeFees;
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
          grossPnl: Number(rawPnl.toFixed(4)),
          netPnl: Number(netPnl.toFixed(4)),
          pnl: Number(netPnl.toFixed(4)),
          pnlPct: Number(pnlPct.toFixed(2)),
          entryFee: Number(active.entryFee.toFixed(4)),
          exitFee: Number(exitFee.toFixed(4)),
          entryFeeType: active.entryFeeType,
          exitFeeType,
          totalFees: Number(totalTradeFees.toFixed(4)),
          exitReason,
        });

        sim.currentPos = null;
      }
    }

    // 2. Build mock execution context for current candle
    const simulatedContext = {
      market: {
        getPrice: async () => candle.close,
        getCandles: async (limit?: number) => {
          const count = limit ? Math.min(limit, 1000) : 300;
          const startIdx = Math.max(0, i + 1 - count);
          return candles.slice(startIdx, i + 1);
        },
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
          // If already short, close the short first
          if (sim.currentPos && sim.currentPos.side === 'short') {
            const shortPos = sim.currentPos;
            const exitPrice = candle.close;
            const exitNotional = exitPrice * shortPos.size;
            const exitFee = exitNotional * takerFeeRate; // Signal close executes at market taker
            totalTakerFees += exitFee;
            const totalTradeFees = shortPos.entryFee + exitFee;

            const rawPnl = (shortPos.entryPrice - exitPrice) * shortPos.size;
            const netPnl = rawPnl - totalTradeFees;
            const pnlPct = (netPnl / shortPos.marginUsed) * 100;
            sim.equity += netPnl;

            trades.push({
              id: shortPos.id,
              pair,
              side: 'short',
              entryTime: shortPos.entryTime,
              exitTime: candle.time,
              entryPrice: shortPos.entryPrice,
              exitPrice,
              leverage: shortPos.leverage,
              size: shortPos.size,
              notional: shortPos.notional,
              grossPnl: Number(rawPnl.toFixed(4)),
              netPnl: Number(netPnl.toFixed(4)),
              pnl: Number(netPnl.toFixed(4)),
              pnlPct: Number(pnlPct.toFixed(2)),
              entryFee: Number(shortPos.entryFee.toFixed(4)),
              exitFee: Number(exitFee.toFixed(4)),
              entryFeeType: shortPos.entryFeeType,
              exitFeeType: 'taker',
              totalFees: Number(totalTradeFees.toFixed(4)),
              exitReason: 'signal_close',
            });
            sim.currentPos = null;
          }

          // Open long position
          if (!sim.currentPos) {
            const lev = Number(opts.leverage) || 10;
            const allocPct = (opts.percentBp ?? 1000) / 10000;
            const margin = Math.max(10, sim.equity * allocPct);
            const notional = margin * lev;
            const size = notional / candle.close;

            const entryFeeType: 'maker' | 'taker' = opts.orderType === 'limit' ? 'maker' : 'taker';
            const entryFee = entryFeeType === 'maker' ? notional * makerFeeRate : notional * takerFeeRate;

            if (entryFeeType === 'maker') totalMakerFees += entryFee;
            else totalTakerFees += entryFee;

            sim.currentPos = {
              id: `sim-order-${i}`,
              side: 'long',
              entryPrice: candle.close,
              entryTime: candle.time,
              leverage: lev,
              size,
              notional,
              marginUsed: margin,
              entryFee,
              entryFeeType,
              takeProfitPrice: opts.takeProfitPrice ? Number(opts.takeProfitPrice) : null,
              stopLossPrice: opts.stopLossPrice ? Number(opts.stopLossPrice) : null,
            };
          }

          const currentSize = sim.currentPos ? sim.currentPos.size : 0;
          return { success: true, price: candle.close, quantity: currentSize };
        },
        sell: async (opts: AlgoTradeOptions) => {
          // If already long, close the long first
          if (sim.currentPos && sim.currentPos.side === 'long') {
            const longPos = sim.currentPos;
            const exitPrice = candle.close;
            const exitNotional = exitPrice * longPos.size;
            const exitFee = exitNotional * takerFeeRate; // Signal close executes at market taker
            totalTakerFees += exitFee;
            const totalTradeFees = longPos.entryFee + exitFee;

            const rawPnl = (exitPrice - longPos.entryPrice) * longPos.size;
            const netPnl = rawPnl - totalTradeFees;
            const pnlPct = (netPnl / longPos.marginUsed) * 100;
            sim.equity += netPnl;

            trades.push({
              id: longPos.id,
              pair,
              side: 'long',
              entryTime: longPos.entryTime,
              exitTime: candle.time,
              entryPrice: longPos.entryPrice,
              exitPrice,
              leverage: longPos.leverage,
              size: longPos.size,
              notional: longPos.notional,
              grossPnl: Number(rawPnl.toFixed(4)),
              netPnl: Number(netPnl.toFixed(4)),
              pnl: Number(netPnl.toFixed(4)),
              pnlPct: Number(pnlPct.toFixed(2)),
              entryFee: Number(longPos.entryFee.toFixed(4)),
              exitFee: Number(exitFee.toFixed(4)),
              entryFeeType: longPos.entryFeeType,
              exitFeeType: 'taker',
              totalFees: Number(totalTradeFees.toFixed(4)),
              exitReason: 'signal_close',
            });
            sim.currentPos = null;
          }

          // Open short position
          if (!sim.currentPos) {
            const lev = Number(opts.leverage) || 10;
            const allocPct = (opts.percentBp ?? 1000) / 10000;
            const margin = Math.max(10, sim.equity * allocPct);
            const notional = margin * lev;
            const size = notional / candle.close;

            const entryFeeType: 'maker' | 'taker' = opts.orderType === 'limit' ? 'maker' : 'taker';
            const entryFee = entryFeeType === 'maker' ? notional * makerFeeRate : notional * takerFeeRate;

            if (entryFeeType === 'maker') totalMakerFees += entryFee;
            else totalTakerFees += entryFee;

            sim.currentPos = {
              id: `sim-order-${i}`,
              side: 'short',
              entryPrice: candle.close,
              entryTime: candle.time,
              leverage: lev,
              size,
              notional,
              marginUsed: margin,
              entryFee,
              entryFeeType,
              takeProfitPrice: opts.takeProfitPrice ? Number(opts.takeProfitPrice) : null,
              stopLossPrice: opts.stopLossPrice ? Number(opts.stopLossPrice) : null,
            };
          }

          const currentSize = sim.currentPos ? sim.currentPos.size : 0;
          return { success: true, price: candle.close, quantity: currentSize };
        },
        close: async (closePair?: string) => {
          if (closePair && closePair !== pair) {
            return { success: true, pair: closePair, exitedCount: 0 };
          }
          if (sim.currentPos) {
            const pos = sim.currentPos;
            const exitPrice = candle.close;
            const exitNotional = exitPrice * pos.size;
            const exitFee = exitNotional * takerFeeRate;
            totalTakerFees += exitFee;
            const totalTradeFees = pos.entryFee + exitFee;

            const rawPnl = pos.side === 'long'
              ? (exitPrice - pos.entryPrice) * pos.size
              : (pos.entryPrice - exitPrice) * pos.size;

            const netPnl = rawPnl - totalTradeFees;
            const pnlPct = (netPnl / pos.marginUsed) * 100;
            sim.equity += netPnl;

            trades.push({
              id: pos.id,
              pair,
              side: pos.side,
              entryTime: pos.entryTime,
              exitTime: candle.time,
              entryPrice: pos.entryPrice,
              exitPrice,
              leverage: pos.leverage,
              size: pos.size,
              notional: pos.notional,
              grossPnl: Number(rawPnl.toFixed(4)),
              netPnl: Number(netPnl.toFixed(4)),
              pnl: Number(netPnl.toFixed(4)),
              pnlPct: Number(pnlPct.toFixed(2)),
              entryFee: Number(pos.entryFee.toFixed(4)),
              exitFee: Number(exitFee.toFixed(4)),
              entryFeeType: pos.entryFeeType,
              exitFeeType: 'taker',
              totalFees: Number(totalTradeFees.toFixed(4)),
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

    // 3. Execute compiled strategy function for current candle
    try {
      await strategyRunner(simulatedContext as unknown as import('./algo-sdk.js').AlgoContext);
    } catch (err) {
      if (logs.length < 50) {
        logs.push(`[${new Date(candle.time).toISOString()}] Tick error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 4. Record equity curve snapshot (downsampled to max ~500 points + trade execution bars)
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

    const sampleStep = Math.max(1, Math.floor(candles.length / 500));
    const isTradeBar = trades.length > 0 && trades[trades.length - 1]!.exitTime === candle.time;
    if (i === minWarmup || i === candles.length - 1 || i % sampleStep === 0 || isTradeBar) {
      equityCurve.push({
        time: candle.time,
        price: candle.close,
        equity: Number(currentMarkEquity.toFixed(2)),
        drawdownPct: Number(dd.toFixed(2)),
      });
    }
  }

  // Close any trailing position at final candle close
  if (sim.currentPos && candles.length > 0) {
    const pos = sim.currentPos;
    const finalCandle = candles[candles.length - 1]!;
    const exitPrice = finalCandle.close;
    const exitNotional = exitPrice * pos.size;
    const exitFee = exitNotional * takerFeeRate;
    totalTakerFees += exitFee;
    const totalTradeFees = pos.entryFee + exitFee;

    const rawPnl = pos.side === 'long'
      ? (exitPrice - pos.entryPrice) * pos.size
      : (pos.entryPrice - exitPrice) * pos.size;

    const netPnl = rawPnl - totalTradeFees;
    const pnlPct = (netPnl / pos.marginUsed) * 100;
    sim.equity += netPnl;

    trades.push({
      id: pos.id,
      pair,
      side: pos.side,
      entryTime: pos.entryTime,
      exitTime: finalCandle.time,
      entryPrice: pos.entryPrice,
      exitPrice,
      leverage: pos.leverage,
      size: pos.size,
      notional: pos.notional,
      grossPnl: Number(rawPnl.toFixed(4)),
      netPnl: Number(netPnl.toFixed(4)),
      pnl: Number(netPnl.toFixed(4)),
      pnlPct: Number(pnlPct.toFixed(2)),
      entryFee: Number(pos.entryFee.toFixed(4)),
      exitFee: Number(exitFee.toFixed(4)),
      entryFeeType: pos.entryFeeType,
      exitFeeType: 'taker',
      totalFees: Number(totalTradeFees.toFixed(4)),
      exitReason: 'end_of_data',
    });
    sim.currentPos = null;
  }

  // 5. Compute performance statistics
  const totalTrades = trades.length;
  const winningTrades = trades.filter((t) => t.netPnl > 0).length;
  const losingTrades = trades.filter((t) => t.netPnl <= 0).length;
  const winRatePct = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

  const grossProfit = trades.filter((t) => t.grossPnl > 0).reduce((sum, t) => sum + t.grossPnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.grossPnl < 0).reduce((sum, t) => sum + t.grossPnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99.9 : 0;

  const totalFees = totalMakerFees + totalTakerFees;
  const netProfit = sim.equity - initialCapital;
  const netProfitPct = (netProfit / initialCapital) * 100;

  const totalDurationMs = trades.reduce((sum, t) => sum + (t.exitTime - t.entryTime), 0);
  const avgTradeDurationMinutes = totalTrades > 0 ? totalDurationMs / totalTrades / (60 * 1000) : 0;

  // Sharpe Ratio
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
      grossProfit: Number(grossProfit.toFixed(2)),
      grossLoss: Number(grossLoss.toFixed(2)),
      totalFees: Number(totalFees.toFixed(2)),
      makerFees: Number(totalMakerFees.toFixed(2)),
      takerFees: Number(totalTakerFees.toFixed(2)),
      makerFeeRate,
      takerFeeRate,
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
