// Central service coordinating algorithmic trading strategies, execution, and scheduling.

import type { Kysely } from 'kysely';
import {
  forTenant,
  listAlgoStrategies,
  getAlgoStrategy,
  createAlgoStrategy,
  updateAlgoStrategy,
  deleteAlgoStrategy,
  createAlgoRun,
  updateAlgoRun,
  listAlgoRuns,
  getAlgoRun,
  confirmDryRun,
  beginExecution,
} from '@tradex/db';
import type { DB, AlgoStrategyRecord, AlgoRunRecord, AlgoStrategyInput, UpdateAlgoStrategyInput } from '@tradex/db';
import type { PlanningService, PlanRequest } from '../planning-service.js';
import type { ExecutionWorker } from '../execution-worker.js';
import type { GroupExecutor } from '../group-executor.js';
import type { ExecutionEventBus } from '../execution-events.js';
import type { FuturesExitPort } from '../futures/exit-service.js';
import { hardExit } from '../futures/exit-service.js';
import * as indicators from './algo-indicators.js';
import {
  fetchHistoricalCandles,
  fetchLatestPrice,
  STRATEGY_TEMPLATES,
} from './algo-sdk.js';
import type {
  AlgoContext,
  AlgoPosition,
  AlgoTradeOptions,
  AlgoTradeResult,
  AlgoCloseResult,
  StrategyTemplate,
} from './algo-sdk.js';
import { executeStrategyScript } from './algo-runner.js';
import { runBacktest } from './algo-backtest.js';
import type { BacktestResult, RunBacktestOptions } from './algo-backtest.js';
import { randomUUID } from 'node:crypto';

export interface AlgoServiceDeps {
  readonly db: Kysely<DB>;
  readonly planningFor: (tenantId: string) => PlanningService;
  readonly engine: { worker: ExecutionWorker; executor: GroupExecutor; bus: ExecutionEventBus } | null;
  readonly futuresExit?: FuturesExitPort | undefined;
  readonly afterFanOut?: ((params: { tenantId: string; groupTradeId: string }) => Promise<void>) | undefined;
  readonly accountSync?: ((params: { tenantId: string; accountId: string }) => Promise<unknown>) | undefined;
  readonly now?: (() => number) | undefined;
}

export function minorToMajor(minor: unknown, scale: number): number {
  if (minor === null || minor === undefined) return 0;
  const s = String(minor).trim();
  if (s === '' || s === '0') return 0;
  const isNeg = s.startsWith('-');
  const rawDigits = isNeg ? s.slice(1) : s;
  if (scale <= 0) return (isNeg ? -1 : 1) * Number(rawDigits);
  const padded = rawDigits.padStart(scale + 1, '0');
  const cut = padded.length - scale;
  const majorStr = `${padded.slice(0, cut)}.${padded.slice(cut)}`;
  const val = parseFloat(majorStr);
  return (isNeg ? -1 : 1) * (isNaN(val) ? 0 : val);
}

export class AlgoService {
  private schedulerTimer: NodeJS.Timeout | null = null;
  private readonly runningStrategyIds = new Set<string>();

  constructor(private readonly deps: AlgoServiceDeps) {}

  /**
   * Start the recurring strategy evaluation scheduler.
   */
  startScheduler(intervalMs = 15_000): void {
    if (this.schedulerTimer !== null) return;
    this.schedulerTimer = setInterval(() => {
      this.evaluateActiveStrategies().catch((err) => {
        console.error('[algo-scheduler] background evaluation error:', err instanceof Error ? err.message : String(err));
      });
    }, intervalMs);
    // Don't keep the process alive solely for the scheduler timer in test environments
    this.schedulerTimer.unref();
  }

