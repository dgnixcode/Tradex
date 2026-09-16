import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  confirmAccount, deleteAccount, fetchAccount, resumeAccount, suspendAccount, syncAccount,
} from '../api.ts';
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
  const [syncNote, setSyncNote] = useState<string | null>(null);

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

  // The balances below are the numbers every trade is sized from. They only
  // refresh on connect without this, so a withdrawal made afterwards is invisible.
  const sync = useMutation({
    mutationFn: () => syncAccount(accountId),
    onSuccess: (out) => {
      setOpError(null);
      setSyncNote(`Read ${out.balances} balance(s) — can fund with ${out.currencies.join(' / ') || 'nothing'}.`);
      invalidate();
    },
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not read the exchange'),
  });

  const remove = useMutation({
    mutationFn: () => deleteAccount(accountId),
    onSuccess: () => navigate('/app/accounts', { replace: true }),
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not delete the account'),
  });

  if (account.isLoading) return <div className="panel full-width-page">Loading account…</div>;
  if (account.isError) return <div className="panel error full-width-page">{(account.error as Error).message}</div>;
  if (!account.isSuccess) return <div className="panel full-width-page">No such account.</div>;

  const a = account.data;
  const busy = finish.isPending || suspend.isPending || resume.isPending || remove.isPending || sync.isPending;

  return (
    <div className="account-detail-page full-width-page">
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h2 style={{ margin: 0 }}>{a.name}</h2>
            <span className={`badge ${statusBadgeClass(a.status)}`}>
              {STATUS_LABEL[a.status] ?? a.status}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {/* Refresh / Sync Balances button */}
            <button
              className="btn secondary btn-sm"
              disabled={sync.isPending || account.isFetching}
              onClick={() => {
                sync.mutate();
                void account.refetch();
              }}
              title="Fetch fresh balances directly from exchange"
            >
              {sync.isPending ? 'Syncing with exchange…' : '🔄 Refresh / Sync'}
            </button>

            {/* Quick Action buttons */}
            {isOwner && a.status === 'pending_validation' && (
              <button className="btn btn-sm" disabled={busy} onClick={() => finish.mutate()}>
                {finish.isPending ? 'Switching on…' : 'Finish connecting'}
              </button>
            )}

            {isOwner && a.status === 'active' && (
              confirmSuspend ? (
                <span className="inline-confirm">
                  <span className="muted" style={{ fontSize: 12.5 }}>Stop trading?</span>
                  <button className="btn danger btn-sm" disabled={busy} onClick={() => suspend.mutate()}>
                    {suspend.isPending ? 'Deactivating…' : 'Yes, deactivate'}
                  </button>
                  <button className="btn ghost btn-sm" onClick={() => setConfirmSuspend(false)}>Cancel</button>
                </span>
              ) : (
                <button
                  className="btn secondary btn-sm"
                  disabled={busy}
                  onClick={() => setConfirmSuspend(true)}
                  title="Pause trading this account"
                >
                  Deactivate
                </button>
              )
            )}

            {isOwner && a.status === 'suspended' && (
              <button className="btn btn-sm" disabled={busy} onClick={() => resume.mutate()}>
                {resume.isPending ? 'Reactivating…' : 'Reactivate'}
              </button>
            )}

            {isOwner && a.deletable && (
              confirmDelete ? (
                <span className="inline-confirm">
                  <span className="muted" style={{ fontSize: 12.5 }}>Delete account?</span>
                  <button className="btn danger btn-sm" disabled={busy} onClick={() => remove.mutate()}>
                    {remove.isPending ? 'Deleting…' : 'Yes, delete'}
                  </button>
                  <button className="btn ghost btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </span>
              ) : (
                <button
                  className="btn danger-outline btn-sm"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                  title="Permanently remove account (only if never traded)"
                >
                  Delete
                </button>
              )
            )}

            <Link to="/app/accounts" className="btn ghost btn-sm">
              ← All accounts
            </Link>
          </div>
        </div>

        {syncNote !== null && (
          <div style={{
            background: 'rgba(76, 141, 255, 0.1)',
            border: '1px solid rgba(76, 141, 255, 0.3)',
            color: 'var(--accent)',
            padding: '8px 14px',
            borderRadius: 'var(--radius)',
            marginBottom: 14,
            fontSize: 13,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}>
            <span>✓ {syncNote}</span>
            <button
              className="btn ghost btn-sm"
              style={{ padding: '2px 8px', height: 'auto', minHeight: 'unset', color: 'var(--text)' }}
              onClick={() => setSyncNote(null)}
            >
              ✕
            </button>
          </div>
        )}

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

        <table style={{ width: '100%' }}>
          <tbody>
            {/* TWO DIFFERENT QUESTIONS, kept apart:
                  * here — how this account is CONFIGURED to trade: the one currency
                    percentage orders are sized against, and which currencies it can
                    pay with at all.
                  * below — what it actually HOLDS, currency by currency.
                A single "funding currency" row used to sit here and read as if it
                were everything the account had, which is wrong the moment an account
                holds both INR and USDT. */}
            <tr>
              <td className="muted" style={{ width: 220, verticalAlign: 'top' }}>
                Allocated capital<br /><span style={{ fontSize: 11 }}>(sizing basis)</span>
              </td>
              <td className="mono">
                {a.allocatedCapitalMinor === null || a.allocatedCurrency === null
                  ? <span className="muted">not read from the exchange yet</span>
                  : formatMinor(a.allocatedCapitalMinor, quoteScaleOf(a.allocatedCurrency), a.allocatedCurrency)}
                {a.fundingCurrencies.length > 1 && (
                  <span className="muted" style={{ display: 'block', fontSize: 11 }}>
                    percentage orders are sized against this one currency; you choose the
                    currency on the ticket
                  </span>
                )}
              </td>
            </tr>
            <tr>
              <td className="muted" style={{ width: 220, verticalAlign: 'top' }}>Available to trade</td>
              <td>
                {/* THE MOST-ASKED-FOR LINE ON THIS PAGE, so it shows every funding
                    currency and its real balance — not just the one the sizing basis
                    happens to name. An account holding both INR and USDT that showed
                    only USDT here read as if the INR did not exist. */}
                {a.fundingCurrencies.length === 0 ? (
                  <span className="muted">nothing yet — sync after funding the account</span>
                ) : (
                  <table style={{ margin: 0, width: '100%', maxWidth: 520 }}>
                    <tbody>
                      {a.fundingCurrencies.map((c) => {
                        const row = a.balances.find((b) => b.currency === c);
                        return (
                          <tr key={c}>
                            <td style={{ paddingLeft: 0, width: 80, fontWeight: 600 }}>{c}</td>
                            <td className="mono" style={{ paddingLeft: 0 }}>
                              {row === undefined
                                ? <span className="muted">no balance on record — sync</span>
                                : formatMinor(row.freeMinor, row.scale, c)}
                            </td>
                            <td style={{ paddingLeft: 12 }}>
                              {c === a.allocatedCurrency
                                ? <span className="badge planned" style={{ fontSize: 10.5 }}>sizing basis</span>
                                : null}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </td>
            </tr>
            <tr>
              <td className="muted" style={{ width: 220 }}>Reconciled against</td>
              <td className="mono">
                {a.confirmedAgainstMinor === null || a.allocatedCurrency === null
                  ? <span className="muted">not switched on yet</span>
                  : formatMinor(a.confirmedAgainstMinor, quoteScaleOf(a.allocatedCurrency), a.allocatedCurrency)}
              </td>
            </tr>
            <tr>
              <td className="muted" style={{ width: 220 }}>Switched on</td>
              <td>{when(a.confirmedAt)}</td>
            </tr>
            <tr>
              <td className="muted" style={{ width: 220 }}>Added</td>
              <td>{when(a.createdAt)}</td>
            </tr>
            <tr>
              <td className="muted" style={{ width: 220 }}>Groups</td>
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}>What the exchange says this account holds</h2>
          <button
            className="btn secondary btn-sm"
            style={{ marginLeft: 'auto' }}
            disabled={sync.isPending || account.isFetching}
            onClick={() => {
              sync.mutate();
              void account.refetch();
            }}
          >
            {sync.isPending ? 'Reading the exchange…' : '🔄 Sync balances'}
          </button>
        </div>
        <p className="sub muted" style={{ marginTop: 0, marginBottom: 16 }}>
          The exchange&apos;s own numbers, and what every trade is sized from. They only change here
          when the account is read — so sync after a deposit or a withdrawal.
        </p>
        {a.balances.length === 0 ? (
          <p className="muted">No balances were recorded.</p>
        ) : (
          <table style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: '15%' }}>Currency</th>
                <th style={{ width: '25%' }}>Free</th>
                <th style={{ width: '25%' }}>Locked</th>
                <th style={{ width: '20%' }}>Can pay for a trade</th>
                <th style={{ width: '15%' }}>Read at</th>
              </tr>
            </thead>
            <tbody>
              {a.balances.map((b) => (
                <tr key={b.currency}>
                  <td style={{ fontWeight: 600 }}>{b.currency}</td>
                  <td className="mono">{formatMinor(b.freeMinor, b.scale, b.currency)}</td>
                  <td className="mono">{formatMinor(b.lockedMinor, b.scale, b.currency)}</td>
                  <td>
                    {/* Which of the coins they hold can actually settle an order.
                        A holding of BTC is what you SELL, not what you pay with —
                        so the distinction belongs on the row, not in a table
                        caption. */}
                    {(a.fundingCurrencies as readonly string[]).includes(b.currency) ? (
                      <span className="badge planned" style={{ fontSize: 10.5 }}>
                        yes{b.currency === a.allocatedCurrency ? ' · sizing basis' : ''}
                      </span>
                    ) : (
                      <span className="muted" style={{ fontSize: 11 }}>no</span>
                    )}
                  </td>
                  <td className="muted">{when(b.observedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="panel">
        <h2>Account Actions</h2>
        <p className="sub muted" style={{ marginTop: -12, marginBottom: 16 }}>
          Lifecycle management and trading controls for this connected exchange account.
        </p>
        {!isOwner ? (
          <p className="muted">
            Changing an account needs the workspace owner with a fresh second factor.
          </p>
        ) : (
          <div className="row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
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
                Deactivate Account
              </button>
            ))}

            {a.status === 'suspended' && (
              <button className="btn" disabled={busy} onClick={() => resume.mutate()}>
                {resume.isPending ? 'Reactivating…' : 'Reactivate Account'}
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
                Delete Account
              </button>
            )) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button className="btn danger-outline" disabled title={a.undeletableReason ?? 'Account cannot be deleted'}>
                  Delete Account
                </button>
                <span className="muted" style={{ fontSize: 12 }}>{a.undeletableReason}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
