import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adjustFuturesPosition,
  confirmAccount,
  deleteAccount,
  exitFuturesPosition,
  fetchAccount,
  fetchFuturesPositions,
  resumeAccount,
  setFuturesProtection,
  setTrailingProtection,
  suspendAccount,
  syncAccount,
} from '../api.ts';
import type { FuturesPositionRow } from '../api.ts';
import { useAuth } from '../auth.tsx';
import {
  PositionManageModal,
  addMinors,
  bufferColor,
  calcRoePct,
  fmtMinor,
  fmtPrice,
  pnlClass,
  pnlText,
  roeText,
} from './Futures.tsx';

// One connected exchange account.
// Features:
// 1. Tabbed navigation: Positions (default), Overview & Balances, Account Actions.
// 2. Positions Tab: Displays all live futures positions for this account with real-time mark,
//    liquidation buffer, unrealised PnL, ROE %, and the full-featured PositionManageModal.
// 3. Removed confusing spot token / dust table since Tradex is a futures execution system
//    and funding balances (INR / USDT) are clearly shown at the top.

const STATUS_LABEL: Record<string, string> = {
  active: 'active',
  pending_validation: 'not switched on',
  suspended: 'deactivated',
  disconnected: 'disconnected',
};

const statusBadgeClass = (status: string): string => (status === 'active' ? 'planned' : 'skipped');

