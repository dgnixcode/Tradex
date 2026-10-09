import { afterEach, describe, expect, it, vi } from 'vitest';
import { adjustFuturesPosition, updateFuturesPositionLeverage } from './api.ts';

afterEach(() => vi.unstubAllGlobals());

describe('group position action batching', () => {
  it('sends all 80 positions in one request with separate retry keys', async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const { actions } = JSON.parse(init.body as string);
      return { ok: true, json: async () => ({ results: actions.map((item: { requestId: string }) => ({
        requestId: item.requestId, status: 200, body: { quantity: '0.001', venueOrderId: 'v', full: false },
      })) }) };
    });
    vi.stubGlobal('fetch', fetcher);
    const results = await Promise.all(Array.from({ length: 80 }, (_, i) => adjustFuturesPosition(`position-${i}`, 'reduce', 2500)));
    expect(results).toHaveLength(80);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe('/api/futures/positions/batch');
    const { actions } = JSON.parse(fetcher.mock.calls[0]![1].body as string);
    expect(new Set(actions.map((a: { requestId: string }) => a.requestId)).size).toBe(80);
  });
  it('reports each account failure while preserving successful results', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const { actions } = JSON.parse(init.body as string);
      return { ok: true, json: async () => ({ results: actions.map((item: { requestId: string }, i: number) => ({
        requestId: item.requestId, status: i === 0 ? 409 : 200,
        body: i === 0 ? { message: 'Needs reconciliation' } : { ok: true, newLeverage: '5' },
      })) }) };
    }));
    const results = await Promise.allSettled(['p1', 'p2'].map((id) => updateFuturesPositionLeverage(id, 5)));
    expect(results[0]?.status).toBe('rejected');
    expect(results[1]).toEqual({ status: 'fulfilled', value: { ok: true, newLeverage: '5' } });
  });
});
