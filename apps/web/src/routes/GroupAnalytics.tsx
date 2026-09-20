import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchBlotterGroups, fetchGroup, fetchTradingAnalytics } from '../api.ts';
import type { TradingAnalyticsReport } from '../api.ts';
import { fmtCurrency, fmtSignedCurrency, getPnlSentiment, renderMultiCurrency } from './Analytics.tsx';
import { fmtPrice } from './Futures.tsx';
import { GroupOrderItem } from './Blotter.tsx';

export function GroupAnalytics({ propGroupId }: { readonly propGroupId?: string }) {
  const params = useParams();
  const groupId = propGroupId ?? params.groupId ?? '';
  const isEmbedded = Boolean(propGroupId);

  const [timeframe, setTimeframe] = useState<'all' | '30d' | '7d' | 'today' | 'custom'>('all');
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState(() => {
    return new Date().toISOString().slice(0, 10);
  });
  const [activeTab, setActiveTab] = useState<'exposure' | 'closed' | 'orders' | 'members'>('exposure');
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());

  const toggleGroupExpand = (groupTradeId: string) => {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupTradeId)) next.delete(groupTradeId);
      else next.add(groupTradeId);
      return next;
    });
  };

  const groupQuery = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => fetchGroup(groupId),
    enabled: Boolean(groupId),
  });

  const fromMs = timeframe === 'custom' && customFrom ? new Date(`${customFrom}T00:00:00Z`).getTime() : undefined;
  const toMs = timeframe === 'custom' && customTo ? new Date(`${customTo}T23:59:59.999Z`).getTime() : undefined;

  const analyticsQuery = useQuery<TradingAnalyticsReport>({
    queryKey: ['group-trading-analytics', groupId, timeframe, fromMs, toMs],
    queryFn: () => fetchTradingAnalytics({
      groupId,
      timeframe,
      fromMs,
      toMs,
    }),
    enabled: Boolean(groupId),
    refetchInterval: 5_000,
  });

  const groupOrdersQuery = useQuery({
    queryKey: ['blotter-groups', groupId],
    queryFn: () => fetchBlotterGroups({
      groupId,
      limit: 50,
    }),
    enabled: Boolean(groupId),
    refetchInterval: 6_000,
  });

  const data = analyticsQuery.data;
  const kpis = data?.kpis;
  const group = groupQuery.data;

  const netSentiment = getPnlSentiment(kpis?.netPnlMinor);
  const realSentiment = getPnlSentiment(kpis?.realizedPnlMinor);
  const unrealSentiment = getPnlSentiment(kpis?.unrealisedPnlMinor);
  const isNetProf = netSentiment === 'prof';
  const isNetLoss = netSentiment === 'loss';
  const isRealProf = realSentiment === 'prof';
  const isRealLoss = realSentiment === 'loss';
  const isUnrealProf = unrealSentiment === 'prof';
  const isUnrealLoss = unrealSentiment === 'loss';

  return (
    <div className={isEmbedded ? 'group-analytics-embedded' : 'panel full-width-page'}>
      {/* ── Top Header Bar ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {isEmbedded ? (
              <Link
                to={`/app/groups/${groupId}/analytics`}
                className="btn secondary btn-sm"
                style={{ fontSize: 11.5, padding: '2px 8px', display: 'inline-flex', alignItems: 'center', gap: 5, textDecoration: 'none' }}
              >
                Dedicated Page ↗
              </Link>
            ) : (
              <>
                <Link to={`/app/groups/${groupId}`} style={{ color: 'var(--muted)', textDecoration: 'none', fontSize: 13 }}>
                  ← Back to Group Overview
                </Link>
                <span className="muted">/</span>
              </>
            )}
            <h2 style={{ margin: 0 }}>{group?.name ?? 'Strategy Group'} Analytics</h2>
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
            Dedicated trading performance, closed trade history, margin exposure, and member telemetry for {group?.name ?? 'this group'}.
          </p>
        </div>

        {/* Filters Toolbar */}
        <div className="telemetry-toolbar">
          <div className="telemetry-pills">
            {(['all', '30d', '7d', 'today', 'custom'] as const).map((tf) => (
              <button
                key={tf}
                type="button"
                className={`telemetry-pill ${timeframe === tf ? 'active' : ''}`}
                onClick={() => setTimeframe(tf)}
              >
                {tf === 'all' ? 'All Time' : tf === '30d' ? '30 Days' : tf === '7d' ? '7 Days' : tf === 'today' ? 'Today' : 'Custom'}
              </button>
            ))}
          </div>

          {timeframe === 'custom' && (
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
            disabled={analyticsQuery.isFetching}
            onClick={() => {
              void analyticsQuery.refetch();
              void groupOrdersQuery.refetch();
            }}
            title="Refresh group telemetry"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: analyticsQuery.isFetching ? 'spin 1s linear infinite' : 'none' }}>
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
            {analyticsQuery.isFetching ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {analyticsQuery.isLoading && <p className="muted">Loading group trading telemetry…</p>}
      {analyticsQuery.isError && <div className="error">{(analyticsQuery.error as Error).message}</div>}

      {data && kpis && (
        <>
          {/* ── KPI Summary Cards ── */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 14,
              marginBottom: 24,
            }}
          >
            {/* KPI 1: Net Group PnL */}
            <div
              style={{
                background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                border: '1px solid #1e2433',
                borderRadius: 12,
                padding: '16px 18px',
                borderLeft: `4px solid ${isNetProf ? '#10b981' : isNetLoss ? '#ef4444' : '#64748b'}`,
              }}
            >
              <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Net Group PnL (Total)
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 22,
                    fontWeight: 800,
                    color: isNetProf ? 'var(--ok)' : isNetLoss ? 'var(--danger)' : 'var(--text)',
                    letterSpacing: '-0.5px',
                  }}
                >
                  {renderMultiCurrency(kpis.netPnlMinor, true)}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                Realized: {renderMultiCurrency(kpis.realizedPnlMinor, true)}
              </div>
            </div>

            {/* KPI 2: Realized Closed PnL */}
            <div
              style={{
                background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                border: '1px solid #1e2433',
                borderRadius: 12,
                padding: '16px 18px',
                borderLeft: `4px solid ${isRealProf ? '#10b981' : isRealLoss ? '#ef4444' : '#8b5cf6'}`,
              }}
            >
              <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Realized Closed PnL
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 22,
                    fontWeight: 800,
                    color: isRealProf ? 'var(--ok)' : isRealLoss ? 'var(--danger)' : 'var(--text)',
                    letterSpacing: '-0.5px',
                  }}
                >
                  {renderMultiCurrency(kpis.realizedPnlMinor, true)}
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                Across {kpis.closedTradesCount} closed trade{kpis.closedTradesCount === 1 ? '' : 's'} ({kpis.winningClosedTrades}W / {kpis.losingClosedTrades}L)
              </div>
            </div>

            {/* KPI 3: Unrealised PnL */}
            <div
              style={{
                background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                border: '1px solid #1e2433',
                borderRadius: 12,
                padding: '16px 18px',
                borderLeft: `4px solid ${isUnrealProf ? '#10b981' : isUnrealLoss ? '#ef4444' : '#64748b'}`,
              }}
            >
              <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Unrealised PnL (Live)
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontSize: 22,
                    fontWeight: 800,
                    color: isUnrealProf ? 'var(--ok)' : isUnrealLoss ? 'var(--danger)' : 'var(--text)',
                    letterSpacing: '-0.5px',
                  }}
                >
                  {renderMultiCurrency(kpis.unrealisedPnlMinor, true)}
                </span>
                {kpis.pnlPercentage && Object.entries(kpis.pnlPercentage).map(([cur, pct]) => {
                  const isP = pct > 0;
                  const isL = pct < 0;
                  return (
                    <span
                      key={cur}
                      className="pnl-pct-badge"
                      style={{
                        fontSize: 11.5,
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: 6,
                        background: isP ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                        color: isP ? 'var(--ok)' : 'var(--danger)',
                        border: `1px solid ${isP ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'}`,
                      }}
                    >
                      {isP ? '+' : isL ? '−' : ''}{Math.abs(pct).toFixed(2)}% ({cur})
                    </span>
                  );
                })}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                Across {kpis.openPositionsCount} active trade{kpis.openPositionsCount === 1 ? '' : 's'}
              </div>
            </div>

            {/* KPI 4: Locked Margin Deployed */}
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
                {renderMultiCurrency(kpis.lockedMarginMinor, false)}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                Active collateral backing positions
              </div>
            </div>

            {/* KPI 5: Volume */}
            <div
              style={{
                background: 'linear-gradient(180deg, #131722 0%, #0d0f14 100%)',
                border: '1px solid #1e2433',
                borderRadius: 12,
                padding: '16px 18px',
                borderLeft: '4px solid #f59e0b',
              }}
            >
              <div className="stat-label" style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Group Traded Volume
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--text)', letterSpacing: '-0.5px' }}>
                {renderMultiCurrency(kpis.totalTradedVolumeMinor, false)}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                From {kpis.filledOrders} filled child order{kpis.filledOrders === 1 ? '' : 's'}
              </div>
            </div>

            {/* KPI 6: Win Rate & Fill Rate */}
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
                  win rate
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>
                Fill Rate: <strong style={{ color: 'var(--text)' }}>{kpis.fillRatePct.toFixed(1)}%</strong> ({kpis.filledOrders}/{kpis.totalOrders})
              </div>
            </div>
          </div>

          {/* ── Section Navigation Tabs ── */}
          <div className="account-nav-tabs" style={{ marginBottom: 16 }}>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'exposure' ? 'active' : ''}`}
              onClick={() => setActiveTab('exposure')}
            >
              <span>Group Asset Exposure ({data.symbols.length})</span>
            </button>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'closed' ? 'active' : ''}`}
              onClick={() => setActiveTab('closed')}
            >
              <span>Closed Trades & Performance ({data.closedTrades?.length ?? 0})</span>
            </button>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'orders' ? 'active' : ''}`}
              onClick={() => setActiveTab('orders')}
            >
              <span>Group Orders Blotter ({groupOrdersQuery.data?.groups.length ?? 0})</span>
            </button>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'members' ? 'active' : ''}`}
              onClick={() => setActiveTab('members')}
            >
              <span>Member Contribution Matrix ({data.accounts.length})</span>
            </button>
          </div>

          {/* ── TAB 1: GROUP ASSET EXPOSURE (LIVE POSITIONS) ── */}
          {activeTab === 'exposure' && (
            <div className="table-scroll-container desktop-pos-table" style={{ background: '#0d0f14', borderRadius: 12, border: '1px solid #1e2433' }}>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Asset / Pair</th>
                    <th>Margin Mode</th>
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
                  {data.symbols.length === 0 && (
                    <tr>
                      <td colSpan={10} style={{ textAlign: 'center', padding: '36px', color: 'var(--muted)' }}>
                        No open positions for this group in this timeframe.
                      </td>
                    </tr>
                  )}
                  {data.symbols.map((s) => {
                    const pnlNum = Number(s.unrealisedPnlMinor);
                    const isP = pnlNum > 0;
                    const isL = pnlNum < 0;

                    return (
                      <tr key={`${s.pair}-${s.marginCurrency}`}>
                        <td>
                          <strong>{s.symbol}</strong> <span className="muted" style={{ fontSize: 11 }}>({s.pair})</span>
                        </td>
                        <td>
                          <span className="group-badge" style={{ fontSize: 11 }}>{s.marginCurrency}</span>
                        </td>
                        <td>
                          <span
                            className="badge"
                            style={{
                              color: s.side === 'long' ? 'var(--ok)' : s.side === 'short' ? 'var(--danger)' : 'var(--text-dim)',
                              borderColor: s.side === 'long' ? 'var(--ok)' : s.side === 'short' ? 'var(--danger)' : 'var(--text-dim)',
                              background: s.side === 'long' ? 'rgba(75,181,99,0.12)' : s.side === 'short' ? 'rgba(240,85,90,0.12)' : 'transparent',
                              fontSize: 10.5,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                            }}
                          >
                            {s.side}
                          </span>
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>{s.totalQuantity}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{s.positionsCount}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{s.avgEntryPrice ? fmtPrice(s.avgEntryPrice) : '—'}</td>
                        <td className="mono" style={{ textAlign: 'right', color: 'var(--accent)' }}>{s.markPrice ? fmtPrice(s.markPrice) : '—'}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{fmtCurrency(s.lockedMarginMinor, s.marginCurrency)}</td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: isP ? 'var(--ok)' : isL ? 'var(--danger)' : 'var(--text)' }}>
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
                                background: isP ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                                color: isP ? 'var(--ok)' : 'var(--danger)',
                              }}
                            >
                              {isP ? '+' : isL ? '−' : ''}{Math.abs(s.roePct).toFixed(2)}%
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

          {/* ── TAB 2: CLOSED TRADES & REALIZED PNL ── */}
          {activeTab === 'closed' && (
            <div className="table-scroll-container desktop-pos-table" style={{ background: '#0d0f14', borderRadius: 12, border: '1px solid #1e2433' }}>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Closed Time</th>
                    <th>Account</th>
                    <th>Asset / Pair</th>
                    <th>Side</th>
                    <th style={{ textAlign: 'right' }}>Quantity</th>
                    <th style={{ textAlign: 'right' }}>Entry Price</th>
                    <th style={{ textAlign: 'right' }}>Exit Price</th>
                    <th style={{ textAlign: 'right' }}>Realized PnL</th>
                    <th style={{ textAlign: 'right' }}>ROE %</th>
                    <th style={{ textAlign: 'center' }}>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {(!data.closedTrades || data.closedTrades.length === 0) && (
                    <tr>
                      <td colSpan={10} style={{ textAlign: 'center', padding: '36px', color: 'var(--muted)' }}>
                        No closed trades recorded for this group in this timeframe.
                      </td>
                    </tr>
                  )}
                  {(data.closedTrades ?? []).map((t) => {
                    const pnlNum = Number(t.realizedPnlMinor);
                    const isP = pnlNum > 0;
                    const isL = pnlNum < 0;

                    return (
                      <tr key={t.id}>
                        <td className="muted" style={{ fontSize: 11.5 }}>
                          {new Date(t.closedAtMs).toLocaleString('en-IN')}
                        </td>
                        <td style={{ fontWeight: 600 }}>
                          <Link to={`/app/accounts/${t.accountId}`} style={{ color: 'var(--text)', textDecoration: 'none' }}>
                            {t.accountName}
                          </Link>
                        </td>
                        <td>
                          <strong>{t.pair}</strong>
                        </td>
                        <td>
                          <span
                            className="badge"
                            style={{
                              color: t.side === 'long' ? 'var(--ok)' : 'var(--danger)',
                              borderColor: t.side === 'long' ? 'var(--ok)' : 'var(--danger)',
                              background: t.side === 'long' ? 'rgba(75,181,99,0.12)' : 'rgba(240,85,90,0.12)',
                              fontSize: 10.5,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                            }}
                          >
                            {t.side} {t.leverage ? `${t.leverage}` : ''}
                          </span>
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>{t.quantity}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{fmtPrice(t.avgEntryPrice)}</td>
                        <td className="mono" style={{ textAlign: 'right', color: 'var(--accent)' }}>{fmtPrice(t.avgExitPrice)}</td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700, color: isP ? 'var(--ok)' : isL ? 'var(--danger)' : 'var(--text)' }}>
                          {fmtSignedCurrency(t.realizedPnlMinor, t.marginCurrency)}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 600, color: isP ? 'var(--ok)' : isL ? 'var(--danger)' : 'var(--muted)' }}>
                          {t.roePct !== null ? `${t.roePct > 0 ? '+' : ''}${t.roePct.toFixed(2)}%` : '—'}
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span
                            className="badge"
                            style={{
                              background: isP ? 'rgba(16,185,129,0.15)' : isL ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.06)',
                              color: isP ? 'var(--ok)' : isL ? 'var(--danger)' : 'var(--muted)',
                              border: `1px solid ${isP ? 'rgba(16,185,129,0.35)' : isL ? 'rgba(239,68,68,0.35)' : 'transparent'}`,
                              fontSize: 10.5,
                              fontWeight: 700,
                            }}
                          >
                            {isP ? 'WIN' : isL ? 'LOSS' : 'FLAT'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── TAB 3: GROUP ORDERS BLOTTER ── */}
          {activeTab === 'orders' && (
            <div>
              {groupOrdersQuery.isLoading && <p className="muted">Loading group orders…</p>}
              {groupOrdersQuery.data && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <span className="muted" style={{ fontSize: 13 }}>
                      Showing {groupOrdersQuery.data.groups.length} group orders with individual account execution details
                    </span>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="btn btn-sm secondary"
                        style={{ fontSize: 11.5, padding: '4px 10px' }}
                        onClick={() => {
                          const allIds = new Set(groupOrdersQuery.data?.groups.map((g) => g.groupTradeId) ?? []);
                          setExpandedGroupIds(allIds);
                        }}
                      >
                        Expand All
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm secondary"
                        style={{ fontSize: 11.5, padding: '4px 10px' }}
                        onClick={() => setExpandedGroupIds(new Set())}
                      >
                        Collapse All
                      </button>
                    </div>
                  </div>

                  {groupOrdersQuery.data.groups.length === 0 ? (
                    <div className="empty-state" style={{ padding: '36px', background: '#0d0f14', borderRadius: 12, border: '1px solid #1e2433', textAlign: 'center' }}>
                      <p className="muted" style={{ margin: 0 }}>No group orders recorded for this group yet.</p>
                    </div>
                  ) : (
                    groupOrdersQuery.data.groups.map((g) => (
                      <GroupOrderItem
                        key={g.groupTradeId}
                        g={g}
                        isExpanded={expandedGroupIds.has(g.groupTradeId)}
                        onToggle={() => toggleGroupExpand(g.groupTradeId)}
                      />
                    ))
                  )}
                </>
              )}
            </div>
          )}

          {/* ── TAB 4: MEMBER CONTRIBUTION MATRIX ── */}
          {activeTab === 'members' && (
            <div className="table-scroll-container desktop-pos-table" style={{ background: '#0d0f14', borderRadius: 12, border: '1px solid #1e2433' }}>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Allocated Capital</th>
                    <th style={{ textAlign: 'right' }}>Open Trades</th>
                    <th style={{ textAlign: 'right' }}>Locked Margin</th>
                    <th style={{ textAlign: 'right' }}>Realized PnL</th>
                    <th style={{ textAlign: 'right' }}>Unrealised PnL</th>
                    <th style={{ textAlign: 'right' }}>Return %</th>
                    <th style={{ textAlign: 'right' }}>Fill Rate</th>
                    <th style={{ textAlign: 'center' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.length === 0 && (
                    <tr>
                      <td colSpan={10} style={{ textAlign: 'center', padding: '36px', color: 'var(--muted)' }}>
                        No members in this group.
                      </td>
                    </tr>
                  )}
                  {data.accounts.map((acc) => {
                    const accPnlVal = Number(acc.unrealisedPnlMinor['INR'] ?? '0') + (Number(acc.unrealisedPnlMinor['USDT'] ?? '0') / 1000000);
                    const accIsProf = acc.roePct !== null ? acc.roePct > 0 : accPnlVal > 0;
                    const accIsLoss = acc.roePct !== null ? acc.roePct < 0 : accPnlVal < 0;

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
                        <td className="mono" style={{ textAlign: 'right' }}>
                          {renderMultiCurrency(acc.lockedMarginMinor, false)}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>
                          {renderMultiCurrency(acc.realizedPnlMinor, true)}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>
                          {renderMultiCurrency(acc.unrealisedPnlMinor, true)}
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
                                background: accIsProf ? 'rgba(16,185,129,0.15)' : accIsLoss ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.06)',
                                color: accIsProf ? 'var(--ok)' : accIsLoss ? 'var(--danger)' : 'var(--muted)',
                              }}
                            >
                              {accIsProf ? '+' : accIsLoss ? '−' : ''}{Math.abs(acc.roePct).toFixed(2)}%
                            </span>
                          ) : '—'}
                        </td>
                        <td style={{ textAlign: 'right', fontSize: 12 }}>
                          <strong>{acc.fillRatePct.toFixed(0)}%</strong> <span className="muted">({acc.filledOrders}/{acc.totalOrders})</span>
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <Link to={`/app/accounts/${acc.accountId}`} className="btn btn-sm secondary" style={{ fontSize: 11, padding: '3px 8px' }}>
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
        </>
      )}
    </div>
  );
}
