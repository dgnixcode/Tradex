import { useMemo, useState } from 'react';
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
    <div style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
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

export function renderKpiValue(
  minorByCur: Record<string, string> | null | undefined,
  signed: boolean = false,
  currencyFilter: 'all' | 'INR' | 'USDT' = 'all',
  fontSize?: number,
): React.ReactNode {
  if (!minorByCur || Object.keys(minorByCur).length === 0) {
    const cur = currencyFilter === 'USDT' ? 'USDT' : 'INR';
    const text = signed ? (cur === 'INR' ? '+₹0.00' : '+0.00 USDT') : (cur === 'INR' ? '₹0.00' : '0.00 USDT');
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span className="kpi-single-val" style={{ fontSize: fontSize ?? 21, color: 'var(--muted)' }}>
          {text}
        </span>
        <span className={`kpi-currency-pill ${cur.toLowerCase()}`}>{cur}</span>
      </div>
    );
  }

  const allEntries = Object.entries(minorByCur).filter(([_, val]) => val !== '0' && val !== '');
  const activeEntries = currencyFilter === 'all'
    ? allEntries
    : allEntries.filter(([cur]) => cur.toUpperCase() === currencyFilter.toUpperCase());

  if (activeEntries.length === 0) {
    const cur = currencyFilter === 'USDT' ? 'USDT' : 'INR';
    const text = signed ? (cur === 'INR' ? '+₹0.00' : '+0.00 USDT') : (cur === 'INR' ? '₹0.00' : '0.00 USDT');
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span className="kpi-single-val" style={{ fontSize: fontSize ?? 21, color: 'var(--muted)' }}>
          {text}
        </span>
        <span className={`kpi-currency-pill ${cur.toLowerCase()}`}>{cur}</span>
      </div>
    );
  }

  if (activeEntries.length === 1) {
    const [cur, val] = activeEntries[0];
    const text = signed ? fmtSignedCurrency(val, cur) : fmtCurrency(val, cur);
    const num = Number(val);
    const isPos = num > 0;
    const isNeg = num < 0;
    const color = signed ? (isPos ? 'var(--ok)' : isNeg ? 'var(--danger)' : 'var(--text)') : 'var(--text)';
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span className="kpi-single-val" style={{ fontSize: fontSize ?? 21, color }}>
          {text}
        </span>
        <span className={`kpi-currency-pill ${cur.toLowerCase()}`}>{cur}</span>
      </div>
    );
  }

  // Dual Currency active (both INR and USDT)
  return (
    <div className="kpi-dual-currency">
      {activeEntries.map(([cur, val]) => {
        const text = signed ? fmtSignedCurrency(val, cur) : fmtCurrency(val, cur);
        const num = Number(val);
        const isPos = num > 0;
        const isNeg = num < 0;
        const color = signed ? (isPos ? 'var(--ok)' : isNeg ? 'var(--danger)' : 'var(--text)') : 'var(--text)';
        return (
          <div key={cur} className="kpi-currency-row">
            <span className={`kpi-currency-pill ${cur.toLowerCase()}`}>{cur}</span>
            <span className="kpi-row-val" style={{ color, fontSize: fontSize ? Math.max(12, fontSize - 4) : 15 }}>
              {text}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function downloadCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  const escapeCell = (c: unknown) => {
    if (c === null || c === undefined) return '""';
    const s = String(c).replace(/"/g, '""');
    return `"${s}"`;
  };
  const csvContent = 'data:text/csv;charset=utf-8,' +
    [headers.map(escapeCell).join(','), ...rows.map((r) => r.map(escapeCell).join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function Analytics() {
  const [timeframe, setTimeframe] = useState<'today' | '7d' | '30d' | 'all' | 'custom'>('all');
  const [currencyFilter, setCurrencyFilter] = useState<'all' | 'INR' | 'USDT'>('all');
  const [tableSearch, setTableSearch] = useState('');
  const [customFrom, setCustomFrom] = useState(() => {
    const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  });
  const [customTo, setCustomTo] = useState(() => {
    return new Date().toISOString().slice(0, 10);
  });
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [activeTab, setActiveTab] = useState<'symbols' | 'closed' | 'groups' | 'accounts' | 'orders'>('closed');
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

  // Filtered lists for table search
  const filteredClosedTrades = useMemo(() => {
    const list = data?.closedTrades ?? [];
    const q = tableSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((t) =>
      t.pair.toLowerCase().includes(q) ||
      t.market.toLowerCase().includes(q) ||
      t.accountName.toLowerCase().includes(q) ||
      (t.groupName ?? '').toLowerCase().includes(q) ||
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

  const filteredGroups = useMemo(() => {
    const list = data?.groups ?? [];
    const q = tableSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((g) => g.groupName.toLowerCase().includes(q));
  }, [data?.groups, tableSearch]);

  const filteredAccounts = useMemo(() => {
    const list = data?.accounts ?? [];
    const q = tableSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((a) =>
      a.accountName.toLowerCase().includes(q) ||
      (a.groupName ?? '').toLowerCase().includes(q)
    );
  }, [data?.accounts, tableSearch]);

  const handleExportCsv = () => {
    const dateStr = new Date().toISOString().slice(0, 10);
    if (activeTab === 'closed') {
      const headers = ['Closed Time', 'Account', 'Group', 'Pair', 'Side', 'Quantity', 'Entry Price', 'Exit Price', 'Realized PnL', 'Currency', 'ROE %', 'Outcome'];
      const rows = filteredClosedTrades.map((t) => [
        new Date(t.closedAtMs).toLocaleString('en-IN'),
        t.accountName,
        t.groupName ?? '—',
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
      downloadCsv(`tradex_closed_trades_${dateStr}.csv`, headers, rows);
    } else if (activeTab === 'symbols') {
      const headers = ['Asset', 'Pair', 'Margin Mode', 'Side', 'Positions Count', 'Total Size', 'Avg Entry Price', 'Mark Price', 'Locked Margin', 'Unrealised PnL', 'ROE %'];
      const rows = filteredSymbols.map((s) => [
        s.symbol,
        s.pair,
        s.marginCurrency,
        s.side.toUpperCase(),
        s.positionsCount,
        s.totalQuantity,
        s.avgEntryPrice,
        s.markPrice,
        s.lockedMarginMinor,
        s.unrealisedPnlMinor,
        s.roePct !== null ? `${s.roePct.toFixed(2)}%` : '—',
      ]);
      downloadCsv(`tradex_active_positions_${dateStr}.csv`, headers, rows);
    } else if (activeTab === 'groups') {
      const headers = ['Strategy Group', 'Members', 'Active Trades', 'ROE %', 'Profitable Members', 'Unprofitable Members'];
      const rows = filteredGroups.map((g) => [
        g.groupName,
        g.memberCount,
        g.activePositionsCount,
        g.roePct !== null ? `${g.roePct.toFixed(2)}%` : '—',
        g.profitableMembersCount,
        g.unprofitableMembersCount,
      ]);
      downloadCsv(`tradex_groups_telemetry_${dateStr}.csv`, headers, rows);
    } else if (activeTab === 'accounts') {
      const headers = ['Account', 'Strategy Group', 'Status', 'Open Trades', 'Return %', 'Total Orders', 'Fill Rate %'];
      const rows = filteredAccounts.map((a) => [
        a.accountName,
        a.groupName ?? '—',
        a.status,
        a.openPositionsCount,
        a.roePct !== null ? `${a.roePct.toFixed(2)}%` : '—',
        a.totalOrders,
        `${a.fillRatePct.toFixed(1)}%`,
      ]);
      downloadCsv(`tradex_accounts_leaderboard_${dateStr}.csv`, headers, rows);
    }
  };

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
                background: 'rgba(16,185,129,0.12)',
                color: 'var(--ok)',
                border: '1px solid rgba(16,185,129,0.3)',
                fontSize: 11,
                fontWeight: 600,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '3px 9px',
                borderRadius: 20,
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block', boxShadow: '0 0 8px var(--ok)' }} />
              Live Telemetry (5s)
            </span>
          </div>
          <p className="muted" style={{ margin: '4px 0 0', fontSize: 13 }}>
            Comprehensive desk performance, realized PnL, margin exposure, and order execution analytics.
          </p>
        </div>

        {/* Filters: Currency, Timeframe & Strategy Group */}
        <div className="telemetry-toolbar">
          {/* Currency Mode Filter */}
          <div className="telemetry-pills" title="Filter display currency">
            {(['all', 'INR', 'USDT'] as const).map((cf) => (
              <button
                key={cf}
                type="button"
                className={`telemetry-pill ${currencyFilter === cf ? 'active' : ''}`}
                onClick={() => setCurrencyFilter(cf)}
              >
                {cf === 'all' ? 'All Currencies' : cf}
              </button>
            ))}
          </div>

          {/* Timeframe Selector */}
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
          {/* ── Redesigned KPI Summary Grid (Equal Height & Structured Micro-Typography) ── */}
          <div className="telemetry-kpi-grid">
            {/* KPI 1: Net Desk PnL (Realized + Unrealized) */}
            <div className={`telemetry-kpi-card ${isNetProf ? 'profit' : isNetLoss ? 'loss' : 'neutral'}`}>
              <div className="kpi-card-header">
                <span className="kpi-card-title">Net Desk PnL</span>
                <div className="kpi-card-icon-box" style={{ color: isNetProf ? 'var(--ok)' : isNetLoss ? 'var(--danger)' : '#94a3b8' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    {isNetProf ? (
                      <>
                        <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
                        <polyline points="17 6 23 6 23 12" />
                      </>
                    ) : (
                      <>
                        <polyline points="23 18 13.5 8.5 8.5 13.5 1 6" />
                        <polyline points="17 18 23 18 23 12" />
                      </>
                    )}
                  </svg>
                </div>
              </div>
              <div className="kpi-card-body">
                {renderKpiValue(kpis.netPnlMinor, true, currencyFilter)}
              </div>
              <div className="kpi-card-footer">
                <span className="muted">Realized:</span>
                <span style={{ fontWeight: 600, color: isRealProf ? 'var(--ok)' : isRealLoss ? 'var(--danger)' : 'var(--text)' }}>
                  {renderKpiValue(kpis.realizedPnlMinor, true, currencyFilter, 11.5)}
                </span>
              </div>
            </div>

            {/* KPI 2: Realized Closed PnL */}
            <div className={`telemetry-kpi-card ${isRealProf ? 'profit' : isRealLoss ? 'loss' : 'realized'}`}>
              <div className="kpi-card-header">
                <span className="kpi-card-title">Realized Closed PnL</span>
                <div className="kpi-card-icon-box" style={{ color: isRealProf ? 'var(--ok)' : isRealLoss ? 'var(--danger)' : '#a78bfa' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                    <polyline points="22 4 12 14.01 9 11.01" />
                  </svg>
                </div>
              </div>
              <div className="kpi-card-body">
                {renderKpiValue(kpis.realizedPnlMinor, true, currencyFilter)}
              </div>
              <div className="kpi-card-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                  <span>{kpis.closedTradesCount} closed trade{kpis.closedTradesCount === 1 ? '' : 's'}</span>
                  <span style={{ fontWeight: 700 }}>
                    <span style={{ color: 'var(--ok)' }}>{kpis.winningClosedTrades}W</span> / <span style={{ color: 'var(--danger)' }}>{kpis.losingClosedTrades}L</span>
                  </span>
                </div>
                {kpis.closedTradesCount > 0 && (
                  <div className="kpi-mini-bar-track" title={`${kpis.winningClosedTrades} Wins / ${kpis.losingClosedTrades} Losses`}>
                    <div
                      className="kpi-mini-bar-win"
                      style={{ width: `${(kpis.winningClosedTrades / kpis.closedTradesCount) * 100}%` }}
                    />
                    <div
                      className="kpi-mini-bar-loss"
                      style={{ width: `${(kpis.losingClosedTrades / kpis.closedTradesCount) * 100}%` }}
                    />
                  </div>
                )}
              </div>
            </div>

            {/* KPI 3: Unrealised PnL (Open Positions) */}
            <div className={`telemetry-kpi-card ${isUnrealProf ? 'profit' : isUnrealLoss ? 'loss' : 'neutral'}`}>
              <div className="kpi-card-header">
                <span className="kpi-card-title">Unrealised PnL (Live)</span>
                <div className="kpi-card-icon-box" style={{ color: isUnrealProf ? 'var(--ok)' : isUnrealLoss ? 'var(--danger)' : '#38bdf8' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
                  </svg>
                </div>
              </div>
              <div className="kpi-card-body">
                {renderKpiValue(kpis.unrealisedPnlMinor, true, currencyFilter)}
                {kpis.pnlPercentage && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
                    {Object.entries(kpis.pnlPercentage)
                      .filter(([cur]) => currencyFilter === 'all' || cur.toUpperCase() === currencyFilter.toUpperCase())
                      .map(([cur, pct]) => {
                        const isP = pct > 0;
                        const isL = pct < 0;
                        return (
                          <span
                            key={cur}
                            className="pnl-pct-badge"
                            style={{
                              fontSize: 10.5,
                              fontWeight: 700,
                              padding: '1px 6px',
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
                  </div>
                )}
              </div>
              <div className="kpi-card-footer">
                <span>{kpis.openPositionsCount} active trade{kpis.openPositionsCount === 1 ? '' : 's'}</span>
                <span className="muted" style={{ fontSize: 11 }}>Live Mark</span>
              </div>
            </div>

            {/* KPI 4: Margin Deployed */}
            <div className="telemetry-kpi-card margin">
              <div className="kpi-card-header">
                <span className="kpi-card-title">Locked Margin</span>
                <div className="kpi-card-icon-box" style={{ color: '#60a5fa' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
              </div>
              <div className="kpi-card-body">
                {renderKpiValue(kpis.lockedMarginMinor, false, currencyFilter)}
              </div>
              <div className="kpi-card-footer">
                <span>Active Collateral</span>
                <span className="badge" style={{ fontSize: 10, padding: '1px 5px', background: 'rgba(59,130,246,0.15)', color: '#60a5fa' }}>
                  Hedged
                </span>
              </div>
            </div>

            {/* KPI 5: Volume */}
            <div className="telemetry-kpi-card volume">
              <div className="kpi-card-header">
                <span className="kpi-card-title">Traded Volume</span>
                <div className="kpi-card-icon-box" style={{ color: '#fbbf24' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                </div>
              </div>
              <div className="kpi-card-body">
                {renderKpiValue(kpis.totalTradedVolumeMinor, false, currencyFilter)}
              </div>
              <div className="kpi-card-footer">
                <span>From {kpis.filledOrders} filled order{kpis.filledOrders === 1 ? '' : 's'}</span>
                <span className="muted" style={{ fontSize: 11 }}>Cumulative</span>
              </div>
            </div>

            {/* KPI 6: Win Rate & Fill Rate */}
            <div className="telemetry-kpi-card winrate">
              <div className="kpi-card-header">
                <span className="kpi-card-title">Performance</span>
                <div className="kpi-card-icon-box" style={{ color: '#34d399' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <circle cx="12" cy="12" r="6" />
                    <circle cx="12" cy="12" r="2" />
                  </svg>
                </div>
              </div>
              <div className="kpi-card-body">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span className="kpi-single-val" style={{ color: kpis.winRatePct && kpis.winRatePct >= 50 ? 'var(--ok)' : kpis.winRatePct !== null ? '#f59e0b' : 'var(--muted)' }}>
                    {kpis.winRatePct !== null ? `${kpis.winRatePct.toFixed(1)}%` : '—'}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>win rate</span>
                </div>
              </div>
              <div className="kpi-card-footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
                  <span className="muted">Fill Rate:</span>
                  <strong style={{ color: 'var(--text)' }}>{kpis.fillRatePct.toFixed(1)}% ({kpis.filledOrders}/{kpis.totalOrders})</strong>
                </div>
                {kpis.totalOrders > 0 && (
                  <div className="kpi-mini-bar-track" title={`Fill Rate: ${kpis.fillRatePct.toFixed(1)}%`}>
                    <div className="kpi-mini-bar-win" style={{ width: `${Math.min(100, Math.max(0, kpis.fillRatePct))}%` }} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Section Navigation Tabs & Table Controls ── */}
          <div className="telemetry-tabs-wrapper">
            <div className="telemetry-tabs-list">
              <button
                type="button"
                className={`telemetry-tab-item ${activeTab === 'closed' ? 'active' : ''}`}
                onClick={() => setActiveTab('closed')}
              >
                <span>Closed Trades & PnL</span>
                <span className="telemetry-tab-count">{data.closedTrades?.length ?? 0}</span>
              </button>
              <button
                type="button"
                className={`telemetry-tab-item ${activeTab === 'symbols' ? 'active' : ''}`}
                onClick={() => setActiveTab('symbols')}
              >
                <span>Active Positions</span>
                <span className="telemetry-tab-count">{data.symbols.length}</span>
              </button>
              <button
                type="button"
                className={`telemetry-tab-item ${activeTab === 'groups' ? 'active' : ''}`}
                onClick={() => setActiveTab('groups')}
              >
                <span>Strategy Groups</span>
                <span className="telemetry-tab-count">{data.groups.length}</span>
              </button>
              <button
                type="button"
                className={`telemetry-tab-item ${activeTab === 'accounts' ? 'active' : ''}`}
                onClick={() => setActiveTab('accounts')}
              >
                <span>Account Leaderboard</span>
                <span className="telemetry-tab-count">{data.accounts.length}</span>
              </button>
              <button
                type="button"
                className={`telemetry-tab-item ${activeTab === 'orders' ? 'active' : ''}`}
                onClick={() => setActiveTab('orders')}
              >
                <span>Group Orders Blotter</span>
                <span className="telemetry-tab-count">{groupOrdersQuery.data?.groups.length ?? 0}</span>
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
                  {filteredSymbols.length === 0 && (
                    <tr>
                      <td colSpan={10} style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>
                        {tableSearch.trim() !== ''
                          ? `No open positions match "${tableSearch}".`
                          : 'No open positions for the selected filter.'}
                      </td>
                    </tr>
                  )}
                  {filteredSymbols.map((s) => {
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
                              borderColor: s.side === 'long' ? 'rgba(16,185,129,0.4)' : s.side === 'short' ? 'rgba(239,68,68,0.4)' : 'var(--text-dim)',
                              background: s.side === 'long' ? 'rgba(16,185,129,0.12)' : s.side === 'short' ? 'rgba(239,68,68,0.12)' : 'transparent',
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
                  {filteredClosedTrades.length === 0 && (
                    <tr>
                      <td colSpan={11} style={{ textAlign: 'center', padding: '36px', color: 'var(--muted)' }}>
                        {tableSearch.trim() !== ''
                          ? `No closed trades match "${tableSearch}".`
                          : 'No closed trades recorded in this timeframe.'}
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
                  {filteredGroups.length === 0 && (
                    <tr>
                      <td colSpan={10} style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>
                        {tableSearch.trim() !== ''
                          ? `No strategy groups match "${tableSearch}".`
                          : 'No strategy groups found.'}
                      </td>
                    </tr>
                  )}
                  {filteredGroups.map((g) => {
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
                  {filteredAccounts.length === 0 && (
                    <tr>
                      <td colSpan={11} style={{ textAlign: 'center', padding: '30px', color: 'var(--muted)' }}>
                        {tableSearch.trim() !== ''
                          ? `No accounts match "${tableSearch}".`
                          : 'No accounts found.'}
                      </td>
                    </tr>
                  )}
                  {filteredAccounts.map((a) => {
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
