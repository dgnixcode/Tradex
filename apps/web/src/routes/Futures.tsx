import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adjustFuturesPosition, exitFuturesPosition, fetchFuturesPositions,
  refreshFuturesPositions, setFuturesProtection,
} from '../api.ts';
import type { FuturesPositionRow } from '../api.ts';

// The Positions page — plan/phase-15 T15.11.
//
// Every open perpetual futures position across the tenant's accounts, at mark.
// Mark price, liquidation and unrealised PnL are legitimate here — the §6a
// carve-out lives in this subdirectory outside the 07-no-mark-to-market scan
// (spot books never landed on this page; the spot Positions surface was
// removed once the product settled on futures-only).
//
// Two write actions per row:
//   * Set / edit an SL and/or TP on an open position. The venue does NOT allow
//     "move" — moving a live SL/TP is cancel-then-create (research/04 F12),
//     which the route documents and the customer notices as a brief
//     unprotected window.
//   * Close (hard exit): the server cancels every conditional attached to the
//     position first, then calls positions/exit, then reconciles to zero.

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

function fmtSignedMinor(minor: string, quote: 'INR' | 'USDT'): string {
  return minor.startsWith('-') ? fmtMinor(minor, quote) : `+${fmtMinor(minor, quote)}`;
}

function bufferColor(bp: number | null): string | undefined {
  if (bp === null) return undefined;
  if (bp < 200) return 'var(--danger)';
  if (bp < 1000) return '#c48a00';
  return 'var(--ok)';
}

function Row({ p, onExit, onEdit, onAdjust, exiting, editingId, adjusting }: {
  readonly p: FuturesPositionRow;
  readonly onExit: (venuePositionId: string, marginCurrency: 'INR' | 'USDT') => void;
  readonly onEdit: (venuePositionId: string) => void;
  /** Partial close (reduce) or add (increase) by basis points of the position. */
  readonly onAdjust: (venuePositionId: string, direction: 'reduce' | 'increase', percentBp: number) => void;
  readonly exiting: string | null;
  readonly editingId: string | null;
  readonly adjusting: string | null;
}) {
  const pnl = p.unrealisedPnlMinor;
  return (
    <tr>
      <td>
        {p.accountName}
        <span className="muted" style={{ display: 'block', fontSize: 11 }}>{p.pair}</span>
      </td>
      <td>
        <span className={`badge ${p.side === 'long' ? 'planned' : 'skipped'}`}>{p.side}</span>
      </td>
      <td className="mono">{p.quantity}</td>
      <td>{p.leverage === null ? <span className="muted">—</span> : `${p.leverage}×`}</td>
      <td className="mono">{p.avgEntryPrice ?? <span className="muted">—</span>}</td>
      <td className="mono">{p.markPrice ?? <span className="muted">—</span>}</td>
      <td className="mono" style={{ color: bufferColor(p.liqBufferBp) }}>
        {p.liquidationPrice ?? <span className="muted">—</span>}
        {p.liqBufferBp !== null && (
          <span className="muted" style={{ display: 'block', fontSize: 11 }}>
            {(p.liqBufferBp / 100).toFixed(2)}% buffer
          </span>
        )}
      </td>
      <td className="mono" style={{ color: pnl !== null && !pnl.startsWith('-') ? 'var(--ok)' : pnl?.startsWith('-') ? 'var(--danger)' : undefined }}>
        {pnl === null ? <span className="muted">—</span> : fmtSignedMinor(pnl, p.marginCurrency)}
      </td>
      <td>
        {p.stopLossTrigger === null && p.takeProfitTrigger === null
          ? <span className="muted">none</span>
          : (
              <>
                {p.stopLossTrigger !== null && <span className="badge skipped" style={{ fontSize: 10.5 }}>SL {p.stopLossTrigger}</span>}
                {p.takeProfitTrigger !== null && <span className="badge planned" style={{ fontSize: 10.5, marginLeft: 4 }}>TP {p.takeProfitTrigger}</span>}
              </>
            )}
        {p.side !== 'flat' && (
          <button
            className="btn btn-sm secondary"
            style={{ marginLeft: 8, fontSize: 11, padding: '2px 8px' }}
            onClick={() => onEdit(p.venuePositionId)}
            disabled={editingId === p.venuePositionId}
          >
            Set
          </button>
        )}
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {/* Partial close, and add. `Close` stays the full exit — it goes through
            positions/exit, which is atomic and cancels the conditionals first;
            these slice the position with an ordinary order instead. */}
        {p.side !== 'flat' && (
          <>
            {[2500, 5000, 7500, 10000].map((bp) => (
              <button
                key={`r${bp}`}
                className="btn btn-sm secondary"
                style={{ marginRight: 4, fontSize: 11, padding: '2px 7px' }}
                disabled={adjusting !== null || exiting !== null}
                title={bp === 10000 ? 'Close the whole position' : `Close ${bp / 100}% of the position`}
                onClick={() => (bp === 10000
                  ? onExit(p.venuePositionId, p.marginCurrency)
                  : onAdjust(p.venuePositionId, 'reduce', bp))}
              >
                −{bp / 100}%
              </button>
            ))}
            {[2500, 5000].map((bp) => (
              <button
                key={`a${bp}`}
                className="btn btn-sm ghost"
                style={{ marginRight: 4, fontSize: 11, padding: '2px 7px' }}
                disabled={adjusting !== null || exiting !== null}
                title={`Add ${bp / 100}% more to this position`}
                onClick={() => onAdjust(p.venuePositionId, 'increase', bp)}
              >
                +{bp / 100}%
              </button>
            ))}
          </>
        )}
        <button
          className="btn btn-sm"
          style={{ background: 'var(--danger)', color: '#fff', border: 'none' }}
          disabled={exiting !== null || adjusting !== null || p.side === 'flat'}
          onClick={() => onExit(p.venuePositionId, p.marginCurrency)}
        >
          {exiting === p.venuePositionId ? 'Exiting…' : adjusting !== null ? 'Working…' : 'Close all'}
        </button>
      </td>
    </tr>
  );
}

