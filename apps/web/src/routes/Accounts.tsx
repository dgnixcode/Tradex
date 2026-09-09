import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchAccountList } from '../api.ts';
import { useAuth } from '../auth.tsx';

// The Accounts section — the tenant's connected exchange accounts (T02.8's read
// model): status, allocated capital, the typed-vs-real divergence cue, and the
// currencies each can fund with. Connecting is a separate, owner + 2FA surface
// (ConnectAccount) because it handles an exchange API key; disconnecting and
// re-reconciling stay future work.

const STATUS_LABEL: Record<string, string> = {
  active: 'active',
  pending_validation: 'validating',
  suspended: 'suspended',
  disconnected: 'disconnected',
};

/** 'planned' and 'skipped' are the two badge styles the palette already has. */
const statusBadgeClass = (status: string): string =>
  status === 'active' ? 'planned' : status === 'pending_validation' ? 'skipped' : 'skipped';

function capitalLabel(minor: string, currency: string): string {
  const scale = currency === 'INR' ? 2 : 8;
  const digits = minor.padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  const num = `${whole}${frac === '' ? '' : `.${frac}`}`;
  return currency === 'INR' ? `₹${num}` : `${num} ${currency}`;
}

export function Accounts() {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccountList });
  const { state } = useAuth();
  const isOwner = state.status === 'authenticated' && state.session.role === 'owner';

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Accounts</h2>
        {isOwner ? (
          <Link to="/app/accounts/connect" className="btn btn-sm" style={{ marginLeft: 'auto' }}>Connect an account</Link>
        ) : (
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12.5 }}>connecting needs the owner</span>
        )}
      </div>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        The exchange accounts connected to this workspace. One account, one set of keys.
      </p>

      {accounts.isLoading && <p className="muted">Loading accounts…</p>}
      {accounts.isError && <div className="error">{(accounts.error as Error).message}</div>}

      {accounts.isSuccess && accounts.data.length === 0 && (
        <div className="empty-state">
          <p className="empty-ico">🔗</p>
          <p>No accounts connected yet.</p>
          <p className="muted">
            Your connected exchange accounts will appear here — with their status, allocated
            capital and funding currencies — ready to group and trade together.
          </p>
        </div>
      )}

      {accounts.isSuccess && accounts.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Status</th>
              <th>Allocated</th>
              <th>Funding</th>
              <th>Typed vs real</th>
            </tr>
          </thead>
          <tbody>
            {accounts.data.map((a) => (
              <tr key={a.id} className={a.status === 'disconnected' || a.status === 'suspended' ? 'skipped' : ''}>
                <td>{a.name}</td>
                <td><span className={`badge ${statusBadgeClass(a.status)}`}>{STATUS_LABEL[a.status] ?? a.status}</span></td>
                <td className="mono">{capitalLabel(a.allocatedCapitalMinor, a.allocatedCurrency)}</td>
                <td>{a.fundingCurrencies.length > 0 ? a.fundingCurrencies.join(' / ') : <span className="muted">none yet</span>}</td>
                <td>
                  {a.confirmedAgainstMinor === null ? (
                    <span className="muted">not confirmed</span>
                  ) : a.diverges ? (
                    <span className="danger-text" style={{ color: 'var(--danger)' }}>diverged — re-check</span>
                  ) : (
                    <span style={{ color: 'var(--ok)' }}>matches</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
