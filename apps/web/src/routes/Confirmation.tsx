import { useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { confirmTrade, fetchKillSwitchStatus, fetchTrade } from '../api.ts';
import type { PreviewResult, PreviewRow } from '../api.ts';
import { Countdown } from '../components/Countdown.tsx';

// The confirmation screen (T04.8 / 21 F3). The per-account preview table renders
// the persisted child_order rows one-for-one (U2): what the customer sees is
// exactly what was planned. Skipped rows show their reason and remedy in the same
// table, greyed. A countdown ties to the server's expiry. The acknowledgement
// checkbox appears ONLY when at least one account was skipped — so a customer
// cannot confirm a partial fan-out without noticing the gaps.
//
// Confirm is the ONE send-authorising action in the app, and this screen never
// performs a send — it hands the preview token to the server, which decides
// (rung-0 dry run, or a real fan-out behind the capability-gated engine). When
// the response says `dryRun:false` the fan-out already happened, so this screen
// hands the operator to the live-progress screen for that trade; a `dryRun:true`
// response (local dev, no engine) is recorded and stays here.

export function Confirmation() {
  const { groupTradeId = '' } = useParams();
  const navigate = useNavigate();

  const killSwitchQuery = useQuery({
    queryKey: ['kill-switch'],
    queryFn: fetchKillSwitchStatus,
    refetchInterval: 3000,
  });
  const isHalted = Boolean(killSwitchQuery.data?.active);

  const trade = useQuery({
    queryKey: ['trade', groupTradeId],
    queryFn: () => fetchTrade(groupTradeId),
    // The plan is fixed once previewed; do not refetch and re-order under the user.
    staleTime: Infinity,
  });

  const [expired, setExpired] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const onExpire = useCallback(() => setExpired(true), []);

  const confirm = useMutation({
    mutationFn: (result: PreviewResult) => confirmTrade(result.groupTradeId, result.previewToken),
    // A real send navigates to the live-progress screen, where the SSE stream
    // reports each leg as the worker settles it. A dry run (no engine wired)
    // stays here with the recorded-plan confirmation below.
    onSuccess: (data, result) => {
      try {
        localStorage.removeItem('tradex_ticket_draft');
      } catch {}
      if (data.dryRun === false) navigate(`/app/trades/${result.groupTradeId}/progress`);
    },
  });

  if (trade.isLoading) return <div className="panel">Loading the plan…</div>;
  if (trade.isError) return <div className="panel error">{(trade.error as Error).message}</div>;
  const result = trade.data;
  if (result === undefined) return <div className="panel">No plan found.</div>;

  const skippedCount = result.rows.filter((r: PreviewRow) => r.state === 'skipped').length;
  const plannedCount = result.rows.filter((r: PreviewRow) => r.state === 'planned').length;
  const hasSkips = skippedCount > 0;
  const confirmed = confirm.isSuccess;

  const canConfirm = !expired && !isHalted && plannedCount > 0 && (!hasSkips || acknowledged) && !confirmed;

  const draft = (() => {
    try {
      const raw = localStorage.getItem('tradex_ticket_draft');
      return raw ? (JSON.parse(raw) as { leverage?: string; side?: string; asset?: string; orderType?: string; marginMode?: string }) : null;
    } catch {
      return null;
    }
  })();

  const leverage = result.leverage ?? draft?.leverage ?? null;
  const side = result.side ?? draft?.side ?? null;
  const asset = result.asset ?? draft?.asset ?? null;
  const orderType = result.orderType ?? draft?.orderType ?? null;
  const marginMode = result.positionMarginType ?? draft?.marginMode ?? null;

  return (
    <div className="panel full-width-page">
      {isHalted && (
        <div
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid var(--danger)',
            borderRadius: 6,
            padding: '12px 16px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span style={{ width: 10, height: 10, borderRadius: '50%', backgroundColor: 'var(--danger)', flexShrink: 0 }} />
          <div>
            <strong style={{ color: 'var(--danger)', fontSize: 13, textTransform: 'uppercase' }}>
              EMERGENCY KILL SWITCH ACTIVE — Order Confirmation Blocked
            </strong>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
              The platform is in Read-Only Mode. Order execution is disabled across all accounts.
              {killSwitchQuery.data?.reason ? ` (${killSwitchQuery.data.reason})` : ''}
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Confirm — {plannedCount} to place, {skippedCount} skipped</h2>
          {leverage && (
            <span
              className="pos-lev-pill"
              style={{
                fontSize: 12,
                padding: '3px 9px',
                borderRadius: 4,
                fontWeight: 700,
                letterSpacing: '0.02em',
              }}
            >
              {leverage}× Leverage
            </span>
          )}
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            fontWeight: 600,
            color: '#34d399',
            background: 'rgba(52, 211, 153, 0.1)',
            padding: '3px 8px',
            borderRadius: 4,
            border: '1px solid rgba(52, 211, 153, 0.25)',
          }}>
            <svg viewBox="0 0 20 20" fill="currentColor" width="11" height="11">
              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
            Live exchange balances synced
          </span>
        </div>
        <div>
          {!confirmed && <Countdown expiresAtMs={result.previewExpiresAtMs} onExpire={onExpire} />}
        </div>
      </div>

      {(asset || side || leverage || orderType) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flexWrap: 'wrap',
            padding: '8px 12px',
            background: 'rgba(255, 255, 255, 0.025)',
            borderRadius: 6,
            border: '1px solid rgba(255, 255, 255, 0.08)',
            marginBottom: 14,
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>
            Order details:
          </span>
          {asset && (
            <span style={{ fontWeight: 700, color: 'var(--text)', fontSize: 13 }}>
              {asset}
            </span>
          )}
          {side && (
            <span
              style={{
                padding: '2px 7px',
                borderRadius: 4,
                fontWeight: 700,
                fontSize: 11,
                textTransform: 'uppercase',
                background: side.toLowerCase() === 'buy' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                border: `1px solid ${side.toLowerCase() === 'buy' ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)'}`,
                color: side.toLowerCase() === 'buy' ? '#34d399' : '#f87171',
              }}
            >
              {side.toUpperCase()}
            </span>
          )}
          {orderType && (
            <span
              style={{
                padding: '2px 7px',
                borderRadius: 4,
                fontWeight: 600,
                fontSize: 11,
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: 'var(--text-dim)',
                textTransform: 'uppercase',
              }}
            >
              {orderType}
            </span>
          )}
          {leverage && (
            <span
              className="pos-lev-pill"
              style={{
                fontSize: 11.5,
                padding: '2px 8px',
                borderRadius: 4,
                fontWeight: 700,
              }}
            >
              {leverage}× Leverage
            </span>
          )}
          {marginMode && (
            <span
              style={{
                padding: '2px 7px',
                borderRadius: 4,
                fontWeight: 600,
                fontSize: 11,
                background: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                color: 'var(--text-dim)',
                textTransform: 'capitalize',
              }}
            >
              {marginMode} Margin
            </span>
          )}
          {result.stopLossPrice && (
            <span style={{ fontSize: 11, color: '#f87171' }}>
              SL: <strong className="mono">{result.stopLossPrice}</strong>
            </span>
          )}
          {result.takeProfitPrice && (
            <span style={{ fontSize: 11, color: '#34d399' }}>
              TP: <strong className="mono">{result.takeProfitPrice}</strong>
            </span>
          )}
        </div>
      )}

      {/* Desktop Table View (> 768px) */}
      <div className="table-scroll-container desktop-pos-table">
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Status</th>
              <th>Market</th>
              {leverage && <th>Leverage</th>}
              <th className="mono">Quantity</th>
              <th className="mono">Price</th>
              <th className="mono">Est. cost</th>
              <th>Basis / reason</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row: PreviewRow) => (
              <tr key={row.childOrderId} className={row.state === 'skipped' ? 'skipped' : ''}>
                <td>{row.accountName}</td>
                <td><span className={`badge ${row.state}`}>{row.state}</span></td>
                <td>{row.market ?? '—'}</td>
                {leverage && <td><span className="pos-lev-pill">{leverage}×</span></td>}
                <td className="mono">{row.finalQuantity ?? '—'}</td>
                <td className="mono">{row.priceUsed ?? '—'}</td>
                <td className="mono">{formatCost(row.notionalMinor, row.quoteCurrency)}</td>
                <td>
                  {row.state === 'planned'
                    ? <span className="muted">{describeBasis(row.basisUsed, row.currencyChoiceReason)}</span>
                    : <span>{row.refusalDetail ?? row.refusalCode ?? 'skipped'}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile Preview Cards (<= 768px) */}
      <div className="mobile-pos-cards">
        {result.rows.map((row: PreviewRow) => (
          <div
            key={`mobile-${row.childOrderId}`}
            className="pos-mobile-card"
            style={{ opacity: row.state === 'skipped' ? 0.7 : 1 }}
          >
            <div className="pos-mobile-card-top">
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>{row.accountName}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>Market: {row.market ?? '—'}</div>
              </div>
              <div>
                <span className={`badge ${row.state}`}>{row.state}</span>
              </div>
            </div>

            <div className="pos-mobile-grid" style={{ gridTemplateColumns: leverage ? '1fr 1fr 1fr 1fr' : '1fr 1fr 1fr' }}>
              {leverage && (
                <div className="pos-mobile-cell">
                  <span className="pos-mobile-label">Leverage</span>
                  <span className="pos-mobile-val mono"><span className="pos-lev-pill">{leverage}×</span></span>
                </div>
              )}
              <div className="pos-mobile-cell">
                <span className="pos-mobile-label">Qty</span>
                <span className="pos-mobile-val mono">{row.finalQuantity ?? '—'}</span>
              </div>
              <div className="pos-mobile-cell">
                <span className="pos-mobile-label">Price</span>
                <span className="pos-mobile-val mono">{row.priceUsed ?? '—'}</span>
              </div>
              <div className="pos-mobile-cell">
                <span className="pos-mobile-label">Est. Cost</span>
                <span className="pos-mobile-val mono">{formatCost(row.notionalMinor, row.quoteCurrency)}</span>
              </div>
            </div>

            <div style={{ fontSize: 11.5, color: 'var(--muted)', borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 6 }}>
              {row.state === 'planned'
                ? describeBasis(row.basisUsed, row.currencyChoiceReason)
                : <span style={{ color: 'var(--warn)' }}>{row.refusalDetail ?? row.refusalCode ?? 'skipped'}</span>}
            </div>
          </div>
        ))}
      </div>

      {hasSkips && !confirmed && (
        // The acknowledgement only appears when something was skipped — so the
        // customer must actively confirm they have seen the gaps before placing
        // the rest. It cannot appear on an all-planned trade (nothing to ack).
        <label className="ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>
            I understand that {skippedCount} account{skippedCount === 1 ? '' : 's'} will be skipped for the
            reasons shown above, and I want to proceed with the remaining {plannedCount}.
          </span>
        </label>
      )}

      {confirm.isError && <div className="error">{(confirm.error as Error).message}</div>}

      {confirmed ? (
        // A real fan-out navigates to the progress screen, so reaching this box
        // means the server answered dryRun:true — no execution engine is wired in
        // this build and nothing was sent. Say so plainly.
        <div className="spread-warning" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>
          Dry run recorded. Nothing was sent to the exchange — this build has no execution
          engine wired. The plan and the would-send bodies are stored for review.
        </div>
      ) : (
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn secondary" onClick={() => navigate('/app')}>Back to ticket</button>
          {/* The only forward action: authorise the server to confirm. Disabled
              once expired, or until skips are acknowledged. */}
          <button
            className="btn"
            disabled={!canConfirm || confirm.isPending}
            onClick={() => confirm.mutate(result)}
          >
            {isHalted
              ? 'Trading halted (Kill Switch)'
              : expired
                ? 'Preview expired'
                : confirm.isPending
                  ? 'Confirming…'
                  : `Confirm ${plannedCount}`}
          </button>
        </div>
      )}
    </div>
  );
}

/** Estimated cost from the persisted notional, presentation only. */
function formatCost(notionalMinor: string | null, quote: string | null): string {
  if (notionalMinor === null || quote === null) return '—';
  const scale = quote === 'INR' ? 2 : 8;
  const digits = notionalMinor.padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  const num = `${whole}${frac === '' ? '' : `.${frac}`}`;
  return quote === 'INR' ? `₹${num}` : `${num} ${quote}`;
}

function describeBasis(basis: string | null, reason: string | null): string {
  const b = basis === null ? '' : `basis: ${basis}`;
  const r = reason === null ? '' : reason;
  return [b, r].filter((s) => s !== '').join(' · ') || '—';
}
