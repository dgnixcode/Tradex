import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { fetchBlotterGroups, fetchGroups, fetchTradingAnalytics } from '../api.ts';
import type { TradingAnalyticsReport } from '../api.ts';
import { fmtPrice } from './Futures.tsx';
import { GroupOrderItem } from './Blotter.tsx';

export function fmtCurrency(minorStr: string | null | undefined, cur: string = 'INR'): string {
  if (!minorStr || minorStr === '0') return cur.toUpperCase() === 'INR' ? '₹0.00' : `0.00 ${cur}`;
  const isNeg = minorStr.startsWith('-');
  const absStr = isNeg ? minorStr.slice(1) : minorStr;
  const isUsdt = cur.toUpperCase() === 'USDT';
  const divisor = isUsdt ? 100_000_000 : 100;
  const num = Number(absStr) / divisor;
  const decimals = isUsdt ? (num >= 100 ? 2 : 4) : 2;
  const formatted = num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: decimals });
  const sign = isNeg ? '−' : '';
  return cur.toUpperCase() === 'INR' ? `${sign}₹${formatted}` : `${sign}${formatted} ${cur}`;
}

export function fmtSignedCurrency(minorStr: string | null | undefined, cur: string = 'INR'): string {
  if (!minorStr || minorStr === '0') return cur.toUpperCase() === 'INR' ? '₹0.00' : `0.00 ${cur}`;
  const isNeg = minorStr.startsWith('-');
  const absStr = isNeg ? minorStr.slice(1) : minorStr;
  const isUsdt = cur.toUpperCase() === 'USDT';
  const divisor = isUsdt ? 100_000_000 : 100;
  const num = Number(absStr) / divisor;
  const decimals = isUsdt ? (num >= 100 ? 2 : 4) : 2;
  const formatted = num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: decimals });
  if (cur.toUpperCase() === 'INR') {
    return isNeg ? `−₹${formatted}` : `+₹${formatted}`;
  }
  return isNeg ? `−${formatted} ${cur}` : `+${formatted} ${cur}`;
}

export function getPnlSentiment(minorByCur: Record<string, string> | null | undefined): 'prof' | 'loss' | 'flat' {
  if (!minorByCur) return 'flat';
  let totalINR = 0;
  for (const [cur, val] of Object.entries(minorByCur)) {
    const divisor = cur.toUpperCase() === 'USDT' ? 100_000_000 : 100;
    const mult = cur.toUpperCase() === 'USDT' ? 100 : 1;
    totalINR += (Number(val) / divisor) * mult;
  }
  if (totalINR > 0.01) return 'prof';
  if (totalINR < -0.01) return 'loss';
  return 'flat';
}

