import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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
  GroupPositionManageModal,
  PositionManageModal,
  QuickExitModal,
  addMinors,
  buildGroups,
  calcEstimatedTpSl,
  calcRoePct,
  fmtMinor,
  fmtPrice,
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

  // Scope: 'coin' = positions for the currently displayed chart coin; 'all' = all open positions
  const [scope, setScope] = useState<'coin' | 'all'>('coin');
  const [pnlFilter, setPnlFilter] = useState<'all' | 'profit' | 'loss'>('all');
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
        text: `Synced ${out.accounts} accounts — ${out.positions} open positions.`,
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
        text: `Position closed at market (cancelled ${out.cancelled.length} orders).`,
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
        ? { kind: 'err', text: `Some legs failed: ${failures.join('; ')}` }
        : { kind: 'ok', text: 'Protection updated.' });
      setManagingPosition(null);
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  // Filter hidden accounts
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

  const otherCoinsList = useMemo(() => {
    const list = Array.from(new Set(otherPositions.map((p) => parseCoinFromPair(p.pair)).filter(Boolean) as string[]));
    return list.slice(0, 5);
  }, [otherPositions]);

  const targetRows = scope === 'coin' ? coinPositions : activeRows;

  // Build groups for the selected scope
  const groups = useMemo(() => buildGroups(targetRows), [targetRows]);

  // PnL Filter (All / Profit / Loss)
  const displayedGroups = useMemo(() => {
    if (pnlFilter === 'profit') {
      return groups.filter((g) => Number(g.totalPnlMinor ?? 0) > 0);
    }
    if (pnlFilter === 'loss') {
      return groups.filter((g) => Number(g.totalPnlMinor ?? 0) < 0);
    }
    return groups;
  }, [groups, pnlFilter]);

  // Aggregated Net PnL and ROE for the active scope
  const summaryKpis = useMemo(() => {
    const byCurrency: Record<string, string> = {};
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
      totalQty,
      netRoe,
      count: targetRows.length,
    };
  }, [targetRows]);

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

  const toggleGroupCollapse = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const pnlCurrencies = Object.keys(summaryKpis.pnlByCurrency);
  const primaryCur = pnlCurrencies.includes('USDT') ? 'USDT' : pnlCurrencies[0] || 'USDT';
  const primaryPnlMinor = summaryKpis.pnlByCurrency[primaryCur] ?? '0';
  const netPnlNum = Number(primaryPnlMinor);
  const isNetProfit = netPnlNum > 0;
  const isNetLoss = netPnlNum < 0;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        flex: '1 1 0%',
        overflow: 'hidden',
        boxSizing: 'border-box',
      }}
    >
      {/* ── Fixed Header: Scope Switcher + Live Net PnL + Sync ── */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          padding: '8px 10px',
          background: '#0a0d12',
          borderBottom: '1px solid #1a1e27',
          flexShrink: 0,
        }}
      >
        {/* Row 1: Scope Pills + Live Net PnL + Sync */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          {/* Scope Segmented Pill */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              background: '#141820',
              padding: 2,
              borderRadius: 6,
              border: '1px solid #202633',
            }}
          >
            <button
              type="button"
              onClick={() => setScope('coin')}
              style={{
                padding: '3px 8px',
                fontSize: 11,
                fontWeight: 700,
                borderRadius: 4,
                border: 'none',
                background: scope === 'coin' ? '#10b981' : 'transparent',
                color: scope === 'coin' ? '#ffffff' : '#8b949e',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span>{normCoin}</span>
              <span
                style={{
                  fontSize: 9.5,
                  padding: '0 4px',
                  borderRadius: 8,
                  background: scope === 'coin' ? 'rgba(255,255,255,0.25)' : '#1e2430',
                  color: scope === 'coin' ? '#ffffff' : '#8b949e',
                  fontWeight: 800,
                }}
              >
                {coinPositions.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setScope('all')}
              style={{
                padding: '3px 8px',
                fontSize: 11,
                fontWeight: 700,
                borderRadius: 4,
                border: 'none',
                background: scope === 'all' ? '#3b82f6' : 'transparent',
                color: scope === 'all' ? '#ffffff' : '#8b949e',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <span>All</span>
              <span
                style={{
                  fontSize: 9.5,
                  padding: '0 4px',
                  borderRadius: 8,
                  background: scope === 'all' ? 'rgba(255,255,255,0.25)' : '#1e2430',
                  color: scope === 'all' ? '#ffffff' : '#8b949e',
                  fontWeight: 800,
                }}
              >
                {activeRows.length}
              </span>
            </button>
          </div>

          {/* Right side: Live Scope PnL + Sync button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {targetRows.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    color: isNetProfit ? '#10b981' : isNetLoss ? '#ef4444' : '#c9d1d9',
                  }}
                >
                  {pnlText(primaryPnlMinor, primaryCur as 'INR' | 'USDT')}
                </span>
                {summaryKpis.netRoe !== null && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 800,
                      padding: '1px 4px',
                      borderRadius: 3,
                      color: summaryKpis.netRoe >= 0 ? '#34d399' : '#f87171',
                      background: summaryKpis.netRoe >= 0 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                    }}
                  >
                    {roeText(summaryKpis.netRoe).trim()}
                  </span>
                )}
              </div>
            )}

            {/* Sync button */}
            <button
              type="button"
              disabled={refreshMut.isPending}
              onClick={() => refreshMut.mutate()}
              style={{
                background: '#161b22',
                border: '1px solid #28303d',
                color: '#8b949e',
                borderRadius: 5,
                width: 26,
                height: 26,
                padding: 0,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
              title="Sync positions with exchange"
            >
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ animation: refreshMut.isPending ? 'spin 1s linear infinite' : 'none' }}
              >
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
            </button>
          </div>
        </div>

        {/* Row 2: Filter tabs (only if multiple positions) */}
        {targetRows.length > 1 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
            <div style={{ display: 'inline-flex', gap: 3 }}>
              <button
                type="button"
                onClick={() => setPnlFilter('all')}
                style={{
                  padding: '2px 7px',
                  fontSize: 10.5,
                  fontWeight: 700,
                  borderRadius: 4,
                  border: 'none',
                  background: pnlFilter === 'all' ? '#21262d' : 'transparent',
                  color: pnlFilter === 'all' ? '#f0f6fc' : '#8b949e',
                  cursor: 'pointer',
                }}
              >
                All ({groups.length})
              </button>
              <button
                type="button"
                onClick={() => setPnlFilter('profit')}
                style={{
                  padding: '2px 7px',
                  fontSize: 10.5,
                  fontWeight: 700,
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
                  padding: '2px 7px',
                  fontSize: 10.5,
                  fontWeight: 700,
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

            {hiddenRowsCount > 0 && (
              <button
                type="button"
                onClick={() => setShowHiddenAccounts((prev) => !prev)}
                style={{
                  padding: '2px 6px',
                  fontSize: 10,
                  fontWeight: 700,
                  borderRadius: 4,
                  border: 'none',
                  background: showHiddenAccounts ? 'rgba(239, 68, 68, 0.2)' : '#161b22',
                  color: showHiddenAccounts ? '#fca5a5' : '#8b949e',
                  cursor: 'pointer',
                }}
              >
                {showHiddenAccounts ? `Hide ${hiddenRowsCount}` : `+${hiddenRowsCount} Hidden`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* ── Status Message Toast ── */}
      {message && (
        <div
          style={{
            padding: '6px 10px',
            fontSize: 11,
            fontWeight: 600,
            background: message.kind === 'ok' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            color: message.kind === 'ok' ? '#34d399' : '#f87171',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexShrink: 0,
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

      {/* ── Kill Switch Banner ── */}
      {isHalted && (
        <div
          style={{
            background: 'rgba(239, 68, 68, 0.18)',
            borderBottom: '1px solid var(--danger)',
            padding: '6px 10px',
            fontSize: 11,
            color: '#fca5a5',
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          KILL SWITCH ACTIVE — Exits locked (Read-Only).
        </div>
      )}

      {/* ── Scrollable Body: Major Info & Main Action Buttons Only ── */}
      <div
        className="coin-positions-scroll-body"
        style={{
          padding: '8px 10px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {targetRows.length === 0 ? (
          /* Empty State */
          <div className="trade-drawer-empty">
            <div style={{ color: '#8b949e', fontSize: 13, fontWeight: 700 }}>
              {scope === 'coin' ? `No Open Positions on ${normCoin}` : 'No Open Positions'}
            </div>

            {scope === 'coin' && otherPositions.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: '100%', marginTop: 2 }}>
                <span style={{ fontSize: 11, color: '#64748b' }}>
                  Open on other coins:
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, justifyContent: 'center' }}>
                  {otherCoinsList.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className="trade-drawer-coin-btn"
                      onClick={() => onSelectCoin?.(c)}
                      title={`Open ${c} chart`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn-sm secondary"
                  style={{ width: '100%', marginTop: 4, fontSize: 11.5, padding: '5px 8px' }}
                  onClick={() => setScope('all')}
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
                style={{ width: '100%', marginTop: 4, fontSize: 12, padding: '6px 12px' }}
              >
                Place New {normCoin} Order
              </button>
            )}
          </div>
        ) : displayedGroups.length === 0 ? (
          <div style={{ padding: '20px 10px', textAlign: 'center', color: '#8b949e', fontSize: 11.5 }}>
            No positions match your filter.
          </div>
        ) : (
          displayedGroups.map((g) => {
            const isGrouped = g.positions.length > 1 || scope === 'all';
            const isCollapsed = collapsedGroups.has(g.key);
            const groupPnlNum = Number(g.totalPnlMinor ?? 0);
            const groupRoe = calcRoePct({
              avgEntryPrice: String(g.positions.reduce((acc, p) => acc + Number(p.avgEntryPrice || 0), 0) / (g.positions.length || 1)),
              markPrice: g.positions[0]?.markPrice ?? null,
              leverage: g.positions[0]?.leverage ?? '1',
              side: g.side,
            });

            return (
              <div key={g.key} className="trade-drawer-group">
                {/* Group Summary Banner (when grouped) */}
                {isGrouped && (
                  <div
                    className="trade-drawer-group-head"
                    onClick={() => toggleGroupCollapse(g.key)}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span style={{ fontWeight: 800, fontSize: 13, color: '#f0f6fc' }}>
                          {g.asset}
                        </span>
                        <span className={`trade-drawer-side-pill ${g.side}`}>
                          {g.side.toUpperCase()}
                        </span>
                        <span className="trade-drawer-grp-tag">
                          {g.groupNames[0] || 'Group'} ({g.positions.length})
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span className={`trade-drawer-pnl ${groupPnlNum > 0 ? 'pos' : groupPnlNum < 0 ? 'neg' : ''}`}>
                          {pnlText(g.totalPnlMinor, g.marginCurrency)}
                        </span>
                        {groupRoe !== null && (
                          <span className={`trade-drawer-roe-pill ${groupRoe >= 0 ? 'pos' : 'neg'}`}>
                            {roeText(groupRoe).trim()}
                          </span>
                        )}
                        <span style={{ fontSize: 9.5, color: '#8b949e', marginLeft: 2 }}>
                          {isCollapsed ? '▼' : '▲'}
                        </span>
                      </div>
                    </div>

                    {/* Group Actions Bar */}
                    <div
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <span style={{ fontSize: 10.5, color: '#8b949e' }}>
                        Qty: <strong style={{ color: '#e2e8f0' }}>{g.totalQty.toFixed(4).replace(/\.?0+$/, '')}</strong>
                      </span>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          className="btn btn-sm secondary"
                          style={{ padding: '3px 8px', fontSize: 10.5, fontWeight: 700, borderRadius: 5 }}
                          onClick={() => { setManagingGroup(g); setMessage(null); }}
                          title="Group-wide TP/SL & adjustments"
                        >
                          Manage Group
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm quick-exit-btn"
                          disabled={isHalted}
                          style={{ padding: '3px 8px', fontSize: 10.5, fontWeight: 700, borderRadius: 5 }}
                          onClick={() => { setQuickExitTarget({ type: 'group', group: g }); setMessage(null); }}
                          title="Instant market exit for all accounts in this group"
                        >
                          Quick Exit
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Individual Position Cards */}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: isGrouped ? '6px' : 0 }}>
                    {g.positions.map((p) => {
                      const roe = calcRoePct(p);
                      const tpSl = calcEstimatedTpSl(p);
                      const pnlNum = Number(p.unrealisedPnlMinor ?? 0);
                      const isProfit = pnlNum > 0;
                      const isLoss = pnlNum < 0;

                      return (
                        <div key={p.venuePositionId} className="trade-drawer-card">
                          {/* Top: Account Link + Side/Lev + PnL/ROE */}
                          <div className="trade-drawer-card-top">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                              <Link
                                to={`/app/accounts/${p.accountId}`}
                                className="trade-drawer-acc-link"
                                title={`Open account ${p.accountName}`}
                              >
                                {p.accountName}
                              </Link>
                              <span className={`trade-drawer-side-pill ${p.side}`}>
                                {p.side.toUpperCase()} {p.leverage ? `${p.leverage}×` : ''}
                              </span>
                              {p.groupName && !isGrouped && (
                                <span className="trade-drawer-grp-tag">
                                  {p.groupName}
                                </span>
                              )}
                            </div>

                            <div style={{ textAlign: 'right', display: 'flex', alignItems: 'baseline', gap: 4, flexShrink: 0 }}>
                              <span className={`trade-drawer-pnl ${isProfit ? 'pos' : isLoss ? 'neg' : ''}`}>
                                {pnlText(p.unrealisedPnlMinor, p.marginCurrency)}
                              </span>
                              {roe !== null && (
                                <span className={`trade-drawer-roe-pill ${roe >= 0 ? 'pos' : 'neg'}`}>
                                  {roeText(roe).trim()}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Major Information Grid: 2x2 Clean Layout */}
                          <div className="trade-drawer-grid">
                            <div className="trade-drawer-cell">
                              <span className="trade-drawer-lbl">Entry → Mark</span>
                              <span className="trade-drawer-val mono">
                                {fmtPrice(p.avgEntryPrice)} <span style={{ color: '#64748b' }}>→</span> {fmtPrice(p.markPrice)}
                              </span>
                            </div>

                            <div className="trade-drawer-cell">
                              <span className="trade-drawer-lbl">Margin · Qty</span>
                              <span className="trade-drawer-val mono">
                                {p.lockedMarginMinor ? fmtMinor(p.lockedMarginMinor, p.marginCurrency) : '—'} <span style={{ color: '#64748b' }}>·</span> {p.quantity}
                              </span>
                            </div>

                            <div className="trade-drawer-cell">
                              <span className="trade-drawer-lbl">Liq Price</span>
                              <span
                                className="trade-drawer-val mono"
                                style={{
                                  color: p.liqBufferBp !== null && p.liqBufferBp < 1000 ? '#ef4444' : '#facc15',
                                }}
                              >
                                {fmtPrice(p.liquidationPrice)}
                                {p.liqBufferBp !== null && (
                                  <span
                                    style={{
                                      fontSize: 10,
                                      marginLeft: 4,
                                      color: p.liqBufferBp < 1000 ? '#ef4444' : '#ca8a04',
                                      fontWeight: 600,
                                    }}
                                  >
                                    ({(p.liqBufferBp / 100).toFixed(1)}% buf)
                                  </span>
                                )}
                              </span>
                            </div>

                            <div className="trade-drawer-cell">
                              <span className="trade-drawer-lbl">TP / SL</span>
                              <span className="trade-drawer-val">
                                {!tpSl.hasSl && !tpSl.hasTp ? (
                                  <span style={{ color: '#64748b', fontSize: 11 }}>None</span>
                                ) : (
                                  <span style={{ display: 'inline-flex', gap: 3 }}>
                                    {tpSl.hasTp && (
                                      <span className="trade-drawer-target-pill tp">
                                        TP {tpSl.tpPriceText}
                                      </span>
                                    )}
                                    {tpSl.hasSl && (
                                      <span className="trade-drawer-target-pill sl">
                                        SL {tpSl.slPriceText}
                                      </span>
                                    )}
                                  </span>
                                )}
                              </span>
                            </div>
                          </div>

                          {/* Main Action Buttons */}
                          <div className="trade-drawer-actions">
                            <button
                              type="button"
                              className="btn btn-sm secondary trade-drawer-btn"
                              onClick={() => { setManagingPosition(p); setMessage(null); }}
                              title="Set TP/SL, trailing stop, partial close, or leverage"
                            >
                              Manage
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm quick-exit-btn trade-drawer-btn danger"
                              disabled={isHalted}
                              onClick={() => { setQuickExitTarget({ type: 'account', position: p }); setMessage(null); }}
                              title={isHalted ? 'Emergency Kill Switch Active' : 'Market Quick Exit'}
                            >
                              Quick Exit
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
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
