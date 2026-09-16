import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adjustFuturesPosition, exitFuturesPosition, fetchFuturesPositions, fetchGroups,
  refreshFuturesPositions, setFuturesProtection, setTrailingProtection,
} from '../api.js';
import type { FuturesPositionRow } from '../api.ts';

// The Positions page — modern UI/UX overhaul.
//
// Key improvements:
//   1. Group Name visibility: Every position links to its Account Group (e.g. "📁 Momentum").
//   2. Real-money Safety: Accidental clicks eliminated by replacing direct "Close" buttons
//      with a full-featured "Manage" modal with two-step exit confirmation.
//   3. High-Density Visibility: Cards are expanded by default so all metrics are readable immediately.
//   4. High-Scale Account Handling: Groups with 100+ accounts feature account search and smart
//      pagination ("Show all N accounts") preventing overwhelming scroll length.
//   5. Live 3s Real-Time Marks, Margins, and ROE % throughout.

/* ─── helpers ─── */

function quoteScaleOf(quote: 'INR' | 'USDT'): number {
  return quote === 'INR' ? 2 : 8;
}

function fmtMinor(minor: string, quote: 'INR' | 'USDT'): string {
  const scale = quoteScaleOf(quote);
  const neg = minor.startsWith('-');
  const digits = neg ? minor.slice(1) : minor;
  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, -scale);
  const frac = padded.slice(-scale).replace(/0+$/, '');
  const body = `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac === '' ? '' : `.${frac}`}`;
  const sign = neg ? '−' : '';
  return quote === 'INR' ? `${sign}₹${body}` : `${sign}${body} ${quote}`;
}

function pnlClass(minor: string | null): string {
  if (minor === null) return '';
  if (minor.startsWith('-')) return 'pnl-loss';
  if (minor === '0' || minor === '') return '';
  return 'pnl-profit';
}

function pnlText(minor: string | null, quote: 'INR' | 'USDT'): string {
  if (minor === null) return '—';
  if (minor.startsWith('-')) return fmtMinor(minor, quote);
  return `+${fmtMinor(minor, quote)}`;
}

function bufferColor(bp: number | null): string | undefined {
  if (bp === null) return undefined;
  if (bp < 200) return 'var(--danger)';
  if (bp < 1000) return '#c48a00';
  return 'var(--ok)';
}

/** Add two minor-unit strings. Works for both positive and negative values. */
function addMinors(a: string, b: string): string {
  return String(BigInt(a) + BigInt(b));
}

/** Calculate proportional minor units (e.g. 25% of 6952663) using basis points */
function calcProportionalMinor(minor: string | null, pct: number): string | null {
  if (minor === null || minor === '' || minor === '0' || !Number.isFinite(pct) || pct <= 0) return null;
  try {
    const b = BigInt(minor);
    const bp = BigInt(Math.round(pct * 100));
    return String((b * bp) / 10000n);
  } catch {
    return null;
  }
}

function calcRoePct(p: { avgEntryPrice: string | null; markPrice: string | null; leverage: string | null; side: 'long' | 'short' | 'flat' }): number | null {
  if (p.avgEntryPrice === null || p.markPrice === null || p.side === 'flat') return null;
  const entry = Number(p.avgEntryPrice);
  const mark = Number(p.markPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(mark) || entry <= 0) return null;
  const lev = p.leverage !== null && Number(p.leverage) > 0 ? Number(p.leverage) : 1;
  const dir = p.side === 'short' ? -1 : 1;
  const pct = ((mark - entry) / entry) * 100 * lev * dir;
  return Number.isFinite(pct) ? pct : null;
}

function roeText(pct: number | null): string {
  if (pct === null) return '';
  const sign = pct >= 0 ? '+' : '';
  return ` (${sign}${pct.toFixed(2)}%)`;
}

function pctToTrigger(refPrice: number, pct: number, side: 'long' | 'short', leg: 'sl' | 'tp'): number {
  const down = (side === 'long' && leg === 'sl') || (side === 'short' && leg === 'tp');
  return down ? refPrice * (1 - pct / 100) : refPrice * (1 + pct / 100);
}

function triggerToPct(refPrice: number, triggerPrice: number, side: 'long' | 'short', leg: 'sl' | 'tp'): number {
  const down = (side === 'long' && leg === 'sl') || (side === 'short' && leg === 'tp');
  const pct = down
    ? ((refPrice - triggerPrice) / refPrice) * 100
    : ((triggerPrice - refPrice) / refPrice) * 100;
  return Math.abs(pct);
}

/* ─── grouped position type ─── */

interface PositionGroup {
  key: string;
  /** e.g. "BTC" */
  asset: string;
  pair: string;
  side: 'long' | 'short' | 'flat';
  marginCurrency: 'INR' | 'USDT';
  /** Sum of all account quantities. */
  totalQty: number;
  /** Aggregated margin in minor units. */
  totalMarginMinor: string | null;
  /** Aggregated unrealised PnL in minor units. */
  totalPnlMinor: string | null;
  /** Per-account positions in this group. */
  positions: FuturesPositionRow[];
  /** Unique group names across positions in this instrument. */
  groupNames: string[];
}

function buildGroups(rows: readonly FuturesPositionRow[]): PositionGroup[] {
  const map = new Map<string, PositionGroup>();
  for (const p of rows) {
    const key = `${p.pair}|${p.side}|${p.marginCurrency}`;
    let g = map.get(key);
    if (g === undefined) {
      // Extract the asset name from the pair (e.g., "B-BTC_USDT" → "BTC")
      const asset = p.pair.replace(/^[A-Z]-/, '').replace(/_.*$/, '');
      g = {
        key,
        asset,
        pair: p.pair,
        side: p.side,
        marginCurrency: p.marginCurrency,
        totalQty: 0,
        totalMarginMinor: null,
        totalPnlMinor: null,
        positions: [],
        groupNames: [],
      };
      map.set(key, g);
    }
    g.positions.push(p);
    g.totalQty += Number(p.quantity);
    if (p.groupName && !g.groupNames.includes(p.groupName)) {
      g.groupNames.push(p.groupName);
    }
    if (p.lockedMarginMinor !== null && p.lockedMarginMinor !== '' && p.lockedMarginMinor !== '0') {
      g.totalMarginMinor = g.totalMarginMinor === null
        ? p.lockedMarginMinor
        : addMinors(g.totalMarginMinor, p.lockedMarginMinor);
    }
    if (p.unrealisedPnlMinor !== null) {
      g.totalPnlMinor = g.totalPnlMinor === null
        ? p.unrealisedPnlMinor
        : addMinors(g.totalPnlMinor, p.unrealisedPnlMinor);
    }
  }
  return Array.from(map.values());
}

