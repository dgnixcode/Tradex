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
          {/* Desktop Table View (> 768px) */}
          <div className="table-scroll-container desktop-pos-table">
            <table>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Status</th>
                  <th>Strategy Group</th>
                  <th>Allocated</th>
                  <th>Funding</th>
                  <th>Connected</th>
                </tr>
              </thead>
              <tbody>
                {accounts.data.map((a) => (
                  <tr key={a.id} className={a.status === 'disconnected' || a.status === 'suspended' ? 'skipped' : ''}>
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
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Account Cards (<= 768px) */}
          <div className="mobile-pos-cards">
            {accounts.data.map((a) => (
              <div
                key={`mobile-${a.id}`}
                className="pos-mobile-card"
                style={{
                  opacity: a.status === 'disconnected' || a.status === 'suspended' ? 0.75 : 1,
                }}
              >
                <div className="pos-mobile-card-top">
                  <div>
                    <Link
                      to={`/app/accounts/${a.id}`}
                      style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', textDecoration: 'none' }}
                    >
                      {a.name} →
                    </Link>
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
                      {a.confirmedAgainstMinor !== null ? '✓ Activated' : 'Not activated'}
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
            ))}
          </div>
        </>
      )}
    </div>
  );
}
