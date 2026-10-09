import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchGroup, syncAccount } from './api.ts';
import { refreshTradeBalances, useTradeBalances } from './hooks/useTradeBalances.ts';
import { TerminalControls } from './components/TerminalControls.tsx';

vi.mock('./api.ts', () => ({ fetchGroup: vi.fn(), syncAccount: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
let balanceState: ReturnType<typeof useTradeBalances>;
function Probe({ kind, id, reload }: { kind: 'group' | 'account'; id: string; reload: () => Promise<unknown> }) {
  balanceState = useTradeBalances(kind, id, reload);
  return <span>{balanceState.pending ? 'refreshing' : balanceState.error ?? 'ready'}</span>;
}
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(syncAccount).mockReset().mockResolvedValue({ currencies: ['INR'], balances: 1 });
  vi.mocked(fetchGroup).mockReset();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe('trade balance refresh', () => {
  it('refreshes the actual Default group members, excluding disabled and inactive accounts', async () => {
    vi.mocked(fetchGroup).mockResolvedValue({ id: 'default', name: 'Default (All Accounts)', description: null, members: [
      { accountId: 'A', enabled: true, status: 'active' },
      { accountId: 'B', enabled: true, status: 'active' },
      { accountId: 'C', enabled: false, status: 'active' },
      { accountId: 'D', enabled: true, status: 'suspended' },
    ].map((member) => ({ ...member, accountName: member.accountId, displayOrder: 0, allocatedCapitalMinor: '100', allocatedCurrency: 'INR' as const })) });
    await refreshTradeBalances('group', 'default');
    expect(fetchGroup).toHaveBeenCalledWith('default');
    expect(vi.mocked(syncAccount).mock.calls.map(([id]) => id)).toEqual(['A', 'B']);
  });

  it('dispatches group reads concurrently with at most eight in flight', async () => {
    vi.mocked(fetchGroup).mockResolvedValue({ id: 'group', name: 'Group', description: null, members: Array.from({ length: 10 }, (_, i) => ({ accountId: String(i), accountName: String(i), displayOrder: i, allocatedCapitalMinor: '100', allocatedCurrency: 'INR' as const, enabled: true, status: 'active' })) });
    const firstBatch = deferred();
    let active = 0, peak = 0;
    vi.mocked(syncAccount).mockImplementation(async () => {
      active++; peak = Math.max(peak, active); await firstBatch.promise; active--;
      return { currencies: [], balances: 0 };
    });
    const refreshing = refreshTradeBalances('group', 'group');
    await vi.waitFor(() => expect(syncAccount).toHaveBeenCalledTimes(8));
    expect(peak).toBe(8);
    firstBatch.resolve(); await refreshing;
    expect(syncAccount).toHaveBeenCalledTimes(10);
  });

  it('treats a partially failed exchange read as a failed refresh', async () => {
    vi.mocked(syncAccount).mockRejectedValueOnce(new Error('offline'));
    await expect(refreshTradeBalances('account', 'A')).rejects.toThrow('could not be refreshed');
  });

  it('automatically refreshes an initial or restored account, then waits for displayed balances', async () => {
    const cache = deferred(); const reload = vi.fn(() => cache.promise);
    await act(async () => root.render(<Probe kind="account" id="saved-account" reload={reload} />));
    expect(syncAccount).toHaveBeenCalledWith('saved-account');
    expect(balanceState.pending).toBe(true);
    await act(async () => { cache.resolve(); });
    expect(balanceState.pending).toBe(false);
    await act(async () => { void balanceState.refresh(); });
    expect(syncAccount).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('keeps the new selection pending when an older selection finishes', async () => {
    const old = deferred(), current = deferred();
    vi.mocked(syncAccount).mockImplementation(async (id) => { await (id === 'A' ? old.promise : current.promise); return { currencies: [], balances: 0 }; });
    const reload = vi.fn(async () => {});
    await act(async () => root.render(<Probe kind="account" id="A" reload={reload} />));
    await act(async () => root.render(<Probe kind="account" id="B" reload={reload} />));
    await act(async () => { old.resolve(); });
    expect(balanceState.pending).toBe(true);
    await act(async () => { current.resolve(); });
    expect(balanceState.pending).toBe(false);
  });

  it('exposes exchange or display-reload failure instead of silently showing success', async () => {
    const reload = vi.fn(async () => { throw new Error('display failed'); });
    await act(async () => root.render(<Probe kind="account" id="A" reload={reload} />));
    expect(balanceState.pending).toBe(false);
    expect(balanceState.error).toContain('Displayed funds may be old');
    await act(async () => root.render(<Probe kind="account" id="" reload={reload} />));
    expect(balanceState.pending).toBe(false); expect(balanceState.error).toBeNull();
  });

  it('reuses an in-flight read across StrictMode effect replay', async () => {
    const read = deferred();
    vi.mocked(syncAccount).mockImplementation(async () => { await read.promise; return { currencies: [], balances: 0 }; });
    await act(async () => root.render(<StrictMode><Probe kind="account" id="A" reload={async () => {}} /></StrictMode>));
    expect(syncAccount).toHaveBeenCalledTimes(1);
    await act(async () => { read.resolve(); });
    expect(balanceState.pending).toBe(false);
  });
});

describe('terminal panel controls', () => {
  it('labels each consistent icon, reports active state and toggles the requested panel', () => {
    const select = vi.fn();
    act(() => root.render(<TerminalControls active="position" onSelect={select} asset="BTC" positionCount={4} />));
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('.rail-tab-btn')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Order Ticket', 'Watchlist', 'Positions']);
    expect(buttons.map((button) => button.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true']);
    expect(host.querySelectorAll('svg[width="20"][height="20"][aria-hidden="true"]')).toHaveLength(3);
    expect(host.querySelector('.rail-position-count')?.textContent).toBe('4');
    act(() => { buttons[0]!.click(); buttons[1]!.click(); buttons[2]!.click(); });
    expect(select.mock.calls).toEqual([['trade'], ['watchlist'], [null]]);
  });
});
