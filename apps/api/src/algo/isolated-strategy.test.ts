import { describe, expect, it, vi } from 'vitest';
import { executeStrategyScript } from './algo-runner.js';
import type { AlgoContext } from './algo-sdk.js';
import * as indicators from './algo-indicators.js';

function context(): AlgoContext {
  return {
    market: { getPrice: async () => 100, getCandles: async () => [] },
    positions: { get: async () => null, list: async () => [] },
    account: { getBalance: async () => ({ freeMargin: 0, totalEquity: 0, currency: 'USDT' }) },
    indicators, params: {}, log: vi.fn(),
    trade: { buy: async () => ({ success: true }), sell: async () => ({ success: true }), close: async () => ({ success: true, pair: '', exitedCount: 0 }), closeAll: async () => [] },
  };
}

describe('strategy isolation', () => {
  it.each([
    'return process.env',
    'return ctx.market.getPrice.constructor("return process")().env',
    'return (await ctx.account.getBalance()).constructor.constructor("return process")().env',
  ])('prevents Node access through %s', async (body) => {
    const result = await executeStrategyScript(`export default async function(ctx) { ${body}; }`, context(), 500);
    expect(result.success).toBe(false);
  });
  it.each(['while(true) {}', 'await ctx.market.getPrice(); while(true) {}', 'while(true) { await Promise.resolve(); }'])('interrupts runaway code: %s', async (body) => {
    const started = Date.now();
    const result = await executeStrategyScript(`export default async function(ctx) { ${body} }`, context(), 150);
    expect(result.success).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it('does not return success while an unawaited SDK trade is pending', async () => {
    const base = context();
    let finished = false;
    const ctx: AlgoContext = { ...base, trade: { ...base.trade,
      buy: async () => { await new Promise((r) => setTimeout(r, 20)); finished = true; return { success: true }; },
    } };
    const result = await executeStrategyScript('export default function(ctx) { ctx.trade.buy({}); }', ctx, 500);
    expect(result.success, result.error).toBe(true);
    expect(finished).toBe(true);
    expect(result.actionsTaken).toHaveLength(1);
  });
  it('waits for an already-started trade even when the guest times out', async () => {
    const base = context();
    let finished = false;
    const ctx: AlgoContext = { ...base, trade: { ...base.trade,
      buy: async () => { await new Promise((r) => setTimeout(r, 100)); finished = true; return { success: true }; },
    } };
    const result = await executeStrategyScript('export default async function(ctx) { await ctx.trade.buy({}); }', ctx, 20);
    expect(result.success).toBe(false);
    expect(finished).toBe(true);
  });
  it('rejects fake array lengths before running host indicators', async () => {
    const result = await executeStrategyScript('export default function(ctx) { ctx.indicators.sma({length:1e300}, 10); }', context(), 150);
    expect(result.success).toBe(false);
    expect(result.error).toContain('bounded data array');
  });
});