/* ─── per-account row inside a group card ─── */

function AccountRow({
  p,
  onManage,
}: {
  readonly p: FuturesPositionRow;
  readonly onManage: (position: FuturesPositionRow) => void;
}) {
  const roe = calcRoePct(p);
  const hasSl = p.stopLossTrigger !== null && p.stopLossTrigger !== '0' && p.stopLossTrigger !== '0.0' && Number(p.stopLossTrigger) > 0;
  const hasTp = p.takeProfitTrigger !== null && p.takeProfitTrigger !== '0' && p.takeProfitTrigger !== '0.0' && Number(p.takeProfitTrigger) > 0;

  return (
    <tr>
      <td>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <strong style={{ fontSize: 13.5, color: 'var(--text)' }}>{p.accountName}</strong>
          <div style={{ fontSize: 11, color: 'var(--muted)', display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
            <span style={{ opacity: 0.6 }}>📁</span> {p.groupName || 'Ungrouped'}
          </div>
        </div>
      </td>
      <td className="mono" style={{ textAlign: 'right' }}>{p.quantity}</td>
      <td>{p.leverage === null ? <span className="muted">—</span> : `${p.leverage}×`}</td>
      <td className="mono" style={{ textAlign: 'right' }}>
        {p.lockedMarginMinor && p.lockedMarginMinor !== '0' ? fmtMinor(p.lockedMarginMinor, p.marginCurrency) : <span className="muted">—</span>}
      </td>
      <td className="mono" style={{ textAlign: 'right' }}>{p.avgEntryPrice ?? <span className="muted">—</span>}</td>
      <td className="mono" style={{ textAlign: 'right', color: 'var(--accent)' }}>{p.markPrice ?? <span className="muted">—</span>}</td>
      <td className="mono" style={{ textAlign: 'right', color: bufferColor(p.liqBufferBp) }}>
        {p.liquidationPrice ?? <span className="muted">—</span>}
        {p.liqBufferBp !== null && (
          <span className="muted" style={{ display: 'block', fontSize: 10.5 }}>
            {(p.liqBufferBp / 100).toFixed(1)}% buf
          </span>
        )}
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
            {hasSl && <span className="badge skipped" style={{ fontSize: 9.5, padding: '1px 5px' }}>SL {p.stopLossTrigger}</span>}
            {hasTp && <span className="badge planned" style={{ fontSize: 9.5, padding: '1px 5px' }}>TP {p.takeProfitTrigger}</span>}
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
          onClick={() => onManage(p)}
        >
          <span>⚙</span> Manage
        </button>
      </td>
    </tr>
  );
}

/* ─── group card with high-scale account handling ─── */

function GroupCard({
  group,
  collapsed,
  onToggle,
  onManage,
}: {
  readonly group: PositionGroup;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onManage: (position: FuturesPositionRow) => void;
}) {
  const [accountSearch, setAccountSearch] = useState('');
  const [showAll, setShowAll] = useState(false);

  const sideColor = group.side === 'long' ? 'var(--ok)' : group.side === 'short' ? 'var(--danger)' : 'var(--text-dim)';
  const totalWeight = group.positions.reduce((acc, pos) => acc + Number(pos.quantity), 0);
  const weightedRoeSum = group.positions.reduce((acc, pos) => {
    const r = calcRoePct(pos);
    return r !== null ? acc + r * Number(pos.quantity) : acc;
  }, 0);
  const groupRoe = totalWeight > 0 ? weightedRoeSum / totalWeight : null;

  // Filter accounts within this group if search term provided
  const filteredPositions = useMemo(() => {
    if (!accountSearch.trim()) return group.positions;
    const q = accountSearch.toLowerCase().trim();
    return group.positions.filter((p) =>
      p.accountName.toLowerCase().includes(q) ||
      (p.groupName && p.groupName.toLowerCase().includes(q))
    );
  }, [group.positions, accountSearch]);

  const hasMany = group.positions.length > 5;
  const visiblePositions = hasMany && !showAll && !accountSearch.trim()
    ? filteredPositions.slice(0, 5)
    : filteredPositions;

  const groupTitle = group.groupNames.length === 1
    ? group.groupNames[0]
    : group.groupNames.length > 1
      ? `${group.groupNames.slice(0, 2).join(', ')}${group.groupNames.length > 2 ? ` (+${group.groupNames.length - 2})` : ''}`
      : 'Ungrouped';

  return (
    <div className="position-card">
      <div className="position-card-header" onClick={onToggle}>
        {/* Asset + Side */}
        <span className="asset-name">{group.asset}</span>
        <span
          className="badge"
          style={{
            color: sideColor,
            borderColor: sideColor,
            background: group.side === 'long' ? 'rgba(75,181,99,0.1)' : group.side === 'short' ? 'rgba(240,85,90,0.1)' : 'transparent',
            fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          }}
        >
          {group.side}
        </span>
        <span className="card-meta">{group.marginCurrency}</span>

        {/* Group Name badge */}
        <span className="group-badge" title={group.groupNames.join(', ')}>
          📁 {groupTitle}
        </span>

        {/* Aggregated stats */}
        <span className="card-meta" style={{ marginLeft: 6 }}>
          Qty <strong style={{ color: 'var(--text)' }}>{group.totalQty.toFixed(4).replace(/\.?0+$/, '')}</strong>
        </span>
        {group.totalMarginMinor !== null && (
          <span className="card-meta">
            Margin <strong style={{ color: 'var(--text)' }}>{fmtMinor(group.totalMarginMinor, group.marginCurrency)}</strong>
          </span>
        )}
        <span className="card-meta">
          {group.positions.length} account{group.positions.length > 1 ? 's' : ''}
        </span>

        {/* PnL */}
        <span className={`card-pnl ${pnlClass(group.totalPnlMinor)}`}>
          {pnlText(group.totalPnlMinor, group.marginCurrency)}
          {groupRoe !== null && (
            <span style={{ fontSize: 11, marginLeft: 6, fontWeight: 500 }}>
              {roeText(groupRoe)}
            </span>
          )}
        </span>

        {/* Expand chevron */}
        <span className={`expand-icon ${!collapsed ? 'open' : ''}`}>▼</span>
      </div>

      {!collapsed && (
        <div className="position-card-body">
          {/* Sub-header with account filter if group has more than 5 accounts */}
          {hasMany && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 14px',
                background: 'rgba(0, 0, 0, 0.2)',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                Showing {visiblePositions.length} of {group.positions.length} accounts in this trade
              </span>
              <input
                type="text"
                className="card-account-search"
                placeholder="Filter accounts in group…"
                value={accountSearch}
                onChange={(e) => setAccountSearch(e.target.value)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th>Account & Group</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th>Lev</th>
                <th style={{ textAlign: 'right' }}>Margin</th>
                <th style={{ textAlign: 'right' }}>Entry</th>
                <th style={{ textAlign: 'right' }}>Mark (Live)</th>
                <th style={{ textAlign: 'right' }}>Liquidation</th>
                <th style={{ textAlign: 'right' }}>PnL (ROE)</th>
                <th>Protection</th>
                <th style={{ textAlign: 'center' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {visiblePositions.map((p) => (
                <AccountRow
                  key={`${p.accountId}-${p.pair}-${p.marginCurrency}`}
                  p={p}
                  onManage={onManage}
                />
              ))}
            </tbody>
          </table>

          {/* Show More toggle for groups with 100+ accounts */}
          {hasMany && !accountSearch.trim() && (
            <div className="show-more-bar">
              <span>Showing {visiblePositions.length} of {group.positions.length} accounts</span>
              <button
                type="button"
                className="btn btn-sm secondary"
                style={{ fontSize: 11, padding: '2px 10px' }}
                onClick={() => setShowAll((v) => !v)}
              >
                {showAll ? 'Show Fewer (5) ▲' : `Show All ${group.positions.length} Accounts (${group.positions.length - 5} more) ▼`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ─── Position Management Modal (Zero Accidental Exits) ─── */

const SL_PCT_CHIPS = [1, 2, 5, 10] as const;
const TP_PCT_CHIPS = [2, 5, 10, 15, 20, 30] as const;
const REDUCE_PCT_CHIPS = [10, 25, 50, 75] as const;
const INCREASE_PCT_CHIPS = [25, 50, 100] as const;

interface PositionManageModalProps {
  readonly position: FuturesPositionRow;
  readonly onClose: () => void;
  readonly onExit: (id: string, marginCurrency: 'INR' | 'USDT') => void;
  readonly onAdjust: (id: string, direction: 'reduce' | 'increase', percentBp: number) => void;
  readonly onProtection: (args: { id: string; slp?: string | undefined; tpp?: string | undefined; trailing?: boolean | undefined }) => void;
  readonly isExiting: boolean;
  readonly isAdjusting: boolean;
  readonly isProtecting: boolean;
}

function PositionManageModal({
  position,
  onClose,
  onExit,
  onAdjust,
  onProtection,
  isExiting,
  isAdjusting,
  isProtecting,
}: PositionManageModalProps) {
  const [activeTab, setActiveTab] = useState<'protection' | 'partial' | 'increase' | 'close'>('protection');
  const [confirmExit, setConfirmExit] = useState(false);

  const qc = useQueryClient();

  // Query groups for group funding balance (auto-refreshes every 3s)
  const groupsQuery = useQuery({
    queryKey: ['groups'],
    queryFn: fetchGroups,
    refetchInterval: 3000,
  });

  const matchedGroup = useMemo(() => {
    const gn = position.groupName;
    if (!groupsQuery.data || !gn) return null;
    const gnLower = gn.trim().toLowerCase();
    return groupsQuery.data.find(
      (g) => g.name === gn || g.name.trim().toLowerCase() === gnLower,
    ) ?? null;
  }, [groupsQuery.data, position.groupName]);

  const otherCurrency: 'INR' | 'USDT' = position.marginCurrency === 'INR' ? 'USDT' : 'INR';
  const groupFundingCurMinor = matchedGroup ? matchedGroup.allocatedByCurrency[position.marginCurrency] : null;
  const groupFundingOtherMinor = matchedGroup ? matchedGroup.allocatedByCurrency[otherCurrency] : null;

  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const handleManualRefresh = async () => {
    setIsManualRefreshing(true);
    try {
      await Promise.all([
        groupsQuery.refetch(),
        qc.invalidateQueries({ queryKey: ['futures-positions'] }),
      ]);
    } finally {
      setTimeout(() => setIsManualRefreshing(false), 500);
    }
  };
  const isRefreshing = isManualRefreshing || groupsQuery.isFetching;

  // Partial close / reduce state
  const [reducePct, setReducePct] = useState<number>(25);
  const [customReduceInput, setCustomReduceInput] = useState<string>('');
  const isCustomReduce = customReduceInput !== '' && Number(customReduceInput) === reducePct;

  // Increase / add state
  const [increasePct, setIncreasePct] = useState<number>(25);
  const [customIncreaseInput, setCustomIncreaseInput] = useState<string>('');
  const isCustomIncrease = customIncreaseInput !== '' && Number(customIncreaseInput) === increasePct;

  // Protection state
  const initSl = position.stopLossTrigger && position.stopLossTrigger !== '0' && Number(position.stopLossTrigger) > 0 ? position.stopLossTrigger : '';
  const initTp = position.takeProfitTrigger && position.takeProfitTrigger !== '0' && Number(position.takeProfitTrigger) > 0 ? position.takeProfitTrigger : '';
  const [sl, setSl] = useState(initSl);
  const [tp, setTp] = useState(initTp);
  const [slTpMode, setSlTpMode] = useState<'percent' | 'price'>('percent');
  const [slPct, setSlPct] = useState('');
  const [tpPct, setTpPct] = useState('');
  const [trailing, setTrailing] = useState(false);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExiting && !isAdjusting && !isProtecting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isExiting, isAdjusting, isProtecting]);

  const roe = calcRoePct(position);
  const refPrice = position.avgEntryPrice !== null ? Number(position.avgEntryPrice) : NaN;
  const hasRef = Number.isFinite(refPrice) && refPrice > 0;
  const sideOk = position.side === 'long' || position.side === 'short';

  const effectiveSl = slTpMode === 'percent' && slPct !== '' && hasRef && sideOk
    ? pctToTrigger(refPrice, Number(slPct), position.side as 'long' | 'short', 'sl').toFixed(8).replace(/\.?0+$/, '')
    : sl;
  const effectiveTp = slTpMode === 'percent' && tpPct !== '' && hasRef && sideOk
    ? pctToTrigger(refPrice, Number(tpPct), position.side as 'long' | 'short', 'tp').toFixed(8).replace(/\.?0+$/, '')
    : tp;

  const validNumber = /^\d+(\.\d+)?$/;
  const slValid = slTpMode === 'price' ? (sl === '' || validNumber.test(sl)) : (slPct === '' || (validNumber.test(slPct) && Number(slPct) <= 100));
  const tpValid = slTpMode === 'price' ? (tp === '' || validNumber.test(tp)) : (tpPct === '' || (validNumber.test(tpPct) && Number(tpPct) <= 100));
  const canSaveProtection = slValid && tpValid && ((slTpMode === 'price' ? sl !== '' : slPct !== '') || (slTpMode === 'price' ? tp !== '' : tpPct !== ''));

  const sideBadgeColor = position.side === 'long' ? 'var(--ok)' : 'var(--danger)';
  const totalQty = Number(position.quantity);
  const reduceQty = (totalQty * reducePct / 100).toFixed(4);
  const remainQty = Math.max(0, totalQty - Number(reduceQty)).toFixed(4);
  const increaseQty = (totalQty * increasePct / 100).toFixed(4);
  const newTotalQty = (totalQty + Number(increaseQty)).toFixed(4);
  const addMarginMinor = calcProportionalMinor(position.lockedMarginMinor, increasePct);
  const reduceMarginMinor = calcProportionalMinor(position.lockedMarginMinor, reducePct);

  return (
    <div className="position-modal-overlay" onClick={onClose}>
      <div className="position-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="position-modal-header">
          <div>
            <h3 className="position-modal-title">
              <span>{position.pair}</span>
              <span
                className="badge"
                style={{
                  color: sideBadgeColor,
                  borderColor: sideBadgeColor,
                  background: position.side === 'long' ? 'rgba(75,181,99,0.12)' : 'rgba(240,85,90,0.12)',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                }}
              >
                {position.side} {position.leverage ? `${position.leverage}×` : ''}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-dim)', fontWeight: 400 }}>
                ({position.marginCurrency})
              </span>
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                {position.accountName}
              </span>
              <span className="group-badge">
                📁 {position.groupName || 'Ungrouped'}
              </span>
            </div>
          </div>
          <button type="button" className="position-modal-close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        {/* Live Metrics Header Card */}
        <div className="position-modal-metrics">
          <div className="modal-metric-card">
            <span className="modal-metric-label">Unrealised PnL</span>
            <span className={`modal-metric-value ${pnlClass(position.unrealisedPnlMinor)}`} style={{ fontSize: 15 }}>
              {pnlText(position.unrealisedPnlMinor, position.marginCurrency)}
              {roe !== null && <span style={{ fontSize: 12, marginLeft: 4 }}>{roeText(roe).trim()}</span>}
            </span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Position Size</span>
            <span className="modal-metric-value">{position.quantity}</span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Margin Invested</span>
            <span className="modal-metric-value">
              {position.lockedMarginMinor ? fmtMinor(position.lockedMarginMinor, position.marginCurrency) : '—'}
            </span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Entry Price</span>
            <span className="modal-metric-value">{position.avgEntryPrice ?? '—'}</span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Mark Price</span>
            <span className="modal-metric-value" style={{ color: 'var(--accent)' }}>
              {position.markPrice ?? '—'}
            </span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Liquidation Price</span>
            <span className="modal-metric-value" style={{ color: bufferColor(position.liqBufferBp) }}>
              {position.liquidationPrice ?? '—'}
              {position.liqBufferBp !== null && (
                <span style={{ fontSize: 10.5, color: 'var(--muted)', display: 'block' }}>
                  {(position.liqBufferBp / 100).toFixed(1)}% buffer
                </span>
              )}
            </span>
          </div>
        </div>

        {/* Action Tabs */}
        <div className="position-modal-tabs">
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'protection' ? 'active' : ''}`}
            onClick={() => setActiveTab('protection')}
          >
            🛡️ SL / TP Protection
          </button>
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'partial' ? 'active' : ''}`}
            onClick={() => setActiveTab('partial')}
          >
            ✂️ Partial Exit
          </button>
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'increase' ? 'active' : ''}`}
            onClick={() => setActiveTab('increase')}
          >
            ➕ Add / Increase
          </button>
          <button
            type="button"
            className={`position-modal-tab danger-tab ${activeTab === 'close' ? 'active' : ''}`}
            onClick={() => { setActiveTab('close'); setConfirmExit(false); }}
          >
            🚨 Close Position
          </button>
        </div>

        {/* Tab Body */}
        <div className="position-modal-body">
          {/* ── Tab 1: SL/TP Protection ── */}
          {activeTab === 'protection' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
                  Set automatic bracket protection on CoinDCX.
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--panel-2)', padding: '2px 4px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--line)' }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{
                      padding: '2px 10px', fontSize: 11,
                      background: slTpMode === 'percent' ? 'var(--accent)' : 'transparent',
                      color: slTpMode === 'percent' ? '#000000' : 'var(--muted)',
                      fontWeight: slTpMode === 'percent' ? 700 : 400,
                      border: 'none',
                    }}
                    onClick={() => setSlTpMode('percent')}
                  >
                    % Percent
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{
                      padding: '2px 10px', fontSize: 11,
                      background: slTpMode === 'price' ? 'var(--accent)' : 'transparent',
                      color: slTpMode === 'price' ? '#000000' : 'var(--muted)',
                      fontWeight: slTpMode === 'price' ? 700 : 400,
                      border: 'none',
                    }}
                    onClick={() => setSlTpMode('price')}
                  >
                    Exact Price
                  </button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                {/* Stop Loss */}
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="modal-sl" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                    Stop Loss Trigger
                  </label>
                  {slTpMode === 'price' ? (
                    <>
                      <input
                        id="modal-sl"
                        inputMode="decimal"
                        value={sl}
                        onChange={(e) => setSl(e.target.value)}
                        placeholder="leave empty to clear"
                        style={{ marginTop: 6 }}
                      />
                      {sl !== '' && hasRef && sideOk && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          ≈ {triggerToPct(refPrice, Number(sl), position.side as 'long' | 'short', 'sl').toFixed(2)}% loss from entry
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <input
                        id="modal-sl"
                        inputMode="decimal"
                        value={slPct}
                        placeholder="e.g. 5"
                        onChange={(e) => setSlPct(e.target.value.replace(/[^\d.]/g, ''))}
                        style={{ marginTop: 6 }}
                      />
                      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                        {SL_PCT_CHIPS.map((v) => (
                          <button
                            key={v}
                            type="button"
                            className="btn btn-sm secondary"
                            style={{
                              flex: 1, padding: '3px 0', fontSize: 11,
                              background: slPct === String(v) ? 'var(--danger)' : 'var(--surface-3)',
                              color: slPct === String(v) ? '#fff' : 'var(--text-dim)',
                              borderColor: slPct === String(v) ? 'var(--danger)' : 'var(--line)',
                            }}
                            onClick={() => setSlPct(String(v))}
                          >
                            {v}%
                          </button>
                        ))}
                      </div>
                      {hasRef && sideOk && slPct !== '' && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Trigger: {pctToTrigger(refPrice, Number(slPct), position.side as 'long' | 'short', 'sl').toFixed(2)}
                        </div>
                      )}
                    </>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', marginTop: 12, gap: 6 }}>
                    <input
                      type="checkbox"
                      id="modal-trailing"
                      checked={trailing}
                      onChange={(e) => setTrailing(e.target.checked)}
                      style={{ width: 14, height: 14, cursor: 'pointer' }}
                    />
                    <label htmlFor="modal-trailing" style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}>
                      Auto-Trailing SL (1% step)
                    </label>
                  </div>
                </div>

                {/* Take Profit */}
                <div className="field" style={{ margin: 0 }}>
                  <label htmlFor="modal-tp" style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                    Take Profit Trigger
                  </label>
                  {slTpMode === 'price' ? (
                    <>
                      <input
                        id="modal-tp"
                        inputMode="decimal"
                        value={tp}
                        onChange={(e) => setTp(e.target.value)}
                        placeholder="leave empty to clear"
                        style={{ marginTop: 6 }}
                      />
                      {tp !== '' && hasRef && sideOk && (
                        <div className="hint" style={{ color: 'var(--ok)', fontSize: 11, marginTop: 4 }}>
                          ≈ {triggerToPct(refPrice, Number(tp), position.side as 'long' | 'short', 'tp').toFixed(2)}% gain from entry
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <input
                        id="modal-tp"
                        inputMode="decimal"
                        value={tpPct}
                        placeholder="e.g. 10"
                        onChange={(e) => setTpPct(e.target.value.replace(/[^\d.]/g, ''))}
                        style={{ marginTop: 6 }}
                      />
                      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                        {TP_PCT_CHIPS.map((v) => (
                          <button
                            key={v}
                            type="button"
                            className="btn btn-sm secondary"
                            style={{
                              flex: 1, padding: '3px 0', fontSize: 11,
                              background: tpPct === String(v) ? 'var(--ok)' : 'var(--surface-3)',
                              color: tpPct === String(v) ? '#000000' : 'var(--text-dim)',
                              borderColor: tpPct === String(v) ? 'var(--ok)' : 'var(--line)',
                              fontWeight: tpPct === String(v) ? 700 : 500,
                            }}
                            onClick={() => setTpPct(String(v))}
                          >
                            {v}%
                          </button>
                        ))}
                      </div>
                      {hasRef && sideOk && tpPct !== '' && (
                        <div className="hint" style={{ color: 'var(--ok)', fontSize: 11, marginTop: 4 }}>
                          Trigger: {pctToTrigger(refPrice, Number(tpPct), position.side as 'long' | 'short', 'tp').toFixed(2)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isProtecting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!canSaveProtection || isProtecting}
                  onClick={() => onProtection({
                    id: position.venuePositionId,
                    slp: effectiveSl || undefined,
                    tpp: effectiveTp || undefined,
                    trailing,
                  })}
                >
                  {isProtecting ? 'Updating Protection…' : 'Save Protection Rules'}
                </button>
              </div>
            </div>
          )}

          {/* ── Tab 2: Partial Exit ── */}
          {activeTab === 'partial' && (
            <div>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Safely scale out of this position by selling a portion at current market. The remainder stays open with your current leverage and protection.
              </p>

              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>Select percentage to close:</span>
                  <strong style={{ fontSize: 14, color: '#f59e0b' }}>−{reducePct}%</strong>
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  {REDUCE_PCT_CHIPS.map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      className="btn btn-sm secondary"
                      style={{
                        flex: 1,
                        minWidth: 50,
                        padding: '6px 0',
                        fontSize: 12,
                        background: reducePct === pct && !isCustomReduce ? '#f59e0b' : 'var(--surface-3)',
                        color: reducePct === pct && !isCustomReduce ? '#000000' : 'var(--text-dim)',
                        borderColor: reducePct === pct && !isCustomReduce ? '#f59e0b' : 'var(--line)',
                        fontWeight: reducePct === pct && !isCustomReduce ? 700 : 500,
                      }}
                      onClick={() => {
                        setReducePct(pct);
                        setCustomReduceInput('');
                      }}
                    >
                      −{pct}%
                    </button>
                  ))}

                  {/* Custom % Input */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1.3, minWidth: 100 }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Custom %"
                      value={customReduceInput}
                      onChange={(e) => {
                        const val = e.target.value.replace(/[^\d.]/g, '');
                        setCustomReduceInput(val);
                        const num = parseFloat(val);
                        if (!isNaN(num) && num > 0 && num < 100) {
                          setReducePct(num);
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        fontSize: 12,
                        background: isCustomReduce ? 'rgba(245, 158, 11, 0.15)' : 'var(--surface-3)',
                        borderColor: isCustomReduce ? '#f59e0b' : 'var(--line)',
                        color: isCustomReduce ? '#f59e0b' : 'var(--text)',
                        fontWeight: isCustomReduce ? 700 : 400,
                        textAlign: 'center',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>%</span>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', paddingTop: 10, borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Selling Size: </span>
                    <strong style={{ color: '#f59e0b' }}>{reduceQty}</strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Remaining Size: </span>
                    <strong style={{ color: 'var(--text)' }}>{remainQty}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Est. Margin Released: </span>
                    <strong style={{ color: '#f59e0b' }}>
                      {reduceMarginMinor ? fmtMinor(reduceMarginMinor, position.marginCurrency) : '—'}
                    </strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Est. Margin Remaining: </span>
                    <span style={{ color: 'var(--text)' }}>
                      {position.lockedMarginMinor && reduceMarginMinor
                        ? fmtMinor(String(BigInt(position.lockedMarginMinor) - BigInt(reduceMarginMinor)), position.marginCurrency)
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isAdjusting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{
                    background: '#f59e0b',
                    color: '#000000',
                    fontWeight: 700,
                    border: 'none',
                  }}
                  disabled={isAdjusting || reducePct <= 0 || reducePct >= 100}
                  onClick={() => onAdjust(position.venuePositionId, 'reduce', Math.round(reducePct * 100))}
                >
                  {isAdjusting ? 'Executing Partial Exit…' : `Close ${reducePct}% (${reduceQty} ${position.pair.split('_')[0].replace(/^[A-Z]-/, '')})`}
                </button>
              </div>
            </div>
          )}

          {/* ── Tab 3: Add / Increase ── */}
          {activeTab === 'increase' && (
            <div>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Add more size to this existing position at current market price using group capital.
              </p>

              {/* Group Funding Balance Card with Live / Manual Refresh */}
              <div
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius)',
                  padding: '10px 14px',
                  marginBottom: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Group Available Capital
                    </span>
                    <span
                      style={{
                        display: 'inline-block',
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        background: 'var(--ok)',
                        boxShadow: '0 0 6px var(--ok)',
                      }}
                      title="Auto-refreshing live data every 3s"
                    />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 16, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
                      {groupFundingCurMinor !== null ? fmtMinor(groupFundingCurMinor, position.marginCurrency) : '—'}
                    </strong>
                    {otherCurrency && groupFundingOtherMinor !== null && groupFundingOtherMinor !== '0' && (
                      <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                        ({fmtMinor(groupFundingOtherMinor, otherCurrency)})
                      </span>
                    )}
                    <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                      • {position.groupName || 'Ungrouped'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  className="btn btn-sm secondary"
                  onClick={handleManualRefresh}
                  disabled={isRefreshing}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '4px 10px',
                    fontSize: 11.5,
                    whiteSpace: 'nowrap',
                  }}
                  title="Refresh group capital and live positions"
                >
                  <span style={{ display: 'inline-block', transform: isRefreshing ? 'rotate(180deg)' : 'none', transition: 'transform 0.5s ease' }}>
                    🔄
                  </span>
                  {isRefreshing ? 'Refreshing…' : 'Refresh'}
                </button>
              </div>

              {/* Percentage Selection & Calculations */}
              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>Select percentage to add:</span>
                  <strong style={{ fontSize: 14, color: 'var(--ok)' }}>+{increasePct}%</strong>
                </div>

                {/* Chips + Custom Input */}
                <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  {INCREASE_PCT_CHIPS.map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      className="btn btn-sm secondary"
                      style={{
                        flex: 1,
                        minWidth: 54,
                        padding: '6px 0',
                        fontSize: 12,
                        background: increasePct === pct && !isCustomIncrease ? 'var(--ok)' : 'var(--surface-3)',
                        color: increasePct === pct && !isCustomIncrease ? '#000000' : 'var(--text-dim)',
                        borderColor: increasePct === pct && !isCustomIncrease ? 'var(--ok)' : 'var(--line)',
                        fontWeight: increasePct === pct && !isCustomIncrease ? 700 : 500,
                      }}
                      onClick={() => {
                        setIncreasePct(pct);
                        setCustomIncreaseInput('');
                      }}
                    >
                      +{pct}%
                    </button>
                  ))}

                  {/* Custom % Field */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1.3, minWidth: 100 }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Custom %"
                      value={customIncreaseInput}
                      onChange={(e) => {
                        const val = e.target.value.replace(/[^\d.]/g, '');
                        setCustomIncreaseInput(val);
                        const num = parseFloat(val);
                        if (!isNaN(num) && num > 0) {
                          setIncreasePct(num);
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        fontSize: 12,
                        background: isCustomIncrease ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface-3)',
                        borderColor: isCustomIncrease ? 'var(--ok)' : 'var(--line)',
                        color: isCustomIncrease ? 'var(--ok)' : 'var(--text)',
                        fontWeight: isCustomIncrease ? 700 : 400,
                        textAlign: 'center',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>%</span>
                  </div>
                </div>

                {/* Financial Breakdown */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', paddingTop: 10, borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Estimated Funds Used: </span>
                    <strong style={{ color: 'var(--ok)' }}>
                      {addMarginMinor ? fmtMinor(addMarginMinor, position.marginCurrency) : '—'}
                    </strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Adding Size: </span>
                    <strong style={{ color: 'var(--ok)' }}>+{increaseQty}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Current Margin: </span>
                    <span style={{ color: 'var(--text)' }}>
                      {position.lockedMarginMinor ? fmtMinor(position.lockedMarginMinor, position.marginCurrency) : '—'}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>New Total Size: </span>
                    <strong style={{ color: 'var(--text)' }}>{newTotalQty}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>New Est. Total Margin: </span>
                    <strong style={{ color: 'var(--text)' }}>
                      {position.lockedMarginMinor && addMarginMinor
                        ? fmtMinor(addMinors(position.lockedMarginMinor, addMarginMinor), position.marginCurrency)
                        : '—'}
                    </strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Remaining Group Fund: </span>
                    <span style={{ color: groupFundingCurMinor && addMarginMinor && BigInt(groupFundingCurMinor) < BigInt(addMarginMinor) ? 'var(--danger)' : 'var(--text)' }}>
                      {groupFundingCurMinor && addMarginMinor
                        ? (BigInt(groupFundingCurMinor) < BigInt(addMarginMinor)
                            ? `${fmtMinor(String(BigInt(groupFundingCurMinor) - BigInt(addMarginMinor)), position.marginCurrency)} (Deficit)`
                            : fmtMinor(String(BigInt(groupFundingCurMinor) - BigInt(addMarginMinor)), position.marginCurrency))
                        : (groupFundingCurMinor ? fmtMinor(groupFundingCurMinor, position.marginCurrency) : '—')}
                    </span>
                  </div>
                </div>

                {/* Warning if requested funds exceed available group capital */}
                {groupFundingCurMinor && addMarginMinor && BigInt(groupFundingCurMinor) < BigInt(addMarginMinor) && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '8px 12px',
                      background: 'rgba(240, 85, 90, 0.12)',
                      border: '1px solid var(--danger)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 12,
                      color: 'var(--danger)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span>⚠️</span>
                    <span>
                      Estimated funds needed ({fmtMinor(addMarginMinor, position.marginCurrency)}) exceed available group capital ({fmtMinor(groupFundingCurMinor, position.marginCurrency)})!
                    </span>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isAdjusting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ background: 'var(--ok)', color: '#000000', fontWeight: 700, border: 'none' }}
                  disabled={isAdjusting || increasePct <= 0}
                  onClick={() => onAdjust(position.venuePositionId, 'increase', Math.round(increasePct * 100))}
                >
                  {isAdjusting ? 'Increasing Position…' : `Add +${increasePct}% (+${increaseQty}) • Est. ${addMarginMinor ? fmtMinor(addMarginMinor, position.marginCurrency) : ''}`}
                </button>
              </div>
            </div>
          )}

          {/* ── Tab 4: Close Position (Two-Step Accidental Protection) ── */}
          {activeTab === 'close' && (
            <div>
              <div
                style={{
                  border: '1px solid rgba(240, 85, 90, 0.4)',
                  background: 'rgba(240, 85, 90, 0.08)',
                  borderRadius: 'var(--radius)',
                  padding: 16,
                  marginBottom: 16,
                }}
              >
                <h4 style={{ margin: '0 0 8px', color: 'var(--danger)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span>⚠️</span> Full Market Exit Confirmation
                </h4>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
                  Closing this position will immediately execute a market order on CoinDCX for the entire <strong>{position.quantity}</strong>.
                </p>
                <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  <li>Any attached Stop Loss or Take Profit orders will be safely cancelled first.</li>
                  <li>Estimated PnL to be realized: <strong className={pnlClass(position.unrealisedPnlMinor)}>{pnlText(position.unrealisedPnlMinor, position.marginCurrency)}</strong></li>
                  <li>Margin released: <strong>{position.lockedMarginMinor ? fmtMinor(position.lockedMarginMinor, position.marginCurrency) : '—'}</strong></li>
                </ul>
              </div>

              {!confirmExit ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isExiting}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ background: 'var(--danger)', color: '#fff', border: 'none' }}
                    onClick={() => setConfirmExit(true)}
                  >
                    Close Position at Market ⚡
                  </button>
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 12,
                    padding: 14,
                    background: 'rgba(240, 85, 90, 0.15)',
                    borderRadius: 'var(--radius)',
                    border: '1px solid var(--danger)',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', textAlign: 'right' }}>
                    🚨 Are you absolutely sure? Real money position will be closed immediately!
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-sm secondary"
                      onClick={() => setConfirmExit(false)}
                      disabled={isExiting}
                    >
                      No, Keep Position
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ background: 'var(--danger)', color: '#fff', border: 'none', fontWeight: 700 }}
                      disabled={isExiting}
                      onClick={() => onExit(position.venuePositionId, position.marginCurrency)}
                    >
                      {isExiting ? 'Closing Position Now…' : 'YES, CONFIRM MARKET EXIT'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Main Component ─── */

export function Futures() {
  const qc = useQueryClient();
  const [managingPosition, setManagingPosition] = useState<FuturesPositionRow | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // By default, cards are EXPANDED so all critical details are visible immediately.
  // collapsedGroups keeps track of cards the user explicitly minimized.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const positions = useQuery({
    queryKey: ['futures-positions'],
    queryFn: fetchFuturesPositions,
    refetchInterval: 3000,
  });

  const refreshMut = useMutation({
    mutationFn: () => refreshFuturesPositions(),
    onSuccess: (out) => {
      setMessage({
        kind: 'ok',
        text: `Re-read ${out.accounts} account${out.accounts === 1 ? '' : 's'} from the exchange — ${out.positions} open position${out.positions === 1 ? '' : 's'}.`,
      });
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  const adjustMut = useMutation({
    mutationFn: ({ id, direction, percentBp }: { id: string; direction: 'reduce' | 'increase'; percentBp: number }) =>
      adjustFuturesPosition(id, direction, percentBp),
    onSuccess: (out, { direction, percentBp }) => {
      setMessage({
        kind: 'ok',
        text: `${direction === 'reduce' ? 'Closed' : 'Added'} ${percentBp / 100}% — ${out.quantity} ${direction === 'reduce' ? 'sold' : 'bought'}${out.full ? ' (full exit via positions/exit)' : ''}.`,
      });
      setManagingPosition(null);
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  const exitMut = useMutation({
    mutationFn: ({ id, marginCurrency }: { id: string; marginCurrency: 'INR' | 'USDT' }) =>
      exitFuturesPosition(id, marginCurrency),
    onSuccess: (out) => {
      setMessage({
        kind: 'ok',
        text: `Position closed at market (cancelled ${out.cancelled.length} conditional order${out.cancelled.length === 1 ? '' : 's'}${out.venueGroupId === null ? '' : `, venue group ${out.venueGroupId}`}).`,
      });
      setManagingPosition(null);
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
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
      setMessage(failures.length > 0
        ? { kind: 'err', text: `Some legs failed — ${failures.join('; ')}` }
        : { kind: 'ok', text: 'Protection updated.' });
      setManagingPosition(null);
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  const rows = positions.data?.views ?? [];
  const hasAny = rows.length > 0;

  // Build grouped positions
  const groups = useMemo(() => buildGroups(rows), [rows]);

  // Keep managingPosition up-to-date with live polling
  const liveManagingPosition = useMemo(() => {
    if (managingPosition === null) return null;
    return rows.find((r) => r.venuePositionId === managingPosition.venuePositionId) ?? managingPosition;
  }, [rows, managingPosition]);

  // Compute total PnL across all positions
  const totalPnl = useMemo(() => {
    const byCurrency: Record<string, string> = {};
    for (const p of rows) {
      if (p.unrealisedPnlMinor !== null) {
        const cur = p.marginCurrency;
        byCurrency[cur] = byCurrency[cur] === undefined
          ? p.unrealisedPnlMinor
          : addMinors(byCurrency[cur]!, p.unrealisedPnlMinor);
      }
    }
    return byCurrency;
  }, [rows]);

  // Compute total Margin invested across all positions
  const totalMargin = useMemo(() => {
    const byCurrency: Record<string, string> = {};
    for (const p of rows) {
      if (p.lockedMarginMinor !== null && p.lockedMarginMinor !== '' && p.lockedMarginMinor !== '0') {
        const cur = p.marginCurrency;
        byCurrency[cur] = byCurrency[cur] === undefined
          ? p.lockedMarginMinor
          : addMinors(byCurrency[cur]!, p.lockedMarginMinor);
      }
    }
    return byCurrency;
  }, [rows]);

  const toggleGroupCollapse = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const collapseAll = (): void => {
    setCollapsedGroups(new Set(groups.map((g) => g.key)));
  };

  const expandAll = (): void => {
    setCollapsedGroups(new Set());
  };

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsedGroups.has(g.key));

  return (
    <div className="panel full-width-page">
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Positions</h2>
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

        {groups.length > 1 && (
          <button
            type="button"
            className="btn btn-sm secondary"
            style={{ fontSize: 11.5, padding: '3px 10px' }}
            onClick={allCollapsed ? expandAll : collapseAll}
          >
            {allCollapsed ? 'Expand All' : 'Collapse All'}
          </button>
        )}

        <button
          type="button"
          className="btn secondary btn-sm"
          style={{ marginLeft: 'auto' }}
          disabled={refreshMut.isPending}
          onClick={() => refreshMut.mutate()}
        >
          {refreshMut.isPending ? 'Reading the exchange…' : 'Sync from exchange'}
        </button>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {positions.data === undefined ? '' : `updated ${new Date(positions.data.at).toLocaleTimeString('en-IN')}`}
        </span>
      </div>

      {/* ── Summary ── */}
      {hasAny && (
        <div className="positions-summary">
          <div>
            <div className="stat-label">Unrealised PnL</div>
            <div style={{ display: 'flex', gap: 16 }}>
              {Object.entries(totalPnl).map(([cur, minor]) => (
                <span key={cur} className={`pnl-big ${pnlClass(minor)}`}>
                  {pnlText(minor, cur as 'INR' | 'USDT')}
                </span>
              ))}
              {Object.keys(totalPnl).length === 0 && (
                <span className="pnl-big muted">—</span>
              )}
            </div>
          </div>
          <div style={{ borderLeft: '1px solid var(--line)', paddingLeft: 20 }}>
            <div className="stat-label">Margin Invested</div>
            <div style={{ display: 'flex', gap: 16 }}>
              {Object.entries(totalMargin).map(([cur, minor]) => (
                <span key={cur} className="stat-value" style={{ fontWeight: 600 }}>
                  {fmtMinor(minor, cur as 'INR' | 'USDT')}
                </span>
              ))}
              {Object.keys(totalMargin).length === 0 && (
                <span className="stat-value muted">—</span>
              )}
            </div>
          </div>
          <div style={{ borderLeft: '1px solid var(--line)', paddingLeft: 20 }}>
            <div className="stat-label">Positions</div>
            <div className="stat-value">{rows.length}</div>
          </div>
          <div>
            <div className="stat-label">Groups</div>
            <div className="stat-value">{groups.length}</div>
          </div>
        </div>
      )}

      {/* ── Messages ── */}
      {message !== null && (
        <div style={{ marginBottom: 12, fontSize: 13, color: message.kind === 'ok' ? 'var(--ok)' : 'var(--danger)' }}>
          {message.text}
        </div>
      )}

      {/* ── Loading / Error / Empty ── */}
      {positions.isLoading && <p className="muted">Loading positions…</p>}
      {positions.isError && <div className="error">{(positions.error as Error).message}</div>}

      {positions.isSuccess && !hasAny && (
        <div className="empty-state">
          <p className="empty-ico">📈</p>
          <p>No open futures positions.</p>
          <p className="muted">Perpetual positions across your accounts will appear here — with mark, liquidation and unrealised PnL — while they are open.</p>
        </div>
      )}

      {/* ── Grouped Position Cards (Expanded by Default) ── */}
      {hasAny && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <h3 style={{ fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: 0 }}>
              Grouped Positions
            </h3>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              All metrics and accounts visible by default
            </span>
          </div>

          {groups.map((g) => (
            <GroupCard
              key={g.key}
              group={g}
              collapsed={collapsedGroups.has(g.key)}
              onToggle={() => toggleGroupCollapse(g.key)}
              onManage={(pos) => { setManagingPosition(pos); setMessage(null); }}
            />
          ))}
        </div>
      )}

      {/* ── Position Management Modal (Safe Execution & Bracket Controls) ── */}
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