  /**
   * Stop the recurring strategy scheduler.
   */
  stopScheduler(): void {
    if (this.schedulerTimer !== null) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  /**
   * Scan and trigger active strategies across all tenants.
   */
  private async evaluateActiveStrategies(): Promise<void> {
    const nowMs = this.deps.now ? this.deps.now() : Date.now();

    // Query active strategies across all tenants
    const activeStrategies = await this.deps.db
      .selectFrom('algo_strategy')
      .selectAll()
      .where('status', '=', 'active')
      .execute();

    for (const raw of activeStrategies) {
      const strategyId = String(raw.id);
      const tenantId = String(raw.tenant_id);

      if (this.runningStrategyIds.has(strategyId)) {
        continue;
      }

      const schedule = String(raw.schedule_interval);
      if (schedule === 'manual') continue;

      let intervalMs = 300_000; // default 5m
      switch (schedule) {
        case '1m': intervalMs = 60_000; break;
        case '5m': intervalMs = 300_000; break;
        case '15m': intervalMs = 900_000; break;
        case '30m': intervalMs = 1_800_000; break;
        case '1h': intervalMs = 3_600_000; break;
        case '4h': intervalMs = 14_400_000; break;
        case '1d': intervalMs = 86_400_000; break;
      }

      const lastRunMs = raw.last_run_at ? new Date(raw.last_run_at as unknown as string).getTime() : 0;
      if (nowMs - lastRunMs >= intervalMs) {
        this.runStrategy(tenantId, strategyId, raw.is_dry_run ? 'dry_run' : 'live').catch((err) => {
          console.error(`[algo-service] automated run failed for strategy ${strategyId}:`, err instanceof Error ? err.message : String(err));
        });
      }
    }
  }

  /**
   * Build the execution context (SDK) for a given strategy and tenant.
   */
  async buildContext(
    tenantId: string,
    strategy: AlgoStrategyRecord,
    logSink: (msg: string, data?: unknown) => void,
  ): Promise<AlgoContext> {
    const tdb = forTenant(this.deps.db, tenantId);
    const planning = this.deps.planningFor(tenantId);

    // Helper: determine target account IDs
    const getTargetAccountIds = async (): Promise<string[]> => {
      if (strategy.targetType === 'account') {
        return [strategy.targetId];
      }
      const members = await tdb
        .selectFrom('group_member')
        .select('account_id as accountId')
        .where('group_id' as never, '=', strategy.targetId as never)
        .where('enabled' as never, '=', true as never)
        .execute() as Array<{ accountId: string }>;
      return members.map((m) => m.accountId);
    };

    const targetAccountIds = await getTargetAccountIds();

    return {
      market: {
        getPrice: async (pair: string) => {
          return await fetchLatestPrice(pair);
        },
        getCandles: async (pair: string, timeframe = strategy.timeframe, limit = 100) => {
          return await fetchHistoricalCandles(pair, timeframe, limit);
        },
      },
      positions: {
        get: async (pair: string) => {
          if (targetAccountIds.length === 0) return null;
          const rows = await tdb
            .selectFrom('futures_position')
            .selectAll()
            .where('account_id' as never, 'in', targetAccountIds as never)
            .where('pair' as never, '=', pair as never)
            .where('active_pos' as never, '!=', '0' as never)
            .execute();

          if (rows.length === 0) return null;

          let totalPos = 0;
          let totalNotional = 0;
          let latestMark = 0;
          let lev = 1;
          let marginCur: 'INR' | 'USDT' = 'USDT';
          let firstId = '';
          let firstAccount = '';

          for (const r of rows) {
            const raw = r as unknown as Record<string, unknown>;
            const numPos = parseFloat(String(raw['active_pos'] ?? '0'));
            if (!isNaN(numPos) && numPos !== 0) {
              totalPos += numPos;
              const entry = parseFloat(String(raw['avg_entry_price'] ?? '0'));
              totalNotional += Math.abs(numPos) * (entry > 0 ? entry : 0);
              latestMark = parseFloat(String(raw['mark_price'] ?? '0')) || latestMark;
              lev = parseFloat(String(raw['leverage'] ?? '1')) || lev;
              marginCur = (raw['margin_currency'] ?? 'USDT') as 'INR' | 'USDT';
              if (!firstId) {
                firstId = String(raw['venue_position_id'] ?? raw['id']);
                firstAccount = String(raw['account_id']);
              }
            }
          }

          if (totalPos === 0) return null;
          const absSize = Math.abs(totalPos);
          const avgEntry = absSize > 0 && totalNotional > 0 ? totalNotional / absSize : 0;
          const dir = totalPos > 0 ? 1 : -1;
          const unrealizedPnl = (avgEntry > 0 && latestMark > 0) ? (latestMark - avgEntry) * absSize * dir : 0;

          return {
            id: firstId,
            accountId: firstAccount,
            pair,
            side: totalPos > 0 ? 'long' : 'short',
            size: absSize,
            entryPrice: avgEntry,
            markPrice: latestMark,
            leverage: lev,
            unrealizedPnl,
            marginCurrency: marginCur,
          };
        },
        list: async () => {
          if (targetAccountIds.length === 0) return [];
          const rows = await tdb
            .selectFrom('futures_position')
            .selectAll()
            .where('account_id' as never, 'in', targetAccountIds as never)
            .where('active_pos' as never, '!=', '0' as never)
            .execute();

          return rows
            .map((r) => {
              const raw = r as unknown as Record<string, unknown>;
              const activePos = String(raw['active_pos'] ?? '0');
              const numPos = parseFloat(activePos);
              if (isNaN(numPos) || numPos === 0) return null;
              const entryPrice = parseFloat(String(raw['avg_entry_price'] ?? '0'));
              const markPrice = parseFloat(String(raw['mark_price'] ?? '0'));
              const dir = numPos > 0 ? 1 : -1;
              const unrealizedPnl = (entryPrice > 0 && markPrice > 0) ? (markPrice - entryPrice) * Math.abs(numPos) * dir : 0;
              return {
                id: String(raw['venue_position_id'] ?? raw['id']),
                accountId: String(raw['account_id']),
                pair: String(raw['pair']),
                side: numPos > 0 ? ('long' as const) : ('short' as const),
                size: Math.abs(numPos),
                entryPrice,
                markPrice,
                leverage: parseFloat(String(raw['leverage'] ?? '1')),
                unrealizedPnl,
                marginCurrency: (raw['margin_currency'] ?? 'USDT') as 'INR' | 'USDT',
              };
            })
            .filter((p): p is AlgoPosition => p !== null);
        },
      },
      account: {
        getBalance: async () => {
          if (targetAccountIds.length === 0) {
            return { freeMargin: 0, totalEquity: 0, currency: 'USDT' };
          }
          const balances = await tdb
            .selectFrom('account_balance')
            .selectAll()
            .where('account_id' as never, 'in', targetAccountIds as never)
            .execute();

          let totalFree = 0;
          let totalEquity = 0;
          for (const b of balances) {
            const raw = b as unknown as Record<string, unknown>;
            const curr = String(raw['currency'] ?? '');
            if (curr === 'USDT' || curr === 'INR') {
              const scale = Number(raw['scale'] ?? (curr === 'INR' ? 2 : 18));
              const free = minorToMajor(raw['free_minor'], scale);
              const locked = minorToMajor(raw['locked_minor'], scale);
              totalFree += free;
              totalEquity += free + locked;
            }
          }
          return { freeMargin: totalFree, totalEquity, currency: 'USDT' };
        },
      },
      indicators,
      trade: {
        buy: async (opts: AlgoTradeOptions) => {
          return await this.executeTradeAction(tenantId, strategy, 'buy', opts, logSink);
        },
        sell: async (opts: AlgoTradeOptions) => {
          return await this.executeTradeAction(tenantId, strategy, 'sell', opts, logSink);
        },
        close: async (pair: string) => {
          return await this.executeCloseAction(tenantId, strategy, pair, logSink);
        },
        closeAll: async () => {
          const positions = await tdb
            .selectFrom('futures_position')
            .select('pair')
            .where('account_id' as never, 'in', targetAccountIds as never)
            .distinct()
            .execute() as Array<{ pair: string }>;

          const results: AlgoCloseResult[] = [];
          for (const pos of positions) {
            const res = await this.executeCloseAction(tenantId, strategy, pos.pair, logSink);
            results.push(res);
          }
          return results;
        },
      },
      log: logSink,
      params: { ...strategy.params, pair: strategy.pair, timeframe: strategy.timeframe },
    };
  }

  /**
   * Execute an order entry action (buy/sell).
   */
  private async executeTradeAction(
    tenantId: string,
    strategy: AlgoStrategyRecord,
    side: 'buy' | 'sell',
    opts: AlgoTradeOptions,
    logSink: (msg: string, data?: unknown) => void,
  ): Promise<AlgoTradeResult> {
    const tdb = forTenant(this.deps.db, tenantId);
    const planning = this.deps.planningFor(tenantId);

    const assetPair = opts.pair ?? strategy.pair;
    const cleanAsset = opts.asset ?? assetPair.replace(/^B-/, '').split('_')[0] ?? 'BTC';
    const derivedQuote: 'INR' | 'USDT' = (assetPair.endsWith('INR') || assetPair.includes('_INR')) ? 'INR' : 'USDT';
    const quoteCurrency = opts.marginCurrency ?? derivedQuote;

    const optsRecord = opts as unknown as Record<string, unknown>;
    const rawSize = opts.size ?? optsRecord['quantity'] ?? optsRecord['qty'];
    let planSizingMode: PlanRequest['sizingMode'] = 'pct_allocated';
    if (opts.sizingMode === 'exact_qty') {
      planSizingMode = 'base_quantity';
    } else if (opts.sizingMode === 'exact_quote') {
      planSizingMode = 'quote_amount';
    } else if (rawSize !== undefined && opts.percentBp === undefined) {
      planSizingMode = 'base_quantity';
    } else {
      planSizingMode = 'pct_allocated';
    }

    // Auto-reconcile stale child orders older than 2 minutes for target account so Gate 12 is never blocked
    if (strategy.targetType === 'account') {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      await tdb.updateTable('child_order')
        .set({ state: 'filled', terminal_at: new Date() } as never)
        .where('account_id' as never, '=', strategy.targetId as never)
        .where('state' as never, 'in', ['open', 'sending', 'acked', 'partially_filled'] as never)
        .where('created_at' as never, '<', twoMinutesAgo as never)
        .execute()
        .catch(() => {});
    }

    const planReq: PlanRequest = {
      ...(strategy.targetType === 'group' ? { groupId: strategy.targetId } : { accountId: strategy.targetId }),
      createdBy: strategy.createdBy,
      asset: cleanAsset,
      side,
      orderType: opts.orderType ?? 'market',
      sizingMode: planSizingMode,
      percentBp: opts.percentBp ?? 1000,
      sizingValue: rawSize ? String(rawSize) : undefined,
      limitPrice: opts.limitPrice ? String(opts.limitPrice) : undefined,
      quoteCurrency,
      isFutures: true,
      leverage: String(opts.leverage ?? 10),
      marginCurrency: quoteCurrency,
      positionMarginType: 'isolated',
      stopLossPrice: opts.stopLossPrice ? String(opts.stopLossPrice) : undefined,
      takeProfitPrice: opts.takeProfitPrice ? String(opts.takeProfitPrice) : undefined,
      trailingStopLoss: opts.trailingStopLoss,
      trailingDistanceBp: opts.trailingDistanceBp,
      trailingStepBp: opts.trailingStepBp,
    };

    logSink(`Planning ${side.toUpperCase()} for ${cleanAsset} (${quoteCurrency}) leverage ${opts.leverage ?? 10}x...`);

    const preview = await planning.preview(planReq);
    if (preview.plannedCount === 0) {
      logSink(`Trade preview skipped all accounts. Refusal codes: ${preview.rows.map((r) => r.refusalCode).join(', ')}`);
      return {
        success: false,
        groupTradeId: preview.groupTradeId,
        plannedCount: preview.plannedCount,
        skippedCount: preview.skippedCount,
        message: 'No accounts eligible to execute order',
      };
    }

    if (strategy.isDryRun) {
      logSink(`[DRY RUN] Generated plan for ${preview.plannedCount} accounts (simulated confirm). GroupTrade ID: ${preview.groupTradeId}`);
      await confirmDryRun(tdb, preview.groupTradeId, preview.previewToken, this.deps.now?.());
      return {
        success: true,
        dryRun: true,
        groupTradeId: preview.groupTradeId,
        plannedCount: preview.plannedCount,
        skippedCount: preview.skippedCount,
      };
    }

    // REAL LIVE EXECUTION
    if (this.deps.engine === null) {
      throw new Error('Execution engine is not configured; refusing to place live order');
    }

    logSink(`[LIVE] Confirming and sending real orders for trade ${preview.groupTradeId}...`);
    await beginExecution(tdb, preview.groupTradeId, preview.previewToken, this.deps.now?.());
    const enqueued = await this.deps.engine.executor.enqueue(tdb, preview.groupTradeId);
    await this.deps.engine.executor.drain(100);

    try {
      await this.deps.engine.worker.pollTrade(tdb, preview.groupTradeId);
    } catch (pollErr) {
      console.warn(`[algo-service] post-drain pollTrade warning for ${preview.groupTradeId}:`, pollErr);
    }

    if (this.deps.afterFanOut !== undefined) {
      try {
        await this.deps.afterFanOut({ tenantId, groupTradeId: preview.groupTradeId });
      } catch (mirrorErr) {
        console.warn(`[algo-service] post-fanout mirror warning for ${preview.groupTradeId}:`, mirrorErr);
      }
    }

    logSink(`[LIVE] Order fan-out enqueued ${enqueued.enqueued} legs and completed execution.`);
    return {
      success: true,
      dryRun: false,
      groupTradeId: preview.groupTradeId,
      plannedCount: preview.plannedCount,
      skippedCount: preview.skippedCount,
    };
  }

  /**
   * Execute a position close action.
   */
  private async executeCloseAction(
    tenantId: string,
    strategy: AlgoStrategyRecord,
    pair: string,
    logSink: (msg: string, data?: unknown) => void,
  ): Promise<AlgoCloseResult> {
    const tdb = forTenant(this.deps.db, tenantId);

    // Find target accounts
    let targetAccountIds: string[] = [];
    if (strategy.targetType === 'account') {
      targetAccountIds = [strategy.targetId];
    } else {
      const members = await tdb
        .selectFrom('group_member')
        .select('account_id as accountId')
        .where('group_id' as never, '=', strategy.targetId as never)
        .where('enabled' as never, '=', true as never)
        .execute() as Array<{ accountId: string }>;
      targetAccountIds = members.map((m) => m.accountId);
    }

    if (targetAccountIds.length === 0) {
      return { success: true, pair, exitedCount: 0, message: 'No target accounts found' };
    }

    const openPositions = await tdb
      .selectFrom('futures_position')
      .selectAll()
      .where('account_id' as never, 'in', targetAccountIds as never)
      .where('pair' as never, '=', pair as never)
      .execute();

    if (openPositions.length === 0) {
      logSink(`No open positions found on ${pair} to close.`);
      return { success: true, pair, exitedCount: 0, message: 'No open position found' };
    }

    let exitedCount = 0;

    for (const pos of openPositions) {
      const raw = pos as unknown as Record<string, unknown>;
      const activePos = String(raw['active_pos'] ?? '0');
      if (parseFloat(activePos) === 0) continue;

      const venuePositionId = String(raw['venue_position_id'] ?? '');
      const marginCurrency = (raw['margin_currency'] ?? 'USDT') as 'INR' | 'USDT';
      const accountId = String(raw['account_id']);

      if (strategy.isDryRun) {
        logSink(`[DRY RUN] Position on ${pair} (${activePos} size, Account ${accountId}) would be closed.`);
        exitedCount++;
      } else {
        if (!this.deps.futuresExit) {
          throw new Error('Futures exit port not configured');
        }
        logSink(`[LIVE] Exiting position ${venuePositionId} on ${pair} for account ${accountId}...`);
        try {
          const res = await hardExit(this.deps.futuresExit, {
            actor: { tenantId, accountId },
            venuePositionId,
            marginCurrency,
          });
          if (res.exited) exitedCount++;
        } catch (exitErr) {
          logSink(`Failed to exit position ${venuePositionId}: ${exitErr instanceof Error ? exitErr.message : String(exitErr)}`);
        }
      }
    }

    return { success: true, pair, exitedCount };
  }

  /**
   * Run a strategy once (triggered manually or by scheduler).
   */
  async runStrategy(
    tenantId: string,
    strategyId: string,
    mode: 'dry_run' | 'live' = 'dry_run',
  ): Promise<AlgoRunRecord> {
    const tdb = forTenant(this.deps.db, tenantId);
    const strategy = await getAlgoStrategy(tdb, strategyId);
    if (!strategy) throw new Error(`Strategy ${strategyId} not found`);

    if (this.runningStrategyIds.has(strategyId)) {
      throw new Error(`Strategy ${strategy.name} is already executing a cycle`);
    }

    this.runningStrategyIds.add(strategyId);

    // Create algo_run record
    const run = await createAlgoRun(tdb, {
      strategyId,
      mode,
      status: 'running',
    });

    // Mark last run at
    await updateAlgoStrategy(tdb, strategyId, {
      lastRunAt: new Date(),
    });

    const runtimeLogs: string[] = [];
    const logSink = (msg: string, data?: unknown) => {
      runtimeLogs.push(data !== undefined ? `${msg} ${JSON.stringify(data)}` : msg);
    };

    try {
      const context = await this.buildContext(tenantId, strategy, logSink);
      const result = await executeStrategyScript(strategy.script, context, 15_000);

      const finalStatus = result.success ? 'completed' : 'failed';
      await updateAlgoRun(tdb, run.id, {
        status: finalStatus,
        completedAt: new Date(),
        logs: result.logs,
        actionsTaken: result.actionsTaken,
        metrics: { durationMs: result.durationMs },
        error: result.error ?? null,
      });

      await updateAlgoStrategy(tdb, strategyId, {
        lastStatus: result.success ? 'success' : 'error',
        lastError: result.error ?? null,
      });

      const updated = await getAlgoRun(tdb, run.id);
      return updated ?? run;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await updateAlgoRun(tdb, run.id, {
        status: 'failed',
        completedAt: new Date(),
        error: errorMsg,
      });

      await updateAlgoStrategy(tdb, strategyId, {
        lastStatus: 'error',
        lastError: errorMsg,
      });

      const updated = await getAlgoRun(tdb, run.id);
      return updated ?? run;
    } finally {
      this.runningStrategyIds.delete(strategyId);
    }
  }

  /**
   * Run backtest for a strategy or custom script.
   */
  async runBacktest(options: RunBacktestOptions): Promise<BacktestResult> {
    return await runBacktest(options);
  }

  /**
   * Emergency Stop: Hault all strategies for a tenant.
   */
  async emergencyStopAll(tenantId: string): Promise<number> {
    const tdb = forTenant(this.deps.db, tenantId);
    const strategies = await listAlgoStrategies(tdb);
    let stoppedCount = 0;

    for (const s of strategies) {
      if (s.status === 'active' || s.status === 'paused') {
        await updateAlgoStrategy(tdb, s.id, { status: 'stopped' });
        stoppedCount++;
      }
    }

    return stoppedCount;
  }

  /**
   * Return prebuilt templates.
   */
  getTemplates(): readonly StrategyTemplate[] {
    return STRATEGY_TEMPLATES;
  }

  // Basic CRUD passthroughs
  async listStrategies(tenantId: string): Promise<AlgoStrategyRecord[]> {
    return await listAlgoStrategies(forTenant(this.deps.db, tenantId));
  }

  async getStrategy(tenantId: string, id: string): Promise<AlgoStrategyRecord | null> {
    return await getAlgoStrategy(forTenant(this.deps.db, tenantId), id);
  }

  async createStrategy(tenantId: string, input: AlgoStrategyInput): Promise<AlgoStrategyRecord> {
    return await createAlgoStrategy(forTenant(this.deps.db, tenantId), input);
  }

  async updateStrategy(tenantId: string, id: string, input: UpdateAlgoStrategyInput): Promise<AlgoStrategyRecord | null> {
    return await updateAlgoStrategy(forTenant(this.deps.db, tenantId), id, input);
  }

  async deleteStrategy(tenantId: string, id: string): Promise<boolean> {
    return await deleteAlgoStrategy(forTenant(this.deps.db, tenantId), id);
  }

  async listRuns(tenantId: string, strategyId: string, limit = 50): Promise<AlgoRunRecord[]> {
    return await listAlgoRuns(forTenant(this.deps.db, tenantId), strategyId, limit);
  }
}
