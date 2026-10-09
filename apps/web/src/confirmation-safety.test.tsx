import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Confirmation } from './routes/Confirmation.tsx';
import { confirmTrade, type PreviewResult, type PreviewRow } from './api.ts';

vi.mock('./api.ts', () => ({
  fetchTrade: vi.fn(), fetchKillSwitchStatus: vi.fn(async () => ({ active: false })),
  confirmTrade: vi.fn(() => new Promise(() => {})),
}));

let host: HTMLDivElement;
let root: Root;
let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(confirmTrade).mockClear();
});
afterEach(() => {
  act(() => root.unmount()); client.clear(); host.remove(); localStorage.clear(); vi.unstubAllGlobals();
});

const row: PreviewRow = {
  childOrderId: 'child', accountId: 'account', accountName: 'Test account', state: 'planned',
  market: 'B-BTC_USDT', quoteCurrency: 'USDT', finalQuantity: '0.01', priceUsed: '60000',
  notionalMinor: '60000000000', basisUsed: 'allocated', basisAmountMinor: '12000000000',
  currencyChoiceReason: null, spreadIsWide: false, refusalCode: null, refusalDetail: null,
};
function plan(patch: Partial<PreviewResult> = {}): PreviewResult {
  return {
    groupTradeId: 'plan', previewToken: 'persisted-token', previewExpiresAtMs: Date.now() + 60000,
    plannedCount: 1, skippedCount: 0, rows: [row], isFutures: true,
    leverage: '5', side: 'buy', asset: 'BTC', orderType: 'limit', marginCurrency: 'USDT', positionMarginType: 'isolated',
    ...patch,
  };
}
async function render(savedPlan: PreviewResult) {
  client.setQueryData(['trade', 'plan'], savedPlan);
  await act(async () => root.render(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/app/trades/plan']}><Routes>
      <Route path="/app/trades/:groupTradeId" element={<Confirmation />} />
    </Routes></MemoryRouter>
  </QueryClientProvider>));
}
const confirmButton = () => host.querySelector<HTMLButtonElement>('.desk-send-button')!;

describe('persisted order confirmation', () => {
  it('shows the saved trailing step basis and initial protection before confirmation', async () => {
    await render(plan({ stopLossPrice: '55000', trailingStopLoss: true, trailingStepBasis: 'roe', trailingStepBp: '100' }));
    expect(host.textContent).toContain('Trailing: 1% ROE step');
    expect(host.textContent).toContain('55000');
  });
  it('shows the saved server order despite a conflicting draft and authorizes once on rapid clicks', async () => {
    localStorage.setItem('tradex_ticket_draft', JSON.stringify({ side: 'sell', asset: 'ETH', leverage: '100' }));
    await render(plan());
    expect(host.textContent).toContain('Long BTC · limit · 1 account');
    expect(host.textContent).not.toContain('ETH');
    await act(async () => { confirmButton().click(); confirmButton().click(); });
    expect(confirmTrade).toHaveBeenCalledTimes(1);
    expect(confirmTrade).toHaveBeenCalledWith('plan', 'persisted-token');
  });

  it('requires explicit acknowledgement of skipped accounts', async () => {
    await render(plan({ skippedCount: 1, rows: [row, { ...row, childOrderId: 'skipped', accountId: 'other', state: 'skipped', refusalDetail: 'Insufficient margin' }] }));
    expect(confirmButton().disabled).toBe(true);
    act(() => host.querySelector<HTMLInputElement>('.ack input')!.click());
    expect(confirmButton().disabled).toBe(false);
  });

  it('blocks an expired preview', async () => {
    await render(plan({ previewExpiresAtMs: Date.now() - 1000 }));
    expect(confirmButton().disabled).toBe(true);
    expect(confirmButton().textContent).toBe('Preview expired');
    expect(confirmTrade).not.toHaveBeenCalled();
  });
});
