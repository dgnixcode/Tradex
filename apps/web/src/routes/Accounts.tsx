import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addGroupMember,
  DEFAULT_GROUP_NAME,
  fetchAccountList,
  fetchGroups,
  removeGroupMember,
  updateAccount,
} from '../api.ts';
import type { AccountListItem } from '../api.ts';
import { useAuth } from '../auth.tsx';

// The Accounts section — the tenant's connected exchange accounts (T02.8's read
// model): status, the capital the exchange reports, and the currencies each can
// fund with. Connecting is a separate, owner + 2FA surface (ConnectAccount)
// because it handles an exchange API key; disconnecting stays future work.
//
// There is no typed-vs-real column: the customer never types a capital figure, so
// the allocated capital IS the venue's balance and has nothing to diverge from.

const STATUS_LABEL: Record<string, string> = {
  active: 'active',
  pending_validation: 'validating',
  suspended: 'suspended',
  disconnected: 'disconnected',
};

/** 'planned' and 'skipped' are the two badge styles the palette already has. */
const statusBadgeClass = (status: string): string =>
  status === 'active' ? 'planned' : status === 'pending_validation' ? 'skipped' : 'skipped';

function capitalLabel(minor: string | null, currency: string | null): string {
  if (minor === null || currency === null) return '—';
  const scale = currency === 'INR' ? 2 : 8;
  const digits = minor.padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  const num = `${whole}${frac === '' ? '' : `.${frac}`}`;
  return currency === 'INR' ? `₹${num}` : `${num} ${currency}`;
}

