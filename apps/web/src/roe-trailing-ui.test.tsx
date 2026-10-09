import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGroups, calcGroupRoePct, calcRoePct, GroupPositionManageModal } from './routes/Futures.tsx';
import { setFuturesProtection, setTrailingProtection, type FuturesPositionRow } from './api.ts';

vi.mock('./api.ts', async (original) => ({
  ...await original<object>(),
  setFuturesProtection: vi.fn(), setTrailingProtection: vi.fn(),
  fetchKillSwitchStatus: vi.fn(async () => ({ active: false })),
}));
const position: FuturesPositionRow = {
  venuePositionId: 'position', accountId: 'account', accountName: 'Test account', groupName: 'Test group',
  pair: 'B-BTC_USDT', marginCurrency: 'USDT', side: 'long', quantity: '1', avgEntryPrice: '100', markPrice: '101',
  liquidationPrice: '80', unrealisedPnlMinor: '100000000', liqBufferBp: 2000, leverage: '10', lockedMarginMinor: '1000000000',
  stopLossTrigger: '95', takeProfitTrigger: '110', fundingRateBp: null, markStaleForMs: 0,
};
let host: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); client.setQueryData(['accounts'], []);
  vi.mocked(setFuturesProtection).mockReset().mockResolvedValue({ stopLoss: { ok: true }, takeProfit: { ok: true } });
  vi.mocked(setTrailingProtection).mockReset().mockResolvedValue({ ok: true, message: 'enabled' });
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });

describe('ROE display and management', () => {
  it('matches return on actual margin after adding collateral', () => {
    expect(calcRoePct(position)).toBe(10);
    expect(calcRoePct({ ...position, lockedMarginMinor: '2000000000' })).toBe(5);
    expect(calcRoePct({ ...position, side: 'short', markPrice: '99' })).toBe(10);
    expect(calcRoePct({ ...position, marginCurrency: 'INR', lockedMarginMinor: '80000', settlementCurrencyAvgPrice: '80' })).toBe(10);
    expect(calcRoePct({ ...position, marginCurrency: 'INR', settlementCurrencyAvgPrice: null })).toBeNull();
  });
  it('weights group ROE by collateral instead of quantity', () => {
    const group = buildGroups([position, { ...position, venuePositionId: 'other', lockedMarginMinor: '2000000000' }])[0]!;
    expect(calcGroupRoePct(group)).toBeCloseTo(20 / 3);
  });
  async function enableGroupTrailing() {
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <GroupPositionManageModal group={buildGroups([position])[0]!} onClose={() => {}} onRefreshPositions={() => {}} />
    </MemoryRouter></QueryClientProvider>));
    act(() => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('SL / TP Protection'))!.click());
    expect(host.textContent).toContain('Auto-Trailing SL (1% ROE step)');
    act(() => host.querySelector<HTMLInputElement>('#grp-trailing')!.click());
    await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Apply Rules to All'))!.click());
  }
  it('sends the chosen stop with a ROE step and no forced 1% price distance', async () => {
    await enableGroupTrailing();
    expect(setTrailingProtection).toHaveBeenCalledWith('position', { enable: true, currentSlPrice: '95', stepBp: '100', stepBasis: 'roe' });
  });
  it('does not enable trailing when the venue refused the underlying stop', async () => {
    vi.mocked(setFuturesProtection).mockResolvedValue({ stopLoss: { ok: false, reason: 'refused' } });
    await enableGroupTrailing();
    expect(setTrailingProtection).not.toHaveBeenCalled();
    expect(host.textContent).toContain('1 failed');
  });
});
