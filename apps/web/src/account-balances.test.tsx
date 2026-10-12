import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAccountList, syncAccount, type AccountListItem } from './api.ts';
import { refreshAccountListBalances } from './account-balances.ts';
import { Accounts } from './routes/Accounts.tsx';

vi.mock('./api.ts', () => ({
  fetchAccountList: vi.fn(), syncAccount: vi.fn(), fetchGroups: vi.fn(async () => []),
  DEFAULT_GROUP_NAME: 'Default (All Accounts)', addGroupMember: vi.fn(), removeGroupMember: vi.fn(), updateAccount: vi.fn(),
}));
vi.mock('./auth.tsx', () => ({ useAuth: () => ({ state: { status: 'unauthenticated' } }) }));

const account = (id: string, status: AccountListItem['status'] = 'active'): AccountListItem => ({
  id, name: `Account ${id}`, status, serialNo: 1, allocatedCurrency: 'INR', allocatedCapitalMinor: '99900',
  confirmedAgainstMinor: '99900', fundingCurrencies: ['INR', 'USDT'], groupId: null, groupName: null,
  hideFromPositions: false, balancesByCurrency: { INR: '10000', USDT: '200000000' },
});
let host: HTMLDivElement; let root: Root; let client: QueryClient;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.mocked(fetchAccountList).mockReset();
  vi.mocked(syncAccount).mockReset().mockResolvedValue({ currencies: ['INR', 'USDT'], balances: 2 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});
afterEach(() => { act(() => root.unmount()); client.clear(); host.remove(); vi.unstubAllGlobals(); });

describe('account list balance refresh', () => {
  it('reads all connected accounts with bounded parallelism and finishes later batches after failures', async () => {
    const rows = [...Array.from({ length: 10 }, (_, i) => account(String(i))), account('suspended', 'suspended'), account('gone', 'disconnected')];
    vi.mocked(fetchAccountList).mockResolvedValue(rows);
    let active = 0, peak = 0; let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(syncAccount).mockImplementation(async id => {
      active++; peak = Math.max(peak, active);
      try { await gate; if (id === '0') throw new Error('offline'); return { currencies: ['INR'], balances: 1 }; }
      finally { active--; }
    });
    const refreshing = refreshAccountListBalances();
    await vi.waitFor(() => expect(syncAccount).toHaveBeenCalledTimes(8));
    expect(peak).toBe(8);
    release();
    expect(await refreshing).toEqual({ refreshed: 10, failed: ['Account 0'] });
    expect(vi.mocked(syncAccount).mock.calls.map(([id]) => id)).toEqual(rows.slice(0, 11).map(row => row.id));
  });

  it('the real Refresh button reads exchange balances, waits for cache reload and reports partial failures', async () => {
    const first = account('A'); const second = account('B');
    vi.mocked(fetchAccountList).mockResolvedValue([first, second]);
    vi.mocked(syncAccount).mockImplementation(async id => {
      if (id === 'B') throw new Error('offline');
      vi.mocked(fetchAccountList).mockResolvedValue([{ ...first, balancesByCurrency: { INR: '0', USDT: '0' } }, second]);
      return { currencies: [], balances: 0 };
    });
    await act(async () => root.render(<QueryClientProvider client={client}><MemoryRouter><Accounts /></MemoryRouter></QueryClientProvider>));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    const refresh = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.title === 'Refresh all account balances from the exchange')!;
    expect(refresh).toBeDefined();
    await act(async () => { refresh.click(); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(syncAccount).toHaveBeenCalledWith('A'); expect(syncAccount).toHaveBeenCalledWith('B');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('1 accounts refreshed. Could not refresh: Account B');
    expect(refresh.disabled).toBe(false);
    expect(client.getQueryData<AccountListItem[]>(['accounts'])?.[0]?.balancesByCurrency?.INR).toBe('0');
    expect(host.textContent).toContain('₹100'); // fresh INR summary, not saved ₹999 per account
    expect(host.textContent).toContain('2 USDT');
  });
});
