import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGroups, GroupPositionManageModal, PositionManageModal } from './routes/Futures.tsx';
import { TradeTicket } from './routes/TradeTicket.tsx';
import { leverageForBalance, useLeverageLimits } from './hooks/useLeverageLimits.ts';
import { fetchFuturesInstrument, type FuturesPositionRow } from './api.ts';

vi.mock('./api.ts', async (original) => ({ ...await original<object>(),
  fetchFuturesInstrument: vi.fn(async () => ({ pair: 'B-ETH_USDT', marginCurrency: 'USDT', leverageTiers: [{ upToNotional: '100000', maxLeverage: 20 }] })),
  syncAccount: vi.fn(async () => ({})), fetchAccounts: vi.fn(async () => [{ id: 'account', name: 'Test account', balancesByCurrency: { USDT: '500000000' } }]),
  fetchGroups: vi.fn(async () => []), fetchAccountList: vi.fn(async () => []), fetchAssets: vi.fn(async () => []),
  fetchFuturesPositions: vi.fn(async () => ({ views: [] })), fetchKillSwitchStatus: vi.fn(async () => ({ active: false })),
  fetchMarketPrice: vi.fn(async () => ({ bestBid: '100', bestAsk: '101' })),
}));
vi.mock('./components/TradingViewChart.tsx', () => ({ TradingViewChart: () => null }));
vi.mock('./components/WatchlistPanel.tsx', () => ({ WatchlistPanel: () => null }));
vi.mock('./components/CoinPositionsDrawer.tsx', () => ({ CoinPositionsDrawer: () => null }));
vi.mock('./hooks/useLiveTicker.ts', () => ({ useLiveTicker: () => ({ bestBid: '100', bestAsk: '101', updatedAtMs: Date.now(), connected: true }) }));

const position: FuturesPositionRow = {
  venuePositionId: 'position', accountId: 'account', accountName: 'Test account', groupName: 'Test group', pair: 'B-ETH_USDT',
  marginCurrency: 'USDT', side: 'long', quantity: '1', avgEntryPrice: '100', markPrice: '100', leverage: '10',
  liquidationPrice: '80', unrealisedPnlMinor: '0', liqBufferBp: 2000, lockedMarginMinor: '1000000000',
  stopLossTrigger: '95', takeProfitTrigger: '110', fundingRateBp: null, markStaleForMs: 0,
};
let host: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['accounts'], [{ id: 'account', name: 'Test account', balancesByCurrency: { USDT: '500000000' } }]);
  client.setQueryData(['futures-instrument', 'B-ETH_USDT', 'USDT'], { leverageTiers: [{ upToNotional: '100000', maxLeverage: 20 }] });
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); });
async function render(element: React.ReactNode) {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter>{element}</MemoryRouter></QueryClientProvider>));
}
function openLeverage() { act(() => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Adjust Leverage')!.click()); }
function typeValue(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('leverage controls', () => {
  it('chooses leverage without exceeding the selected balance budget', () => {
    expect(leverageForBalance(100, 10, 5, 100, 20)).toBe(7);
    expect(100 / leverageForBalance(100, 10, 5, 25, 20)! - 10).toBeLessThanOrEqual(1.25);
    expect(leverageForBalance(100, 10, 1000, 100, 20)).toBe(1);
    expect(leverageForBalance(100, 10, 0, 100, 20)).toBeNull();
    expect(leverageForBalance(100, 1, 1, 10, 20)).toBeNull();
  });
  it('replaces the individual leverage slider with an available-balance slider', async () => {
    await render(<PositionManageModal position={position} onClose={() => {}} onExit={() => {}} onAdjust={() => {}} onProtection={() => {}} isExiting={false} isAdjusting={false} isProtecting={false} />);
    openLeverage();
    expect(host.textContent).toContain('Max 20×');
    expect(host.textContent).toContain('Available balance to use');
    expect(host.textContent).not.toContain('Slide to adjust');
    expect(host.querySelectorAll('input[type="range"]')).toHaveLength(1);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '100×')).toBe(false);
    const slider = host.querySelector<HTMLInputElement>('#leverage-balance-slider')!;
    expect(slider.disabled).toBe(false);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '100');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).toContain('Adjust Leverage to 7×');
    expect(slider.value).toBe('100');
    expect(host.textContent).toContain('Estimated extra margin: 4.2857 USDT');
    typeValue(host.querySelector<HTMLInputElement>('input[aria-label="Target leverage"]')!, '21');
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Adjust Leverage to 21×')?.disabled).toBe(true);
  });
  it('removes the group leverage slider and filters unsupported presets', async () => {
    await render(<GroupPositionManageModal group={buildGroups([position])[0]!} onClose={() => {}} onRefreshPositions={() => {}} />);
    openLeverage();
    expect(host.textContent).toContain('Max 20×');
    expect(host.querySelectorAll('input[type="range"]')).toHaveLength(0);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '50×' || b.textContent === '100×')).toBe(false);
    typeValue(host.querySelector<HTMLInputElement>('input[aria-label="Target group leverage"]')!, '2.5');
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'No Accounts Selected')?.disabled).toBe(true);
  });
  it('disables leverage management when the exchange limits are unavailable', async () => {
    client.setQueryData(['futures-instrument', 'B-ETH_USDT', 'USDT'], { leverageTiers: [] });
    await render(<GroupPositionManageModal group={buildGroups([position])[0]!} onClose={() => {}} onRefreshPositions={() => {}} />);
    openLeverage();
    expect(host.textContent).toContain('Leverage limits unavailable');
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'No Accounts Selected')?.disabled).toBe(true);
  });
  it('shows the coin limit on the trade ticket and keeps an excessive saved value invalid', async () => {
    localStorage.setItem('tradex_ticket_draft', JSON.stringify({ asset: 'ETH', marginCurrency: 'USDT', leverage: '100' }));
    await render(<TradeTicket />);
    expect(host.textContent).toContain('Max 20×');
    expect(host.textContent).toContain('Choose a whole-number leverage from 1 to 20×');
    expect(host.querySelector<HTMLInputElement>('#lev')?.value).toBe('100');
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="Increase leverage"]')?.disabled).toBe(true);
  });
  it('does not reuse another coin’s cached limit while the new coin loads', async () => {
    vi.mocked(fetchFuturesInstrument).mockImplementationOnce(() => new Promise(() => {}));
    function Limits({ pair }: { pair: string }) { const limits = useLeverageLimits(pair, 'USDT'); return <span>{limits.maxLeverage}</span>; }
    await render(<Limits pair="B-ETH_USDT" />); expect(host.textContent).toBe('20');
    await render(<Limits pair="B-SOL_USDT" />); expect(host.textContent).toBe('0');
  });
});
