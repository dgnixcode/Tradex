import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Confirmation } from './routes/Confirmation.tsx';
import { Execution } from './routes/Execution.tsx';
import { confirmTrade, fetchExecutionReport, fetchTrade, type ConfirmResult, type ExecutionReportResponse, type PreviewResult } from './api.ts';

vi.mock('./api.ts', () => ({
  fetchTrade: vi.fn(), fetchExecutionReport: vi.fn(), confirmTrade: vi.fn(), retryFailedTrade: vi.fn(),
  fetchKillSwitchStatus: vi.fn(async () => ({ active: false })),
  ApiError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
}));

const plan: PreviewResult = {
  groupTradeId: 'plan', previewToken: 'saved-token', previewExpiresAtMs: Date.now() + 600000,
  plannedCount: 1, skippedCount: 0, isFutures: true, side: 'buy', asset: 'BTC', orderType: 'market', leverage: '5', marginCurrency: 'INR',
  rows: [{ childOrderId: 'child', accountId: 'account', accountName: 'Test account', state: 'planned', market: 'B-BTC_USDT', quoteCurrency: 'INR',
    finalQuantity: '0.01', priceUsed: '60000', notionalMinor: '6000000', basisUsed: 'allocated', basisAmountMinor: '1200000',
    currencyChoiceReason: null, spreadIsWide: false, refusalCode: null, refusalDetail: null }],
};
function snapshot(status: string, state = 'planned'): ExecutionReportResponse {
  const placed = ['filled', 'open', 'acked', 'partially_filled'].includes(state);
  return { status, dryRun: false, report: {
    planned: 1, placed: Number(placed), skipped: 0, rejected: Number(state === 'rejected'), needsReview: Number(state === 'unknown'),
    allPlaced: placed, groupedCauses: [], rows: [{ accountId: 'account', state, market: 'B-BTC_USDT', finalQuantity: '0.01', notionalMinor: '6000000',
      reason: state === 'rejected' ? 'Insufficient funds' : null, refusalCode: state === 'rejected' ? 'funds' : null,
      coid: null, exchangeOrderId: placed ? 'venue-order' : null }],
  } };
}
class FakeStream {
  static CLOSED = 2;
  static instances: FakeStream[] = [];
  readyState = 1; onerror: (() => void) | null = null;
  listeners = new Map<string, EventListener>();
  constructor() { FakeStream.instances.push(this); }
  addEventListener(name: string, listener: EventListener) { this.listeners.set(name, listener); }
  close() { this.readyState = 2; }
  emit(name: string, data: unknown) { this.listeners.get(name)?.(new MessageEvent(name, { data: JSON.stringify(data) })); }
}
let host: HTMLDivElement, root: Root, client: QueryClient;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('EventSource', FakeStream);
  FakeStream.instances = [];
  vi.mocked(fetchTrade).mockReset().mockResolvedValue(plan);
  vi.mocked(fetchExecutionReport).mockReset().mockResolvedValue(snapshot('previewed'));
  vi.mocked(confirmTrade).mockReset().mockImplementation(() => new Promise(() => {}));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(['trade', 'plan'], plan);
});
afterEach(async () => {
  await act(async () => root.unmount()); client.clear(); host.remove(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals();
});
async function flush(ms = 5) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
async function render(progress = false) {
  await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[`/app/trades/plan${progress ? '/progress' : ''}`]}>
    <Routes><Route path="/app/trades/:groupTradeId" element={<Confirmation />} /><Route path="/app/trades/:groupTradeId/progress" element={<Execution />} /><Route path="/app/positions" element={<p>Positions overview</p>} /></Routes>
  </MemoryRouter></QueryClientProvider>));
  await flush();
}
async function submit() { await act(async () => host.querySelector<HTMLButtonElement>('.desk-send-button')!.click()); await flush(); }

