import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { confirmAccount, deleteAccount, fetchAccount, resumeAccount, suspendAccount } from '../api.ts';
import { useAuth } from '../auth.tsx';

// One connected exchange account. The list page answers "which accounts do I
// have"; this answers "what is this one, and what can I do about it".
//
// The two actions here exist because the alternative was nothing at all: before
// this page an account could only be created, never paused or removed, and a
// connect that half-finished could only be abandoned. Deactivate is the reversible
// brake; delete is offered only while it is still possible — the ledger is
// append-only, so an account that has traded can never be removed and the page
// says so instead of showing a button that would fail.

const STATUS_LABEL: Record<string, string> = {
  active: 'active',
  pending_validation: 'not switched on',
  suspended: 'deactivated',
  disconnected: 'disconnected',
};

const statusBadgeClass = (status: string): string => (status === 'active' ? 'planned' : 'skipped');

/**
 * Minor units -> a readable amount. The scale is a PARAMETER, never derived from
 * the currency code: a stored balance carries the wallet scale the venue reported,
 * which is finer than the currency's tradable step (a real INR balance came back
 * at scale 18). Deriving the scale from the code renders such a row as
 * ₹50,84,37,69,24,990 instead of ₹0.005.
 */
function formatMinor(minor: string, scale: number, currency: string): string {
  const digits = minor.padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const frac = scale === 0 ? '' : digits.slice(-scale).replace(/0+$/, '');
  const num = `${whole}${frac === '' ? '' : `.${frac}`}`;
  return currency === 'INR' ? `₹${num}` : `${num} ${currency}`;
}

/** The tradable step of a quote. Sizing bases are always stated at this scale. */
const quoteScaleOf = (currency: string): number => (currency === 'INR' ? 2 : 8);

function when(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(iso).toLocaleString();
}

