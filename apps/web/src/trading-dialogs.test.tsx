import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickExitModal, GroupPositionManageModal, buildGroups } from './routes/Futures.tsx';
import { GroupOrderItem } from './routes/Blotter.tsx';
import type { FuturesPositionRow } from './api.ts';
import { useSafeDialog } from './hooks/useSafeDialog.ts';

vi.mock('./api.js', async (original) => ({
  ...await original<object>(),
  exitFuturesPosition: vi.fn(() => new Promise(() => {})),
  adjustFuturesPosition: vi.fn(() => new Promise(() => {})),
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

describe('group action and order status safety', () => {
  it('dispatches a funded group addition once on rapid clicks and keeps the modal locked while pending', async () => {
    const { adjustFuturesPosition } = await import('./api.js');
    vi.mocked(adjustFuturesPosition).mockClear();
    const client = new QueryClient();
    client.setQueryData(['accounts'], [{ id: 'account-A', name: 'A', allocatedCurrency: 'USDT', allocatedCapitalMinor: '10000000000', balancesByCurrency: { USDT: '10000000000' } }]);
    const onClose = vi.fn();
    act(() => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <GroupPositionManageModal group={buildGroups([position('A')])[0]!} onClose={onClose} onRefreshPositions={() => {}} />
    </MemoryRouter></QueryClientProvider>));
    // New dialogs start with a blank explicit quantity, requiring deliberate input.
    expect(host.querySelector<HTMLInputElement>('input[placeholder="e.g. 0.01"]')?.value).toBe('');
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('% of Available Balance'))!.click());
    const send = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Funded Account'))!;
    expect(send.disabled).toBe(false);
    act(() => { send.click(); send.click(); });
    expect(adjustFuturesPosition).toHaveBeenCalledTimes(1);
    const args = vi.mocked(adjustFuturesPosition).mock.calls[0]!;
    expect(args[4]).toBe('0.002083333333333333');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('.position-modal-close')?.disabled).toBe(true);
    act(() => root.render(null)); client.clear();
  });

  it('never presents a resting group order as fully filled', () => {
    act(() => root.render(<MemoryRouter><GroupOrderItem isExpanded={false} onToggle={() => {}} g={{
      groupTradeId: 'order', groupId: 'group', groupName: 'Test group', asset: 'BTC', market: 'B-BTC_USDT',
      side: 'buy', orderType: 'limit', isFutures: true, sizingMode: 'base_quantity', status: 'executing',
      createdAtMs: Date.now(), totalAccounts: 3, filledCount: 0, skippedCount: 0, failedCount: 0,
      totalQuantity: '0.03', children: [],
    }} /></MemoryRouter>));
    expect(host.querySelector('.badge.planned')).toBe(null);
    expect(host.querySelector('.badge.state-working')?.textContent).toContain('0/3 Filled');
  });
});

