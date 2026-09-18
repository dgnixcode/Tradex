import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addGroupMember, archiveGroup, DEFAULT_GROUP_NAME, fetchAccountList, fetchGroup,
  fetchTradingAnalytics, removeGroupMember, setGroupMemberEnabled, updateGroup,
} from '../api.ts';
import type { GroupDetail as GroupDetailData } from '../api.ts';
import { fmtCurrency, fmtSignedCurrency } from './Analytics.tsx';
import { fmtPrice } from './Futures.tsx';

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

  const [activeTab, setActiveTab] = useState<'members' | 'analytics'>('members');
  const [analyticsTimeframe, setAnalyticsTimeframe] = useState<'all' | '30d' | '7d' | 'today' | 'custom'>('all');
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState(() => {
    return new Date().toISOString().slice(0, 10);
  });

  const fromMs = analyticsTimeframe === 'custom' && customFrom ? new Date(`${customFrom}T00:00:00Z`).getTime() : undefined;
  const toMs = analyticsTimeframe === 'custom' && customTo ? new Date(`${customTo}T23:59:59.999Z`).getTime() : undefined;

  const groupAnalytics = useQuery({
    queryKey: ['trading-analytics', 'group', groupId, analyticsTimeframe, fromMs, toMs],
    queryFn: () => fetchTradingAnalytics({ groupId, timeframe: analyticsTimeframe, fromMs, toMs }),
    enabled: activeTab === 'analytics',
    refetchInterval: 5000,
  });

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
                Master System Group
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

      {/* members and analytics tabs */}
      <div className="panel">
        {/* Tab Navigation */}
        <div className="account-nav-tabs" style={{ marginBottom: 20 }}>
          <button
            type="button"
            className={`account-nav-tab ${activeTab === 'members' ? 'active' : ''}`}
            onClick={() => setActiveTab('members')}
          >
            <span>Members & Accounts</span>
            {detail.members.length > 0 && (
              <span className="account-tab-badge">{detail.members.length}</span>
            )}
          </button>
          <button
            type="button"
            className={`account-nav-tab ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <span>Group Analytics</span>
          </button>
        </div>

        {activeTab === 'members' && (
          <div>
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
              All connected exchange accounts are automatically enrolled in this master group.
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
                  <strong>Reassignment:</strong> <code>{selectedAddableAccount.name}</code> is currently assigned to <strong>{selectedAddableAccount.groupName}</strong>. Adding it here will reassign it to this group (1 account = 1 strategy group).
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )}

    {/* TAB 2: GROUP ANALYTICS */}
    {activeTab === 'analytics' && (
      <div>
        {/* Header & Timeframe Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16 }}>Strategy Group Telemetry</h3>
            <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
              Aggregated trading performance, member contribution matrix, and asset exposure for {detail.name}.
            </p>
          </div>

          <div className="telemetry-toolbar">
            <div className="telemetry-pills">
              {(['all', '30d', '7d', 'today', 'custom'] as const).map((tf) => (
                <button
                  key={tf}
                  type="button"
                  className={`telemetry-pill ${analyticsTimeframe === tf ? 'active' : ''}`}
                  onClick={() => setAnalyticsTimeframe(tf)}
                >
                  {tf === 'all' ? 'All Time' : tf === '30d' ? '30 Days' : tf === '7d' ? '7 Days' : tf === 'today' ? 'Today' : 'Custom'}
                </button>
              ))}
            </div>

            {analyticsTimeframe === 'custom' && (
              <div className="telemetry-date-range">
                <label>From:
                  <input
                    type="date"
                    className="telemetry-date-input"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                  />
                </label>
                <label>To:
                  <input
                    type="date"
                    className="telemetry-date-input"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                  />
                </label>
              </div>
            )}

            <button
              type="button"
              className="telemetry-action-btn"
              disabled={groupAnalytics.isFetching}
              onClick={() => groupAnalytics.refetch()}
              title="Refresh group analytics"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: groupAnalytics.isFetching ? 'spin 1s linear infinite' : 'none' }}>
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
              {groupAnalytics.isFetching ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </div>

        {groupAnalytics.isLoading && <p className="muted">Loading group trading telemetry…</p>}
        {groupAnalytics.isError && <div className="error">{(groupAnalytics.error as Error).message}</div>}

        {groupAnalytics.data && (() => {
          const rep = groupAnalytics.data;
          const kpis = rep.kpis;
          const pnlInr = kpis.unrealisedPnlMinor['INR'] ?? '0';
          const marginInr = kpis.lockedMarginMinor['INR'] ?? '0';
          const pnlPctInr = kpis.pnlPercentage['INR'];
          const pnlNum = Number(pnlInr);
          const isProf = pnlNum > 0;
          const isLoss = pnlNum < 0;

          return (
            <div>
              {/* KPI Cards Grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 14,
                  marginBottom: 24,
                }}
              >
                {/* KPI 1: Group Net PnL */}
                <div
                  style={{
                    background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                    border: '1px solid #1e2433',
                    borderRadius: 12,
                    padding: '16px 18px',
                    borderLeft: `4px solid ${isProf ? '#10b981' : isLoss ? '#ef4444' : '#64748b'}`,
                  }}
                >
                  <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                    Group Unrealised PnL
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span
                      style={{
                        fontSize: 22,
                        fontWeight: 800,
                        color: isProf ? 'var(--ok)' : isLoss ? 'var(--danger)' : 'var(--text)',
                        letterSpacing: '-0.5px',
                      }}
                    >
                      {fmtSignedCurrency(pnlInr, 'INR')}
                    </span>
                    {pnlPctInr !== undefined && (
                      <span
                        className="pnl-pct-badge"
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: 6,
                          background: isProf ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                          color: isProf ? 'var(--ok)' : 'var(--danger)',
                          border: `1px solid ${isProf ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'}`,
                        }}
                      >
                        {isProf ? '+' : isLoss ? '−' : ''}{Math.abs(pnlPctInr).toFixed(2)}%
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                    Across {kpis.openPositionsCount} active trade{kpis.openPositionsCount === 1 ? '' : 's'}
                  </div>
                </div>

                {/* KPI 2: Group Margin Deployed */}
                <div
                  style={{
                    background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                    border: '1px solid #1e2433',
                    borderRadius: 12,
                    padding: '16px 18px',
                    borderLeft: '4px solid #3b82f6',
                  }}
                >
                  <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                    Locked Margin Deployed
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.5px' }}>
                    {fmtCurrency(marginInr, 'INR')}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                    Collateral backing group positions
                  </div>
                </div>

                {/* KPI 3: Group Volume */}
                <div
                  style={{
                    background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                    border: '1px solid #1e2433',
                    borderRadius: 12,
                    padding: '16px 18px',
                    borderLeft: '4px solid #8b5cf6',
                  }}
                >
                  <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                    Group Traded Volume
                  </div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.5px' }}>
                    {fmtCurrency(kpis.totalTradedVolumeMinor['INR'] ?? '0', 'INR')}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                    From {kpis.filledOrders} filled group order{kpis.filledOrders === 1 ? '' : 's'}
                  </div>
                </div>

                {/* KPI 4: Win Rate & Fill Rate */}
                <div
                  style={{
                    background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                    border: '1px solid #1e2433',
                    borderRadius: 12,
                    padding: '16px 18px',
                    borderLeft: '4px solid #10b981',
                  }}
                >
                  <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                    Win Rate & Fill Rate
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--ok)' }}>
                      {kpis.winRatePct !== null ? `${kpis.winRatePct.toFixed(1)}%` : '—'}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                      ({kpis.winningPositions}W / {kpis.losingPositions}L)
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                    Fill Rate: <strong style={{ color: 'var(--text)' }}>{kpis.fillRatePct.toFixed(1)}%</strong> ({kpis.filledOrders}/{kpis.totalOrders})
                  </div>
                </div>
              </div>

              {/* Member Contribution Matrix */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h4 style={{ margin: 0, fontSize: 15 }}>Member Performance & Contribution Matrix</h4>
                  <span className="muted" style={{ fontSize: 12 }}>{rep.accounts.length} member account{rep.accounts.length === 1 ? '' : 's'}</span>
                </div>

                {rep.accounts.length === 0 ? (
                  <div className="empty-state" style={{ padding: '24px 16px', background: 'rgba(255,255,255,0.02)', borderRadius: 8 }}>
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>No accounts in this group yet.</p>
                  </div>
                ) : (
                  <div className="table-scroll-container">
                    <table style={{ width: '100%' }}>
                      <thead>
                        <tr>
                          <th>Account</th>
                          <th>Status</th>
                          <th style={{ textAlign: 'right' }}>Allocated Capital</th>
                          <th style={{ textAlign: 'right' }}>Active Trades</th>
                          <th style={{ textAlign: 'right' }}>Locked Margin</th>
                          <th style={{ textAlign: 'right' }}>Unrealised PnL</th>
                          <th style={{ textAlign: 'right' }}>Return %</th>
                          <th style={{ textAlign: 'right' }}>Execution Rate</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rep.accounts.map((acc) => {
                          const accPnlInr = acc.unrealisedPnlMinor['INR'] ?? '0';
                          const accMarginInr = acc.lockedMarginMinor['INR'] ?? '0';
                          const accPnlNum = Number(accPnlInr);
                          const accIsProf = accPnlNum > 0;
                          const accIsLoss = accPnlNum < 0;

                          return (
                            <tr key={acc.accountId}>
                              <td>
                                <Link to={`/app/accounts/${acc.accountId}`} style={{ fontWeight: 700, color: 'var(--accent)', textDecoration: 'none' }}>
                                  {acc.accountName}
                                </Link>
                              </td>
                              <td><span className={`badge ${acc.status === 'active' ? 'planned' : 'skipped'}`}>{acc.status}</span></td>
                              <td className="mono" style={{ textAlign: 'right' }}>
                                {acc.allocatedCapitalMinor
                                  ? fmtCurrency(acc.allocatedCapitalMinor, acc.allocatedCurrency ?? 'INR')
                                  : '—'}
                              </td>
                              <td className="mono" style={{ textAlign: 'right' }}>{acc.openPositionsCount}</td>
                              <td className="mono" style={{ textAlign: 'right' }}>{fmtCurrency(accMarginInr, 'INR')}</td>
                              <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: accIsProf ? 'var(--ok)' : accIsLoss ? 'var(--danger)' : 'var(--text)' }}>
                                {fmtSignedCurrency(accPnlInr, 'INR')}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                {acc.roePct !== null ? (
                                  <span
                                    className="pnl-pct-badge"
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 700,
                                      padding: '2px 6px',
                                      borderRadius: 4,
                                      background: accIsProf ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                                      color: accIsProf ? 'var(--ok)' : 'var(--danger)',
                                    }}
                                  >
                                    {accIsProf ? '+' : accIsLoss ? '−' : ''}{Math.abs(acc.roePct).toFixed(2)}%
                                  </span>
                                ) : '—'}
                              </td>
                              <td style={{ textAlign: 'right', fontSize: 12 }}>
                                <strong>{acc.fillRatePct.toFixed(0)}%</strong> <span className="muted">({acc.filledOrders}/{acc.totalOrders})</span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Group Asset Exposure */}
              <div style={{ marginBottom: 28 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h4 style={{ margin: 0, fontSize: 15 }}>Group Asset Exposure</h4>
                  <span className="muted" style={{ fontSize: 12 }}>{rep.symbols.length} active pair{rep.symbols.length === 1 ? '' : 's'}</span>
                </div>

                {rep.symbols.length === 0 ? (
                  <div className="empty-state" style={{ padding: '24px 16px', background: 'rgba(255,255,255,0.02)', borderRadius: 8 }}>
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>No active positions open across this group's accounts.</p>
                  </div>
                ) : (
                  <div className="table-scroll-container">
                    <table style={{ width: '100%' }}>
                      <thead>
                        <tr>
                          <th>Asset / Pair</th>
                          <th>Side</th>
                          <th style={{ textAlign: 'right' }}>Total Size</th>
                          <th style={{ textAlign: 'right' }}>Positions</th>
                          <th style={{ textAlign: 'right' }}>Avg Entry</th>
                          <th style={{ textAlign: 'right' }}>Mark Price</th>
                          <th style={{ textAlign: 'right' }}>Locked Margin</th>
                          <th style={{ textAlign: 'right' }}>Unrealised PnL</th>
                          <th style={{ textAlign: 'right' }}>ROE %</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rep.symbols.map((s) => {
                          const sPnlNum = Number(s.unrealisedPnlMinor);
                          const sIsProf = sPnlNum > 0;
                          const sIsLoss = sPnlNum < 0;
                          return (
                            <tr key={s.pair}>
                              <td><strong>{s.symbol}</strong> <span className="muted" style={{ fontSize: 11 }}>({s.pair})</span></td>
                              <td>
                                <span className={`badge ${s.side === 'long' ? 'planned' : s.side === 'short' ? 'skipped' : ''}`}>
                                  {s.side.toUpperCase()}
                                </span>
                              </td>
                              <td className="mono" style={{ textAlign: 'right' }}>{s.totalQuantity}</td>
                              <td className="mono" style={{ textAlign: 'right' }}>{s.positionsCount}</td>
                              <td className="mono" style={{ textAlign: 'right' }}>{s.avgEntryPrice ? fmtPrice(s.avgEntryPrice) : '—'}</td>
                              <td className="mono" style={{ textAlign: 'right' }}>{s.markPrice ? fmtPrice(s.markPrice) : '—'}</td>
                              <td className="mono" style={{ textAlign: 'right' }}>{fmtCurrency(s.lockedMarginMinor, s.marginCurrency)}</td>
                              <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: sIsProf ? 'var(--ok)' : sIsLoss ? 'var(--danger)' : 'var(--text)' }}>
                                {fmtSignedCurrency(s.unrealisedPnlMinor, s.marginCurrency)}
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                {s.roePct !== null ? (
                                  <span
                                    className="pnl-pct-badge"
                                    style={{
                                      fontSize: 11,
                                      fontWeight: 700,
                                      padding: '2px 6px',
                                      borderRadius: 4,
                                      background: sIsProf ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                                      color: sIsProf ? 'var(--ok)' : 'var(--danger)',
                                    }}
                                  >
                                    {sIsProf ? '+' : sIsLoss ? '−' : ''}{Math.abs(s.roePct).toFixed(2)}%
                                  </span>
                                ) : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Group Order Execution Blotter */}
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h4 style={{ margin: 0, fontSize: 15 }}>Group Execution Orders</h4>
                  <span className="muted" style={{ fontSize: 12 }}>{rep.recentOrders.length} order{rep.recentOrders.length === 1 ? '' : 's'}</span>
                </div>

                {rep.recentOrders.length === 0 ? (
                  <div className="empty-state" style={{ padding: '24px 16px', background: 'rgba(255,255,255,0.02)', borderRadius: 8 }}>
                    <p className="muted" style={{ margin: 0, fontSize: 13 }}>No orders recorded for this group in this timeframe.</p>
                  </div>
                ) : (
                  <div className="table-scroll-container">
                    <table style={{ width: '100%', fontSize: 13 }}>
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Account</th>
                          <th>Pair</th>
                          <th>Side</th>
                          <th>State</th>
                          <th style={{ textAlign: 'right' }}>Filled Qty</th>
                          <th style={{ textAlign: 'right' }}>Avg Fill Price</th>
                          <th style={{ textAlign: 'right' }}>Notional</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rep.recentOrders.map((o) => (
                          <tr key={o.id}>
                            <td className="muted" style={{ fontSize: 12 }}>{new Date(o.createdAtMs).toLocaleTimeString()}</td>
                            <td>
                              <Link to={`/app/accounts/${o.accountId}`} style={{ color: 'var(--text)', textDecoration: 'none' }}>
                                {o.accountName}
                              </Link>
                            </td>
                            <td><strong>{o.pair}</strong></td>
                            <td>
                              <span
                                className="badge"
                                style={{
                                  background: o.side === 'buy' ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                                  color: o.side === 'buy' ? 'var(--ok)' : 'var(--danger)',
                                  fontWeight: 700,
                                }}
                              >
                                {o.side.toUpperCase()}
                              </span>
                            </td>
                            <td><span className={`badge ${o.state === 'filled' ? 'planned' : o.state === 'rejected' ? 'skipped' : ''}`}>{o.state}</span></td>
                            <td className="mono" style={{ textAlign: 'right' }}>{o.filledQuantity ?? '—'}</td>
                            <td className="mono" style={{ textAlign: 'right' }}>{o.avgFillPrice ? fmtPrice(o.avgFillPrice) : '—'}</td>
                            <td className="mono" style={{ textAlign: 'right' }}>{o.notionalMinor ? fmtCurrency(o.notionalMinor, o.quoteCurrency ?? 'INR') : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    )}
  </div>
</div>
);
}
