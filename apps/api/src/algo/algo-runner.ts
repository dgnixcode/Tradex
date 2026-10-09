import type { AlgoContext } from './algo-sdk.js';
import { compileIsolatedStrategy } from './isolated-strategy.js';

export interface LogEntry {
  readonly timestamp: string;
  readonly level: 'info' | 'warn' | 'error' | 'trade';
  readonly message: string;
  readonly data?: unknown;
}
export interface ExecutionResult {
  readonly success: boolean;
  readonly logs: readonly LogEntry[];
  readonly actionsTaken: readonly unknown[];
  readonly error?: string | undefined;
  readonly durationMs: number;
}

export async function executeStrategyScript(source: string, context: AlgoContext, timeoutMs = 10_000): Promise<ExecutionResult> {
  const started = Date.now();
  const logs: LogEntry[] = [];
  const actionsTaken: unknown[] = [];
  const pendingTrades = new Set<Promise<unknown>>();
  const log = (message: string, data?: unknown) => {
    if (logs.length >= 1000) throw new Error('Strategy log limit exceeded');
    logs.push({ timestamp: new Date().toISOString(), level: 'info', message: String(message).slice(0, 10_000), data });
    context.log(message, data);
  };
  const record = async (action: string, options: unknown, fn: () => Promise<unknown>) => {
    const job = fn();
    pendingTrades.add(job);
    let result: unknown;
    try { result = await job; } finally { pendingTrades.delete(job); }
    actionsTaken.push({ action, options, result, timestamp: new Date().toISOString() });
    logs.push({ timestamp: new Date().toISOString(), level: 'trade', message: `TRADE ${action.toUpperCase()}`, data: result });
    return result;
  };
  let isolated: Awaited<ReturnType<typeof compileIsolatedStrategy>> | undefined;
  try {
    isolated = await compileIsolatedStrategy(source);
    await isolated.run({ ...context, log, trade: {
      buy: (opts) => record('buy', opts, () => context.trade.buy(opts)) as ReturnType<AlgoContext['trade']['buy']>,
      sell: (opts) => record('sell', opts, () => context.trade.sell(opts)) as ReturnType<AlgoContext['trade']['sell']>,
      close: (pair) => record('close', pair, () => context.trade.close(pair)) as ReturnType<AlgoContext['trade']['close']>,
      closeAll: () => record('closeAll', null, () => context.trade.closeAll()) as ReturnType<AlgoContext['trade']['closeAll']>,
    } }, timeoutMs);
    return { success: true, logs, actionsTaken, durationMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logs.push({ timestamp: new Date().toISOString(), level: 'error', message });
    return { success: false, logs, actionsTaken, error: message, durationMs: Date.now() - started };
  } finally {
    isolated?.dispose();
    // A guest timeout cannot cancel an exchange request already sent. Keep the
    // strategy lease until every started trade has actually settled.
    await Promise.allSettled(pendingTrades);
  }
}

export async function compileStrategyForBacktest(source: string): Promise<{
  (context: AlgoContext): Promise<unknown>;
  dispose(): void;
}> {
  const isolated = await compileIsolatedStrategy(source);
  const run = (context: AlgoContext) => isolated.run(context, 1000);
  run.dispose = () => isolated.dispose();
  return run;
}