function formatMinor(minor: string, scale: number, currency: string): string {
  const digits = minor.padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const frac = scale === 0 ? '' : digits.slice(-scale).replace(/0+$/, '');
  const num = `${whole}${frac === '' ? '' : `.${frac}`}`;
  return currency === 'INR' ? `₹${num}` : `${num} ${currency}`;
}

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

  const [activeTab, setActiveTab] = useState<'positions' | 'overview' | 'actions'>('positions');
  const [managingPosition, setManagingPosition] = useState<FuturesPositionRow | null>(null);

  const [opError, setOpError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const account = useQuery({
    queryKey: ['account', accountId],
    queryFn: () => fetchAccount(accountId),
  });

  const futuresPositions = useQuery({
    queryKey: ['futures-positions'],
    queryFn: fetchFuturesPositions,
    refetchInterval: 3000,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['account', accountId] });
    void queryClient.invalidateQueries({ queryKey: ['accounts'] });
    void queryClient.invalidateQueries({ queryKey: ['groups'] });
    void queryClient.invalidateQueries({ queryKey: ['futures-positions'] });
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

  const adjustMut = useMutation({
    mutationFn: ({ id, direction, percentBp }: { id: string; direction: 'reduce' | 'increase'; percentBp: number }) =>
      adjustFuturesPosition(id, direction, percentBp),
    onSuccess: (out, { direction, percentBp }) => {
      setSyncNote(`${direction === 'reduce' ? 'Closed' : 'Added'} ${percentBp / 100}% — ${out.quantity} ${direction === 'reduce' ? 'sold' : 'bought'}${out.full ? ' (full exit)' : ''}.`);
      setManagingPosition(null);
      invalidate();
    },
    onError: (e) => setOpError((e as Error).message),
  });

  const exitMut = useMutation({
    mutationFn: ({ id, marginCurrency }: { id: string; marginCurrency: 'INR' | 'USDT' }) =>
      exitFuturesPosition(id, marginCurrency),
    onSuccess: (out) => {
      setSyncNote(`Position closed at market (cancelled ${out.cancelled.length} conditional order${out.cancelled.length === 1 ? '' : 's'}).`);
      setManagingPosition(null);
      invalidate();
    },
    onError: (e) => setOpError((e as Error).message),
  });

  const protMut = useMutation({
    mutationFn: async (args: { readonly id: string; readonly slp?: string | undefined; readonly tpp?: string | undefined; readonly trailing?: boolean | undefined }) => {
      const body: { stopLossPrice?: string; takeProfitPrice?: string; moveExisting: boolean } = { moveExisting: true };
      if (args.slp !== undefined && args.slp !== '') body.stopLossPrice = args.slp;
      if (args.tpp !== undefined && args.tpp !== '') body.takeProfitPrice = args.tpp;

      const out = await setFuturesProtection(args.id, body);

      if (args.trailing && args.slp) {
        await setTrailingProtection(args.id, {
          enable: true,
          currentSlPrice: args.slp,
          stepBp: '100',
          distanceBp: '100',
        });
      } else if (!args.trailing) {
        await setTrailingProtection(args.id, { enable: false });
      }
      return out;
    },
    onSuccess: (out) => {
      const failures: string[] = [];
      if (out.stopLoss?.ok === false) failures.push(`SL: ${out.stopLoss.reason ?? 'refused'}`);
      if (out.takeProfit?.ok === false) failures.push(`TP: ${out.takeProfit.reason ?? 'refused'}`);
      if (failures.length > 0) {
        setOpError(`Some legs failed — ${failures.join('; ')}`);
      } else {
        setSyncNote('Protection updated.');
      }
      setManagingPosition(null);
      invalidate();
    },
    onError: (e) => setOpError((e as Error).message),
  });

  const a = account.data;
  const busy = finish.isPending || suspend.isPending || resume.isPending || remove.isPending || sync.isPending;

  // Filter positions strictly for this account
  const accountPositions = useMemo(() => {
    const views = futuresPositions.data?.views ?? [];
    return views.filter((p) => {
      const isThisAccount = p.accountId === accountId || (a && p.accountName.trim().toLowerCase() === a.name.trim().toLowerCase());
      if (!isThisAccount) return false;
      if (p.side === 'flat') return false;
      const q = Number(p.quantity);
      if (!Number.isFinite(q) || q <= 0) return false;
      return true;
    });
  }, [futuresPositions.data?.views, accountId, a]);

  const liveManagingPosition = useMemo(() => {
    if (managingPosition === null) return null;
    const views = futuresPositions.data?.views ?? [];
    return views.find((r) => r.venuePositionId === managingPosition.venuePositionId) ?? managingPosition;
  }, [futuresPositions.data?.views, managingPosition]);

  // Aggregate unrealised PnL for this account
  const totalAccountPnl = useMemo(() => {
    const byCurrency: Record<string, string> = {};
    for (const p of accountPositions) {
      if (p.unrealisedPnlMinor !== null) {
        const cur = p.marginCurrency;
        byCurrency[cur] = byCurrency[cur] === undefined
          ? p.unrealisedPnlMinor
          : addMinors(byCurrency[cur]!, p.unrealisedPnlMinor);
      }
    }
    return byCurrency;
  }, [accountPositions]);

  // Aggregate margin for this account
  const totalAccountMargin = useMemo(() => {
    const byCurrency: Record<string, string> = {};
    for (const p of accountPositions) {
      if (p.lockedMarginMinor !== null && p.lockedMarginMinor !== '' && p.lockedMarginMinor !== '0') {
        const cur = p.marginCurrency;
        byCurrency[cur] = byCurrency[cur] === undefined
          ? p.lockedMarginMinor
          : addMinors(byCurrency[cur]!, p.lockedMarginMinor);
      }
    }
    return byCurrency;
  }, [accountPositions]);

  if (account.isLoading) return <div className="panel full-width-page">Loading account…</div>;
  if (account.isError) return <div className="panel error full-width-page">{(account.error as Error).message}</div>;
  if (!account.isSuccess || !a) return <div className="panel full-width-page">No such account.</div>;

  return (
    <div className="account-detail-page full-width-page">
      <div className="panel">
        {/* Account Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h2 style={{ margin: 0 }}>{a.name}</h2>
            <span className={`badge ${statusBadgeClass(a.status)}`}>
              {STATUS_LABEL[a.status] ?? a.status}
            </span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <button
              className="btn secondary btn-sm"
              disabled={sync.isPending || account.isFetching || futuresPositions.isFetching}
              onClick={() => {
                sync.mutate();
                void account.refetch();
                void futuresPositions.refetch();
              }}
              title="Fetch fresh balances & positions directly from exchange"
            >
              {sync.isPending ? 'Syncing with exchange…' : '🔄 Refresh / Sync'}
            </button>

            <Link to="/app/accounts" className="btn ghost btn-sm">
              ← All accounts
            </Link>
          </div>
        </div>

        {/* Sync Note Alert */}
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

        {/* Account Status Alerts */}
        {a.status === 'pending_validation' && (
          <div className="spread-warning" style={{ marginBottom: 16 }}>
            The key was checked and works, but this account was never switched on — so it is not
            traded. Finish connecting to enable trades on this account.
          </div>
        )}
        {a.status === 'suspended' && (
          <div className="spread-warning" style={{ marginBottom: 16 }}>
            Deactivated. Group trades skip this account entirely until it is reactivated; its key,
            its capital and its history are untouched.
          </div>
        )}

        {/* Tab Navigation */}
        <div className="account-nav-tabs">
          <button
            type="button"
            className={`account-nav-tab ${activeTab === 'positions' ? 'active' : ''}`}
            onClick={() => setActiveTab('positions')}
          >
            <span>📈 Positions</span>
            {accountPositions.length > 0 && (
              <span className="account-tab-badge">{accountPositions.length}</span>
            )}
          </button>
          <button
            type="button"
            className={`account-nav-tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <span>📋 Overview & Balances</span>
          </button>
          <button
            type="button"
            className={`account-nav-tab ${activeTab === 'actions' ? 'active' : ''}`}
            onClick={() => setActiveTab('actions')}
          >
            <span>⚙️ Account Actions</span>
          </button>
        </div>

        {/* TAB 1: POSITIONS */}
        {activeTab === 'positions' && (
          <div>
            {futuresPositions.isLoading && <p className="muted">Loading positions…</p>}
            {futuresPositions.isError && <div className="error">{(futuresPositions.error as Error).message}</div>}

            {futuresPositions.isSuccess && accountPositions.length === 0 && (
              <div className="empty-state" style={{ padding: '40px 20px' }}>
                <p className="empty-ico">📈</p>
                <p style={{ fontWeight: 600, fontSize: 15, margin: '8px 0 4px' }}>No Open Futures Positions</p>
                <p className="muted" style={{ maxWidth: 460, margin: '0 auto', fontSize: 13 }}>
                  This account currently has no active futures positions. Positions opened for this account during group trades will appear here with real-time PnL, leverage, and bracket controls.
                </p>
              </div>
            )}

            {accountPositions.length > 0 && (
              <>
                {/* Account-level Summary Stats */}
                <div className="positions-summary" style={{ marginBottom: 16 }}>
                  <div>
                    <div className="stat-label">Unrealised PnL</div>
                    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                      {Object.entries(totalAccountPnl).map(([cur, minor]) => {
                        const pnlVal = Number(minor);
                        const marginMinor = totalAccountMargin[cur];
                        const marginVal = marginMinor ? Number(marginMinor) : 0;
                        const pct = marginVal > 0 ? (pnlVal / marginVal) * 100 : null;
                        const isProf = pnlVal > 0;
                        const isLoss = pnlVal < 0;
                        const sign = isProf ? '+' : isLoss ? '-' : '';
                        const pctColor = isProf ? 'var(--ok)' : isLoss ? 'var(--danger)' : 'var(--text-dim)';
                        const pctBg = isProf ? 'rgba(16, 185, 129, 0.15)' : isLoss ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 255, 255, 0.05)';
                        const pctBorder = isProf ? 'rgba(16, 185, 129, 0.35)' : isLoss ? 'rgba(239, 68, 68, 0.35)' : 'rgba(255, 255, 255, 0.1)';

                        return (
                          <div key={cur} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <span className={`pnl-big ${pnlClass(minor)}`}>
                              {pnlText(minor, cur as 'INR' | 'USDT')}
                            </span>
                            {pct !== null && (
                              <span
                                className="pnl-pct-badge"
                                style={{
                                  color: pctColor,
                                  background: pctBg,
                                  border: `1px solid ${pctBorder}`,
                                }}
                              >
                                {sign}{Math.abs(pct).toFixed(2)}%
                              </span>
                            )}
                          </div>
                        );
                      })}
                      {Object.keys(totalAccountPnl).length === 0 && (
                        <span className="pnl-big muted">—</span>
                      )}
                    </div>
                  </div>
                  <div style={{ borderLeft: '1px solid var(--line)', paddingLeft: 20 }}>
                    <div className="stat-label">Margin Invested</div>
                    <div style={{ display: 'flex', gap: 16 }}>
                      {Object.entries(totalAccountMargin).map(([cur, minor]) => (
                        <span key={cur} className="stat-value" style={{ fontWeight: 600 }}>
                          {fmtMinor(minor, cur as 'INR' | 'USDT')}
                        </span>
                      ))}
                      {Object.keys(totalAccountMargin).length === 0 && (
                        <span className="stat-value muted">—</span>
                      )}
                    </div>
                  </div>
                  <div style={{ borderLeft: '1px solid var(--line)', paddingLeft: 20 }}>
                    <div className="stat-label">Open Positions</div>
                    <div className="stat-value">{accountPositions.length}</div>
                  </div>
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
                    <span
                      className="badge"
                      style={{
                        background: 'rgba(75,181,99,0.12)',
                        color: 'var(--ok)',
                        border: '1px solid var(--ok)',
                        fontSize: 11,
                        fontWeight: 600,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 5,
                        padding: '2px 8px',
                      }}
                    >
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block' }} />
                      Live (3s)
                    </span>
                  </div>
                </div>

                {/* Positions Table (Desktop > 768px) */}
                <div className="table-scroll-container desktop-pos-table">
                  <table style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Contract</th>
                        <th>Side</th>
                        <th style={{ textAlign: 'right' }}>Size</th>
                        <th style={{ textAlign: 'right' }}>Avg Entry</th>
                        <th style={{ textAlign: 'right' }}>Mark</th>
                        <th style={{ textAlign: 'right' }}>Liq Price</th>
                        <th style={{ textAlign: 'right' }}>Margin</th>
                        <th style={{ textAlign: 'right' }}>Unrealised PnL</th>
                        <th>Protection</th>
                        <th style={{ textAlign: 'center' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {accountPositions.map((p) => {
                        const roe = calcRoePct(p);
                        const hasSl = p.stopLossTrigger && p.stopLossTrigger !== '0' && Number(p.stopLossTrigger) > 0;
                        const hasTp = p.takeProfitTrigger && p.takeProfitTrigger !== '0' && Number(p.takeProfitTrigger) > 0;
                        const sideBadgeColor = p.side === 'long' ? 'var(--ok)' : p.side === 'short' ? 'var(--danger)' : 'var(--text-dim)';
                        return (
                          <tr key={p.venuePositionId}>
                            <td style={{ fontWeight: 600 }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span>{p.pair}</span>
                                <span className="muted" style={{ fontSize: 11 }}>({p.marginCurrency})</span>
                              </div>
                              {p.groupName && (
                                <span className="group-badge" style={{ marginTop: 3 }}>
                                  📁 {p.groupName}
                                </span>
                              )}
                            </td>
                            <td>
                              <span
                                className="badge"
                                style={{
                                  color: sideBadgeColor,
                                  borderColor: sideBadgeColor,
                                  background: p.side === 'long' ? 'rgba(75,181,99,0.1)' : p.side === 'short' ? 'rgba(240,85,90,0.1)' : 'transparent',
                                  fontSize: 11,
                                  fontWeight: 700,
                                  textTransform: 'uppercase',
                                }}
                              >
                                {p.side} {p.leverage ? `${p.leverage}×` : ''}
                              </span>
                            </td>
                            <td className="mono" style={{ textAlign: 'right' }}>
                              {p.quantity}
                            </td>
                            <td className="mono" style={{ textAlign: 'right' }}>
                              {fmtPrice(p.avgEntryPrice)}
                            </td>
                            <td className="mono" style={{ textAlign: 'right', color: 'var(--accent)' }}>
                              {fmtPrice(p.markPrice)}
                            </td>
                            <td className="mono" style={{ textAlign: 'right', color: bufferColor(p.liqBufferBp) }}>
                              {fmtPrice(p.liquidationPrice)}
                              {p.liqBufferBp !== null && (
                                <span className="muted" style={{ display: 'block', fontSize: 10.5 }}>
                                  {(p.liqBufferBp / 100).toFixed(1)}% buf
                                </span>
                              )}
                            </td>
                            <td className="mono" style={{ textAlign: 'right' }}>
                              {p.lockedMarginMinor !== null && p.lockedMarginMinor !== ''
                                ? fmtMinor(p.lockedMarginMinor, p.marginCurrency)
                                : '—'}
                            </td>
                            <td className={`mono ${pnlClass(p.unrealisedPnlMinor)}`} style={{ textAlign: 'right', fontWeight: 600 }}>
                              {pnlText(p.unrealisedPnlMinor, p.marginCurrency)}
                              {roe !== null && (
                                <span style={{ display: 'block', fontSize: 11, fontWeight: 500 }}>
                                  {roeText(roe).trim()}
                                </span>
                              )}
                            </td>
                            <td>
                              {!hasSl && !hasTp ? (
                                <span className="muted" style={{ fontSize: 11.5 }}>none</span>
                              ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                  {hasSl && <span className="badge skipped" style={{ fontSize: 9.5, padding: '1px 5px' }}>SL {fmtPrice(p.stopLossTrigger)}</span>}
                                  {hasTp && <span className="badge planned" style={{ fontSize: 9.5, padding: '1px 5px' }}>TP {fmtPrice(p.takeProfitTrigger)}</span>}
                                </div>
                              )}
                            </td>
                            <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
                              <button
                                type="button"
                                className="btn btn-sm secondary"
                                style={{
                                  fontSize: 11.5,
                                  padding: '3px 10px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 4,
                                  fontWeight: 600,
                                }}
                                onClick={() => {
                                  setManagingPosition(p);
                                  setOpError(null);
                                  setSyncNote(null);
                                }}
                              >
                                <span>⚙</span> Manage
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Position Cards (<= 768px) */}
                <div className="mobile-pos-cards">
                  {accountPositions.map((p) => {
                    const roe = calcRoePct(p);
                    const hasSl = p.stopLossTrigger && p.stopLossTrigger !== '0' && Number(p.stopLossTrigger) > 0;
                    const hasTp = p.takeProfitTrigger && p.takeProfitTrigger !== '0' && Number(p.takeProfitTrigger) > 0;
                    const sideColor = p.side === 'long' ? 'var(--ok)' : p.side === 'short' ? 'var(--danger)' : 'var(--text-dim)';
                    return (
                      <div key={`mobile-${p.venuePositionId}`} className="pos-mobile-card">
                        <div className="pos-mobile-card-top">
                          <div>
                            <div className="pos-mobile-acc-name">{p.pair} ({p.marginCurrency})</div>
                            {p.groupName && <div className="pos-mobile-grp-badge">📁 {p.groupName}</div>}
                          </div>
                          <div style={{ textAlign: 'right' }}>
                            <div className={`pos-mobile-pnl ${pnlClass(p.unrealisedPnlMinor)}`}>
                              {pnlText(p.unrealisedPnlMinor, p.marginCurrency)}
                            </div>
                            {roe !== null && (
                              <span className="pos-mobile-roe-pill" style={{ color: roe >= 0 ? 'var(--ok)' : 'var(--danger)' }}>
                                {roeText(roe).trim()}
                              </span>
                            )}
                          </div>
                        </div>

                        <div className="pos-mobile-grid">
                          <div className="pos-mobile-cell">
                            <span className="pos-mobile-label">Side / Lev</span>
                            <span className="pos-mobile-val" style={{ color: sideColor, fontWeight: 700 }}>
                              {p.side.toUpperCase()} {p.leverage ? `${p.leverage}×` : ''}
                            </span>
                          </div>
                          <div className="pos-mobile-cell">
                            <span className="pos-mobile-label">Margin</span>
                            <span className="pos-mobile-val mono">
                              {p.lockedMarginMinor && p.lockedMarginMinor !== '0' ? fmtMinor(p.lockedMarginMinor, p.marginCurrency) : '—'}
                            </span>
                          </div>
                          <div className="pos-mobile-cell">
                            <span className="pos-mobile-label">Size</span>
                            <span className="pos-mobile-val mono">{p.quantity}</span>
                          </div>
                          <div className="pos-mobile-cell">
                            <span className="pos-mobile-label">Entry</span>
                            <span className="pos-mobile-val mono">{fmtPrice(p.avgEntryPrice)}</span>
                          </div>
                          <div className="pos-mobile-cell">
                            <span className="pos-mobile-label">Mark</span>
                            <span className="pos-mobile-val mono" style={{ color: 'var(--accent)' }}>{fmtPrice(p.markPrice)}</span>
                          </div>
                          <div className="pos-mobile-cell">
                            <span className="pos-mobile-label">Liq Buffer</span>
                            <span className="pos-mobile-val mono" style={{ color: bufferColor(p.liqBufferBp) }}>
                              {p.liqBufferBp !== null ? `${(p.liqBufferBp / 100).toFixed(1)}%` : fmtPrice(p.liquidationPrice)}
                            </span>
                          </div>
                        </div>

                        <div className="pos-mobile-card-foot">
                          <div className="pos-mobile-prot">
                            <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 4 }}>Protection:</span>
                            {!hasSl && !hasTp ? (
                              <span className="muted" style={{ fontSize: 11 }}>None</span>
                            ) : (
                              <div style={{ display: 'inline-flex', gap: 4 }}>
                                {hasSl && <span className="badge skipped" style={{ fontSize: 9, padding: '1px 5px' }}>SL {fmtPrice(p.stopLossTrigger)}</span>}
                                {hasTp && <span className="badge planned" style={{ fontSize: 9, padding: '1px 5px' }}>TP {fmtPrice(p.takeProfitTrigger)}</span>}
                              </div>
                            )}
                          </div>

                          <button
                            type="button"
                            className="btn btn-sm secondary"
                            style={{ width: '100%', marginTop: 8, padding: '8px', fontSize: 12.5, fontWeight: 700, borderRadius: 8 }}
                            onClick={() => {
                              setManagingPosition(p);
                              setOpError(null);
                              setSyncNote(null);
                            }}
                          >
                            ⚙ Manage Position
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        {/* TAB 2: OVERVIEW & BALANCES */}
        {activeTab === 'overview' && (
          <div>
            <table style={{ width: '100%' }}>
              <tbody>
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
                  <td className="muted" style={{ width: 220 }}>Strategy Group</td>
                  <td>
                    {a.groupName && a.groupId ? (
                      <Link to={`/app/groups/${a.groupId}`} style={{ textDecoration: 'none' }}>
                        <span className="badge" style={{ background: 'rgba(59, 130, 246, 0.1)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.25)' }}>
                          📁 {a.groupName}
                        </span>
                      </Link>
                    ) : (
                      <span className="muted">Unassigned</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <td className="muted" style={{ width: 220 }}>Master Desk</td>
                  <td>
                    <span className="badge" style={{ background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)' }}>
                      🌐 Default (All Accounts)
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* Collapsed inspection for raw spot coin balances */}
            {a.balances.length > 0 && (
              <details style={{ marginTop: 28, borderTop: '1px solid var(--line)', paddingTop: 16 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)', fontSize: 12.5, fontWeight: 600 }}>
                  🔍 Show Raw Exchange Wallet Holdings ({a.balances.length} coins recorded)
                </summary>
                <div style={{ marginTop: 12 }}>
                  <table style={{ width: '100%', fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th>Currency</th>
                        <th>Free</th>
                        <th>Locked</th>
                        <th>Funding</th>
                        <th>Read At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.balances.map((b) => (
                        <tr key={b.currency}>
                          <td style={{ fontWeight: 600 }}>{b.currency}</td>
                          <td className="mono">{formatMinor(b.freeMinor, b.scale, b.currency)}</td>
                          <td className="mono">{formatMinor(b.lockedMinor, b.scale, b.currency)}</td>
                          <td>
                            {(a.fundingCurrencies as readonly string[]).includes(b.currency) ? (
                              <span className="badge planned" style={{ fontSize: 10 }}>yes</span>
                            ) : (
                              <span className="muted">no</span>
                            )}
                          </td>
                          <td className="muted">{when(b.observedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            )}
          </div>
        )}

        {/* TAB 3: ACCOUNT ACTIONS */}
        {activeTab === 'actions' && (
          <div>
            <p className="sub muted" style={{ marginTop: 0, marginBottom: 16 }}>
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
        )}

        {opError !== null && <div className="error" style={{ marginTop: 14 }}>{opError}</div>}
      </div>

      {/* ── Position Management Modal (Safe Execution & Bracket Controls for Specific Account) ── */}
      {liveManagingPosition !== null && (
        <PositionManageModal
          position={liveManagingPosition}
          onClose={() => setManagingPosition(null)}
          onExit={(id, mc) => exitMut.mutate({ id, marginCurrency: mc })}
          onAdjust={(id, direction, percentBp) => adjustMut.mutate({ id, direction, percentBp })}
          onProtection={(args) => protMut.mutate(args)}
          isExiting={exitMut.isPending}
          isAdjusting={adjustMut.isPending}
          isProtecting={protMut.isPending}
        />
      )}
    </div>
  );
}