export function Futures() {
  const qc = useQueryClient();
  const [exiting, setExiting] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const positions = useQuery({ queryKey: ['futures-positions'], queryFn: fetchFuturesPositions });

  // The mirror refreshes after a fan-out and after an exit. Neither covers a
  // position changed anywhere else — closed from the exchange's own app, or left
  // over from a trade whose leg failed after the venue had already opened it. This
  // is the way to ask the venue again.
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
    mutationFn: (args: { readonly id: string; readonly slp?: string | undefined; readonly tpp?: string | undefined }) => {
      const body: { stopLossPrice?: string; takeProfitPrice?: string; moveExisting: boolean } = { moveExisting: true };
      if (args.slp !== undefined && args.slp !== '') body.stopLossPrice = args.slp;
      if (args.tpp !== undefined && args.tpp !== '') body.takeProfitPrice = args.tpp;
      return setFuturesProtection(args.id, body);
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

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 18 }}>
        Open perpetual futures positions across your accounts, at mark. Close hard-exits the position at market — every attached stop-loss
        or take-profit is cancelled first so a stale trigger can never open an opposite position after exit.
      </p>

      {message !== null && (
        <div style={{ marginBottom: 12, fontSize: 13, color: message.kind === 'ok' ? 'var(--ok)' : 'var(--danger)' }}>
          {message.text}
        </div>
      )}

      {editingId !== null && (
        <ProtectionEditor
          onCancel={() => setEditingId(null)}
          onSubmit={(slp, tpp) => protMut.mutate({ id: editingId, slp, tpp })}
          pending={protMut.isPending}
          existing={editingRow}
        />
      )}

      {positions.isLoading && <p className="muted">Loading positions…</p>}
      {positions.isError && <div className="error">{(positions.error as Error).message}</div>}

      {positions.isSuccess && !hasAny && (
        <div className="empty-state">
          <p className="empty-ico">📈</p>
          <p>No open futures positions.</p>
          <p className="muted">Perpetual positions across your accounts will appear here — with mark, liquidation and unrealised PnL — while they are open.</p>
        </div>
      )}

      {hasAny && (
        <table>
          <thead>
            <tr>
              <th>Account · Pair</th><th>Side</th>
              <th style={{ textAlign: 'right' }}>Qty</th><th>Leverage</th>
              <th style={{ textAlign: 'right' }}>Avg entry</th><th style={{ textAlign: 'right' }}>Mark</th>
              <th style={{ textAlign: 'right' }}>Liquidation</th><th style={{ textAlign: 'right' }}>Unrealised</th>
              <th>Protection</th><th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <Row
                key={`${p.accountId}-${p.pair}-${p.marginCurrency}`}
                p={p}
                exiting={exiting}
                editingId={editingId}
                onExit={(id, mc) => exitMut.mutate({ id, marginCurrency: mc })}
                onAdjust={(id, direction, percentBp) => adjustMut.mutate({ id, direction, percentBp })}
                adjusting={adjusting}
                onEdit={(id) => { setEditingId(id); setMessage(null); }}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface ProtectionEditorProps {
  readonly onCancel: () => void;
  readonly onSubmit: (stopLossPrice?: string, takeProfitPrice?: string) => void;
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
function pctToTrigger(refPrice: number, pct: number, positionSide: 'long' | 'short', leg: 'sl' | 'tp'): number {
  const down = (positionSide === 'long' && leg === 'sl') || (positionSide === 'short' && leg === 'tp');
  return down ? refPrice * (1 - pct / 100) : refPrice * (1 + pct / 100);
}

/** Reverse: compute the percentage distance from entry to trigger price. */
function triggerToPct(refPrice: number, triggerPrice: number, positionSide: 'long' | 'short', leg: 'sl' | 'tp'): number {
  const down = (positionSide === 'long' && leg === 'sl') || (positionSide === 'short' && leg === 'tp');
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
    onSubmit(effectiveSl || undefined, effectiveTp || undefined);
  };

  const pillStyle = (active: boolean) => ({
    padding: '2px 10px', fontSize: 11,
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-dim)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
  });

  const chipStyle = (active: boolean) => ({
    flex: 1, padding: '4px 0', fontSize: 11.5, fontWeight: active ? 600 : 500,
    background: active ? 'var(--accent-soft)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-dim)',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
    borderRadius: 'var(--radius-pill)',
  } as const);

  return (
    <div
      style={{
        marginBottom: 14, padding: 12, borderRadius: 10,
        border: '1px solid var(--border, rgba(0,0,0,0.12))',
        background: 'var(--panel-bg, #fafafa)',
      }}
    >
      <div style={{ marginBottom: 8, fontSize: 13 }}>
        <strong>Set protection</strong>
        {existing !== undefined && (
          <span className="muted" style={{ marginLeft: 8 }}>
            {existing.accountName} · {existing.pair}
          </span>
        )}
      </div>
      {/* Single Price / % toggle for both SL and TP */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Mode
        </span>
        <div style={{ display: 'flex', gap: 3 }}>
          <button type="button" className="btn btn-sm" aria-pressed={slTpMode === 'percent'} style={pillStyle(slTpMode === 'percent')} onClick={() => setSlTpMode('percent')}>%</button>
          <button type="button" className="btn btn-sm" aria-pressed={slTpMode === 'price'} style={pillStyle(slTpMode === 'price')} onClick={() => setSlTpMode('price')}>Price</button>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* ── Stop-loss ── */}
        <div className="field" style={{ margin: 0, minWidth: 180, flex: 1 }}>
          <label htmlFor="edit-sl" style={{ marginBottom: 5 }}>Stop-loss trigger</label>
          {slTpMode === 'price' ? (
            <>
              <input id="edit-sl" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} placeholder="leave empty to skip" />
              {sl !== '' && hasRef && sideOk && (
                <div className="hint" style={{ marginTop: 4 }}>
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
              <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
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
                <div className="hint" style={{ marginTop: 4 }}>
                  ≈ {pctToTrigger(refPrice, Number(slPct), positionSide as 'long' | 'short', 'sl').toFixed(2)} trigger price
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Take-profit ── */}
        <div className="field" style={{ margin: 0, minWidth: 180, flex: 1 }}>
          <label htmlFor="edit-tp" style={{ marginBottom: 5 }}>Take-profit trigger</label>
          {slTpMode === 'price' ? (
            <>
              <input id="edit-tp" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} placeholder="leave empty to skip" />
              {tp !== '' && hasRef && sideOk && (
                <div className="hint" style={{ marginTop: 4 }}>
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
              <div style={{ display: 'flex', gap: 4, marginTop: 5 }}>
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
                <div className="hint" style={{ marginTop: 4 }}>
                  ≈ {pctToTrigger(refPrice, Number(tpPct), positionSide as 'long' | 'short', 'tp').toFixed(2)} trigger price
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Actions ── */}
        <div style={{ display: 'flex', gap: 8, alignSelf: 'flex-end', flexShrink: 0 }}>
          <button className="btn btn-sm" disabled={!canSubmit || pending} onClick={handleSubmit}>
            {pending ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-sm secondary" onClick={onCancel} disabled={pending}>Cancel</button>
        </div>
      </div>
      <p className="sub muted" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
        The venue does not allow &ldquo;move&rdquo; on a live SL/TP — the server cancels the current leg and creates a fresh one. There is a brief window while the swap happens where the position is unprotected.
      </p>
    </div>
  );
}
