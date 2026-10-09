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
  GroupPositionManageModal,
  PositionManageModal,
  QuickExitModal,
  addMinors,
  buildGroups,
  pnlText,
} from '../routes/Futures.tsx';
import type { PositionGroup, QuickExitTarget } from '../routes/Futures.tsx';
import { parseCoinFromPair } from '../routes/TradeTicket.tsx';
import { TerminalPositionGroup } from './TerminalPositionGroup.tsx';
import { PositionCurrencyBadge } from './PositionCurrencyBadge.tsx';

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
  const [search, setSearch] = useState('');
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

  const visibleGroups = useMemo(() => {
    const query = search.trim().toLowerCase();
    return displayedGroups.filter((group) => !query ||
      [group.asset, group.marginCurrency, ...group.groupNames, ...group.positions.map((p) => p.accountName)].some((value) => value.toLowerCase().includes(query)));
  }, [displayedGroups, search]);

  // Keep margin currencies separate; do not sum unlike currencies or average account ROEs.
  const summaryKpis = useMemo(() => {
    const pnlByCurrency: Record<string, string> = {};
    for (const position of targetRows) {
      if (position.unrealisedPnlMinor === null) continue;
      const currency = position.marginCurrency;
      pnlByCurrency[currency] = addMinors(pnlByCurrency[currency] ?? '0', position.unrealisedPnlMinor);
    }
    return { pnlByCurrency };
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

  return (
    <div className="terminal-positions">
      <div className="terminal-positions-toolbar">
        <div className="terminal-positions-toolbar-row">
          <div className="terminal-position-segments" aria-label="Position scope">
            <button type="button" aria-pressed={scope === 'coin'} onClick={() => setScope('coin')}>{normCoin} <span>{coinPositions.length}</span></button>
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>All <span>{activeRows.length}</span></button>
          </div>
          <div className="terminal-position-filters" aria-label="Filter position groups">
            <button type="button" aria-pressed={pnlFilter === 'all'} onClick={() => setPnlFilter('all')}>All</button>
            <button type="button" aria-pressed={pnlFilter === 'profit'} onClick={() => setPnlFilter('profit')}>Profit</button>
            <button type="button" aria-pressed={pnlFilter === 'loss'} onClick={() => setPnlFilter('loss')}>Loss</button>
          </div>
          <button type="button" className="terminal-sync-button" onClick={() => refreshMut.mutate()} disabled={refreshMut.isPending} title="Sync positions with exchange" aria-label="Sync positions">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5 8a7 7 0 0 1 12-3l3 3M4 16l3 3a7 7 0 0 0 12-3" /></svg>
          </button>
        </div>
        {targetRows.length > 0 && <div className="terminal-position-totals" aria-label="Unrealised P&L by margin currency">
          {(['INR', 'USDT'] as const).filter((currency) => summaryKpis.pnlByCurrency[currency] !== undefined).map((currency) => {
            const minor = summaryKpis.pnlByCurrency[currency]!;
            return <div key={currency}><span><PositionCurrencyBadge currency={currency} /> P&L</span><strong className={minor.startsWith('-') ? 'negative' : minor !== '0' ? 'positive' : ''}>{pnlText(minor, currency)}</strong></div>;
          })}
        </div>}
        <div className="terminal-positions-toolbar-row">
          <input type="search" className="terminal-position-search" aria-label="Search positions" placeholder="Find account, group or coin" value={search} onChange={(event) => setSearch(event.target.value)} />
          <button type="button" className="terminal-text-button" onClick={() => setCollapsedGroups((current) => displayedGroups.every((group) => current.has(group.key)) ? new Set() : new Set(displayedGroups.map((group) => group.key)))}>{displayedGroups.length > 0 && displayedGroups.every((group) => collapsedGroups.has(group.key)) ? 'Expand all' : 'Collapse all'}</button>
        </div>
        {hiddenRowsCount > 0 && <button type="button" className="terminal-text-button" aria-pressed={showHiddenAccounts} onClick={() => setShowHiddenAccounts(!showHiddenAccounts)}>{showHiddenAccounts ? 'Hide excluded accounts' : `Show ${hiddenRowsCount} hidden accounts`}</button>}
      </div>
      {message && <div role="status" className={`terminal-position-message ${message.kind}`}><span>{message.text}</span><button type="button" aria-label="Dismiss position message" onClick={() => setMessage(null)}>×</button></div>}
      {isHalted && <div className="terminal-position-message err" role="status">Trading halted · Position actions locked</div>}
      {positionsQuery.isError && <div className="terminal-position-message err" role="alert">Positions unavailable. {positionsQuery.error.message}</div>}
      <div className="terminal-position-list">
        {positionsQuery.isPending ? <p className="terminal-position-empty" role="status">Loading positions…</p> : targetRows.length === 0 ? <div className="terminal-position-empty">
          <p>{scope === 'coin' ? `No ${normCoin} positions` : 'No open positions'}</p>
          {scope === 'coin' && otherPositions.length > 0 && <><div className="terminal-other-coins">{otherCoinsList.map((asset) => <button type="button" key={asset} onClick={() => onSelectCoin?.(asset)}>{asset}</button>)}</div><button type="button" className="btn secondary btn-sm" onClick={() => setScope('all')}>View all {activeRows.length} positions</button></>}
          {onSwitchToOrder && <button type="button" className="btn secondary btn-sm" onClick={onSwitchToOrder}>New {normCoin} order</button>}
        </div> : visibleGroups.length === 0 ? <p className="terminal-position-empty">No matching positions</p> : visibleGroups.map((group) => <TerminalPositionGroup key={group.key} group={group} collapsed={collapsedGroups.has(group.key)} search={search} halted={isHalted}
          onToggle={() => toggleGroupCollapse(group.key)}
          onManageGroup={(selected) => { setManagingGroup(selected); setMessage(null); }}
          onExitGroup={(selected) => { setQuickExitTarget({ type: 'group', group: selected }); setMessage(null); }}
          onManagePosition={(selected) => { setManagingPosition(selected); setMessage(null); }}
          onExitPosition={(selected) => { setQuickExitTarget({ type: 'account', position: selected }); setMessage(null); }} />)}
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
