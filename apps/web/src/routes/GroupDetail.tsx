import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addGroupMember, archiveGroup, fetchAccountList, fetchGroup,
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
    mutationFn: (accountId: string) => addGroupMember(groupId, accountId),
    onSuccess: () => { setPickAccount(''); invalidate([['group', groupId], ['groups'], ['accounts']]); },
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

  // Accounts that can still be added: not already a member.
  const memberIds = useMemo(() => new Set(detail?.members.map((m) => m.accountId) ?? []), [detail]);
  const addable = useMemo(
    () => (accounts.data ?? []).filter((a) => !memberIds.has(a.id) && a.status === 'active'),
    [accounts.data, memberIds],
  );

  if (group.isLoading) return <div className="panel">Loading group…</div>;
  if (group.isError) return <div className="panel error">{(group.error as Error).message}</div>;
  if (detail === undefined) return <div className="panel">No such group.</div>;

  return (
    <div>
      {/* header / rename */}
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {editing ? (
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
          {confirmArchive ? (
            <span className="inline-confirm">
              <span className="muted">Archive this group?</span>
              <button className="btn danger btn-sm" disabled={archive.isPending} onClick={() => archive.mutate()}>
                {archive.isPending ? 'Archiving…' : 'Yes, archive'}
              </button>
              <button className="btn ghost btn-sm" onClick={() => setConfirmArchive(false)}>Cancel</button>
            </span>
          ) : (
            <button className="btn danger-outline btn-sm" onClick={() => setConfirmArchive(true)}>Archive</button>
          )}
        </div>
        {editing && (
          <div className="field" style={{ marginTop: 14 }}>
            <label htmlFor="desc">Description</label>
            <input id="desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional description" />
          </div>
        )}
        {detail.description !== null && !editing && <p className="muted" style={{ marginBottom: 0 }}>{detail.description}</p>}
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
                    <button
                      className="btn ghost btn-sm danger-text"
                      disabled={removeMember.isPending}
                      onClick={() => removeMember.mutate(m.accountId)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* add member */}
        <div className="add-member" style={{ marginTop: 18 }}>
          {accounts.isLoading ? (
            <span className="muted">Loading accounts…</span>
          ) : addable.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              {accounts.data !== undefined && accounts.data.length === 0
                ? 'No accounts to add — connect an exchange account first.'
                : 'Every account is already in this group.'}
            </p>
          ) : (
            <form
              className="add-member-form"
              onSubmit={(e) => { e.preventDefault(); if (pickAccount !== '') addMember.mutate(pickAccount); }}
            >
              <select value={pickAccount} onChange={(e) => setPickAccount(e.target.value)} aria-label="Account to add">
                <option value="">Add an account…</option>
                {addable.map((a) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
              <button className="btn btn-sm" type="submit" disabled={pickAccount === '' || addMember.isPending}>
                {addMember.isPending ? 'Adding…' : 'Add'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
