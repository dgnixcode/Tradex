import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchGroups, fetchTradingAnalytics } from '../api.ts';
import type { TradingAnalyticsReport } from '../api.ts';
import { fmtPrice } from './Futures.tsx';

export function fmtCurrency(minorStr: string | null | undefined, cur: string = 'INR'): string {
  if (!minorStr || minorStr === '0') return cur === 'INR' ? '₹0.00' : `0.00 ${cur}`;
  const isNeg = minorStr.startsWith('-');
  const absStr = isNeg ? minorStr.slice(1) : minorStr;
  const num = Number(absStr) / 100;
  const formatted = num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = isNeg ? '−' : '';
  return cur === 'INR' ? `${sign}₹${formatted}` : `${sign}${formatted} ${cur}`;
}

export function fmtSignedCurrency(minorStr: string | null | undefined, cur: string = 'INR'): string {
  if (!minorStr || minorStr === '0') return cur === 'INR' ? '₹0.00' : `0.00 ${cur}`;
  const isNeg = minorStr.startsWith('-');
  const absStr = isNeg ? minorStr.slice(1) : minorStr;
  const num = Number(absStr) / 100;
  const formatted = num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return isNeg ? `−₹${formatted}` : `+₹${formatted}`;
}

export function Analytics() {
  const [timeframe, setTimeframe] = useState<'today' | '7d' | '30d' | 'all' | 'custom'>('all');
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState(() => {
    return new Date().toISOString().slice(0, 10);
  });
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'symbols' | 'groups' | 'accounts' | 'orders'>('symbols');

  const groupsQuery = useQuery({
    queryKey: ['groups'],
    queryFn: fetchGroups,
  });

  const fromMs = timeframe === 'custom' && customFrom ? new Date(`${customFrom}T00:00:00Z`).getTime() : undefined;
  const toMs = timeframe === 'custom' && customTo ? new Date(`${customTo}T23:59:59.999Z`).getTime() : undefined;

  const analyticsQuery = useQuery<TradingAnalyticsReport>({
    queryKey: ['trading-analytics', timeframe, selectedGroupId, fromMs, toMs],
    queryFn: () => fetchTradingAnalytics({
      timeframe,
      groupId: selectedGroupId === '' ? undefined : selectedGroupId,
      fromMs,
      toMs,
    }),
    refetchInterval: 5_000,
  });

  const data = analyticsQuery.data;
  const kpis = data?.kpis;

  // Primary currency defaults to INR
  const pnlInr = kpis?.unrealisedPnlMinor['INR'] ?? '0';
  const marginInr = kpis?.lockedMarginMinor['INR'] ?? '0';
  const pnlPctInr = kpis?.pnlPercentage['INR'];

  const pnlNum = Number(pnlInr);
  const isProf = pnlNum > 0;
  const isLoss = pnlNum < 0;

  return (
    <div className="panel full-width-page">
      {/* ── Top Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ margin: 0 }}>Trading Analytics & Telemetry</h2>
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
              Live Telemetry (5s)
            </span>
          </div>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
            Real-time trading performance, margin exposure, and execution analytics across accounts and strategy groups.
          </p>
        </div>

        {/* Filters: Timeframe & Strategy Group */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', background: 'rgba(255,255,255,0.05)', borderRadius: 8, padding: 3, border: '1px solid var(--line)' }}>
            {(['all', '30d', '7d', 'today', 'custom'] as const).map((tf) => (
              <button
                key={tf}
                type="button"
                className={`btn btn-sm ${timeframe === tf ? 'secondary' : 'ghost'}`}
                style={{
                  fontSize: 12,
                  padding: '4px 10px',
                  fontWeight: timeframe === tf ? 700 : 500,
                  borderRadius: 6,
                }}
                onClick={() => setTimeframe(tf)}
              >
                {tf === 'all' ? 'All Time' : tf === '30d' ? '30 Days' : tf === '7d' ? '7 Days' : tf === 'today' ? 'Today' : '📅 Custom'}
              </button>
            ))}
          </div>

          {timeframe === 'custom' && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(255,255,255,0.03)', border: '1px solid var(--line)', borderRadius: 8, padding: '3px 8px' }}>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>From:</span>
              <input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                style={{
                  background: '#0d0f14',
                  border: '1px solid var(--line)',
                  color: 'var(--text)',
                  borderRadius: 4,
                  padding: '2px 6px',
                  fontSize: 12,
                }}
              />
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>To:</span>
              <input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                style={{
                  background: '#0d0f14',
                  border: '1px solid var(--line)',
                  color: 'var(--text)',
                  borderRadius: 4,
                  padding: '2px 6px',
                  fontSize: 12,
                }}
              />
            </div>
          )}

          <select
            className="btn btn-sm"
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
            style={{ fontSize: 12, padding: '5px 12px', minWidth: 160 }}
            aria-label="Filter by group"
          >
            <option value="">All Groups (Entire Desk)</option>
            {(groupsQuery.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>📁 {g.name}</option>
            ))}
          </select>

          <button
            type="button"
            className="btn secondary btn-sm"
            disabled={analyticsQuery.isFetching}
            onClick={() => analyticsQuery.refetch()}
            style={{ fontSize: 12 }}
            title="Refresh analytics data"
          >
            {analyticsQuery.isFetching ? 'Refreshing…' : '🔄 Refresh'}
          </button>
        </div>
      </div>

      {analyticsQuery.isLoading && <p className="muted">Loading trading telemetry…</p>}
      {analyticsQuery.isError && <div className="error">{(analyticsQuery.error as Error).message}</div>}

      {data && kpis && (
        <>
          {/* ── KPI Summary Cards ── */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
              gap: 16,
              marginBottom: 24,
            }}
          >
            {/* KPI 1: Desk Unrealised PnL */}
            <div
              style={{
                background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                border: '1px solid #1e2433',
                borderRadius: 12,
                padding: '16px 20px',
                borderLeft: `4px solid ${isProf ? '#10b981' : isLoss ? '#ef4444' : '#64748b'}`,
              }}
            >
              <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Net Unrealised PnL
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  style={{
                    fontSize: 24,
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

            {/* KPI 2: Margin Deployed */}
            <div
              style={{
                background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                border: '1px solid #1e2433',
                borderRadius: 12,
                padding: '16px 20px',
                borderLeft: '4px solid #3b82f6',
              }}
            >
              <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Locked Margin Deployed
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.5px' }}>
                {fmtCurrency(marginInr, 'INR')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                Active collateral backing open positions
              </div>
            </div>

            {/* KPI 3: Total Traded Volume */}
            <div
              style={{
                background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                border: '1px solid #1e2433',
                borderRadius: 12,
                padding: '16px 20px',
                borderLeft: '4px solid #8b5cf6',
              }}
            >
              <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Executed Trading Volume
              </div>
              <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.5px' }}>
                {fmtCurrency(kpis.totalTradedVolumeMinor['INR'] ?? '0', 'INR')}
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                From {kpis.filledOrders} filled child order{kpis.filledOrders === 1 ? '' : 's'}
              </div>
            </div>

            {/* KPI 4: Win Rate & Execution Success */}
            <div
              style={{
                background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                border: '1px solid #1e2433',
                borderRadius: 12,
                padding: '16px 20px',
                borderLeft: '4px solid #10b981',
              }}
            >
              <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Trade Win Rate & Fill Rate
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 24, fontWeight: 800, color: 'var(--ok)' }}>
                  {kpis.winRatePct !== null ? `${kpis.winRatePct.toFixed(1)}%` : '—'}
                </span>
                <span style={{ fontSize: 13, color: 'var(--muted)' }}>
                  win rate ({kpis.winningPositions}W / {kpis.losingPositions}L)
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                Execution Fill Rate: <strong style={{ color: 'var(--text)' }}>{kpis.fillRatePct.toFixed(1)}%</strong> ({kpis.filledOrders}/{kpis.totalOrders})
              </div>
            </div>
          </div>

          {/* ── Section Navigation Tabs ── */}
          <div className="account-nav-tabs" style={{ marginBottom: 16 }}>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'symbols' ? 'active' : ''}`}
              onClick={() => setActiveTab('symbols')}
            >
              <span>🪙 Asset Performance ({data.symbols.length})</span>
            </button>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'groups' ? 'active' : ''}`}
              onClick={() => setActiveTab('groups')}
            >
              <span>📁 Strategy Groups ({data.groups.length})</span>
            </button>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'accounts' ? 'active' : ''}`}
              onClick={() => setActiveTab('accounts')}
            >
              <span>👥 Account Leaderboard ({data.accounts.length})</span>
            </button>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'orders' ? 'active' : ''}`}
              onClick={() => setActiveTab('orders')}
            >
              <span>📋 Order Activity ({data.recentOrders.length})</span>
            </button>
          </div>

          {/* ── TAB 1: ASSET / SYMBOL BREAKDOWN ── */}
          {activeTab === 'symbols' && (
            <div className="table-scroll-container desktop-pos-table" style={{ background: '#0d0f14', borderRadius: 12, border: '1px solid #1e2433' }}>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Asset / Contract</th>
                    <th>Side</th>
                    <th style={{ textAlign: 'right' }}>Active Trades</th>
                    <th style={{ textAlign: 'right' }}>Total Size</th>
                    <th style={{ textAlign: 'right' }}>Entry Price</th>
                    <th style={{ textAlign: 'right' }}>Mark Price</th>
                    <th style={{ textAlign: 'right' }}>Locked Margin</th>
                    <th style={{ textAlign: 'right' }}>Unrealised PnL</th>
                    <th style={{ textAlign: 'right' }}>ROE %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.symbols.length === 0 && (
                    <tr>
                      <td colSpan={9} style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>
                        No open positions for the selected filter.
                      </td>
                    </tr>
                  )}
                  {data.symbols.map((s) => {
                    const pnlVal = Number(s.unrealisedPnlMinor);
                    const isP = pnlVal > 0;
                    const isL = pnlVal < 0;
                    return (
                      <tr key={s.pair}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className="asset-pill" style={{ fontSize: 13, padding: '2px 8px' }}>{s.symbol}</span>
                            <span className="muted" style={{ fontSize: 12 }}>{s.pair}</span>
                          </div>
                        </td>
                        <td>
                          <span
                            className="badge"
                            style={{
                              color: s.side === 'long' ? 'var(--ok)' : s.side === 'short' ? 'var(--danger)' : 'var(--text-dim)',
                              borderColor: s.side === 'long' ? 'var(--ok)' : s.side === 'short' ? 'var(--danger)' : 'var(--text-dim)',
                              background: s.side === 'long' ? 'rgba(75,181,99,0.12)' : s.side === 'short' ? 'rgba(240,85,90,0.12)' : 'transparent',
                              fontSize: 11,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                            }}
                          >
                            {s.side}
                          </span>
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>{s.positionsCount}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{s.totalQuantity}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{fmtPrice(s.avgEntryPrice)}</td>
                        <td className="mono" style={{ textAlign: 'right', color: 'var(--accent)' }}>{fmtPrice(s.markPrice)}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{fmtCurrency(s.lockedMarginMinor, s.marginCurrency)}</td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: isP ? 'var(--ok)' : isL ? 'var(--danger)' : 'var(--text)' }}>
                          {fmtSignedCurrency(s.unrealisedPnlMinor, s.marginCurrency)}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 600, color: s.roePct && s.roePct > 0 ? 'var(--ok)' : s.roePct && s.roePct < 0 ? 'var(--danger)' : 'var(--muted)' }}>
                          {s.roePct !== null ? `${s.roePct > 0 ? '+' : ''}${s.roePct.toFixed(2)}%` : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── TAB 2: STRATEGY GROUPS COMPARISON ── */}
          {activeTab === 'groups' && (
            <div className="table-scroll-container desktop-pos-table" style={{ background: '#0d0f14', borderRadius: 12, border: '1px solid #1e2433' }}>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Strategy Group</th>
                    <th style={{ textAlign: 'right' }}>Members</th>
                    <th style={{ textAlign: 'right' }}>Open Trades</th>
                    <th style={{ textAlign: 'right' }}>Allocated Capital</th>
                    <th style={{ textAlign: 'right' }}>Locked Margin</th>
                    <th style={{ textAlign: 'right' }}>Unrealised PnL</th>
                    <th style={{ textAlign: 'right' }}>Group ROE</th>
                    <th style={{ textAlign: 'center' }}>Profitable Members</th>
                    <th style={{ textAlign: 'center' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((g) => {
                    const pnlInrVal = Number(g.totalUnrealisedPnlMinor['INR'] ?? '0');
                    const isP = pnlInrVal > 0;
                    const isL = pnlInrVal < 0;
                    return (
                      <tr key={g.groupId}>
                        <td style={{ fontWeight: 600 }}>
                          <Link to={`/app/groups/${g.groupId}`} style={{ color: 'var(--text)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>📁</span> {g.groupName}
                          </Link>
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>{g.memberCount}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{g.activePositionsCount}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{fmtCurrency(g.totalAllocatedMinor['INR'] ?? '0', 'INR')}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{fmtCurrency(g.totalLockedMarginMinor['INR'] ?? '0', 'INR')}</td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: isP ? 'var(--ok)' : isL ? 'var(--danger)' : 'var(--text)' }}>
                          {fmtSignedCurrency(g.totalUnrealisedPnlMinor['INR'] ?? '0', 'INR')}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 600, color: g.roePct && g.roePct > 0 ? 'var(--ok)' : g.roePct && g.roePct < 0 ? 'var(--danger)' : 'var(--muted)' }}>
                          {g.roePct !== null ? `${g.roePct > 0 ? '+' : ''}${g.roePct.toFixed(2)}%` : '—'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span className="badge" style={{ fontSize: 11, background: 'rgba(255,255,255,0.06)' }}>
                            <strong style={{ color: 'var(--ok)' }}>{g.profitableMembersCount}</strong> prof / <strong style={{ color: 'var(--danger)' }}>{g.unprofitableMembersCount}</strong> loss
                          </span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <Link to={`/app/groups/${g.groupId}`} className="btn btn-sm secondary" style={{ fontSize: 11, padding: '3px 8px' }}>
                            View Group →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── TAB 3: ACCOUNT LEADERBOARD ── */}
          {activeTab === 'accounts' && (
            <div className="table-scroll-container desktop-pos-table" style={{ background: '#0d0f14', borderRadius: 12, border: '1px solid #1e2433' }}>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Strategy Group</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Allocated Capital</th>
                    <th style={{ textAlign: 'right' }}>Open Trades</th>
                    <th style={{ textAlign: 'right' }}>Locked Margin</th>
                    <th style={{ textAlign: 'right' }}>Unrealised PnL</th>
                    <th style={{ textAlign: 'right' }}>Return %</th>
                    <th style={{ textAlign: 'right' }}>Orders / Fill Rate</th>
                    <th style={{ textAlign: 'center' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => {
                    const accPnl = Number(a.unrealisedPnlMinor['INR'] ?? '0');
                    const isP = accPnl > 0;
                    const isL = accPnl < 0;
                    return (
                      <tr key={a.accountId}>
                        <td style={{ fontWeight: 600 }}>
                          <Link to={`/app/accounts/${a.accountId}`} style={{ color: 'var(--text)', textDecoration: 'none' }}>
                            {a.accountName}
                          </Link>
                        </td>
                        <td>
                          {a.groupName ? (
                            <span className="group-badge">📁 {a.groupName}</span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          <span className={`badge ${a.status === 'active' ? 'planned' : 'skipped'}`} style={{ fontSize: 10.5 }}>
                            {a.status}
                          </span>
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>
                          {fmtCurrency(a.allocatedCapitalMinor, a.allocatedCurrency ?? 'INR')}
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>{a.openPositionsCount}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>
                          {fmtCurrency(a.lockedMarginMinor['INR'] ?? '0', 'INR')}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: isP ? 'var(--ok)' : isL ? 'var(--danger)' : 'var(--text)' }}>
                          {fmtSignedCurrency(a.unrealisedPnlMinor['INR'] ?? '0', 'INR')}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 600, color: a.roePct && a.roePct > 0 ? 'var(--ok)' : a.roePct && a.roePct < 0 ? 'var(--danger)' : 'var(--muted)' }}>
                          {a.roePct !== null ? `${a.roePct > 0 ? '+' : ''}${a.roePct.toFixed(2)}%` : '—'}
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>
                          {a.totalOrders} ord ({a.fillRatePct.toFixed(0)}% fill)
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <Link to={`/app/accounts/${a.accountId}`} className="btn btn-sm secondary" style={{ fontSize: 11, padding: '3px 8px' }}>
                            View Account →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── TAB 4: RECENT ORDER ACTIVITY ── */}
          {activeTab === 'orders' && (
            <div className="table-scroll-container desktop-pos-table" style={{ background: '#0d0f14', borderRadius: 12, border: '1px solid #1e2433' }}>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Account</th>
                    <th>Strategy Group</th>
                    <th>Pair / Market</th>
                    <th>Side</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Qty</th>
                    <th style={{ textAlign: 'right' }}>Fill Price</th>
                    <th style={{ textAlign: 'right' }}>Notional</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recentOrders.length === 0 && (
                    <tr>
                      <td colSpan={9} style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>
                        No orders recorded within this timeframe.
                      </td>
                    </tr>
                  )}
                  {data.recentOrders.map((o) => (
                    <tr key={o.id}>
                      <td className="muted" style={{ fontSize: 11.5 }}>
                        {new Date(o.createdAtMs).toLocaleString('en-IN')}
                      </td>
                      <td style={{ fontWeight: 600 }}>{o.accountName}</td>
                      <td>
                        {o.groupName ? <span className="group-badge">📁 {o.groupName}</span> : <span className="muted">—</span>}
                      </td>
                      <td className="mono">{o.pair}</td>
                      <td>
                        <span className={`badge ${o.side === 'buy' ? 'planned' : 'skipped'}`} style={{ fontSize: 10.5, textTransform: 'uppercase' }}>
                          {o.side}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${o.state === 'filled' ? 'planned' : o.state === 'rejected' ? 'error' : 'skipped'}`} style={{ fontSize: 10.5 }}>
                          {o.state}
                        </span>
                      </td>
                      <td className="mono" style={{ textAlign: 'right' }}>{o.filledQuantity ?? '—'}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>{fmtPrice(o.avgFillPrice)}</td>
                      <td className="mono" style={{ textAlign: 'right' }}>
                        {o.notionalMinor ? fmtCurrency(o.notionalMinor, o.quoteCurrency ?? 'INR') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
