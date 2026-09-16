import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adjustFuturesPosition, exitFuturesPosition, fetchFuturesPositions,
  refreshFuturesPositions, setFuturesProtection, setTrailingProtection,
} from '../api.js';
import type { FuturesPositionRow } from '../api.ts';

// The Positions page — plan/phase-15 T15.11.
//
// Two-tier layout:
//   1. Summary header — total unrealised PnL, position count, last updated.
//   2. Grouped position cards — aggregated by pair+side+currency (matches how
//      group trades work). Each card expands to show per-account rows.
//
// PnL styling: green +₹ for profit, red −₹ for loss, everywhere.

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
  /** Aggregated unrealised PnL in minor units. */
  totalPnlMinor: string | null;
  /** Per-account positions in this group. */
  positions: FuturesPositionRow[];
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
        totalPnlMinor: null,
        positions: [],
      };
      map.set(key, g);
    }
    g.positions.push(p);
    g.totalQty += Number(p.quantity);
    if (p.unrealisedPnlMinor !== null) {
      g.totalPnlMinor = g.totalPnlMinor === null
        ? p.unrealisedPnlMinor
        : addMinors(g.totalPnlMinor, p.unrealisedPnlMinor);
    }
  }
  return Array.from(map.values());
}

/* ─── per-account row inside a group card ─── */

function AccountRow({ p, onExit, onEdit, onAdjust, exiting, editingId, adjusting }: {
  readonly p: FuturesPositionRow;
  readonly onExit: (venuePositionId: string, marginCurrency: 'INR' | 'USDT') => void;
  readonly onEdit: (venuePositionId: string) => void;
  readonly onAdjust: (venuePositionId: string, direction: 'reduce' | 'increase', percentBp: number) => void;
  readonly exiting: string | null;
  readonly editingId: string | null;
  readonly adjusting: string | null;
}) {
  return (
    <tr>
      <td>
        <strong>{p.accountName}</strong>
      </td>
      <td className="mono">{p.quantity}</td>
      <td>{p.leverage === null ? <span className="muted">—</span> : `${p.leverage}×`}</td>
      <td className="mono">{p.avgEntryPrice ?? <span className="muted">—</span>}</td>
      <td className="mono">{p.markPrice ?? <span className="muted">—</span>}</td>
      <td className="mono" style={{ color: bufferColor(p.liqBufferBp) }}>
        {p.liquidationPrice ?? <span className="muted">—</span>}
        {p.liqBufferBp !== null && (
          <span className="muted" style={{ display: 'block', fontSize: 10.5 }}>
            {(p.liqBufferBp / 100).toFixed(2)}% buffer
          </span>
        )}
      </td>
      <td className={`mono ${pnlClass(p.unrealisedPnlMinor)}`} style={{ fontWeight: 600 }}>
        {pnlText(p.unrealisedPnlMinor, p.marginCurrency)}
      </td>
      <td>
        {p.stopLossTrigger === null && p.takeProfitTrigger === null
          ? <span className="muted" style={{ fontSize: 11.5 }}>none</span>
          : (
              <>
                {p.stopLossTrigger !== null && <span className="badge skipped" style={{ fontSize: 10 }}>SL {p.stopLossTrigger}</span>}
                {p.takeProfitTrigger !== null && <span className="badge planned" style={{ fontSize: 10, marginLeft: 3 }}>TP {p.takeProfitTrigger}</span>}
              </>
            )}
        {p.side !== 'flat' && (
          <button
            className="btn btn-sm secondary"
            style={{ marginLeft: 6, fontSize: 10.5, padding: '1px 7px' }}
            onClick={() => onEdit(p.venuePositionId)}
            disabled={editingId === p.venuePositionId}
          >
            Set
          </button>
        )}
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {p.side !== 'flat' && (
          <>
            {[2500, 5000, 7500, 10000].map((bp) => (
              <button
                key={`r${bp}`}
                className="btn btn-sm secondary"
                style={{ marginRight: 3, fontSize: 10.5, padding: '1px 6px' }}
                disabled={adjusting !== null || exiting !== null}
                title={bp === 10000 ? 'Close the whole position' : `Close ${bp / 100}% of the position`}
                onClick={() => (bp === 10000
                  ? onExit(p.venuePositionId, p.marginCurrency)
                  : onAdjust(p.venuePositionId, 'reduce', bp))}
              >
                −{bp / 100}%
              </button>
            ))}
          </>
        )}
        <button
          className="btn btn-sm"
          style={{ background: 'var(--danger)', color: '#fff', border: 'none', fontSize: 10.5, padding: '2px 8px' }}
          disabled={exiting !== null || adjusting !== null || p.side === 'flat'}
          onClick={() => onExit(p.venuePositionId, p.marginCurrency)}
        >
          {exiting === p.venuePositionId ? 'Exiting…' : 'Close'}
        </button>
      </td>
    </tr>
  );
}

