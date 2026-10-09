import { getQuickJS } from 'quickjs-emscripten';
import type { QuickJSHandle, QuickJSDeferredPromise } from 'quickjs-emscripten';
import type { AlgoContext } from './algo-sdk.js';

export interface IsolatedStrategy {
  run(context: AlgoContext, timeoutMs?: number): Promise<unknown>;
  dispose(): void;
}

/** A WASM guest receives JSON and narrow SDK functions, never Node objects. */
export async function compileIsolatedStrategy(source: string): Promise<IsolatedStrategy> {
  if (source.length > 100_000) throw new Error('Strategy source exceeds 100 KB');
  const module = await getQuickJS();
  const vm = module.newContext();
  vm.runtime.setMemoryLimit(32 * 1024 * 1024);
  vm.runtime.setMaxStackSize(512 * 1024);
  let deadline = Date.now() + 10_000;
  let cpuDeadline = Date.now() + 50;
  let closed = false;
  let current: AlgoContext | undefined;
  let callCount = 0;
  let indicatorWork = 0;
  let running = false;
  const deferreds = new Set<QuickJSDeferredPromise>();
  const pending = new Set<Promise<void>>();
  vm.runtime.setInterruptHandler(() => closed || Date.now() >= deadline || Date.now() >= cpuDeadline);
  const check = () => {
    if (closed || Date.now() >= deadline) throw new Error('Strategy execution timed out');
    if (++callCount > 1000) throw new Error('Strategy SDK call limit exceeded');
  };
  const value = (data: unknown): QuickJSHandle => {
    const json = JSON.stringify(data ?? null);
    if (json.length > 2_000_000) throw new Error('Strategy SDK response exceeds 2 MB');
    return vm.unwrapResult(vm.evalCode(`JSON.parse(${JSON.stringify(json)})`));
  };
  const dispatch = (name: string, args: unknown[]): unknown => {
    check();
    if (!current) throw new Error('No active strategy cycle');
    // Explicit method map; user-provided property names never index host objects.
    const methods: Record<string, (...args: never[]) => unknown> = {
      'market.getPrice': current.market.getPrice,
      'market.getCandles': current.market.getCandles,
      'positions.get': current.positions.get,
      'positions.list': current.positions.list,
      'account.getBalance': current.account.getBalance,
      'trade.buy': current.trade.buy, 'trade.sell': current.trade.sell,
      'trade.close': current.trade.close, 'trade.closeAll': current.trade.closeAll,
      log: current.log,
      timer: (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(2000, Math.max(0, ms)))),
    };
    for (const [key, fn] of Object.entries(current.indicators)) {
      if (typeof fn === 'function') methods[`indicators.${key}`] = (...inputs: unknown[]) => {
        const series = inputs[0];
        if (!Array.isArray(series) || series.length > 10_000) throw new Error('Indicators require a bounded data array');
        const periods = inputs.slice(1);
        if (periods.some((p) => typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p > 10_000)) throw new Error('Invalid indicator period');
        const candles = ['atr', 'supertrend', 'stochastic'].includes(key);
        if (series.some((p: unknown) => candles
          ? typeof p !== 'object' || p === null || ['open', 'high', 'low', 'close'].some((field) => !Number.isFinite((p as Record<string, unknown>)[field]))
          : typeof p !== 'number' || !Number.isFinite(p))) throw new Error('Invalid indicator data');
        indicatorWork += series.length * Math.max(26, ...periods as number[]);
        if (indicatorWork > 5_000_000) throw new Error('Indicator computation budget exceeded');
        return (fn as (...args: never[]) => unknown)(...inputs as never[]);
      };
    }
    if (!Object.hasOwn(methods, name)) throw new Error('Unknown strategy SDK method');
    return methods[name]!(...args as never[]);
  };
  const sync = vm.newFunction('__sync', (name, encoded) => {
    try {
      const json = vm.getString(encoded!);
      if (json.length > 2_000_000) throw new Error('Strategy SDK request exceeds 2 MB');
      return value(dispatch(vm.getString(name!), JSON.parse(json) as unknown[]));
    }
    catch (error) { return { error: vm.newError(error instanceof Error ? error.message : String(error)) }; }
  });
  const async = vm.newFunction('__async', (name, encoded) => {
    const d = vm.newPromise();
    deferreds.add(d);
    let response: unknown;
    try {
      const json = vm.getString(encoded!);
      if (json.length > 2_000_000) throw new Error('Strategy SDK request exceeds 2 MB');
      response = dispatch(vm.getString(name!), JSON.parse(json) as unknown[]);
    }
    catch (error) { response = Promise.reject(error); }
    const job = Promise.resolve(response).then((data) => {
      cpuDeadline = Math.min(deadline, Date.now() + 50);
      if (!closed && d.alive) { const h = value(data); d.resolve(h); h.dispose(); }
    }, (error: unknown) => {
      if (!closed && d.alive) { const h = vm.newError(error instanceof Error ? error.message : String(error)); d.reject(h); h.dispose(); }
    }).catch(() => { /* A timed-out guest is disposed; no further actions may run. */ });
    pending.add(job);
    void job.finally(() => pending.delete(job));
    return d.handle;
  });
  vm.setProp(vm.global, '__sync', sync); sync.dispose();
  vm.setProp(vm.global, '__async', async); async.dispose();
  const cleaned = source.trim()
    .replace(/export\s+default\s+|module\.exports\s*=\s*|exports\.default\s*=\s*/, '__entrypoint = ')
    .replace(/export\s+(async\s+function|function|const|let|var|class)\s+/g, '$1 ');
  const definition = `
    const console = Object.fromEntries(['log','info','warn','error'].map(k => [k, (...a) => __sync('log', JSON.stringify([a.map(x => typeof x === 'object' ? JSON.stringify(x) : String(x)).join(' ')]))]));
    let __timers = new Map(), __timerId = 0;
    function setTimeout(fn, ms) { const id = ++__timerId; __timers.set(id, fn); __async('timer', JSON.stringify([ms])).then(() => { const f = __timers.get(id); __timers.delete(id); if (f) f(); }); return id; }
    function clearTimeout(id) { __timers.delete(id); }
    const __strategy = (function() {
      let __entrypoint;
      ${cleaned};
      if (typeof __entrypoint === 'function') return __entrypoint;
      if (typeof run === 'function') return run;
      if (typeof onTick === 'function') return onTick;
      if (typeof execute === 'function') return execute;
      throw new Error('Strategy must define run, onTick, execute, or a default function');
    })();`;
  try { vm.unwrapResult(vm.evalCode(definition)).dispose(); }
  catch (error) { vm.dispose(); throw error; }
  const entrypoint = vm.unwrapResult(vm.evalCode('(ctx) => Promise.resolve(__strategy(ctx))'));
  let sdk: QuickJSHandle | undefined;
  return {
    async run(context, timeoutMs = 10_000) {
      if (closed || running) throw new Error('Strategy runtime is unavailable');
      running = true;
      current = context;
      callCount = 0;
      indicatorWork = 0;
      deadline = Date.now() + timeoutMs;
      const members = (prefix: string, names: readonly string[], sync = false) =>
        `{${names.map((name) => `${JSON.stringify(name)}: (...a) => ${sync ? '__sync' : '__async'}(${JSON.stringify(`${prefix}.${name}`)}, JSON.stringify(a))`).join(',')}}`;
      cpuDeadline = Math.min(deadline, Date.now() + 50);
      let promise: QuickJSHandle | undefined;
      try {
        sdk ??= vm.unwrapResult(vm.evalCode(`({
          market: ${members('market', ['getPrice','getCandles'])},
          positions: ${members('positions', ['get','list'])},
          account: ${members('account', ['getBalance'])},
          trade: ${members('trade', ['buy','sell','close','closeAll'])},
          indicators: ${members('indicators', Object.keys(context.indicators), true)},
          log: (...a) => __sync('log', JSON.stringify(a)),
        })`));
        const params = value(context.params);
        vm.setProp(sdk, 'params', params); params.dispose();
        promise = vm.unwrapResult(vm.callFunction(entrypoint, vm.undefined, sdk));
        while (true) {
          if (Date.now() >= deadline) throw new Error('Strategy execution timed out');
          // Resolved SDK promises need a microtask turn, not a millisecond timer
          // for every SDK call in every historical candle.
          await Promise.resolve();
          cpuDeadline = Math.min(deadline, Date.now() + 50);
          const jobs = vm.runtime.executePendingJobs(100);
          if (jobs.error) {
            const error = vm.dump(jobs.error) as { message?: string };
            jobs.error.dispose();
            throw new Error(error.message ?? 'Strategy execution interrupted');
          }
          const state = vm.getPromiseState(promise);
          if (state.type === 'fulfilled') {
            const result = vm.dump(state.value); state.value.dispose();
            if (pending.size === 0) return result;
          }
          if (state.type === 'rejected') { const error = vm.dump(state.error) as { message?: string }; state.error.dispose(); throw new Error(error.message ?? 'Strategy failed'); }
          if (!vm.runtime.hasPendingJob()) {
            await Promise.resolve();
            if (vm.runtime.hasPendingJob() || state.type === 'fulfilled' && pending.size === 0) continue;
            if (pending.size > 0) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()));
                void Promise.race(pending).finally(() => { clearTimeout(timer); resolve(); });
              });
            } else await new Promise<void>((resolve) => setTimeout(resolve, 5));
          } else await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        promise?.dispose();
        current = undefined;
        running = false;
        // Never let a timer or un-awaited trade callback leak into the next candle.
        for (const d of deferreds) if (d.alive) d.dispose();
        deferreds.clear();
      }
    },
    dispose() { closed = true; for (const d of deferreds) if (d.alive) d.dispose(); deferreds.clear(); sdk?.dispose(); entrypoint.dispose(); vm.dispose(); },
  };
}