export function renderMultiCurrency(
  minorByCur: Record<string, string> | null | undefined,
  signed: boolean = false,
): React.ReactNode {
  if (!minorByCur || Object.keys(minorByCur).length === 0) {
    return signed ? '+₹0.00' : '₹0.00';
  }
  const entries = Object.entries(minorByCur).filter(([_, val]) => val !== '0' && val !== '');
  if (entries.length === 0) {
    return signed ? '+₹0.00' : '₹0.00';
  }

  return (
    <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      {entries.map(([cur, val]) => {
        const text = signed ? fmtSignedCurrency(val, cur) : fmtCurrency(val, cur);
        const num = Number(val);
        const isPos = num > 0;
        const isNeg = num < 0;
        return (
          <span
            key={cur}
            style={{
              display: 'inline-block',
              fontWeight: 700,
              color: signed ? (isPos ? 'var(--ok)' : isNeg ? 'var(--danger)' : 'var(--text)') : 'var(--text)',
            }}
          >
            {text}
          </span>
        );
      })}
    </div>
  );
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
  const [activeTab, setActiveTab] = useState<'symbols' | 'closed' | 'groups' | 'accounts' | 'orders'>('symbols');
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());

  const toggleGroupExpand = (groupTradeId: string) => {
    setExpandedGroupIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupTradeId)) next.delete(groupTradeId);
      else next.add(groupTradeId);
      return next;
    });
  };

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

  const groupOrdersQuery = useQuery({
    queryKey: ['blotter-groups', selectedGroupId],
    queryFn: () => fetchBlotterGroups({
      groupId: selectedGroupId === '' ? undefined : selectedGroupId,
      limit: 50,
    }),
    refetchInterval: 6_000,
  });

  const data = analyticsQuery.data;
  const kpis = data?.kpis;

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
            Comprehensive performance, realized PnL, margin exposure, and order execution analytics.
          </p>
        </div>

        {/* Filters: Timeframe & Strategy Group */}
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

          <select
            className="telemetry-select"
            value={selectedGroupId}
            onChange={(e) => setSelectedGroupId(e.target.value)}
            aria-label="Filter by group"
          >
            <option value="">All Groups (Entire Desk)</option>
            {(groupsQuery.data ?? []).map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>

          <button
            type="button"
            className="telemetry-action-btn"
            disabled={analyticsQuery.isFetching}
            onClick={() => {
              void analyticsQuery.refetch();
              void groupOrdersQuery.refetch();
            }}
            title="Refresh analytics data"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: analyticsQuery.isFetching ? 'spin 1s linear infinite' : 'none' }}>
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
            {analyticsQuery.isFetching ? 'Refreshing…' : 'Refresh'}
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
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 14,
              marginBottom: 24,
            }}
          >
            {/* KPI 1: Net Desk PnL (Realized + Unrealized) */}
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
                Net Desk PnL (Total)
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

            {/* KPI 2: Realized PnL (Closed Trades) */}
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

            {/* KPI 3: Unrealised PnL (Open Positions) */}
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

            {/* KPI 4: Margin Deployed */}
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
                Executed Trading Volume
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
              className={`account-nav-tab ${activeTab === 'symbols' ? 'active' : ''}`}
              onClick={() => setActiveTab('symbols')}
            >
              <span>Active Positions ({data.symbols.length})</span>
            </button>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'closed' ? 'active' : ''}`}
              onClick={() => setActiveTab('closed')}
            >
              <span>Closed Trades & PnL ({data.closedTrades?.length ?? 0})</span>
            </button>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'groups' ? 'active' : ''}`}
              onClick={() => setActiveTab('groups')}
            >
              <span>Strategy Groups ({data.groups.length})</span>
            </button>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'accounts' ? 'active' : ''}`}
              onClick={() => setActiveTab('accounts')}
            >
              <span>Account Leaderboard ({data.accounts.length})</span>
            </button>
            <button
              type="button"
              className={`account-nav-tab ${activeTab === 'orders' ? 'active' : ''}`}
              onClick={() => setActiveTab('orders')}
            >
              <span>Group Orders Blotter ({groupOrdersQuery.data?.groups.length ?? 0})</span>
            </button>
          </div>

          {/* ── TAB 1: ASSET / SYMBOL BREAKDOWN (LIVE POSITIONS) ── */}
          {activeTab === 'symbols' && (
            <div className="table-scroll-container desktop-pos-table" style={{ background: '#0d0f14', borderRadius: 12, border: '1px solid #1e2433' }}>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Asset / Contract</th>
                    <th>Margin Mode</th>
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
                      <td colSpan={10} style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>
                        No open positions for the selected filter.
                      </td>
                    </tr>
                  )}
                  {data.symbols.map((s) => {
                    const pnlVal = Number(s.unrealisedPnlMinor);
                    const isP = pnlVal > 0;
                    const isL = pnlVal < 0;
                    return (
                      <tr key={`${s.pair}-${s.marginCurrency}`}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span className="asset-pill" style={{ fontSize: 13, padding: '2px 8px' }}>{s.symbol}</span>
                            <span className="muted" style={{ fontSize: 12 }}>{s.pair}</span>
                          </div>
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

          {/* ── TAB 2: CLOSED TRADES & REALIZED PNL ── */}
          {activeTab === 'closed' && (
            <div className="table-scroll-container desktop-pos-table" style={{ background: '#0d0f14', borderRadius: 12, border: '1px solid #1e2433' }}>
              <table style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Closed Time</th>
                    <th>Account</th>
                    <th>Group</th>
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
                      <td colSpan={11} style={{ textAlign: 'center', padding: '36px', color: 'var(--muted)' }}>
                        No closed trades recorded in this timeframe.
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
                          {t.groupName ? <span className="group-badge">{t.groupName}</span> : <span className="muted">—</span>}
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

          {/* ── TAB 3: STRATEGY GROUPS COMPARISON ── */}
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
                    <th style={{ textAlign: 'right' }}>Realized PnL</th>
                    <th style={{ textAlign: 'right' }}>Unrealised PnL</th>
                    <th style={{ textAlign: 'right' }}>Group ROE</th>
                    <th style={{ textAlign: 'center' }}>Profitable Members</th>
                    <th style={{ textAlign: 'center' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((g) => {
                    return (
                      <tr key={g.groupId}>
                        <td style={{ fontWeight: 600 }}>
                          <Link to={`/app/groups/${g.groupId}/analytics`} style={{ color: 'var(--text)', textDecoration: 'none' }}>
                            {g.groupName}
                          </Link>
                        </td>
                        <td className="mono" style={{ textAlign: 'right' }}>{g.memberCount}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{g.activePositionsCount}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{renderMultiCurrency(g.totalAllocatedMinor, false)}</td>
                        <td className="mono" style={{ textAlign: 'right' }}>{renderMultiCurrency(g.totalLockedMarginMinor, false)}</td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>
                          {renderMultiCurrency(g.totalRealizedPnlMinor, true)}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>
                          {renderMultiCurrency(g.totalUnrealisedPnlMinor, true)}
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
                          <Link to={`/app/groups/${g.groupId}/analytics`} className="btn btn-sm secondary" style={{ fontSize: 11, padding: '3px 8px' }}>
                            Analytics →
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── TAB 4: ACCOUNT LEADERBOARD ── */}
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
                    <th style={{ textAlign: 'right' }}>Realized PnL</th>
                    <th style={{ textAlign: 'right' }}>Unrealised PnL</th>
                    <th style={{ textAlign: 'right' }}>Return %</th>
                    <th style={{ textAlign: 'right' }}>Orders / Fill Rate</th>
                    <th style={{ textAlign: 'center' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {data.accounts.map((a) => {
                    return (
                      <tr key={a.accountId}>
                        <td style={{ fontWeight: 600 }}>
                          <Link to={`/app/accounts/${a.accountId}`} style={{ color: 'var(--text)', textDecoration: 'none' }}>
                            {a.accountName}
                          </Link>
                        </td>
                        <td>
                          {a.groupName ? (
                            <span className="group-badge">{a.groupName}</span>
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
                          {renderMultiCurrency(a.lockedMarginMinor, false)}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>
                          {renderMultiCurrency(a.realizedPnlMinor, true)}
                        </td>
                        <td className="mono" style={{ textAlign: 'right', fontWeight: 700 }}>
                          {renderMultiCurrency(a.unrealisedPnlMinor, true)}
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

          {/* ── TAB 5: GROUP ORDERS BLOTTER ── */}
          {activeTab === 'orders' && (
            <div>
              {groupOrdersQuery.isLoading && <p className="muted">Loading group orders…</p>}
              {groupOrdersQuery.data && (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <span className="muted" style={{ fontSize: 13 }}>
                      Showing {groupOrdersQuery.data.groups.length} group execution orders with account details
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
                      <p className="muted" style={{ margin: 0 }}>No group orders recorded yet.</p>
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
        </>
      )}
    </div>
  );
}
