import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addGroupMember, archiveGroup, DEFAULT_GROUP_NAME, fetchAccountList, fetchGroup,
  removeGroupMember, setGroupMemberEnabled, updateGroup,
} from '../api.ts';
import type { GroupDetail as GroupDetailData } from '../api.ts';

// The group detail view. Manages one group's membership: enable/disable each
// account, remove it, or add an account from the tenant's accounts. A disabled
// member stays in the group but is skipped by the fan-out — the customer can
// exclude an account without dissolving the group. Archive removes the group
// from the list (membership rows are retained for audit).
//
// Every mutation invalidates the group + list + accounts queries, so the screen
// reflects the server's state rather than a local guess.

function capitalLabel(minor: string, currency: string): string {
  const scale = currency === 'INR' ? 2 : 8;
  const digits = minor.padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  const num = `${whole}${frac === '' ? '' : `.${frac}`}`;
  return currency === 'INR' ? `₹${num}` : `${num} ${currency}`;
}

export function GroupDetail() {
  const { groupId = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const group = useQuery({ queryKey: ['group', groupId], queryFn: () => fetchGroup(groupId) });
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccountList });

  // Edit state. The rename fields are populated when the user clicks Rename, so
  // there is no state-set-during-render dance to keep them in sync with the query.
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [pickAccount, setPickAccount] = useState('');
  const [opError, setOpError] = useState<string | null>(null);

  const startEditing = (detail: GroupDetailData) => {
    setName(detail.name);
    setDescription(detail.description ?? '');
    setEditing(true);
  };

  const detail: GroupDetailData | undefined = group.data;
  const isDefaultGroup = detail?.name === DEFAULT_GROUP_NAME;

  const invalidate = (keys: string[][]) => {
    for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
  };

  const saveName = useMutation({
    mutationFn: () => updateGroup(groupId, { name, description: description === '' ? null : description }),
    onSuccess: () => { setEditing(false); invalidate([['group', groupId], ['groups']]); },
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not save'),
  });

  const archive = useMutation({
    mutationFn: () => archiveGroup(groupId),
    onSuccess: () => navigate('/app/groups', { replace: true }),
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not archive'),
  });

  const addMember = useMutation({
    mutationFn: (args: { accountId: string; reassign?: boolean }) =>
      addGroupMember(groupId, args.accountId, args.reassign),
    onSuccess: () => {
      setPickAccount('');
      setOpError(null);
      invalidate([['group', groupId], ['groups'], ['accounts']]);
    },
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not add the account'),
  });

  const toggleEnabled = useMutation({
    mutationFn: (args: { accountId: string; enabled: boolean }) =>
      setGroupMemberEnabled(groupId, args.accountId, args.enabled),
    onSuccess: () => invalidate([['group', groupId], ['groups']]),
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not update the member'),
  });

  const removeMember = useMutation({
    mutationFn: (accountId: string) => removeGroupMember(groupId, accountId),
    onSuccess: () => invalidate([['group', groupId], ['groups'], ['accounts']]),
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not remove the member'),
  });

  // Accounts that can still be added: not already a member of THIS group.
  const memberIds = useMemo(() => new Set(detail?.members.map((m) => m.accountId) ?? []), [detail]);
  const addable = useMemo(
    () => (accounts.data ?? []).filter((a) => !memberIds.has(a.id) && a.status === 'active'),
    [accounts.data, memberIds],
  );
  const selectedAddableAccount = useMemo(
    () => (accounts.data ?? []).find((a) => a.id === pickAccount),
    [accounts.data, pickAccount],
  );

  if (group.isLoading) return <div className="panel">Loading group…</div>;
  if (group.isError) return <div className="panel error">{(group.error as Error).message}</div>;
  if (detail === undefined) return <div className="panel">No such group.</div>;

  return (
    <div>
      {/* header / rename */}
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isDefaultGroup ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h2 style={{ margin: 0 }}>{detail.name}</h2>
              <span className="badge" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)' }}>
                🌐 Master System Group
              </span>
            </div>
          ) : editing ? (
            <form
              className="rename-form"
              onSubmit={(e) => { e.preventDefault(); saveName.mutate(); }}
            >
              <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Group name" />
              <button className="btn btn-sm" type="submit" disabled={saveName.isPending || name.trim() === ''}>Save</button>
              <button className="btn ghost btn-sm" type="button" onClick={() => setEditing(false)}>Cancel</button>
            </form>
          ) : (
            <>
              <h2 style={{ margin: 0 }}>{detail.name}</h2>
              <button className="btn ghost btn-sm" onClick={() => startEditing(detail)}>Rename</button>
            </>
          )}
          <span className="spacer" style={{ flex: 1 }} />
          <Link to="/app/groups" className="btn secondary btn-sm">← All groups</Link>
          {!isDefaultGroup && (
            confirmArchive ? (
              <span className="inline-confirm">
                <span className="muted">Archive this group?</span>
                <button className="btn danger btn-sm" disabled={archive.isPending} onClick={() => archive.mutate()}>
                  {archive.isPending ? 'Archiving…' : 'Yes, archive'}
                </button>
                <button className="btn ghost btn-sm" onClick={() => setConfirmArchive(false)}>Cancel</button>
              </span>
            ) : (
              <button className="btn danger-outline btn-sm" onClick={() => setConfirmArchive(true)}>Archive</button>
            )
          )}
        </div>
        {isDefaultGroup ? (
          <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
            Master group automatically containing all connected exchange accounts. Use this to execute whole-desk macro trades across every account simultaneously.
          </p>
        ) : (
          <>
            {editing && (
              <div className="field" style={{ marginTop: 14 }}>
                <label htmlFor="desc">Description</label>
                <input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" />
              </div>
            )}
            {detail.description !== null && !editing && <p className="muted" style={{ marginBottom: 0 }}>{detail.description}</p>}
          </>
        )}
        {opError !== null && <div className="error" style={{ marginTop: 10 }}>{opError}</div>}
      </div>

      {/* members */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Accounts in this group</h3>

        {detail.members.length === 0 ? (
          <div className="empty-state">
            <p className="muted">No accounts yet — add one below to include it in group trades.</p>
          </div>
        ) : (
          <>
            {/* Desktop Table View (> 768px) */}
            <div className="table-scroll-container desktop-pos-table">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Status</th>
                    <th>Allocated</th>
                    <th>In trades</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {detail.members.map((m) => (
                    <tr key={m.accountId} className={m.enabled ? '' : 'skipped'}>
                      <td>{m.accountName}</td>
                      <td><span className={`badge ${m.status === 'active' ? 'planned' : 'skipped'}`}>{m.status}</span></td>
                      <td className="mono">{capitalLabel(m.allocatedCapitalMinor, m.allocatedCurrency)}</td>
                      <td>
                        <span className={`badge ${m.enabled ? 'planned' : 'skipped'}`}>{m.enabled ? 'enabled' : 'disabled'}</span>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button
                          className="btn ghost btn-sm"
                          disabled={toggleEnabled.isPending}
                          onClick={() => toggleEnabled.mutate({ accountId: m.accountId, enabled: !m.enabled })}
                        >
                          {m.enabled ? 'Disable' : 'Enable'}
                        </button>
                        {!isDefaultGroup && (
                          <button
                            className="btn ghost btn-sm danger-text"
                            disabled={removeMember.isPending}
                            onClick={() => removeMember.mutate(m.accountId)}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Member Cards (<= 768px) */}
            <div className="mobile-pos-cards">
              {detail.members.map((m) => (
                <div key={`mobile-${m.accountId}`} className="pos-mobile-card">
                  <div className="pos-mobile-card-top">
                    <div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{m.accountName}</div>
                      <div style={{ marginTop: 4 }}>
                        <span className={`badge ${m.status === 'active' ? 'planned' : 'skipped'}`}>{m.status}</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span className={`badge ${m.enabled ? 'planned' : 'skipped'}`}>{m.enabled ? 'in trades' : 'disabled'}</span>
                      <div className="mono" style={{ fontSize: 13, fontWeight: 700, marginTop: 4 }}>
                        {capitalLabel(m.allocatedCapitalMinor, m.allocatedCurrency)}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: isDefaultGroup ? '1fr' : '1fr 1fr', gap: 8, marginTop: 6 }}>
                    <button
                      type="button"
                      className="btn secondary btn-sm"
                      style={{ padding: '8px', fontSize: 12 }}
                      disabled={toggleEnabled.isPending}
                      onClick={() => toggleEnabled.mutate({ accountId: m.accountId, enabled: !m.enabled })}
                    >
                      {m.enabled ? 'Disable Trade' : 'Enable Trade'}
                    </button>
                    {!isDefaultGroup && (
                      <button
                        type="button"
                        className="btn ghost btn-sm danger-text"
                        style={{ padding: '8px', fontSize: 12, border: '1px solid rgba(239,68,68,0.3)' }}
                        disabled={removeMember.isPending}
                        onClick={() => removeMember.mutate(m.accountId)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* add member */}
        <div className="add-member" style={{ marginTop: 18 }}>
          {isDefaultGroup ? (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              🌐 All connected exchange accounts are automatically enrolled in this master group.
            </p>
          ) : accounts.isLoading ? (
            <span className="muted">Loading accounts…</span>
          ) : addable.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              {accounts.data !== undefined && accounts.data.length === 0
                ? 'No accounts to add — connect an exchange account first.'
                : 'Every account is already in this group.'}
            </p>
          ) : (
            <div>
              <form
                className="add-member-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (pickAccount !== '') addMember.mutate({ accountId: pickAccount, reassign: true });
                }}
              >
                <select value={pickAccount} onChange={(e) => setPickAccount(e.target.value)} aria-label="Account to add">
                  <option value="">Add an account…</option>
                  {addable.map((a) => {
                    const assigned = a.groupName ? ` (In: ${a.groupName})` : ' (Available)';
                    return (
                      <option key={a.id} value={a.id}>{a.name}{assigned}</option>
                    );
                  })}
                </select>
                <button className="btn btn-sm" type="submit" disabled={pickAccount === '' || addMember.isPending}>
                  {addMember.isPending ? 'Adding…' : selectedAddableAccount?.groupName ? 'Reassign & Add' : 'Add'}
                </button>
              </form>
              {selectedAddableAccount?.groupName && (
                <div style={{
                  marginTop: 10,
                  padding: '8px 12px',
                  borderRadius: 6,
                  background: 'rgba(234, 179, 8, 0.1)',
                  border: '1px solid rgba(234, 179, 8, 0.3)',
                  color: '#facc15',
                  fontSize: 12.5,
                }}>
                  ⚠️ <strong>Reassignment:</strong> <code>{selectedAddableAccount.name}</code> is currently assigned to <strong>📁 {selectedAddableAccount.groupName}</strong>. Adding it here will reassign it to this group (1 account = 1 strategy group).
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
