import { useCallback, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { confirmTrade, fetchTrade } from '../api.ts';
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

  const canConfirm = !expired && plannedCount > 0 && (!hasSkips || acknowledged) && !confirmed;

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Confirm — {plannedCount} to place, {skippedCount} skipped</h2>
        <span style={{ marginLeft: 'auto' }}>
          {!confirmed && <Countdown expiresAtMs={result.previewExpiresAtMs} onExpire={onExpire} />}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Status</th>
            <th>Market</th>
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
            {expired
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
