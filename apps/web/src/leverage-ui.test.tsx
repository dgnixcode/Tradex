import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGroups, GroupPositionManageModal, PositionManageModal } from './routes/Futures.tsx';
import { TradeTicket } from './routes/TradeTicket.tsx';
import { computeCenteredLeverage, computeLeverageFromAmountDelta, computeSliderValueFromLeverage, leverageForBalance, useLeverageLimits } from './hooks/useLeverageLimits.ts';
import { fetchAccounts, fetchFuturesInstrument, fetchFuturesFreeBalance, changeFuturesPositionMargin, updateFuturesPositionLeverage, type FuturesPositionRow } from './api.ts';

vi.mock('./api.ts', async (original) => ({ ...await original<object>(),
  fetchFuturesInstrument: vi.fn(async () => ({ pair: 'B-ETH_USDT', marginCurrency: 'USDT', leverageTiers: [{ upToNotional: '100000', maxLeverage: 20 }] })),
  syncAccount: vi.fn(async () => ({})), fetchAccounts: vi.fn(async () => [{ id: 'account', name: 'Test account', balancesByCurrency: { USDT: '500000000' } }]),
  fetchGroups: vi.fn(async () => []), fetchAccountList: vi.fn(async () => []), fetchAssets: vi.fn(async () => []),
  fetchFuturesPositions: vi.fn(async () => ({ views: [] })), fetchKillSwitchStatus: vi.fn(async () => ({ active: false })),
  fetchMarketPrice: vi.fn(async () => ({ bestBid: '100', bestAsk: '101' })),
  fetchFuturesFreeBalance: vi.fn(async () => ({ currency: 'USDT', freeMinor: '500000000' })),
  changeFuturesPositionMargin: vi.fn(async (_id, amount, marginCurrency, direction) => ({ ok: true, amount, marginCurrency, direction, refreshPending: false })),
  updateFuturesPositionLeverage: vi.fn(async () => ({ ok: true, newLeverage: '10' })),
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
  vi.mocked(fetchFuturesFreeBalance).mockReset().mockResolvedValue({ currency: 'USDT', freeMinor: '500000000' });
  vi.mocked(changeFuturesPositionMargin).mockClear(); vi.mocked(updateFuturesPositionLeverage).mockClear();
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
async function openLeverage() {
  await act(async () => [...host.querySelectorAll('button')].find((b) => b.textContent === 'Adjust Leverage')!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}
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

    // Centered slider math: center (0), right (+100 = 20x), left (-33 = 7x, -100 = 1x)
    expect(computeCenteredLeverage(0, 10, 20)).toBe('10');
    expect(computeCenteredLeverage(100, 10, 20)).toBe('20');
    expect(computeCenteredLeverage(-33, 10, 20)).toBe('7');
    expect(computeCenteredLeverage(-100, 10, 20)).toBe('1');
    expect(computeSliderValueFromLeverage(10, 10, 20)).toBe(0);
    expect(computeSliderValueFromLeverage(20, 10, 20)).toBe(100);
    expect(computeSliderValueFromLeverage(7, 10, 20)).toBe(-33);
    expect(computeSliderValueFromLeverage(1, 10, 20)).toBe(-100);

    // Decimal positions (e.g. 2.3x leverage): smooth sliding left in 0.1 increments
    expect(computeCenteredLeverage(-10, 2.3, 20)).toBe('2.2');
    expect(computeCenteredLeverage(-50, 2.3, 20)).toBe('1.6');

    // Margin amount delta to leverage conversion
    expect(computeLeverageFromAmountDelta(4.2857, 10, 100, 5, 20)).toBe('7');
    expect(computeLeverageFromAmountDelta(-5, 10, 100, 5, 20)).toBe('20');
    expect(computeLeverageFromAmountDelta(10, 10, 100, 5, 20)).toBe('6.7'); // clamped to free balance (5)
    expect(computeLeverageFromAmountDelta(-10, 10, 100, 5, 20)).toBe('20'); // clamped to max freeable (5)
    // Preserves 0.1 decimal precision without rounding 1.3 to 1.5
    expect(computeLeverageFromAmountDelta(5000, 1000, 7800, 10000, 20)).toBe('1.3');
  });
  it('replaces the individual leverage slider with an available-balance slider', async () => {
    await render(<PositionManageModal position={position} onClose={() => {}} onExit={() => {}} onAdjust={() => {}} onProtection={() => {}} isExiting={false} isAdjusting={false} isProtecting={false} />);
    await openLeverage();
    expect(host.textContent).toContain('Max 20×');
    expect(host.textContent).toContain('Available balance to use');
    expect(host.textContent).not.toContain('Slide to adjust');
    expect(host.querySelectorAll('input[type="range"]')).toHaveLength(1);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '100×')).toBe(false);
    const slider = host.querySelector<HTMLInputElement>('#leverage-balance-slider')!;
    expect(slider.disabled).toBe(false);
    expect(slider.min).toBe('-100');
    expect(slider.max).toBe('100');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '-33');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).toContain('Adjust Leverage to 7×');
    expect(slider.value).toBe('-33');
    expect(host.textContent).toContain('Estimated extra margin: 4.2857 USDT');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(slider, '100');
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      slider.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(host.textContent).toContain('Adjust Leverage to 20×');
    expect(slider.value).toBe('100');
    expect(host.textContent).toContain('Estimated margin to be freed: 5.0000 USDT');
    typeValue(host.querySelector<HTMLInputElement>('input[aria-label="Target leverage"]')!, '21');
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'Adjust Leverage to 21×')?.disabled).toBe(true);
  });
  it('allows entering positive or negative margin amounts without exceeding own balance', async () => {
    await render(<PositionManageModal position={position} onClose={() => {}} onExit={() => {}} onAdjust={() => {}} onProtection={() => {}} isExiting={false} isAdjusting={false} isProtecting={false} />);
    await openLeverage();
    const amountInput = host.querySelector<HTMLInputElement>('#margin-amount-input')!;
    expect(amountInput).toBeTruthy();
    expect(amountInput.value).toBe('0');

    // Type positive amount (+4.2857) to reduce leverage to 7x
    typeValue(amountInput, '+4.2857');
    expect(host.textContent).toContain('Add 4.2857 USDT to Margin');
    expect(amountInput.value).toBe('+4.2857');

    // Type negative amount (-5) to increase leverage to 20x
    typeValue(amountInput, '-5');
    expect(host.textContent).toContain('Remove 5 USDT from Margin');
    expect(amountInput.value).toBe('-5');

    // An over-budget amount stays visible and must not silently change the transfer.
    typeValue(amountInput, '+10');
    expect(amountInput.value).toBe('+10');
    expect([...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add 10 USDT to Margin')?.disabled).toBe(true);
  });
  it('removes the group leverage slider and filters unsupported presets', async () => {
    await render(<GroupPositionManageModal group={buildGroups([position])[0]!} onClose={() => {}} onRefreshPositions={() => {}} />);
    await openLeverage();
    expect(host.textContent).toContain('Max 20×');
    expect(host.querySelectorAll('input[type="range"]')).toHaveLength(0);
    expect([...host.querySelectorAll('button')].some((b) => b.textContent === '50×' || b.textContent === '100×')).toBe(false);
    typeValue(host.querySelector<HTMLInputElement>('input[aria-label="Target group leverage"]')!, '2.5');
    expect([...host.querySelectorAll('button')].find((b) => b.textContent === 'No Accounts Selected')?.disabled).toBe(true);
  });
  it('submits exactly ₹500 as native INR margin without updating configured leverage or placing an order', async () => {
    vi.mocked(fetchFuturesFreeBalance).mockResolvedValue({ currency: 'INR', freeMinor: '100000' });
    const inrPosition = { ...position, marginCurrency: 'INR' as const, lockedMarginMinor: '264000', avgEntryPrice: '97.63',
      settlementCurrencyAvgPrice: '100', leverage: '3.7' };
    await render(<PositionManageModal position={inrPosition} onClose={() => {}} onExit={() => {}} onAdjust={() => {}} onProtection={() => {}} isExiting={false} isAdjusting={false} isProtecting={false} />);
    await openLeverage();
    typeValue(host.querySelector<HTMLInputElement>('#margin-amount-input')!, '500');
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Add ₹500 to Margin')!;
    expect(button.disabled).toBe(false);
    await act(async () => { button.click(); button.click(); });
    expect(changeFuturesPositionMargin).toHaveBeenCalledTimes(1);
    expect(changeFuturesPositionMargin).toHaveBeenCalledWith('position', '500', 'INR', 'add');
    expect(updateFuturesPositionLeverage).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Added ₹500 to position margin');
  });
  it('disables leverage management when the exchange limits are unavailable', async () => {
    client.setQueryData(['futures-instrument', 'B-ETH_USDT', 'USDT'], { leverageTiers: [] });
    await render(<GroupPositionManageModal group={buildGroups([position])[0]!} onClose={() => {}} onRefreshPositions={() => {}} />);
    await openLeverage();
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
  it('supports decimal leverage adjustments for individual and group positions', async () => {
    vi.mocked(fetchFuturesFreeBalance).mockResolvedValue({ currency: 'USDT', freeMinor: '50000000000' });
    vi.mocked(fetchAccounts).mockResolvedValue([{ id: 'account', name: 'Test account', balancesByCurrency: { USDT: '5000000000' } } as never]);
    client.setQueryData(['accounts'], [{ id: 'account', name: 'Test account', balancesByCurrency: { USDT: '5000000000' } }]);
    await render(<PositionManageModal position={position} onClose={() => {}} onExit={() => {}} onAdjust={() => {}} onProtection={() => {}} isExiting={false} isAdjusting={false} isProtecting={false} />);
    await openLeverage();
    typeValue(host.querySelector<HTMLInputElement>('input[aria-label="Target leverage"]')!, '3.5');
    expect(host.textContent).toContain('Adjust Leverage to 3.5×');
    const singleBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Adjust Leverage to 3.5×');
    expect(singleBtn?.disabled).toBe(false);

    await render(<GroupPositionManageModal group={buildGroups([position])[0]!} onClose={() => {}} onRefreshPositions={() => {}} />);
    await openLeverage();
    typeValue(host.querySelector<HTMLInputElement>('input[aria-label="Target group leverage"]')!, '3.5');
    const groupBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Adjust Leverage on 1 Account to 3.5×');
    expect(groupBtn?.disabled).toBe(false);
  });
});