export function AccountDetail() {
  const { accountId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { state } = useAuth();
  const isOwner = state.status === 'authenticated' && state.session.role === 'owner';

  const [opError, setOpError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState(false);

  const account = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => fetchAccount(accountId),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['account', accountId] });
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
  };

  const finish = useMutation({
    mutationFn: () => confirmAccount(accountId),
    onSuccess: () => { setOpError(null); invalidate(); },
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not switch the account on'),
  });

  const suspend = useMutation({
    mutationFn: () => suspendAccount(accountId),
    onSuccess: () => { setOpError(null); setConfirmSuspend(false); invalidate(); },
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not deactivate the account'),
  });

  const resume = useMutation({
    mutationFn: () => resumeAccount(accountId),
    onSuccess: () => { setOpError(null); invalidate(); },
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not reactivate the account'),
  });

  const remove = useMutation({
    mutationFn: () => deleteAccount(accountId),
    onSuccess: () => navigate('/app/accounts', { replace: true }),
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not delete the account'),
  });

  if (account.isLoading) return <div className="panel">Loading account…</div>;
  if (account.isError) return <div className="panel error">{(account.error as Error).message}</div>;
  if (!account.isSuccess) return <div className="panel">No such account.</div>;

  const a = account.data;
  const busy = finish.isPending || suspend.isPending || resume.isPending || remove.isPending;

  return (
    <>
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0 }}>{a.name}</h2>
          <span className={`badge ${statusBadgeClass(a.status)}`}>
            {STATUS_LABEL[a.status] ?? a.status}
          </span>
          <Link to="/app/accounts" className="btn secondary btn-sm" style={{ marginLeft: 'auto' }}>
            ← All accounts
          </Link>
        </div>

        {a.status === 'pending_validation' && (
          <div className="spread-warning">
            The key was checked and works, but this account was never switched on — so it is not
            traded. Everything below was read from the exchange at that moment.
          </div>
        )}
        {a.status === 'suspended' && (
          <div className="spread-warning">
            Deactivated. Group trades skip this account entirely until it is reactivated; its key,
            its capital and its history are untouched.
          </div>
        )}

        <table style={{ maxWidth: 620 }}>
          <tbody>
            <tr>
              <td className="muted">Allocated capital</td>
              <td className="mono">
                {a.allocatedCapitalMinor === null || a.allocatedCurrency === null
                  ? <span className="muted">not read from the exchange yet</span>
                  : formatMinor(a.allocatedCapitalMinor, quoteScaleOf(a.allocatedCurrency), a.allocatedCurrency)}
              </td>
            </tr>
            <tr>
              <td className="muted">Funding currency</td>
              <td className="mono">{a.allocatedCurrency ?? <span className="muted">—</span>}</td>
            </tr>
            <tr>
              <td className="muted">Can fund with</td>
              <td>{a.fundingCurrencies.length > 0 ? a.fundingCurrencies.join(' / ') : <span className="muted">none</span>}</td>
            </tr>
            <tr>
              <td className="muted">Reconciled against</td>
              <td className="mono">
                {a.confirmedAgainstMinor === null || a.allocatedCurrency === null
                  ? <span className="muted">not switched on yet</span>
                  : formatMinor(a.confirmedAgainstMinor, quoteScaleOf(a.allocatedCurrency), a.allocatedCurrency)}
              </td>
            </tr>
            <tr>
              <td className="muted">Switched on</td>
              <td>{when(a.confirmedAt)}</td>
            </tr>
            <tr>
              <td className="muted">Added</td>
              <td>{when(a.createdAt)}</td>
            </tr>
            <tr>
              <td className="muted">Groups</td>
              <td>
                {a.groupCount === 0
                  ? <span className="muted">in no group</span>
                  : a.groupNames.join(', ')}
              </td>
            </tr>
          </tbody>
        </table>

        {opError !== null && <div className="error" style={{ marginTop: 10 }}>{opError}</div>}
      </div>

      <div className="panel">
        <h2>What the exchange says this account holds</h2>
        <p className="sub muted" style={{ marginTop: -8 }}>
          Read when the key was validated. The ledger is the exchange&apos;s; we only show it.
        </p>
        {a.balances.length === 0 ? (
          <p className="muted">No balances were recorded.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Currency</th><th>Free</th><th>Locked</th><th>Read at</th></tr>
            </thead>
            <tbody>
              {a.balances.map((b) => (
                <tr key={b.currency}>
                  <td>{b.currency}</td>
                  <td className="mono">{formatMinor(b.freeMinor, b.scale, b.currency)}</td>
                  <td className="mono">{formatMinor(b.lockedMinor, b.scale, b.currency)}</td>
                  <td className="muted">{when(b.observedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Actions</h2>
        {!isOwner ? (
          <p className="muted">
            Changing an account needs the workspace owner with a fresh second factor.
          </p>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            {a.status === 'pending_validation' && (
              <button className="btn" disabled={busy} onClick={() => finish.mutate()}>
                {finish.isPending ? 'Switching on…' : 'Finish connecting'}
              </button>
            )}

            {a.status === 'active' && (confirmSuspend ? (
              <span className="inline-confirm">
                <span className="muted">Stop trading this account?</span>
                <button className="btn danger btn-sm" disabled={busy} onClick={() => suspend.mutate()}>
                  {suspend.isPending ? 'Deactivating…' : 'Yes, deactivate'}
                </button>
                <button className="btn ghost btn-sm" onClick={() => setConfirmSuspend(false)}>Cancel</button>
              </span>
            ) : (
              <button className="btn secondary" disabled={busy} onClick={() => setConfirmSuspend(true)}>
                Deactivate
              </button>
            ))}

            {a.status === 'suspended' && (
              <button className="btn" disabled={busy} onClick={() => resume.mutate()}>
                {resume.isPending ? 'Reactivating…' : 'Reactivate'}
              </button>
            )}

            {a.deletable ? (confirmDelete ? (
              <span className="inline-confirm">
                <span className="muted">
                  Delete this account{a.groupCount > 0 ? ` and remove it from ${a.groupCount} group${a.groupCount === 1 ? '' : 's'}` : ''}?
                  This cannot be undone.
                </span>
                <button className="btn danger btn-sm" disabled={busy} onClick={() => remove.mutate()}>
                  {remove.isPending ? 'Deleting…' : 'Yes, delete'}
                </button>
                <button className="btn ghost btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
              </span>
            ) : (
              <button className="btn danger-outline" disabled={busy} onClick={() => setConfirmDelete(true)}>
                Delete
              </button>
            )) : (
              <p className="muted" style={{ margin: 0 }}>{a.undeletableReason}</p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