it('follows completed execution while the confirm response is still pending, without resending', async () => {
  await render(); expect(confirmTrade).not.toHaveBeenCalled();
  localStorage.setItem('tradex_ticket_draft', 'saved');
  await submit(); expect(host.textContent).toContain('Submitting order');
  vi.mocked(fetchExecutionReport).mockResolvedValue(snapshot('completed', 'filled'));
  await flush(1100);
  expect(host.textContent).toContain('Trade executed successfully');
  expect(host.textContent).toContain('venue-order');
  expect(host.querySelector('.desk-send-button')).toBeNull();
  expect(confirmTrade).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('tradex_ticket_draft')).toBeNull();
});

it('recovers a lost confirm response through read-only checks and never authorizes again', async () => {
  vi.mocked(confirmTrade).mockRejectedValue(new TypeError('Failed to fetch'));
  await render(); await submit();
  expect(host.textContent).toContain('Submission outcome is being checked');
  expect(host.querySelector<HTMLButtonElement>('.desk-send-button')!.disabled).toBe(true);
  vi.mocked(fetchExecutionReport).mockResolvedValue(snapshot('executing', 'open'));
  await flush(1100);
  expect(host.textContent).toContain('Orders placed — awaiting fills');
  expect(host.textContent).not.toContain('Trade executed successfully');
  expect(confirmTrade).toHaveBeenCalledTimes(1);
});

it('reopens an accepted trade directly in execution instead of offering confirmation', async () => {
  vi.mocked(fetchExecutionReport).mockResolvedValue(snapshot('completed', 'filled'));
  await render(); await flush();
  expect(host.textContent).toContain('Trade executed successfully');
  expect(confirmTrade).not.toHaveBeenCalled();
});

it('shows a completed dry run honestly without reporting a real fill', async () => {
  vi.mocked(confirmTrade).mockResolvedValue({ status: 'completed', dryRun: true });
  await render(); await submit();
  expect(host.textContent).toContain('Dry run recorded. Nothing was sent');
  expect(host.textContent).not.toContain('Trade executed successfully');
});

it('polls through a failed stream, shows limit placement, then picks up fills automatically', async () => {
  vi.mocked(fetchExecutionReport).mockResolvedValue(snapshot('executing', 'open'));
  await render(true);
  const stream = FakeStream.instances[0]!;
  await act(async () => { stream.readyState = FakeStream.CLOSED; stream.onerror?.(); });
  expect(host.textContent).toContain('Orders placed — awaiting fills');
  vi.mocked(fetchExecutionReport).mockResolvedValue(snapshot('completed', 'filled'));
  await flush(1600);
  expect(host.textContent).toContain('Trade executed successfully');
  expect(host.textContent).toContain('venue-order');
  const reads = vi.mocked(fetchExecutionReport).mock.calls.length;
  await flush(5000); expect(fetchExecutionReport).toHaveBeenCalledTimes(reads);
  expect(confirmTrade).not.toHaveBeenCalled();
});

it('uses the final report even when individual stream events were lost', async () => {
  await render(true);
  const stream = FakeStream.instances[0]!;
  vi.mocked(fetchExecutionReport).mockResolvedValue(snapshot('completed', 'rejected'));
  await act(async () => stream.emit('report', snapshot('completed', 'rejected')));
  await flush();
  expect(host.textContent).toContain('Insufficient funds');
  expect(host.textContent).toContain('1 failed');
  expect(host.textContent).not.toContain('Trade executed successfully');
  expect(stream.readyState).toBe(FakeStream.CLOSED);
});

it('keeps uncertain outcomes distinct from success and offers only status refresh', async () => {
  vi.mocked(fetchExecutionReport).mockResolvedValue(snapshot('executing', 'unknown'));
  await render(true);
  expect(host.textContent).toContain('Execution needs review');
  expect(host.textContent).toContain('do not resubmit');
  expect(host.textContent).not.toContain('Trade executed successfully');
  expect(confirmTrade).not.toHaveBeenCalled();
});

