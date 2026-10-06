import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adjustFuturesPosition,
  exitFuturesPosition,
  fetchFuturesPositions,
  fetchKillSwitchStatus,
  refreshFuturesPositions,
  setFuturesProtection,
  setTrailingProtection,
} from '../api.ts';
import type { FuturesPositionRow } from '../api.ts';
import { useLivePrices } from '../useLivePrices.ts';
import {
  AccountMobileCard,
  GroupCard,
  GroupPositionManageModal,
  PositionManageModal,
  QuickExitModal,
  addMinors,
  buildGroups,
  calcRoePct,
  fmtMinor,
  pnlText,
  roeText,
} from '../routes/Futures.tsx';
import type { PositionGroup, QuickExitTarget } from '../routes/Futures.tsx';
import { parseCoinFromPair } from '../routes/TradeTicket.tsx';

export interface CoinPositionsDrawerProps {
  readonly coin: string;
  readonly onSelectCoin?: ((coin: string) => void) | undefined;
  readonly onSwitchToOrder?: (() => void) | undefined;
  readonly onClose?: (() => void) | undefined;
}

export function CoinPositionsDrawer({
  coin,
  onSelectCoin,
  onSwitchToOrder,
}: CoinPositionsDrawerProps) {
  const qc = useQueryClient();
  const { isStreaming } = useLivePrices();

  // Scope: 'coin' = show positions for the currently displayed chart coin; 'all' = show all positions
  const [scope, setScope] = useState<'coin' | 'all'>('coin');
  const [pnlFilter, setPnlFilter] = useState<'all' | 'profit' | 'loss'>('all');
  const [viewMode, setViewMode] = useState<'cards' | 'tables'>('cards');
  const [searchQuery, setSearchQuery] = useState('');
  const [showHiddenAccounts, setShowHiddenAccounts] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Management modals
  const [managingPosition, setManagingPosition] = useState<FuturesPositionRow | null>(null);
  const [managingGroup, setManagingGroup] = useState<PositionGroup | null>(null);
  const [quickExitTarget, setQuickExitTarget] = useState<QuickExitTarget | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // Kill Switch
  const killSwitchQuery = useQuery({
    queryKey: ['kill-switch'],
    queryFn: fetchKillSwitchStatus,
    refetchInterval: 3000,
  });
  const isHalted = Boolean(killSwitchQuery.data?.active);

  // Live Positions query
  const positionsQuery = useQuery({
    queryKey: ['futures-positions'],
    queryFn: fetchFuturesPositions,
    refetchInterval: isStreaming ? 10_000 : 2_000,
  });

  const allRows = positionsQuery.data?.views ?? [];

  const handleRefreshAll = useCallback(async () => {
    void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    try {
      await refreshFuturesPositions();
    } catch {
      // background sync is best-effort
    }
    void qc.invalidateQueries({ queryKey: ['futures-positions'] });
  }, [qc]);

  const refreshMut = useMutation({
    mutationFn: () => refreshFuturesPositions(),
    onSuccess: (out) => {
      setMessage({
        kind: 'ok',
        text: `Re-read ${out.accounts} accounts from exchange — ${out.positions} open positions.`,
      });
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  const adjustMut = useMutation({
    mutationFn: ({ id, direction, percentBp, quantity }: { id: string; direction: 'reduce' | 'increase'; percentBp?: number | undefined; quantity?: string | undefined }) =>
      adjustFuturesPosition(id, direction, percentBp, undefined, quantity),
    onSuccess: (out, { direction, percentBp, quantity }) => {
      setMessage({
        kind: 'ok',
        text: `${direction === 'reduce' ? 'Closed' : 'Added'} ${quantity ? `${quantity} qty` : `${(percentBp ?? 0) / 100}%`} — ${out.quantity} ${direction === 'reduce' ? 'sold' : 'bought'}.`,
      });
      setManagingPosition(null);
      void handleRefreshAll();
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  const exitMut = useMutation({
    mutationFn: ({ id, marginCurrency }: { id: string; marginCurrency: 'INR' | 'USDT' }) =>
      exitFuturesPosition(id, marginCurrency),
    onSuccess: (out) => {
      setMessage({
        kind: 'ok',
        text: `Position closed at market (cancelled ${out.cancelled.length} conditional orders).`,
      });
      setManagingPosition(null);
      void handleRefreshAll();
    },
    onError: (e) => {
      const msg = (e as Error).message || '';
      if (/no\s+active\s+position/i.test(msg) || /already\s+(closed|flat|exited)/i.test(msg)) {
        setMessage({ kind: 'ok', text: 'Position is already closed.' });
        setManagingPosition(null);
        void handleRefreshAll();
      } else {
        setMessage({ kind: 'err', text: msg });
      }
    },
  });

  const protMut = useMutation({
    mutationFn: async (args: {
      readonly id: string;
      readonly slp?: string | undefined;
      readonly tpp?: string | undefined;
      readonly trailing?: boolean | undefined;
      readonly removeSl?: boolean | undefined;
      readonly removeTp?: boolean | undefined;
    }) => {
      const body: {
        stopLossPrice?: string;
        takeProfitPrice?: string;
        moveExisting: boolean;
        removeStopLoss?: boolean;
        removeTakeProfit?: boolean;
      } = { moveExisting: true };
      if (args.slp !== undefined && args.slp !== '') body.stopLossPrice = args.slp;
      if (args.tpp !== undefined && args.tpp !== '') body.takeProfitPrice = args.tpp;
      if (args.removeSl) body.removeStopLoss = true;
      if (args.removeTp) body.removeTakeProfit = true;

      const out = await setFuturesProtection(args.id, body);

      if (args.trailing && args.slp && !args.removeSl) {
        await setTrailingProtection(args.id, {
          enable: true,
          currentSlPrice: args.slp,
          stepBp: '100',
          distanceBp: '100',
        });
      } else if (!args.trailing || args.removeSl) {
        await setTrailingProtection(args.id, { enable: false });
      }
      return out;
    },
    onSuccess: (out) => {
      const failures: string[] = [];
      if (out.stopLoss?.ok === false) failures.push(`SL: ${out.stopLoss.reason ?? 'refused'}`);
      if (out.takeProfit?.ok === false) failures.push(`TP: ${out.takeProfit.reason ?? 'refused'}`);
      setMessage(failures.length > 0
        ? { kind: 'err', text: `Some legs failed — ${failures.join('; ')}` }
        : { kind: 'ok', text: 'Protection updated.' });
      setManagingPosition(null);
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  // Filter out hidden accounts if toggle is off
  const hiddenRowsCount = useMemo(() => allRows.filter((r) => r.hideFromPositions).length, [allRows]);

  const activeRows = useMemo(() => {
    if (showHiddenAccounts) return allRows;
    return allRows.filter((r) => !r.hideFromPositions);
  }, [allRows, showHiddenAccounts]);

  const normCoin = (coin || 'BTC').trim().toUpperCase();

  // Positions specifically for this coin
  const coinPositions = useMemo(() => {
    return activeRows.filter((r) => {
      const posCoin = (parseCoinFromPair(r.pair) || '').trim().toUpperCase();
      return posCoin === normCoin;
    });
  }, [activeRows, normCoin]);

  // Positions on other coins
  const otherPositions = useMemo(() => {
    return activeRows.filter((r) => {
      const posCoin = (parseCoinFromPair(r.pair) || '').trim().toUpperCase();
      return posCoin !== normCoin;
    });
  }, [activeRows, normCoin]);

  const targetRows = scope === 'coin' ? coinPositions : activeRows;

  // Build groups for the selected scope
  const groups = useMemo(() => buildGroups(targetRows), [targetRows]);

  // Search filter across groups / accounts
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => {
      if (g.asset.toLowerCase().includes(q)) return true;
      if (g.pair.toLowerCase().includes(q)) return true;
      if (g.marginCurrency.toLowerCase().includes(q)) return true;
      if (g.groupNames.some((name) => name.toLowerCase().includes(q))) return true;
      if (g.positions.some((p) => p.accountName.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [groups, searchQuery]);

  // PnL Filter (All / Profit / Loss)
  const displayedGroups = useMemo(() => {
    if (pnlFilter === 'profit') {
      return filteredGroups.filter((g) => Number(g.totalPnlMinor ?? 0) > 0);
    }
    if (pnlFilter === 'loss') {
      return filteredGroups.filter((g) => Number(g.totalPnlMinor ?? 0) < 0);
    }
    return filteredGroups;
  }, [filteredGroups, pnlFilter]);

  // Live polling updates for open modals
  const liveManagingPosition = useMemo(() => {
    if (managingPosition === null) return null;
    return activeRows.find((r) => r.venuePositionId === managingPosition.venuePositionId) ?? managingPosition;
  }, [activeRows, managingPosition]);

  const liveManagingGroup = useMemo(() => {
    if (managingGroup === null) return null;
    return groups.find((g) => g.key === managingGroup.key) ?? managingGroup;
  }, [groups, managingGroup]);

  const liveQuickExitTarget = useMemo<QuickExitTarget | null>(() => {
    if (quickExitTarget === null) return null;
    if (quickExitTarget.type === 'account') {
      const p = activeRows.find((r) => r.venuePositionId === quickExitTarget.position.venuePositionId) ?? quickExitTarget.position;
      return { type: 'account', position: p };
    }
    const g = groups.find((grp) => grp.key === quickExitTarget.group.key) ?? quickExitTarget.group;
    return { type: 'group', group: g };
  }, [activeRows, groups, quickExitTarget]);

  // Aggregated KPIs for displayed positions
  const kpis = useMemo(() => {
    const byCurrency: Record<string, string> = {};
    const marginByCurrency: Record<string, string> = {};
    let totalQty = 0;
    let totalWeight = 0;
    let weightedRoeSum = 0;

    for (const p of targetRows) {
      if (p.unrealisedPnlMinor !== null) {
        const cur = p.marginCurrency;
        byCurrency[cur] = byCurrency[cur] === undefined
          ? p.unrealisedPnlMinor
          : addMinors(byCurrency[cur]!, p.unrealisedPnlMinor);
      }
      if (p.lockedMarginMinor !== null && p.lockedMarginMinor !== '' && p.lockedMarginMinor !== '0') {
        const cur = p.marginCurrency;
        marginByCurrency[cur] = marginByCurrency[cur] === undefined
          ? p.lockedMarginMinor
          : addMinors(marginByCurrency[cur]!, p.lockedMarginMinor);
      }
      const q = Number(p.quantity) || 0;
      totalQty += q;
      const roe = calcRoePct(p);
      if (roe !== null && q > 0) {
        weightedRoeSum += roe * q;
        totalWeight += q;
      }
    }

    const netRoe = totalWeight > 0 ? weightedRoeSum / totalWeight : null;
    return {
      pnlByCurrency: byCurrency,
      marginByCurrency,
      totalQty,
      netRoe,
      accountCount: targetRows.length,
    };
  }, [targetRows]);

  const toggleGroupCollapse = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const pnlCurrencies = Object.keys(kpis.pnlByCurrency);
  const primaryCur = pnlCurrencies.includes('USDT') ? 'USDT' : pnlCurrencies[0] || 'USDT';
  const primaryPnlMinor = kpis.pnlByCurrency[primaryCur] ?? '0';
  const isProfit = Number(primaryPnlMinor) > 0;
  const isLoss = Number(primaryPnlMinor) < 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* ── Sub-header: Scope Switcher + Sync ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          background: '#0d1017',
          borderBottom: '1px solid #1c2027',
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        {/* Scope Tabs: This Coin vs All Coins */}
        <div style={{ display: 'inline-flex', alignItems: 'center', background: '#161b22', padding: 2, borderRadius: 6, border: '1px solid #21262d' }}>
          <button
            type="button"
            onClick={() => setScope('coin')}
            style={{
              padding: '4px 10px',
              fontSize: 11.5,
              fontWeight: 700,
              borderRadius: 4,
              border: 'none',
              background: scope === 'coin' ? '#238636' : 'transparent',
              color: scope === 'coin' ? '#ffffff' : '#8b949e',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 0.15s ease',
            }}
          >
            <span>{normCoin}</span>
            <span
              style={{
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 10,
                background: scope === 'coin' ? 'rgba(255,255,255,0.2)' : '#21262d',
                color: scope === 'coin' ? '#ffffff' : '#8b949e',
                fontWeight: 700,
              }}
            >
              {coinPositions.length}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setScope('all')}
            style={{
              padding: '4px 10px',
              fontSize: 11.5,
              fontWeight: 700,
              borderRadius: 4,
              border: 'none',
              background: scope === 'all' ? '#1f6feb' : 'transparent',
              color: scope === 'all' ? '#ffffff' : '#8b949e',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              transition: 'all 0.15s ease',
            }}
          >
            <span>All Coins</span>
            <span
              style={{
                fontSize: 10,
                padding: '1px 5px',
                borderRadius: 10,
                background: scope === 'all' ? 'rgba(255,255,255,0.2)' : '#21262d',
                color: scope === 'all' ? '#ffffff' : '#8b949e',
                fontWeight: 700,
              }}
            >
              {activeRows.length}
            </span>
          </button>
        </div>

        {/* View Mode & Sync Tools */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Card vs Table View mode toggle */}
          <div style={{ display: 'inline-flex', background: '#161b22', padding: 2, borderRadius: 5, border: '1px solid #21262d' }}>
            <button
              type="button"
              onClick={() => setViewMode('cards')}
              style={{
                padding: '2px 7px',
                fontSize: 10.5,
                fontWeight: 600,
                background: viewMode === 'cards' ? '#30363d' : 'transparent',
                color: viewMode === 'cards' ? '#f0f6fc' : '#8b949e',
                border: 'none',
                borderRadius: 3,
                cursor: 'pointer',
              }}
              title="Card View (best for side drawer)"
            >
              Cards
            </button>
            <button
              type="button"
              onClick={() => setViewMode('tables')}
              style={{
                padding: '2px 7px',
                fontSize: 10.5,
                fontWeight: 600,
                background: viewMode === 'tables' ? '#30363d' : 'transparent',
                color: viewMode === 'tables' ? '#f0f6fc' : '#8b949e',
                border: 'none',
                borderRadius: 3,
                cursor: 'pointer',
              }}
              title="Table View"
            >
              Table
            </button>
          </div>

          {/* Sync Button */}
          <button
            type="button"
            className="btn btn-sm secondary"
            disabled={refreshMut.isPending}
            onClick={() => refreshMut.mutate()}
            style={{
              padding: '3px 8px',
              fontSize: 11,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
            title="Sync positions with exchange"
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ animation: refreshMut.isPending ? 'spin 1s linear infinite' : 'none' }}
            >
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
            {refreshMut.isPending ? 'Syncing…' : 'Sync'}
          </button>
        </div>
      </div>

      {/* ── Kill Switch Banner if active ── */}
      {isHalted && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.15)',
            borderBottom: '1px solid var(--danger)',
            padding: '8px 12px',
            fontSize: 11.5,
            color: '#fca5a5',
            fontWeight: 600,
          }}
        >
          KILL SWITCH ACTIVE — Position exits & adjustments locked (Read-Only Mode).
        </div>
      )}

      {/* ── Status Message Toast ── */}
      {message && (
        <div
          style={{
            padding: '7px 12px',
            fontSize: 11.5,
            fontWeight: 600,
            background: message.kind === 'ok' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            color: message.kind === 'ok' ? '#34d399' : '#f87171',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{message.text}</span>
          <button
            type="button"
            onClick={() => setMessage(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '0 4px' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Summary KPI Strip ── */}
      {targetRows.length > 0 && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 8,
            padding: '10px 12px',
            background: '#090b0e',
            borderBottom: '1px solid #1c2027',
          }}
        >
          {/* KPI 1: Net Unrealized PnL */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10, textTransform: 'uppercase', color: '#8b949e', fontWeight: 600, letterSpacing: '0.04em' }}>
              Unrealized PnL
            </span>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
              <span
                style={{
                  fontSize: 13.5,
                  fontWeight: 800,
                  color: isProfit ? '#10b981' : isLoss ? '#ef4444' : '#c9d1d9',
                }}
              >
                {pnlText(primaryPnlMinor, primaryCur as 'INR' | 'USDT')}
              </span>
              {kpis.netRoe !== null && (
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: kpis.netRoe >= 0 ? '#10b981' : '#ef4444',
                  }}
                >
                  {roeText(kpis.netRoe).trim()}
                </span>
              )}
            </div>
          </div>

          {/* KPI 2: Total Margin */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10, textTransform: 'uppercase', color: '#8b949e', fontWeight: 600, letterSpacing: '0.04em' }}>
              Total Margin
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#f0f6fc', fontFamily: 'monospace' }}>
              {kpis.marginByCurrency[primaryCur]
                ? fmtMinor(kpis.marginByCurrency[primaryCur]!, primaryCur as 'INR' | 'USDT')
                : '—'}
            </span>
          </div>

          {/* KPI 3: Accounts / Qty */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ fontSize: 10, textTransform: 'uppercase', color: '#8b949e', fontWeight: 600, letterSpacing: '0.04em' }}>
              Accounts / Qty
            </span>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#f0f6fc' }}>
              {kpis.accountCount} <span style={{ fontSize: 11, color: '#8b949e', fontWeight: 400 }}>acc ({kpis.totalQty.toFixed(3).replace(/\.?0+$/, '')})</span>
            </span>
          </div>
        </div>
      )}

      {/* ── Search & Filter Controls ── */}
      {targetRows.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            background: '#0d1017',
            borderBottom: '1px solid #1c2027',
            gap: 8,
          }}
        >
          {/* PnL Filter Pills */}
          <div style={{ display: 'inline-flex', gap: 4 }}>
            <button
              type="button"
              onClick={() => setPnlFilter('all')}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 4,
                border: 'none',
                background: pnlFilter === 'all' ? 'rgba(255,255,255,0.1)' : 'transparent',
                color: pnlFilter === 'all' ? '#ffffff' : '#8b949e',
                cursor: 'pointer',
              }}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setPnlFilter('profit')}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 4,
                border: 'none',
                background: pnlFilter === 'profit' ? 'rgba(16, 185, 129, 0.2)' : 'transparent',
                color: pnlFilter === 'profit' ? '#10b981' : '#8b949e',
                cursor: 'pointer',
              }}
            >
              Profit
            </button>
            <button
              type="button"
              onClick={() => setPnlFilter('loss')}
              style={{
                padding: '2px 8px',
                fontSize: 11,
                fontWeight: 600,
                borderRadius: 4,
                border: 'none',
                background: pnlFilter === 'loss' ? 'rgba(239, 68, 68, 0.2)' : 'transparent',
                color: pnlFilter === 'loss' ? '#ef4444' : '#8b949e',
                cursor: 'pointer',
              }}
            >
              Loss
            </button>
          </div>

          {/* Quick search input & hidden toggle */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {hiddenRowsCount > 0 && (
              <button
                type="button"
                onClick={() => setShowHiddenAccounts((prev) => !prev)}
                style={{
                  padding: '2px 6px',
                  fontSize: 10.5,
                  fontWeight: 600,
                  borderRadius: 4,
                  border: 'none',
                  background: showHiddenAccounts ? 'rgba(239, 68, 68, 0.2)' : '#21262d',
                  color: showHiddenAccounts ? '#fca5a5' : '#8b949e',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
                title={showHiddenAccounts ? 'Hide positions from hidden accounts' : 'Show positions from hidden accounts'}
              >
                {showHiddenAccounts ? `Hide ${hiddenRowsCount}` : `Show ${hiddenRowsCount} Hidden`}
              </button>
            )}

            <input
              type="text"
              placeholder="Search account or group…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                background: '#161b22',
                border: '1px solid #21262d',
                borderRadius: 4,
                color: '#f0f6fc',
                fontSize: 11.5,
                padding: '3px 8px',
                outline: 'none',
                width: 140,
              }}
            />
          </div>
        </div>
      )}

      {/* ── Main Body: Position Groups or Empty State ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {targetRows.length === 0 ? (
          /* Empty State */
          <div
            style={{
              padding: '32px 16px',
              textAlign: 'center',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
            }}
          >
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: 'rgba(255, 255, 255, 0.04)',
                border: '1px solid #21262d',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#8b949e',
              }}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
                <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
              </svg>
            </div>

            <div>
              <h4 style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: '#f0f6fc' }}>
                {scope === 'coin' ? `No Open Positions on ${normCoin}` : 'No Open Positions'}
              </h4>
              <p style={{ margin: 0, fontSize: 12, color: '#8b949e', maxWidth: 280, lineHeight: 1.5 }}>
                {scope === 'coin'
                  ? `You currently have 0 active futures positions on ${normCoin}.`
                  : 'You have no open futures positions across any connected accounts.'}
              </p>
            </div>

            {/* Quick Switch CTA */}
            {scope === 'coin' && otherPositions.length > 0 && (
              <div
                style={{
                  background: '#161b22',
                  border: '1px solid #21262d',
                  borderRadius: 6,
                  padding: '8px 12px',
                  width: '100%',
                  maxWidth: 320,
                  fontSize: 11.5,
                  color: '#c9d1d9',
                  textAlign: 'left',
                }}
              >
                <div style={{ marginBottom: 6, color: '#8b949e' }}>
                  You have <strong style={{ color: '#58a6ff' }}>{otherPositions.length}</strong> active position{otherPositions.length > 1 ? 's' : ''} on other coins:
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8 }}>
                  {Array.from(new Set(otherPositions.map((p) => parseCoinFromPair(p.pair)).filter(Boolean) as string[])).slice(0, 6).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => onSelectCoin?.(c)}
                      style={{
                        background: '#21262d',
                        border: '1px solid #30363d',
                        borderRadius: 3,
                        color: '#58a6ff',
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 6px',
                        cursor: 'pointer',
                      }}
                      title={`Switch chart to ${c}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => setScope('all')}
                  style={{
                    width: '100%',
                    background: '#238636',
                    border: 'none',
                    borderRadius: 4,
                    color: '#ffffff',
                    fontSize: 11.5,
                    fontWeight: 600,
                    padding: '6px 10px',
                    cursor: 'pointer',
                  }}
                >
                  View All {activeRows.length} Open Positions &rarr;
                </button>
              </div>
            )}

            {onSwitchToOrder && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={onSwitchToOrder}
                style={{
                  background: '#238636',
                  color: '#ffffff',
                  fontWeight: 600,
                  padding: '7px 16px',
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                Place New {normCoin} Order
              </button>
            )}
          </div>
        ) : displayedGroups.length === 0 ? (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: '#8b949e', fontSize: 12 }}>
            No positions match your search or filter.
          </div>
        ) : viewMode === 'cards' ? (
          /* Cards Mode: Render Each Group with aggregated header + account mobile cards */
          displayedGroups.map((g) => {
            const isCollapsed = collapsedGroups.has(g.key);
            const pnlNum = Number(g.totalPnlMinor ?? 0);
            const sideColor = g.side === 'long' ? 'var(--ok)' : g.side === 'short' ? 'var(--danger)' : 'var(--text-dim)';
            const groupRoe = calcRoePct({
              avgEntryPrice: String(g.positions.reduce((acc, p) => acc + Number(p.avgEntryPrice || 0), 0) / (g.positions.length || 1)),
              markPrice: g.positions[0]?.markPrice ?? null,
              leverage: g.positions[0]?.leverage ?? '1',
              side: g.side,
            });

            return (
              <div
                key={g.key}
                style={{
                  background: '#0d1117',
                  border: '1px solid #21262d',
                  borderRadius: 8,
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                {/* Group Summary Header */}
                <div
                  onClick={() => toggleGroupCollapse(g.key)}
                  style={{
                    padding: '10px 12px',
                    background: '#161b22',
                    borderBottom: !isCollapsed ? '1px solid #21262d' : 'none',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 800, fontSize: 14, color: '#f0f6fc' }}>
                        {g.asset}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          textTransform: 'uppercase',
                          color: sideColor,
                          border: `1px solid ${sideColor}`,
                          borderRadius: 3,
                          padding: '1px 5px',
                        }}
                      >
                        {g.side}
                      </span>
                      <span style={{ fontSize: 11, color: '#8b949e', fontWeight: 600 }}>
                        {g.marginCurrency}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          color: '#58a6ff',
                          background: 'rgba(56, 139, 253, 0.15)',
                          borderRadius: 3,
                          padding: '1px 6px',
                          fontWeight: 600,
                        }}
                      >
                        {g.groupNames[0] || 'Ungrouped'}
                      </span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 14, fontWeight: 800, color: pnlNum > 0 ? '#10b981' : pnlNum < 0 ? '#ef4444' : '#8b949e' }}>
                        {pnlText(g.totalPnlMinor, g.marginCurrency)}
                      </span>
                      {groupRoe !== null && (
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: groupRoe >= 0 ? '#10b981' : '#ef4444' }}>
                          {roeText(groupRoe).trim()}
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: '#8b949e', marginLeft: 4 }}>
                        {isCollapsed ? '▼' : '▲'}
                      </span>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: '#8b949e' }}>
                    <span>
                      Qty: <strong style={{ color: '#f0f6fc' }}>{g.totalQty.toFixed(4).replace(/\.?0+$/, '')}</strong> · {g.positions.length} account{g.positions.length > 1 ? 's' : ''}
                    </span>

                    <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => { setManagingGroup(g); setMessage(null); }}
                        style={{
                          background: 'rgba(124, 107, 255, 0.18)',
                          color: '#c4b5fd',
                          border: '1px solid rgba(124, 107, 255, 0.4)',
                          borderRadius: 4,
                          padding: '2px 8px',
                          fontSize: 10.5,
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                        title="Manage this position across all accounts in the group"
                      >
                        Manage Group
                      </button>

                      <button
                        type="button"
                        disabled={isHalted}
                        onClick={() => { setQuickExitTarget({ type: 'group', group: g }); setMessage(null); }}
                        style={{
                          background: 'rgba(239, 68, 68, 0.18)',
                          color: '#f87171',
                          border: '1px solid rgba(239, 68, 68, 0.4)',
                          borderRadius: 4,
                          padding: '2px 8px',
                          fontSize: 10.5,
                          fontWeight: 700,
                          cursor: isHalted ? 'not-allowed' : 'pointer',
                          opacity: isHalted ? 0.4 : 1,
                        }}
                        title="Quick exit all positions in this group"
                      >
                        Quick Exit
                      </button>
                    </div>
                  </div>
                </div>

                {/* Group Body: List of account cards */}
                {!isCollapsed && (
                  <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: 8, background: '#090b0e' }}>
                    {g.positions.map((p) => (
                      <AccountMobileCard
                        key={`${p.accountId}-${p.pair}-${p.marginCurrency}`}
                        p={p}
                        onManage={(pos) => { setManagingPosition(pos); setMessage(null); }}
                        onQuickExit={(pos) => { setQuickExitTarget({ type: 'account', position: pos }); setMessage(null); }}
                        isHalted={isHalted}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          /* Table View: Render standard GroupCard table */
          displayedGroups.map((g) => (
            <GroupCard
              key={g.key}
              group={g}
              collapsed={collapsedGroups.has(g.key)}
              onToggle={() => toggleGroupCollapse(g.key)}
              onManage={(pos) => { setManagingPosition(pos); setMessage(null); }}
              onManageGroup={(grp) => { setManagingGroup(grp); setMessage(null); }}
              onQuickExit={(pos) => { setQuickExitTarget({ type: 'account', position: pos }); setMessage(null); }}
              onQuickExitGroup={(grp) => { setQuickExitTarget({ type: 'group', group: grp }); setMessage(null); }}
              isHalted={isHalted}
            />
          ))
        )}
      </div>

      {/* ── Position Management Modal (Individual Account) ── */}
      {liveManagingPosition !== null && (
        <PositionManageModal
          position={liveManagingPosition}
          onClose={() => setManagingPosition(null)}
          onExit={(id, mc) => exitMut.mutate({ id, marginCurrency: mc })}
          onAdjust={(id, direction, percentBp, quantity) => adjustMut.mutate({ id, direction, percentBp, quantity })}
          onProtection={(args) => protMut.mutate(args)}
          isExiting={exitMut.isPending}
          isAdjusting={adjustMut.isPending}
          isProtecting={protMut.isPending}
          isHalted={isHalted}
        />
      )}

      {/* ── Group Position Management Modal (Group Actions) ── */}
      {liveManagingGroup !== null && (
        <GroupPositionManageModal
          group={liveManagingGroup}
          onClose={() => setManagingGroup(null)}
          onRefreshPositions={handleRefreshAll}
          isHalted={isHalted}
        />
      )}

      {/* ── Quick Exit Modal (Instant Market Exit with Multi-Account Select) ── */}
      {liveQuickExitTarget !== null && (
        <QuickExitModal
          target={liveQuickExitTarget}
          onClose={() => setQuickExitTarget(null)}
          onRefreshPositions={handleRefreshAll}
          isHalted={isHalted}
        />
      )}
    </div>
  );
}