/* ─── group card ─── */

function GroupCard({ group, expanded, onToggle, onExit, onEdit, onAdjust, exiting, editingId, adjusting }: {
  readonly group: PositionGroup;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onExit: (venuePositionId: string, marginCurrency: 'INR' | 'USDT') => void;
  readonly onEdit: (venuePositionId: string) => void;
  readonly onAdjust: (venuePositionId: string, direction: 'reduce' | 'increase', percentBp: number) => void;
  readonly exiting: string | null;
  readonly editingId: string | null;
  readonly adjusting: string | null;
}) {
  const sideColor = group.side === 'long' ? 'var(--ok)' : group.side === 'short' ? 'var(--danger)' : 'var(--text-dim)';

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

        {/* Aggregated stats */}
        <span className="card-meta" style={{ marginLeft: 8 }}>
          Qty <strong style={{ color: 'var(--text)' }}>{group.totalQty.toFixed(4).replace(/\.?0+$/, '')}</strong>
        </span>
        <span className="card-meta">
          {group.positions.length} account{group.positions.length > 1 ? 's' : ''}
        </span>

        {/* PnL */}
        <span className={`card-pnl ${pnlClass(group.totalPnlMinor)}`}>
          {pnlText(group.totalPnlMinor, group.marginCurrency)}
        </span>

        {/* Expand chevron */}
        <span className={`expand-icon ${expanded ? 'open' : ''}`}>▼</span>
      </div>

      {expanded && (
        <div className="position-card-body">
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th>Lev</th>
                <th style={{ textAlign: 'right' }}>Entry</th>
                <th style={{ textAlign: 'right' }}>Mark</th>
                <th style={{ textAlign: 'right' }}>Liquidation</th>
                <th style={{ textAlign: 'right' }}>PnL</th>
                <th>Protection</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {group.positions.map((p) => (
                <AccountRow
                  key={`${p.accountId}-${p.pair}-${p.marginCurrency}`}
                  p={p}
                  exiting={exiting}
                  editingId={editingId}
                  adjusting={adjusting}
                  onExit={onExit}
                  onEdit={onEdit}
                  onAdjust={onAdjust}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─── main component ─── */

export function Futures() {
  const qc = useQueryClient();
  const [exiting, setExiting] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const positions = useQuery({ queryKey: ['futures-positions'], queryFn: fetchFuturesPositions });

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
    onMutate: ({ id }) => { setAdjusting(id); setMessage(null); },
    onSuccess: (out, { direction, percentBp }) => {
      setMessage({
        kind: 'ok',
        text: `${direction === 'reduce' ? 'Closed' : 'Added'} ${percentBp / 100}% — ${out.quantity} ${direction === 'reduce' ? 'sold' : 'bought'}${out.full ? ' (full exit via positions/exit)' : ''}.`,
      });
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
    onSettled: () => setAdjusting(null),
  });

  const exitMut = useMutation({
    mutationFn: ({ id, marginCurrency }: { id: string; marginCurrency: 'INR' | 'USDT' }) =>
      exitFuturesPosition(id, marginCurrency),
    onMutate: ({ id }) => { setExiting(id); setMessage(null); },
    onSuccess: (out) => {
      setMessage({
        kind: 'ok',
        text: `Position closed at market (cancelled ${out.cancelled.length} conditional order${out.cancelled.length === 1 ? '' : 's'}${out.venueGroupId === null ? '' : `, venue group ${out.venueGroupId}`}).`,
      });
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
    onSettled: () => setExiting(null),
  });

  const protMut = useMutation({
    mutationFn: async (args: { readonly id: string; readonly slp?: string | undefined; readonly tpp?: string | undefined; readonly trailing?: boolean | undefined }) => {
      const body: { stopLossPrice?: string; takeProfitPrice?: string; moveExisting: boolean } = { moveExisting: true };
      if (args.slp !== undefined && args.slp !== '') body.stopLossPrice = args.slp;
      if (args.tpp !== undefined && args.tpp !== '') body.takeProfitPrice = args.tpp;
      
      const out = await setFuturesProtection(args.id, body);
      
      if (args.trailing && args.slp) {
         // Enable trailing SL via separate API call
         await setTrailingProtection(args.id, {
           enable: true,
           currentSlPrice: args.slp,
           stepBp: '100', // Hardcode 1% step for now
           distanceBp: '100' // Hardcode 1% distance for now to avoid complex math in UI
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
      setEditingId(null);
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  const rows = positions.data?.views ?? [];
  const hasAny = rows.length > 0;
  const editingRow = editingId === null ? undefined : rows.find((r) => r.venuePositionId === editingId);

  // Build grouped positions
  const groups = useMemo(() => buildGroups(rows), [rows]);

  // Compute total PnL across all positions (for the summary header)
  const totalPnl = useMemo(() => {
    // Group by currency for separate totals
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

  const toggleGroup = (key: string): void => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="panel full-width-page">
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Positions</h2>
        <button
          className="btn secondary btn-sm"
          style={{ marginLeft: 'auto' }}
          disabled={refreshMut.isPending}
          onClick={() => refreshMut.mutate()}
        >
          {refreshMut.isPending ? 'Reading the exchange…' : 'Refresh from exchange'}
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

      {/* ── Protection editor ── */}
      {editingId !== null && (
        <ProtectionEditor
          onCancel={() => setEditingId(null)}
          onSubmit={(slp, tpp, trailing) => protMut.mutate({ id: editingId, slp, tpp, trailing })}
          pending={protMut.isPending}
          existing={editingRow}
        />
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

      {/* ── Grouped position cards ── */}
      {hasAny && (
        <div>
          <h3 style={{ fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', marginBottom: 10, marginTop: 0 }}>
            Grouped Positions
          </h3>
          {groups.map((g) => (
            <GroupCard
              key={g.key}
              group={g}
              expanded={expandedGroups.has(g.key)}
              onToggle={() => toggleGroup(g.key)}
              exiting={exiting}
              editingId={editingId}
              adjusting={adjusting}
              onExit={(id, mc) => exitMut.mutate({ id, marginCurrency: mc })}
              onEdit={(id) => { setEditingId(id); setMessage(null); }}
              onAdjust={(id, direction, percentBp) => adjustMut.mutate({ id, direction, percentBp })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ProtectionEditorProps {
  readonly onCancel: () => void;
  readonly onSubmit: (stopLossPrice?: string, takeProfitPrice?: string, trailing?: boolean) => void;
  readonly pending: boolean;
  readonly existing: FuturesPositionRow | undefined;
}

/** Common SL percentage distances for quick-select chips. */
const SL_PCT_CHIPS = [1, 2, 5, 10] as const;
/** TP chips include wider targets (15%, 20%) since take-profits are typically further out. */
const TP_PCT_CHIPS = [1, 2, 5, 10, 15, 20] as const;

type ProtectionMode = 'price' | 'percent';

/**
 * Compute the absolute trigger price from a percentage offset.
 * - SL on Long / TP on Short → price moves DOWN from reference
 * - TP on Long / SL on Short → price moves UP from reference
 */
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

function ProtectionEditor({ onCancel, onSubmit, pending, existing }: ProtectionEditorProps) {
  const [sl, setSl] = useState(existing?.stopLossTrigger ?? '');
  const [tp, setTp] = useState(existing?.takeProfitTrigger ?? '');
  const [slTpMode, setSlTpMode] = useState<ProtectionMode>('percent');
  const [slPct, setSlPct] = useState('');
  const [tpPct, setTpPct] = useState('');
  const [trailing, setTrailing] = useState(false);

  const valid = /^\d+(\.\d+)?$/;
  const pctValid = (p: string): boolean => p === '' || (valid.test(p) && Number(p) > 0 && Number(p) <= 100);

  const refPrice = existing?.avgEntryPrice !== null && existing?.avgEntryPrice !== undefined
    ? Number(existing.avgEntryPrice)
    : NaN;
  const hasRef = Number.isFinite(refPrice) && refPrice > 0;
  const positionSide = existing?.side ?? 'long';
  const sideOk = positionSide === 'long' || positionSide === 'short';

  // Compute effective absolute prices from percent when needed.
  const effectiveSl = slTpMode === 'percent' && slPct !== '' && hasRef && sideOk
    ? pctToTrigger(refPrice, Number(slPct), positionSide as 'long' | 'short', 'sl').toFixed(8).replace(/\.?0+$/, '')
    : sl;
  const effectiveTp = slTpMode === 'percent' && tpPct !== '' && hasRef && sideOk
    ? pctToTrigger(refPrice, Number(tpPct), positionSide as 'long' | 'short', 'tp').toFixed(8).replace(/\.?0+$/, '')
    : tp;

  const slOk = slTpMode === 'price' ? (sl === '' || valid.test(sl)) : pctValid(slPct);
  const tpOk = slTpMode === 'price' ? (tp === '' || valid.test(tp)) : pctValid(tpPct);
  const hasSomething = (slTpMode === 'price' ? sl !== '' : slPct !== '') || (slTpMode === 'price' ? tp !== '' : tpPct !== '');
  const canSubmit = slOk && tpOk && hasSomething;

  const handleSubmit = (): void => {
    onSubmit(effectiveSl || undefined, effectiveTp || undefined, trailing);
  };

  const pillStyle = (active: boolean) => ({
    padding: '3px 12px', fontSize: 11, fontWeight: 600,
    background: active ? 'var(--accent)' : 'var(--surface-3)',
    color: active ? '#fff' : 'var(--text-dim)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
    borderRadius: 'var(--radius-pill)',
    cursor: 'pointer',
  });

  const chipStyle = (active: boolean) => ({
    flex: 1, padding: '4px 0', fontSize: 11.5, fontWeight: active ? 700 : 500,
    background: active ? 'var(--accent)' : 'var(--surface-3)',
    color: active ? '#fff' : 'var(--muted)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
    borderRadius: 'var(--radius-pill)',
    cursor: 'pointer',
  } as const);

  return (
    <div
      style={{
        marginBottom: 16, padding: 16, borderRadius: 'var(--radius-lg)',
        border: '1px solid var(--line-strong)',
        background: 'linear-gradient(180deg, var(--panel-2) 0%, var(--bg-2) 100%)',
        boxShadow: 'var(--shadow-md)',
      }}
    >
      <div style={{ marginBottom: 12, fontSize: 13, display: 'flex', alignItems: 'center' }}>
        <strong style={{ color: 'var(--text)' }}>Set protection</strong>
        {existing !== undefined && (
          <span className="badge planned" style={{ marginLeft: 10, fontSize: 11 }}>
            {existing.accountName} · {existing.pair}
          </span>
        )}
      </div>
      {/* Single Price / % toggle for both SL and TP */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Mode
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button type="button" className="btn btn-sm" aria-pressed={slTpMode === 'percent'} style={pillStyle(slTpMode === 'percent')} onClick={() => setSlTpMode('percent')}>%</button>
          <button type="button" className="btn btn-sm" aria-pressed={slTpMode === 'price'} style={pillStyle(slTpMode === 'price')} onClick={() => setSlTpMode('price')}>Price</button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── Stop-loss ── */}
        <div className="field" style={{ margin: 0, minWidth: 200, flex: 1 }}>
          <label htmlFor="edit-sl" style={{ marginBottom: 6 }}>Stop-loss trigger</label>
          {slTpMode === 'price' ? (
            <>
              <input id="edit-sl" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="leave empty to skip" />
              {sl !== '' && hasRef && sideOk && (
                <div className="hint" style={{ marginTop: 4, color: 'var(--accent)' }}>
                  ≈ {triggerToPct(refPrice, Number(sl), positionSide as 'long' | 'short', 'sl').toFixed(2)}% from entry
                </div>
              )}
            </>
          ) : (
            <>
              <input
                id="edit-sl"
                inputMode="decimal"
                value={slPct}
                placeholder="e.g. 5"
                disabled={!hasRef || !sideOk}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./, '$1');
                  if (v === '' || Number(v) <= 100) setSlPct(v);
                }}
              />
              <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                {SL_PCT_CHIPS.map((v) => (
                  <button
                    key={v} type="button" className="btn btn-sm"
                    aria-pressed={slPct !== '' && Number(slPct) === v}
                    disabled={!hasRef || !sideOk}
                    style={chipStyle(slPct !== '' && Number(slPct) === v)}
                    onClick={() => setSlPct(String(v))}
                  >{v}%</button>
                ))}
              </div>
              {hasRef && sideOk && slPct !== '' && pctValid(slPct) && (
                <div className="hint" style={{ marginTop: 4, color: 'var(--accent)' }}>
                  ≈ {pctToTrigger(refPrice, Number(slPct), positionSide as 'long' | 'short', 'sl').toFixed(2)} trigger price
                </div>
              )}
            </>
          )}
          <div style={{ display: 'flex', alignItems: 'center', marginTop: 10 }}>
            <input type="checkbox" id="edit-tsl" checked={trailing} onChange={(e) => setTrailing(e.target.checked)} />
            <label htmlFor="edit-tsl" style={{ marginLeft: 6, fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}>Make Trailing (1% step)</label>
          </div>
        </div>

        {/* ── Take-profit ── */}
        <div className="field" style={{ margin: 0, minWidth: 200, flex: 1 }}>
          <label htmlFor="edit-tp" style={{ marginBottom: 6 }}>Take-profit trigger</label>
          {slTpMode === 'price' ? (
            <>
              <input id="edit-tp" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="leave empty to skip" />
              {tp !== '' && hasRef && sideOk && (
                <div className="hint" style={{ marginTop: 4, color: 'var(--accent)' }}>
                  ≈ {triggerToPct(refPrice, Number(tp), positionSide as 'long' | 'short', 'tp').toFixed(2)}% from entry
                </div>
              )}
            </>
          ) : (
            <>
              <input
                id="edit-tp"
                inputMode="decimal"
                value={tpPct}
                placeholder="e.g. 5"
                disabled={!hasRef || !sideOk}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./, '$1');
                  if (v === '' || Number(v) <= 100) setTpPct(v);
                }}
              />
              <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                {TP_PCT_CHIPS.map((v) => (
                  <button
                    key={v} type="button" className="btn btn-sm"
                    aria-pressed={tpPct !== '' && Number(tpPct) === v}
                    disabled={!hasRef || !sideOk}
                    style={chipStyle(tpPct !== '' && Number(tpPct) === v)}
                    onClick={() => setTpPct(String(v))}
                  >{v}%</button>
                ))}
              </div>
              {hasRef && sideOk && tpPct !== '' && pctValid(tpPct) && (
                <div className="hint" style={{ marginTop: 4, color: 'var(--accent)' }}>
                  ≈ {pctToTrigger(refPrice, Number(tpPct), positionSide as 'long' | 'short', 'tp').toFixed(2)} trigger price
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Actions ── */}
        <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-end', flexShrink: 0, paddingBottom: 4 }}>
          <button className="btn btn-sm" disabled={!canSubmit || pending} onClick={handleSubmit}>
            {pending ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-sm secondary" onClick={onCancel} disabled={pending}>Cancel</button>
        </div>
      </div>
      <p className="sub muted" style={{ marginTop: 12, marginBottom: 0, fontSize: 12 }}>
        The venue does not allow &ldquo;move&rdquo; on a live SL/TP — the server cancels the current leg and creates a fresh one. There is a brief window while the swap happens where the position is unprotected.
      </p>
    </div>
  );
}