describe('explicit group partial exit', () => {
  it('blocks quantity above the smallest account and sends the exact small quantity per account', async () => {
    const { adjustFuturesPosition } = await import('./api.js');
    vi.mocked(adjustFuturesPosition).mockClear();
    const client = new QueryClient();
    client.setQueryData(['accounts'], []);
    const group = buildGroups([position('A'), { ...position('B'), quantity: '0.0001' }])[0]!;
    act(() => root.render(<QueryClientProvider client={client}><MemoryRouter>
      <GroupPositionManageModal group={group} onClose={() => {}} onRefreshPositions={() => {}} />
    </MemoryRouter></QueryClientProvider>));
    act(() => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Partial Exit'))!.click());
    expect(host.querySelector('.position-reduction-mode button[aria-pressed="true"]')?.textContent).toBe('Qty');
    const input = host.querySelector<HTMLInputElement>('.position-reduction-mode input')!;
    const setQuantity = (value: string) => act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const send = () => [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Across All'))!;
    expect(send().disabled).toBe(true);
    setQuantity('0.001');
    expect(send().disabled).toBe(true);
    expect(adjustFuturesPosition).not.toHaveBeenCalled();
    setQuantity('0.000000000000000001');
    expect(send().disabled).toBe(false);
    act(() => { send().click(); send().click(); });
    expect(adjustFuturesPosition).toHaveBeenCalledTimes(2);
    for (const args of vi.mocked(adjustFuturesPosition).mock.calls) {
      expect(args[1]).toBe('reduce');
      expect(args[2]).toBeUndefined();
      expect(args[4]).toBe('0.000000000000000001');
    }
    act(() => root.render(null)); client.clear();
  });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function position(id: string): FuturesPositionRow {
  return {
    venuePositionId: id, accountId: `account-${id}`, accountName: id,
    groupName: 'Test group', pair: 'B-BTC_USDT', marginCurrency: 'USDT', side: 'long',
    quantity: '0.01', avgEntryPrice: '60000', markPrice: '61000', liquidationPrice: '50000',
    unrealisedPnlMinor: '1000000000', liqBufferBp: 1800, leverage: '5', lockedMarginMinor: '12000000000',
    stopLossTrigger: '55000', takeProfitTrigger: '65000', fundingRateBp: null, markStaleForMs: 0,
  };
}
const checkbox = (name: string) => host.querySelector<HTMLInputElement>(`input[aria-label="Select account ${name}"]`)!;

describe('market exit safety', () => {
  it('preserves exclusions through live refreshes and leaves newly appearing accounts unselected', () => {
    const render = (ids: string[]) => act(() => root.render(<QuickExitModal
      target={{ type: 'group', group: buildGroups(ids.map(position))[0]! }}
      onClose={() => {}} onRefreshPositions={() => {}} />));
    render(['A', 'B']);
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Cancel market exit');
    act(() => checkbox('B').click());
    render(['A', 'B', 'C']);
    expect(checkbox('A').checked).toBe(true);
    expect(checkbox('B').checked).toBe(false);
    expect(checkbox('C').checked).toBe(false);
    render(['B', 'C']);
    expect(host.querySelector<HTMLButtonElement>('button.btn:not(.secondary):last-child')?.disabled).toBe(true);
  });

  it('sends only one exit on two clicks in the same event turn and keeps the pending dialog open', async () => {
    const { exitFuturesPosition } = await import('./api.js');
    vi.mocked(exitFuturesPosition).mockClear();
    const onClose = vi.fn();
    act(() => root.render(<QuickExitModal target={{ type: 'account', position: position('A') }}
      onClose={onClose} onRefreshPositions={() => {}} />));
    const confirm = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Confirm & Close'))!;
    act(() => { confirm.click(); confirm.click(); });
    expect(exitFuturesPosition).toHaveBeenCalledTimes(1);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(onClose).not.toHaveBeenCalled();
    expect(host.querySelector<HTMLButtonElement>('.position-modal-close')?.disabled).toBe(true);
  });
});

function Dialog({ busy, onClose }: { busy: boolean; onClose: () => void }) {
  const ref = useSafeDialog(onClose, busy);
  return <div ref={ref} role="dialog" tabIndex={-1}>
    <button className="position-modal-close">Cancel</button><button>Send order</button>
  </div>;
}

describe('dialog keyboard safety', () => {
  it('traps focus, blocks repeated Enter, and restores the opener when closed', () => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    const opener = document.createElement('button');
    document.body.append(opener); opener.focus();
    const onClose = vi.fn();
    act(() => root.render(<Dialog busy={false} onClose={onClose} />));
    const [cancel, send] = [...host.querySelectorAll('button')];
    expect(document.activeElement).toBe(cancel);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(send);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); });
    expect(document.activeElement).toBe(cancel);
    const repeated = new KeyboardEvent('keydown', { key: 'Enter', repeat: true, bubbles: true, cancelable: true });
    document.dispatchEvent(repeated);
    expect(repeated.defaultPrevented).toBe(true);
    act(() => root.render(<Dialog busy onClose={onClose} />));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    act(() => root.render(<Dialog busy={false} onClose={onClose} />));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