it('continues checking after a report-read outage without asking the user to reload', async () => {
  vi.mocked(fetchExecutionReport).mockRejectedValue(new Error('Network unavailable'));
  await render(true);
  expect(host.textContent).toContain('Status updates are temporarily unavailable');
  vi.mocked(fetchExecutionReport).mockResolvedValue(snapshot('completed', 'filled'));
  await flush(1600);
  expect(host.textContent).toContain('Trade executed successfully');
  expect(confirmTrade).not.toHaveBeenCalled();
});

it('blocks confirmation while current status is unavailable, then allows a read-only refresh', async () => {
  vi.mocked(fetchExecutionReport).mockRejectedValue(new Error('Network unavailable'));
  await render();
  expect(host.querySelector<HTMLButtonElement>('.desk-send-button')!.disabled).toBe(true);
  expect(host.textContent).toContain('Current order status could not be verified');
  vi.mocked(fetchExecutionReport).mockResolvedValue(snapshot('previewed'));
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Refresh status')!.click());
  await flush();
  expect(host.querySelector<HTMLButtonElement>('.desk-send-button')!.disabled).toBe(false);
  expect(confirmTrade).not.toHaveBeenCalled();
});

it('polls even if a connected stream stops emitting state updates', async () => {
  await render(true);
  const stream = FakeStream.instances[0]!;
  await act(async () => {
    stream.emit('state', { accountId: 'account', state: 'sending' });
    stream.emit('header', { status: 'executing', dryRun: false });
  });
  vi.mocked(fetchExecutionReport).mockResolvedValue(snapshot('executing', 'open'));
  await flush(1600);
  expect(host.textContent).toContain('Orders placed — awaiting fills');
  expect(host.textContent).toContain('venue-order');
  expect(confirmTrade).not.toHaveBeenCalled();
});

it('reports partial group outcomes per account instead of calling the whole trade successful', async () => {
  const groupedPlan = { ...plan, plannedCount: 2, rows: [...plan.rows, { ...plan.rows[0]!, childOrderId: 'child2', accountId: 'account2', accountName: 'Second account' }] };
  client.setQueryData(['trade', 'plan'], groupedPlan); vi.mocked(fetchTrade).mockResolvedValue(groupedPlan);
  const partial = snapshot('completed', 'filled');
  const failed = { ...snapshot('completed', 'rejected').report.rows[0]!, accountId: 'account2' };
  vi.mocked(fetchExecutionReport).mockResolvedValue({ ...partial, report: { ...partial.report, planned: 2, rejected: 1, allPlaced: false, rows: [...partial.report.rows, failed] } });
  await render(true);
  expect(host.textContent).toContain('Execution finished');
  expect(host.textContent).toContain('1 placed · 1 filled');
  expect(host.textContent).toContain('Second account');
  expect(host.textContent).toContain('Insufficient funds');
  expect(host.textContent).not.toContain('Trade executed successfully');
  expect(confirmTrade).not.toHaveBeenCalled();
});

it('does not pull the user back to an old trade when its confirm response arrives late', async () => {
  let finish!: (result: ConfirmResult) => void;
  vi.mocked(confirmTrade).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await render(); await submit();
  const completed = snapshot('completed', 'filled');
  vi.mocked(fetchExecutionReport).mockResolvedValue(completed);
  await flush(1100);
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'View positions')!.click());
  expect(host.textContent).toBe('Positions overview');
  await act(async () => finish({ ...completed }));
  await flush();
  expect(host.textContent).toBe('Positions overview');
  expect(confirmTrade).toHaveBeenCalledTimes(1);
});

it('does not call an unaccepted preview a recorded dry run while submission is pending', async () => {
  vi.mocked(fetchExecutionReport).mockResolvedValue({ ...snapshot('previewed'), dryRun: true });
  await render(true);
  expect(host.textContent).toContain('Checking execution…');
  expect(host.textContent).not.toContain('Dry run recorded');
  expect(confirmTrade).not.toHaveBeenCalled();
});
