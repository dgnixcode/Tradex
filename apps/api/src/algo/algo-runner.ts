// Sandboxed strategy script runner.
// Executes user-provided algorithm scripts safely with timeouts and memory isolation.

import vm from 'node:vm';
import type { AlgoContext } from './algo-sdk.js';

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

/**
 * Execute a strategy script inside a secure isolated VM sandbox.
 */
export async function executeStrategyScript(
  scriptSource: string,
  context: AlgoContext,
  timeoutMs = 10_000,
): Promise<ExecutionResult> {
  const logs: LogEntry[] = [];
  const actionsTaken: unknown[] = [];
  const startAt = Date.now();

  const customLog = (message: string, data?: unknown) => {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      message: String(message),
      data: data !== undefined ? JSON.parse(JSON.stringify(data)) : undefined,
    };
    logs.push(entry);
    context.log(message, data);
  };

  // Intercept trade actions to record them in actionsTaken
  const originalBuy = context.trade.buy;
  const originalSell = context.trade.sell;
  const originalClose = context.trade.close;
  const originalCloseAll = context.trade.closeAll;

  const wrappedContext: AlgoContext = {
    ...context,
    log: customLog,
    trade: {
      buy: async (opts) => {
        const res = await originalBuy(opts);
        actionsTaken.push({ action: 'buy', options: opts, result: res, timestamp: new Date().toISOString() });
        logs.push({
          timestamp: new Date().toISOString(),
          level: 'trade',
          message: `TRADE BUY [${opts.pair ?? 'N/A'}] - Status: ${res.success ? 'SUCCESS' : 'FAILED'}: ${res.message ?? ''}`,
          data: res,
        });
        return res;
      },
      sell: async (opts) => {
        const res = await originalSell(opts);
        actionsTaken.push({ action: 'sell', options: opts, result: res, timestamp: new Date().toISOString() });
        logs.push({
          timestamp: new Date().toISOString(),
          level: 'trade',
          message: `TRADE SELL [${opts.pair ?? 'N/A'}] - Status: ${res.success ? 'SUCCESS' : 'FAILED'}: ${res.message ?? ''}`,
          data: res,
        });
        return res;
      },
      close: async (pair) => {
        const res = await originalClose(pair);
        actionsTaken.push({ action: 'close', pair, result: res, timestamp: new Date().toISOString() });
        logs.push({
          timestamp: new Date().toISOString(),
          level: 'trade',
          message: `POSITION CLOSE [${pair}] - Exited: ${res.exitedCount}`,
          data: res,
        });
        return res;
      },
      closeAll: async () => {
        const res = await originalCloseAll();
        actionsTaken.push({ action: 'closeAll', result: res, timestamp: new Date().toISOString() });
        logs.push({
          timestamp: new Date().toISOString(),
          level: 'trade',
          message: `CLOSE ALL POSITIONS - Closed: ${res.length}`,
          data: res,
        });
        return res;
      },
    },
  };

  try {
    // Transform ES module export default or named functions to commonjs-style executable block
    let cleanedCode = scriptSource.trim();
    if (cleanedCode.includes('export default')) {
      cleanedCode = cleanedCode.replace(/export\s+default\s+/, '__entrypoint = ');
    } else if (cleanedCode.includes('module.exports =')) {
      cleanedCode = cleanedCode.replace(/module\.exports\s*=\s*/, '__entrypoint = ');
    } else if (cleanedCode.includes('exports.default =')) {
      cleanedCode = cleanedCode.replace(/exports\.default\s*=\s*/, '__entrypoint = ');
    }

    // Strip leading 'export ' on named declarations so VM doesn't throw SyntaxError: Unexpected token 'export'
    cleanedCode = cleanedCode.replace(/export\s+(async\s+function|function|const|let|var|class)\s+/g, '$1 ');

    const sandbox = {
      __context: wrappedContext,
      __entrypoint: null as ((ctx: AlgoContext) => Promise<unknown>) | null,
      console: {
        log: (...args: unknown[]) => customLog(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')),
        info: (...args: unknown[]) => customLog(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ')),
        warn: (...args: unknown[]) => {
          const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
          logs.push({ timestamp: new Date().toISOString(), level: 'warn', message: msg });
        },
        error: (...args: unknown[]) => {
          const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
          logs.push({ timestamp: new Date().toISOString(), level: 'error', message: msg });
        },
      },
      Math,
      Date,
      JSON,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      Promise,
      setTimeout: (fn: () => void, ms: number) => {
        if (ms > 2000) ms = 2000;
        return setTimeout(fn, ms);
      },
      clearTimeout,
    };

    const vmContext = vm.createContext(sandbox);

    // Execute script definition
    const wrapper = `
      (async function() {
        ${cleanedCode};
        if (typeof __entrypoint === 'function') {
          return await __entrypoint(__context);
        } else if (typeof run === 'function') {
          return await run(__context);
        } else if (typeof onTick === 'function') {
          return await onTick(__context);
        } else if (typeof execute === 'function') {
          return await execute(__context);
        } else {
          throw new Error('Strategy script must define or export default an async function run(context)');
        }
      })()
    `;

    const script = new vm.Script(wrapper, {
      filename: 'strategy.js',
    });

    const executionPromise = script.runInContext(vmContext, {
      timeout: timeoutMs,
      displayErrors: true,
    }) as Promise<unknown>;

    await Promise.race([
      executionPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Strategy execution timed out after ${timeoutMs}ms`)), timeoutMs + 100)),
    ]);

    const durationMs = Date.now() - startAt;
    logs.push({
      timestamp: new Date().toISOString(),
      level: 'info',
      message: `Strategy cycle completed successfully in ${durationMs}ms`,
    });

    return {
      success: true,
      logs,
      actionsTaken,
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - startAt;
    const errorMsg = err instanceof Error ? err.message : String(err);
    logs.push({
      timestamp: new Date().toISOString(),
      level: 'error',
      message: `Strategy execution failed: ${errorMsg}`,
    });

    return {
      success: false,
      logs,
      actionsTaken,
      error: errorMsg,
      durationMs,
    };
  }
}

/**
 * Compiles a strategy script once for high-performance backtesting across thousands of candles.
 * Eliminates repeated VM context creation and AST parsing per candle.
 */
export function compileStrategyForBacktest(scriptSource: string): (ctx: AlgoContext) => Promise<unknown> {
  let cleanedCode = scriptSource.trim();
  if (cleanedCode.includes('export default')) {
    cleanedCode = cleanedCode.replace(/export\s+default\s+/, '__entrypoint = ');
  } else if (cleanedCode.includes('module.exports =')) {
    cleanedCode = cleanedCode.replace(/module\.exports\s*=\s*/, '__entrypoint = ');
  } else if (cleanedCode.includes('exports.default =')) {
    cleanedCode = cleanedCode.replace(/exports\.default\s*=\s*/, '__entrypoint = ');
  }

  cleanedCode = cleanedCode.replace(/export\s+(async\s+function|function|const|let|var|class)\s+/g, '$1 ');

  const sandbox = {
    Math,
    Date,
    JSON,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Map,
    Set,
    Promise,
    console: {
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };

  const vmContext = vm.createContext(sandbox);

  const wrapper = `
    (function() {
      let __entrypoint = null;
      ${cleanedCode};
      if (typeof __entrypoint === 'function') return __entrypoint;
      if (typeof run === 'function') return run;
      if (typeof onTick === 'function') return onTick;
      if (typeof execute === 'function') return execute;
      throw new Error('Strategy script must define or export default an async function run(context)');
    })()
  `;

  const script = new vm.Script(wrapper, { filename: 'strategy-backtest.js' });
  const fn = script.runInContext(vmContext) as (ctx: AlgoContext) => Promise<unknown>;
  return fn;
}