export function Accounts() {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccountList });
  const groups = useQuery({ queryKey: ['groups'], queryFn: fetchGroups });
  const { state } = useAuth();
  const isOwner = state.status === 'authenticated' && state.session.role === 'owner';
  const [search, setSearch] = useState('');

  // Visibility toggle state
  const [updatingVisibilityId, setUpdatingVisibilityId] = useState<string | null>(null);
  const [visibilityMessage, setVisibilityMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Group assignment/move modal state
  const [groupModalAccount, setGroupModalAccount] = useState<AccountListItem | null>(null);
  const [targetGroupId, setTargetGroupId] = useState<string>('');
  const [groupModalError, setGroupModalError] = useState<string | null>(null);

  const availableGroups = useMemo(() => {
    if (!groups.data) return [];
    return groups.data.filter(
      (g) => g.name !== DEFAULT_GROUP_NAME && g.id !== groupModalAccount?.groupId
    );
  }, [groups.data, groupModalAccount]);

  const toggleVisibilityMut = useMutation({
    mutationFn: async ({ accountId, hideFromPositions }: { accountId: string; hideFromPositions: boolean }) => {
      return updateAccount(accountId, { hideFromPositions });
    },
    onMutate: ({ accountId }) => {
      setUpdatingVisibilityId(accountId);
      setVisibilityMessage(null);
    },
    onSuccess: (data, vars) => {
      setVisibilityMessage({
        kind: 'ok',
        text: `Account "${data.account.name}" is now ${vars.hideFromPositions ? 'hidden from' : 'visible on'} positions and analytics.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['futures-positions'] });
      void queryClient.invalidateQueries({ queryKey: ['trading-analytics'] });
      void queryClient.invalidateQueries({ queryKey: ['analytics'] });
    },
    onError: (err: Error) => {
      setVisibilityMessage({
        kind: 'err',
        text: err.message || 'Failed to update visibility',
      });
    },
    onSettled: () => {
      setUpdatingVisibilityId(null);
    },
  });

  const assignGroupMut = useMutation({
    mutationFn: async ({ accountId, newGroupId }: { accountId: string; newGroupId: string }) => {
      return addGroupMember(newGroupId, accountId, true);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
      setGroupModalAccount(null);
      setTargetGroupId('');
      setGroupModalError(null);
    },
    onError: (err: Error) => {
      setGroupModalError(err.message || 'Failed to assign group');
    },
  });

  const unassignGroupMut = useMutation({
    mutationFn: async ({ accountId, currentGroupId }: { accountId: string; currentGroupId: string }) => {
      return removeGroupMember(currentGroupId, accountId);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
      setGroupModalAccount(null);
      setTargetGroupId('');
      setGroupModalError(null);
    },
    onError: (err: Error) => {
      setGroupModalError(err.message || 'Failed to remove from group');
    },
  });


  const filteredAccounts = useMemo(() => {
    if (!accounts.data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return accounts.data;
    return accounts.data.filter((a) => {
      const nameMatch = a.name.toLowerCase().includes(q);
      const groupMatch = (a.groupName ?? '').toLowerCase().includes(q);
      const statusMatch = a.status.toLowerCase().includes(q) || (STATUS_LABEL[a.status] ?? '').toLowerCase().includes(q);
      const currMatch = (a.allocatedCurrency ?? '').toLowerCase().includes(q);
      const fundingMatch = a.fundingCurrencies.some((f) => f.toLowerCase().includes(q));
      const visMatch = (a.hideFromPositions ? 'hidden' : 'visible').includes(q);
      return nameMatch || groupMatch || statusMatch || currMatch || fundingMatch || visMatch;
    });
  }, [accounts.data, search]);

  const summary = useMemo(() => {
    const list = accounts.data ?? [];
    let inrMinor = 0n;
    let usdtMinor = 0n;
    let inrCount = 0;
    let usdtCount = 0;
    let activeCount = 0;

    for (const a of list) {
      if (a.status === 'active') activeCount++;
      const cap = a.allocatedCapitalMinor;
      if (!cap || cap === '0') continue;
      if (a.allocatedCurrency === 'INR') {
        inrMinor += BigInt(cap);
        inrCount++;
      } else if (a.allocatedCurrency === 'USDT') {
        usdtMinor += BigInt(cap);
        usdtCount++;
      }
    }

    return {
      inrLabel: inrCount > 0 ? capitalLabel(inrMinor.toString(), 'INR') : '₹0.00',
      usdtLabel: usdtCount > 0 ? capitalLabel(usdtMinor.toString(), 'USDT') : '0.00000000 USDT',
      inrCount,
      usdtCount,
      activeCount,
      totalCount: list.length,
    };
  }, [accounts.data]);

  return (
    <div className="panel full-width-page">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Accounts</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            className="btn secondary btn-sm"
            onClick={() => {
              void accounts.refetch();
              void queryClient.invalidateQueries({ queryKey: ['groups'] });
            }}
            disabled={accounts.isFetching}
            title="Refresh accounts list"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: accounts.isFetching ? 'spin 1s linear infinite' : 'none' }}>
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
            {accounts.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
          {isOwner ? (
            <Link to="/app/accounts/connect" className="btn btn-sm">Connect an account</Link>
          ) : (
            <span className="muted" style={{ fontSize: 12.5 }}>connecting needs the owner</span>
          )}
        </div>
      </div>
      <p className="sub muted" style={{ marginTop: -4, marginBottom: 16 }}>
        The exchange accounts connected to this workspace. One account, one set of keys.
        Open an account to deactivate, reactivate or remove it.
      </p>

      {accounts.isLoading && <p className="muted">Loading accounts…</p>}
      {accounts.isError && <div className="error">{(accounts.error as Error).message}</div>}

      {accounts.isSuccess && accounts.data.length === 0 && (
        <div className="empty-state">
          <p>No accounts connected yet.</p>
          <p className="muted">
            Your connected exchange accounts will appear here — with their status, allocated
            capital and funding currencies — ready to group and trade together.
          </p>
        </div>
      )}

      {accounts.isSuccess && accounts.data.length > 0 && (
        <>
          {/* Overall Combined Balance Summary Cards */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: 12,
            marginBottom: 20,
          }}>
            <div style={{
              background: 'var(--panel-bg, #111827)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '12px 16px',
            }}>
              <div className="muted" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Combined Balance (INR)
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text)' }}>
                {summary.inrLabel}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                {summary.inrCount} account{summary.inrCount === 1 ? '' : 's'} with INR capital
              </div>
            </div>

            <div style={{
              background: 'var(--panel-bg, #111827)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '12px 16px',
            }}>
              <div className="muted" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Combined Balance (USDT)
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text)' }}>
                {summary.usdtLabel}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                {summary.usdtCount} account{summary.usdtCount === 1 ? '' : 's'} with USDT capital
              </div>
            </div>

            <div style={{
              background: 'var(--panel-bg, #111827)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '12px 16px',
            }}>
              <div className="muted" style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                Total Accounts
              </div>
              <div style={{ fontSize: 20, fontWeight: 700, marginTop: 4, color: 'var(--text)' }}>
                {summary.totalCount}
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                <span style={{ color: 'var(--ok, #10b981)', fontWeight: 600 }}>{summary.activeCount} active</span>
                {summary.totalCount > summary.activeCount && ` · ${summary.totalCount - summary.activeCount} inactive`}
              </div>
            </div>
          </div>

          {/* Search and Counts Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <div className={`tradex-search-bar ${search.trim() !== '' ? 'has-query' : ''}`} style={{ minWidth: 260, maxWidth: 360 }}>
              <svg
                className="tradex-search-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                placeholder="Search accounts by name, group, status..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="tradex-search-input"
                aria-label="Search accounts"
              />
              {search.trim() !== '' && (
                <button
                  type="button"
                  className="tradex-search-clear"
                  onClick={() => setSearch('')}
                  title="Clear search"
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
            <div className="muted" style={{ fontSize: '12.5px' }}>
              {search.trim() !== ''
                ? `Showing ${filteredAccounts.length} of ${accounts.data.length} account${accounts.data.length === 1 ? '' : 's'}`
                : `${accounts.data.length} account${accounts.data.length === 1 ? '' : 's'} connected`}
            </div>
          </div>

          {filteredAccounts.length === 0 ? (
            <div className="empty-state" style={{ padding: '36px 16px', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: '14.5px', fontWeight: 600 }}>No accounts match "{search}"</p>
              <p className="muted" style={{ margin: '6px 0 14px', fontSize: '13px' }}>Try adjusting your search by account name, strategy group, or status.</p>
              <button type="button" className="btn secondary btn-sm" onClick={() => setSearch('')}>
                Clear search
              </button>
            </div>
          ) : (
            <>
          {visibilityMessage && (
            <div
              style={{
                marginBottom: 16,
                padding: '10px 14px',
                borderRadius: 6,
                fontSize: 13,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: visibilityMessage.kind === 'ok' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                color: visibilityMessage.kind === 'ok' ? '#10b981' : '#f87171',
                border: `1px solid ${visibilityMessage.kind === 'ok' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              }}
            >
              <span>{visibilityMessage.text}</span>
              <button
                type="button"
                onClick={() => setVisibilityMessage(null)}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center' }}
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          )}

          {/* Desktop Table View (> 768px) */}
          <div className="table-scroll-container desktop-pos-table accounts-table-container">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 44, textAlign: 'center' }}>#</th>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Strategy Group</th>
                  <th>Positions &amp; Analytics</th>
                  <th>Allocated</th>
                  <th>Funding</th>
                  <th>Connected</th>
                </tr>
              </thead>
              <tbody>
                {filteredAccounts.map((a) => {
                  const serialNo = (accounts.data?.findIndex((x) => x.id === a.id) ?? 0) + 1;
                  return (
                    <tr key={a.id} className={a.status === 'disconnected' || a.status === 'suspended' ? 'skipped' : ''}>
                      <td className="mono muted" style={{ fontSize: 12, textAlign: 'center', fontWeight: 600 }}>#{serialNo}</td>
                      <td><Link to={`/app/accounts/${a.id}`}>{a.name}</Link></td>
                      <td><span className={`badge ${statusBadgeClass(a.status)}`}>{STATUS_LABEL[a.status] ?? a.status}</span></td>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {a.groupId && a.groupName ? (
                            <Link to={`/app/groups/${a.groupId}`} style={{ textDecoration: 'none' }}>
                              <span className="badge" style={{ background: 'rgba(59, 130, 246, 0.1)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.25)' }}>
                                {a.groupName}
                              </span>
                            </Link>
                          ) : (
                            <span className="muted" style={{ fontSize: 12 }}>Unassigned</span>
                          )}
                          <button
                            type="button"
                            className="btn secondary btn-sm"
                            style={{
                              padding: '2px 8px',
                              fontSize: 11,
                              height: 22,
                              borderRadius: 4,
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              cursor: 'pointer',
                            }}
                            onClick={() => {
                              setGroupModalAccount(a);
                              setTargetGroupId('');
                              setGroupModalError(null);
                            }}
                            title={a.groupId ? 'Move account to another strategy group' : 'Assign account to a strategy group'}
                          >
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 5v14M5 12h14" />
                            </svg>
                            {a.groupId ? 'Move' : 'Assign'}
                          </button>
                        </div>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          disabled={updatingVisibilityId === a.id}
                          onClick={() => {
                            toggleVisibilityMut.mutate({ accountId: a.id, hideFromPositions: !a.hideFromPositions });
                          }}
                          style={{
                            padding: '3px 10px',
                            fontSize: 11.5,
                            fontWeight: 600,
                            borderRadius: 14,
                            border: a.hideFromPositions
                              ? '1px solid rgba(239, 68, 68, 0.35)'
                              : '1px solid rgba(16, 185, 129, 0.35)',
                            background: a.hideFromPositions
                              ? 'rgba(239, 68, 68, 0.12)'
                              : 'rgba(16, 185, 129, 0.12)',
                            color: a.hideFromPositions ? '#fca5a5' : '#6ee7b7',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                            cursor: 'pointer',
                          }}
                          title={a.hideFromPositions ? 'Click to show this account on platform positions and analytics' : 'Click to hide this account from platform positions and analytics'}
                        >
                          {updatingVisibilityId === a.id ? (
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
                              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                            </svg>
                          ) : a.hideFromPositions ? (
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                              <line x1="1" y1="1" x2="23" y2="23" />
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          )}
                          {a.hideFromPositions ? 'Hidden' : 'Visible'}
                        </button>
                      </td>
                      <td className="mono">{capitalLabel(a.allocatedCapitalMinor, a.allocatedCurrency)}</td>
                      <td>{a.fundingCurrencies.length > 0 ? a.fundingCurrencies.join(' / ') : <span className="muted">none yet</span>}</td>
                      <td>
                        {a.confirmedAgainstMinor === null ? (
                          <span className="muted">not activated</span>
                        ) : (
                          <span style={{ color: 'var(--ok)' }}>from the exchange</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Account Cards (<= 768px) */}
          <div className="mobile-pos-cards">
            {filteredAccounts.map((a) => {
              const serialNo = (accounts.data?.findIndex((x) => x.id === a.id) ?? 0) + 1;
              return (
                <div
                  key={`mobile-${a.id}`}
                  className="pos-mobile-card"
                  style={{
                    opacity: a.status === 'disconnected' || a.status === 'suspended' ? 0.75 : 1,
                  }}
                >
                  <div className="pos-mobile-card-top">
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span className="mono muted" style={{ fontSize: 12, fontWeight: 700, opacity: 0.8 }}>
                          #{serialNo}
                        </span>
                        <Link
                          to={`/app/accounts/${a.id}`}
                          style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', textDecoration: 'none' }}
                        >
                          {a.name} →
                        </Link>
                      </div>
                      <div style={{ marginTop: 4 }}>
                        <span className={`badge ${statusBadgeClass(a.status)}`}>
                          {STATUS_LABEL[a.status] ?? a.status}
                        </span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 10, textTransform: 'uppercase', color: 'var(--muted)', display: 'block' }}>Allocated</span>
                      <span className="mono" style={{ fontSize: 13.5, fontWeight: 700 }}>
                        {capitalLabel(a.allocatedCapitalMinor, a.allocatedCurrency)}
                      </span>
                    </div>
                  </div>

                  <div className="pos-mobile-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
                    <div className="pos-mobile-cell">
                      <span className="pos-mobile-label">Strategy Group</span>
                      <span className="pos-mobile-val" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginTop: 2 }}>
                        {a.groupId && a.groupName ? (
                          <Link to={`/app/groups/${a.groupId}`} style={{ color: '#60a5fa', textDecoration: 'none', fontWeight: 600 }}>
                            {a.groupName}
                          </Link>
                        ) : (
                          <span className="muted">Unassigned</span>
                        )}
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          style={{ padding: '2px 6px', fontSize: 10.5, height: 20, borderRadius: 4 }}
                          onClick={() => {
                            setGroupModalAccount(a);
                            setTargetGroupId('');
                            setGroupModalError(null);
                          }}
                        >
                          {a.groupId ? 'Move' : 'Assign'}
                        </button>
                      </span>
                    </div>
                    <div className="pos-mobile-cell">
                      <span className="pos-mobile-label">Positions &amp; Analytics</span>
                      <span className="pos-mobile-val" style={{ marginTop: 2 }}>
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          disabled={updatingVisibilityId === a.id}
                          onClick={() => {
                            toggleVisibilityMut.mutate({ accountId: a.id, hideFromPositions: !a.hideFromPositions });
                          }}
                          style={{
                            padding: '2px 8px',
                            fontSize: 11,
                            fontWeight: 600,
                            borderRadius: 12,
                            border: a.hideFromPositions
                              ? '1px solid rgba(239, 68, 68, 0.35)'
                              : '1px solid rgba(16, 185, 129, 0.35)',
                            background: a.hideFromPositions
                              ? 'rgba(239, 68, 68, 0.12)'
                              : 'rgba(16, 185, 129, 0.12)',
                            color: a.hideFromPositions ? '#fca5a5' : '#6ee7b7',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                          }}
                        >
                          {a.hideFromPositions ? 'Hidden' : 'Visible'}
                        </button>
                      </span>
                    </div>
                  </div>

                  <div className="pos-mobile-grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 4 }}>
                    <div className="pos-mobile-cell">
                      <span className="pos-mobile-label">Funding Currencies</span>
                      <span className="pos-mobile-val">
                        {a.fundingCurrencies.length > 0 ? a.fundingCurrencies.join(' / ') : 'None'}
                      </span>
                    </div>
                    <div className="pos-mobile-cell">
                      <span className="pos-mobile-label">Exchange Status</span>
                      <span className="pos-mobile-val" style={{ color: a.confirmedAgainstMinor ? 'var(--ok)' : 'var(--muted)' }}>
                        {a.confirmedAgainstMinor !== null ? 'Activated' : 'Not activated'}
                      </span>
                    </div>
                  </div>

                  <Link
                    to={`/app/accounts/${a.id}`}
                    className="btn btn-sm secondary"
                    style={{ width: '100%', padding: '8px', fontSize: 12.5, fontWeight: 600, textAlign: 'center', boxSizing: 'border-box', marginTop: 8 }}
                  >
                    View Details &amp; Positions →
                  </Link>
                </div>
              );
            })}
          </div>
        </>
      )}
        </>
      )}

      {/* ── Assign / Move Strategy Group Modal ── */}
      {groupModalAccount !== null && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setGroupModalAccount(null);
            }
          }}
        >
          <div
            style={{
              background: 'var(--panel-bg, #111827)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 24,
              width: '100%',
              maxWidth: 460,
              boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
                {groupModalAccount.groupId ? 'Move Strategy Group' : 'Assign Strategy Group'}
              </h3>
              <button
                type="button"
                onClick={() => setGroupModalAccount(null)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--muted)',
                  cursor: 'pointer',
                  padding: '2px 6px',
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
                aria-label="Close"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            <p className="muted" style={{ fontSize: 13, marginTop: -6, marginBottom: 16 }}>
              Account: <strong style={{ color: 'var(--text)' }}>{groupModalAccount.name}</strong>
              <br />
              Current Strategy Group:{' '}
              {groupModalAccount.groupName ? (
                <span style={{ color: '#60a5fa', fontWeight: 600 }}>{groupModalAccount.groupName}</span>
              ) : (
                <span style={{ fontStyle: 'italic' }}>Unassigned</span>
              )}
            </p>

            {groupModalError && (
              <div
                style={{
                  padding: '8px 12px',
                  borderRadius: 6,
                  fontSize: 12.5,
                  background: 'rgba(239, 68, 68, 0.15)',
                  color: '#f87171',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  marginBottom: 16,
                }}
              >
                {groupModalError}
              </div>
            )}

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--muted)', marginBottom: 6 }}>
                Select Strategy Group:
              </label>
              <select
                value={targetGroupId}
                onChange={(e) => setTargetGroupId(e.target.value)}
                style={{
                  width: '100%',
                  padding: '9px 12px',
                  fontSize: 13.5,
                  background: 'var(--surface, #1f2937)',
                  color: 'var(--text, #ffffff)',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  outline: 'none',
                }}
              >
                <option value="">-- Choose a group --</option>
                {availableGroups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name} ({g.memberCount} account{g.memberCount === 1 ? '' : 's'})
                  </option>
                ))}
              </select>
              {availableGroups.length === 0 && (
                <p className="muted" style={{ fontSize: 11.5, marginTop: 6, marginBottom: 0 }}>
                  No other custom strategy groups available.{' '}
                  <Link to="/app/groups" style={{ color: 'var(--accent)' }}>
                    Create a group
                  </Link>{' '}
                  first.
                </p>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div>
                {groupModalAccount.groupId && (
                  <button
                    type="button"
                    className="btn secondary btn-sm"
                    disabled={unassignGroupMut.isPending || assignGroupMut.isPending}
                    onClick={() => {
                      if (groupModalAccount.groupId) {
                        unassignGroupMut.mutate({
                          accountId: groupModalAccount.id,
                          currentGroupId: groupModalAccount.groupId,
                        });
                      }
                    }}
                    style={{
                      color: '#f87171',
                      borderColor: 'rgba(239, 68, 68, 0.3)',
                      background: 'rgba(239, 68, 68, 0.08)',
                      fontSize: 12,
                    }}
                  >
                    {unassignGroupMut.isPending ? 'Removing…' : 'Remove from Group'}
                  </button>
                )}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn secondary btn-sm"
                  onClick={() => setGroupModalAccount(null)}
                  disabled={assignGroupMut.isPending || unassignGroupMut.isPending}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!targetGroupId || assignGroupMut.isPending || unassignGroupMut.isPending}
                  onClick={() => {
                    if (targetGroupId) {
                      assignGroupMut.mutate({
                        accountId: groupModalAccount.id,
                        newGroupId: targetGroupId,
                      });
                    }
                  }}
                >
                  {assignGroupMut.isPending
                    ? 'Saving…'
                    : groupModalAccount.groupId
                      ? 'Move to Group'
                      : 'Assign Group'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
