import { useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchBlotterGroups, fetchFuturesPrices, fetchGroup, fetchTradingAnalytics } from '../api.ts';
import type { TradingAnalyticsReport } from '../api.ts';
import { useLivePrices } from '../useLivePrices.ts';
import { fmtCurrency, fmtSignedCurrency, getPnlSentiment, renderMultiCurrency, renderKpiValue, downloadCsv } from './Analytics.tsx';
import { fmtPrice } from './Futures.tsx';
import { GroupOrderItem } from './Blotter.tsx';

export function GroupAnalytics({ propGroupId }: { readonly propGroupId?: string }) {
  const params = useParams();
  const groupId = propGroupId ?? params.groupId ?? '';
  const isEmbedded = Boolean(propGroupId);

  const [timeframe, setTimeframe] = useState<'all' | '30d' | '7d' | 'today' | 'custom'>('all');
  const [currencyFilter, setCurrencyFilter] = useState<'all' | 'INR' | 'USDT'>('all');
  const [tableSearch, setTableSearch] = useState('');
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState(() => {
    return new Date().toISOString().slice(0, 10);
  });
  const [activeTab, setActiveTab] = useState<'exposure' | 'closed' | 'orders' | 'members'>('exposure');
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(new Set());
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);

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

  // Real-time market data streaming via WebSocket/SSE
  const { isStreaming } = useLivePrices();

  // Bulk futures prices query:
  // - When socket stream is active: refetchInterval is false (0 HTTP polls, 100% pure WebSocket/SSE stream)
  // - When socket drops or fails: refetchInterval activates at 1500ms as automatic fallback
  const pricesQuery = useQuery({
    queryKey: ['futures-prices'],
    queryFn: fetchFuturesPrices,
    refetchInterval: isStreaming ? false : 1500,
    staleTime: isStreaming ? Infinity : 500,
  });
  const pricesData = pricesQuery.data;

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
    refetchInterval: isStreaming ? 15_000 : 5_000,
  });

  const groupOrdersQuery = useQuery({
    queryKey: ['blotter-groups', groupId],
    queryFn: () => fetchBlotterGroups({
      groupId,
      limit: 50,
    }),
    enabled: Boolean(groupId),
    refetchInterval: isStreaming ? 15_000 : 5_000,
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

  // Filtered lists for table search
  const filteredClosedTrades = useMemo(() => {
    const list = data?.closedTrades ?? [];
    const q = tableSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((t) =>
      t.pair.toLowerCase().includes(q) ||
      t.accountName.toLowerCase().includes(q) ||
      t.side.toLowerCase().includes(q)
    );
  }, [data?.closedTrades, tableSearch]);

  const filteredSymbols = useMemo(() => {
    const list = data?.symbols ?? [];
    const q = tableSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      s.symbol.toLowerCase().includes(q) ||
      s.pair.toLowerCase().includes(q) ||
      s.marginCurrency.toLowerCase().includes(q) ||
      s.side.toLowerCase().includes(q)
    );
  }, [data?.symbols, tableSearch]);

  const filteredMembers = useMemo(() => {
    const list = data?.accounts ?? [];
    const q = tableSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((a) =>
      a.accountName.toLowerCase().includes(q)
    );
  }, [data?.accounts, tableSearch]);

  const handleExportCsv = () => {
    const dateStr = new Date().toISOString().slice(0, 10);
    const gName = (group?.name ?? 'group').replace(/\s+/g, '_').toLowerCase();
    if (activeTab === 'closed') {
      const headers = ['Closed Time', 'Account', 'Pair', 'Side', 'Quantity', 'Entry Price', 'Exit Price', 'Realized PnL', 'Currency', 'ROE %', 'Outcome'];
      const rows = filteredClosedTrades.map((t) => [
        new Date(t.closedAtMs).toLocaleString('en-IN'),
        t.accountName,
        t.pair,
        t.side.toUpperCase(),
        t.quantity,
        t.avgEntryPrice,
        t.avgExitPrice,
        (Number(t.realizedPnlMinor) / (t.marginCurrency === 'USDT' ? 100_000_000 : 100)).toFixed(2),
        t.marginCurrency,
        t.roePct !== null ? `${t.roePct.toFixed(2)}%` : '—',
        Number(t.realizedPnlMinor) > 0 ? 'WIN' : Number(t.realizedPnlMinor) < 0 ? 'LOSS' : 'FLAT',
      ]);
      downloadCsv(`${gName}_closed_trades_${dateStr}.csv`, headers, rows);
    } else if (activeTab === 'exposure') {
      const headers = ['Asset', 'Pair', 'Margin Mode', 'Side', 'Total Size', 'Positions Count', 'Avg Entry Price', 'Mark Price', 'Locked Margin', 'Unrealised PnL', 'ROE %'];
      const rows = filteredSymbols.map((s) => [
        s.symbol,
        s.pair,
        s.marginCurrency,
        s.side.toUpperCase(),
        s.totalQuantity,
        s.positionsCount,
        s.avgEntryPrice,
        s.markPrice,
        s.lockedMarginMinor,
        s.unrealisedPnlMinor,
        s.roePct !== null ? `${s.roePct.toFixed(2)}%` : '—',
      ]);
      downloadCsv(`${gName}_exposure_${dateStr}.csv`, headers, rows);
    } else if (activeTab === 'members') {
      const headers = ['Account', 'Status', 'Allocated Capital', 'Open Trades', 'ROE %', 'Orders Count', 'Fill Rate %'];
      const rows = filteredMembers.map((a) => [
        a.accountName,
        a.status,
        a.allocatedCapitalMinor,
        a.openPositionsCount,
        a.roePct !== null ? `${a.roePct.toFixed(2)}%` : '—',
        a.totalOrders,
        `${a.fillRatePct.toFixed(1)}%`,
      ]);
      downloadCsv(`${gName}_members_${dateStr}.csv`, headers, rows);
    }
  };

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
          {/* Currency Filter */}
          <div className="telemetry-pills">
            <button
              type="button"
              className={`telemetry-pill ${currencyFilter === 'all' ? 'active' : ''}`}
              onClick={() => setCurrencyFilter('all')}
              title="Show all currencies"
            >
              All Currencies
            </button>
            <button
              type="button"
              className={`telemetry-pill ${currencyFilter === 'INR' ? 'active' : ''}`}
              onClick={() => setCurrencyFilter('INR')}
              title="Filter INR margin metrics only"
            >
              INR Margin
            </button>
            <button
              type="button"
              className={`telemetry-pill ${currencyFilter === 'USDT' ? 'active' : ''}`}
              onClick={() => setCurrencyFilter('USDT')}
              title="Filter USDT margin metrics only"
            >
              USDT Margin
            </button>
          </div>

          {/* Timeframe Filter */}
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

          {/* Socket stream indicator matching Trade Watchlist */}
          {isStreaming ? (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: '#0ecb81',
                background: 'rgba(14, 203, 129, 0.12)',
                border: '1px solid rgba(14, 203, 129, 0.25)',
                borderRadius: 4,
                padding: '4px 8px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
              title="Real-time WebSocket streaming active (<500ms updates via CoinDCX)"
            >
              <span style={{ fontSize: 7, color: '#0ecb81' }}>●</span> Live (WS Stream)
            </span>
          ) : (
            <span
              style={{
                fontSize: 10,
                fontWeight: 600,
                color: '#f59e0b',
                background: 'rgba(245, 158, 11, 0.12)',
                border: '1px solid rgba(245, 158, 11, 0.25)',
                borderRadius: 4,
                padding: '4px 8px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
              title="Connecting to real-time WebSocket stream — falling back to HTTP polling"
            >
              <span style={{ fontSize: 7, color: '#f59e0b' }}>●</span> Polling (1s)
            </span>
          )}

          <button
            type="button"
            className="telemetry-action-btn"
            disabled={isManualRefreshing}
            onClick={async () => {
              setIsManualRefreshing(true);
              try {
                await Promise.all([analyticsQuery.refetch(), groupOrdersQuery.refetch()]);
              } finally {
                setIsManualRefreshing(false);
              }
            }}
            title="Refresh group telemetry"
          >
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: isManualRefreshing ? 'spin 1s linear infinite' : 'none' }}>
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
            {isManualRefreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {analyticsQuery.isLoading && <p className="muted">Loading group trading telemetry…</p>}
      {analyticsQuery.isError && <div className="error">{(analyticsQuery.error as Error).message}</div>}

      {data && kpis && (
        <>
          {/* ── KPI Summary Cards ── */}
          <div className="telemetry-kpi-grid">
            {/* KPI 1: Net Group PnL */}
            <div className={`telemetry-kpi-card ${isNetProf ? 'profit' : isNetLoss ? 'loss' : 'neutral'}`}>
              <div className="kpi-card-header">
                <span className="kpi-card-title">Net Group PnL (Total)</span>
                <span className="kpi-card-icon-box">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
                    <polyline points="17 6 23 6 23 12" />
                  </svg>
                </span>
              </div>
              <div>{renderKpiValue(kpis.netPnlMinor, true, currencyFilter)}</div>
              <div className="kpi-subtext">
                Realized: {renderKpiValue(kpis.realizedPnlMinor, true, currencyFilter, 13)}
              </div>
            </div>

            {/* KPI 2: Realized Closed PnL */}
            <div className={`telemetry-kpi-card ${isRealProf ? 'profit' : isRealLoss ? 'loss' : 'realized'}`}>
              <div className="kpi-card-header">
                <span className="kpi-card-title">Realized Closed PnL</span>
                <span className="kpi-card-icon-box">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </span>
              </div>
              <div>{renderKpiValue(kpis.realizedPnlMinor, true, currencyFilter)}</div>
              <div className="kpi-subtext">
                {kpis.closedTradesCount > 0 ? (
                  <>
                    <div className="kpi-mini-bar-track">
                      <div
                        className="kpi-mini-bar-win"
                        style={{ width: `${(kpis.winningClosedTrades / kpis.closedTradesCount) * 100}%` }}
                      />
                      <div
                        className="kpi-mini-bar-loss"
                        style={{ width: `${(kpis.losingClosedTrades / kpis.closedTradesCount) * 100}%` }}
                      />
                    </div>
                    <span>
                      {kpis.closedTradesCount} trade{kpis.closedTradesCount === 1 ? '' : 's'} ({kpis.winningClosedTrades}W / {kpis.losingClosedTrades}L)
                    </span>
                  </>
                ) : (
                  <span>No closed trades in timeframe</span>
                )}
              </div>
            </div>

            {/* KPI 3: Unrealised PnL */}
            <div className={`telemetry-kpi-card ${isUnrealProf ? 'profit' : isUnrealLoss ? 'loss' : 'neutral'}`}>
              <div className="kpi-card-header">
                <span className="kpi-card-title">Unrealised PnL (Live)</span>
                <span className="kpi-card-icon-box">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                </span>
              </div>
              <div>{renderKpiValue(kpis.unrealisedPnlMinor, true, currencyFilter)}</div>
              <div className="kpi-subtext" style={{ flexWrap: 'wrap', gap: 4 }}>
                {kpis.pnlPercentage && Object.entries(kpis.pnlPercentage).map(([cur, pct]) => {
                  if (currencyFilter !== 'all' && cur.toUpperCase() !== currencyFilter.toUpperCase()) return null;
                  const isP = pct > 0;
                  const isL = pct < 0;
                  return (
                    <span
                      key={cur}
                      className="pnl-pct-badge"
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: 4,
                        background: isP ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.15)',
                        color: isP ? 'var(--ok)' : 'var(--danger)',
                        border: `1px solid ${isP ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)'}`,
                      }}
                    >
                      {isP ? '+' : isL ? '−' : ''}{Math.abs(pct).toFixed(2)}% ({cur})
                    </span>
                  );
                })}
                <span>Across {kpis.openPositionsCount} active trade{kpis.openPositionsCount === 1 ? '' : 's'}</span>
              </div>
            </div>

            {/* KPI 4: Locked Margin */}
            <div className="telemetry-kpi-card margin">
              <div className="kpi-card-header">
                <span className="kpi-card-title">Locked Margin Deployed</span>
                <span className="kpi-card-icon-box">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
              </div>
              <div>{renderKpiValue(kpis.lockedMarginMinor, false, currencyFilter)}</div>
              <div className="kpi-subtext">
                Active collateral backing group positions
              </div>
            </div>

            {/* KPI 5: Traded Volume */}
            <div className="telemetry-kpi-card volume">
              <div className="kpi-card-header">
                <span className="kpi-card-title">Group Traded Volume</span>
                <span className="kpi-card-icon-box">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                </span>
              </div>
              <div>{renderKpiValue(kpis.totalTradedVolumeMinor, false, currencyFilter)}</div>
              <div className="kpi-subtext">
                From {kpis.filledOrders} filled child order{kpis.filledOrders === 1 ? '' : 's'}
              </div>
            </div>

            {/* KPI 6: Performance & Fill Rate */}
            <div className="telemetry-kpi-card winrate">
              <div className="kpi-card-header">
                <span className="kpi-card-title">Performance & Fill Rate</span>
                <span className="kpi-card-icon-box">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="6" />
                    <circle cx="12" cy="12" r="2" />
                  </svg>
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 21, fontWeight: 800, color: 'var(--ok)' }}>
                  {kpis.winRatePct !== null ? `${kpis.winRatePct.toFixed(1)}%` : '—'}
                </span>
                <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                  win rate {kpis.closedTradesCount > 0 ? `(${kpis.winningClosedTrades}W / ${kpis.losingClosedTrades}L)` : ''}
                </span>
              </div>
              <div className="kpi-subtext">
                <div className="kpi-mini-bar-track">
                  <div
                    className="kpi-mini-bar-win"
                    style={{ width: `${Math.min(100, Math.max(0, kpis.fillRatePct))}%` }}
                  />
                </div>
                <span>
                  Fill: <strong style={{ color: 'var(--text)' }}>{kpis.fillRatePct.toFixed(1)}%</strong> ({kpis.filledOrders}/{kpis.totalOrders})
                </span>
              </div>
            </div>
          </div>

          {/* ── Section Navigation Tabs & Search ── */}
          <div className="telemetry-tabs-wrapper">
            <div className="telemetry-tabs-list">
              <button
                type="button"
                className={`telemetry-tab-item ${activeTab === 'exposure' ? 'active' : ''}`}
                onClick={() => setActiveTab('exposure')}
              >
                <span>Group Asset Exposure</span>
                <span className="telemetry-tab-count">{data.symbols.length}</span>
              </button>
              <button
                type="button"
                className={`telemetry-tab-item ${activeTab === 'closed' ? 'active' : ''}`}
                onClick={() => setActiveTab('closed')}
              >
                <span>Closed Trades & Performance</span>
                <span className="telemetry-tab-count">{data.closedTrades?.length ?? 0}</span>
              </button>
              <button
                type="button"
                className={`telemetry-tab-item ${activeTab === 'orders' ? 'active' : ''}`}
                onClick={() => setActiveTab('orders')}
              >
                <span>Group Orders Blotter</span>
                <span className="telemetry-tab-count">{groupOrdersQuery.data?.groups.length ?? 0}</span>
              </button>
              <button
                type="button"
                className={`telemetry-tab-item ${activeTab === 'members' ? 'active' : ''}`}
                onClick={() => setActiveTab('members')}
              >
                <span>Member Matrix</span>
                <span className="telemetry-tab-count">{data.accounts.length}</span>
              </button>
            </div>

            <div className="telemetry-tab-tools">
              <div className="telemetry-search-box">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
                <input
                  type="text"
                  placeholder="Filter table..."
                  value={tableSearch}
                  onChange={(e) => setTableSearch(e.target.value)}
                />
                {tableSearch.trim() !== '' && (
                  <button
                    type="button"
                    onClick={() => setTableSearch('')}
                    style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: '0 2px', fontSize: 12 }}
                  >
                    ✕
                  </button>
                )}
              </div>

              {activeTab !== 'orders' && (
                <button
                  type="button"
                  className="telemetry-csv-btn"
                  onClick={handleExportCsv}
                  title="Export current table to CSV file"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Export CSV
                </button>
              )}
            </div>
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
                    <th style={{ textAlign: 'right' }}>Live Price</th>
                    <th style={{ textAlign: 'right' }}>Locked Margin</th>
                    <th style={{ textAlign: 'right' }}>Unrealised PnL</th>
                    <th style={{ textAlign: 'right' }}>ROE %</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSymbols.length === 0 && (
                    <tr>
                      <td colSpan={10} style={{ textAlign: 'center', padding: '36px', color: 'var(--muted)' }}>
                        {tableSearch.trim() !== ''
                          ? `No open positions match "${tableSearch}".`
                          : 'No open positions for this group in this timeframe.'}
                      </td>
                    </tr>
                  )}
                  {filteredSymbols.map((s) => {
                    const pnlNum = Number(s.unrealisedPnlMinor);
                    const isP = pnlNum > 0;
                    const isL = pnlNum < 0;
                    const sLiveItem = pricesData?.prices?.[s.pair]
                      ?? (s.symbol ? pricesData?.prices?.[`B-${s.symbol.toUpperCase()}_USDT`] : undefined);
                    const sCurPrice = sLiveItem?.markPrice || sLiveItem?.lastPrice || s.markPrice;
                    const sChangePct = sLiveItem?.priceChangePercent;
                    const sHasChange = typeof sChangePct === 'number' && Number.isFinite(sChangePct);
                    const sIsPos = sHasChange && sChangePct >= 0;
                    const sIsNeg = sHasChange && sChangePct < 0;

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
                              borderColor: s.side === 'long' ? 'rgba(16,185,129,0.4)' : s.side === 'short' ? 'rgba(239,68,68,0.4)' : 'var(--text-dim)',
                              background: s.side === 'long' ? 'rgba(16,185,129,0.12)' : s.side === 'short' ? 'rgba(239,68,68,0.12)' : 'transparent',
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
                        <td className="mono" style={{ textAlign: 'right' }}>
                          <span style={{ fontWeight: 600, color: sIsPos ? 'var(--ok)' : sIsNeg ? 'var(--danger)' : 'var(--accent)' }}>
                            {sCurPrice ? fmtPrice(sCurPrice) : '—'}
                          </span>
                          {sHasChange && (
                            <span
                              style={{
                                display: 'block',
                                fontSize: 10.5,
                                fontWeight: 700,
                                color: sIsPos ? 'var(--ok)' : 'var(--danger)',
                              }}
                            >
                              {sIsPos ? '+' : ''}{sChangePct.toFixed(2)}%
                            </span>
                          )}
                        </td>
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
                  {filteredClosedTrades.length === 0 && (
                    <tr>
                      <td colSpan={10} style={{ textAlign: 'center', padding: '36px', color: 'var(--muted)' }}>
                        {tableSearch.trim() !== ''
                          ? `No closed trades match "${tableSearch}".`
                          : 'No closed trades recorded for this group in this timeframe.'}
                      </td>
                    </tr>
                  )}
                  {filteredClosedTrades.map((t) => {
                    const pnlNum = Number(t.realizedPnlMinor);
                    const isP = pnlNum > 0;
                    const isL = pnlNum < 0;

                    return (
                      <tr key={t.id}>
                        <td className="muted" style={{ fontSize: 11.5, whiteSpace: 'nowrap' }}>
                          {new Date(t.closedAtMs).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
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
                              borderColor: t.side === 'long' ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)',
                              background: t.side === 'long' ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)',
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
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '2px 8px',
                              borderRadius: 6,
                            }}
                          >
                            {isP ? '▲ WIN' : isL ? '▼ LOSS' : '• FLAT'}
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
                  {filteredMembers.length === 0 && (
                    <tr>
                      <td colSpan={10} style={{ textAlign: 'center', padding: '36px', color: 'var(--muted)' }}>
                        {tableSearch.trim() !== ''
                          ? `No members match "${tableSearch}".`
                          : 'No members in this group.'}
                      </td>
                    </tr>
                  )}
                  {filteredMembers.map((acc) => {
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
