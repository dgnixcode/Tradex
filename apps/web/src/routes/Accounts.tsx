import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAccountList } from '../api.ts';
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
  const { state } = useAuth();
  const isOwner = state.status === 'authenticated' && state.session.role === 'owner';
  const [search, setSearch] = useState('');

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
      return nameMatch || groupMatch || statusMatch || currMatch || fundingMatch;
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
            <div style={{ position: 'relative', minWidth: '260px', maxWidth: '380px', flex: 1 }}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', opacity: 0.5, pointerEvents: 'none' }}
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                placeholder="Search accounts by name, group, status..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="card-account-search"
                style={{
                  width: '100%',
                  padding: '7px 30px 7px 32px',
                  fontSize: '13px',
                  boxSizing: 'border-box',
                  borderRadius: '6px',
                }}
                aria-label="Search accounts"
              />
              {search.trim() !== '' && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  style={{
                    position: 'absolute',
                    right: 8,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    background: 'none',
                    border: 'none',
                    color: 'var(--muted)',
                    cursor: 'pointer',
                    padding: '2px 6px',
                    fontSize: '13px',
                    lineHeight: 1,
                  }}
                  aria-label="Clear search"
                >
                  x
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
              {/* Desktop Table View (> 768px) */}
              <div className="table-scroll-container desktop-pos-table accounts-table-container">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 44, textAlign: 'center' }}>#</th>
                      <th>Account</th>
                      <th>Status</th>
                      <th>Strategy Group</th>
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
                            {a.groupId && a.groupName ? (
                              <Link to={`/app/groups/${a.groupId}`} style={{ textDecoration: 'none' }}>
                                <span className="badge" style={{ background: 'rgba(59, 130, 246, 0.1)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.25)' }}>
                                  {a.groupName}
                                </span>
                              </Link>
                            ) : (
                              <span className="muted" style={{ fontSize: 12 }}>Unassigned</span>
                            )}
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
                    <span className="pos-mobile-val">
                      {a.groupId && a.groupName ? (
                        <Link to={`/app/groups/${a.groupId}`} style={{ color: '#60a5fa', textDecoration: 'none', fontWeight: 600 }}>
                          {a.groupName}
                        </Link>
                      ) : (
                        <span className="muted">Unassigned</span>
                      )}
                    </span>
                  </div>
                  <div className="pos-mobile-cell">
                    <span className="pos-mobile-label">Funding Currencies</span>
                    <span className="pos-mobile-val">
                      {a.fundingCurrencies.length > 0 ? a.fundingCurrencies.join(' / ') : 'None'}
                    </span>
                  </div>
                </div>

                <div className="pos-mobile-grid" style={{ gridTemplateColumns: '1fr', marginTop: 4 }}>
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
                  style={{ width: '100%', padding: '8px', fontSize: 12.5, fontWeight: 600, textAlign: 'center', boxSizing: 'border-box' }}
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
</div>
  );
}
