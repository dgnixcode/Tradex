import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchTradingState, pauseTrading, resumeTrading } from '../api.ts';
import { useAuth } from '../auth.tsx';

// The desk controls page (phase 05 T05.3/T05.4). One place to see and operate the
// brakes:
//
//   - the platform's own mode (normal / cancel_only / read_only) with its reason;
//   - the tenant pause — a trader can pause with NO re-auth (stopping must never
//     be gated); only an OWNER can resume, and only with a fresh second factor.
//     TOTP enrolment is not built yet, so resume will 403 for everyone until it
//     is — the safe default, surfaced here rather than hidden.
//   - the per-tenant caps, and any markets an operator has restricted.
//
// Pause is two clicks: the button, then a confirm that asks for a reason (a pause
// without a reason is a pause nobody can later explain).

const minorLabel = (minor: string, currency: 'INR' | 'USDT'): string => {
  const scale = currency === 'INR' ? 2 : 8;
  const digits = minor.padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  const num = `${whole}${frac === '' ? '' : `.${frac}`}`;
  return currency === 'INR' ? `₹${num}` : `${num} ${currency}`;
};

export function DeskControls() {
  const { state } = useAuth();
  const role = state.status === 'authenticated' ? state.session.role : '';
  const queryClient = useQueryClient();

  const ts = useQuery({ queryKey: ['trading-state'], queryFn: fetchTradingState });

  const [pausing, setPausing] = useState(false);
  const [reason, setReason] = useState('');
  const [opError, setOpError] = useState<string | null>(null);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['trading-state'] });

  const pause = useMutation({
    mutationFn: () => pauseTrading(reason),
    onSuccess: () => { setPausing(false); setReason(''); setOpError(null); invalidate(); },
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not pause'),
  });
  const resume = useMutation({
    mutationFn: () => resumeTrading(),
    onSuccess: () => { setOpError(null); invalidate(); },
    onError: (e) => setOpError(e instanceof Error ? e.message : 'could not resume'),
  });

  const canPause = role === 'owner' || role === 'trader';
  const isOwner = role === 'owner';

  const data = ts.data;
  const paused = data?.tenant.tradingPaused === true;

  return (
    <div>
      <div className="panel">
        <h2>Desk controls</h2>
        <p className="sub muted" style={{ marginTop: -8 }}>
          The brakes on your desk. Pausing stops new trades instantly; resuming needs an owner and a fresh second factor.
        </p>
        {opError !== null && <div className="error" style={{ marginBottom: 10 }}>{opError}</div>}
      </div>

      {/* pause / resume */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Trading</h3>
        {ts.isLoading ? <p className="muted">Loading…</p> : data === undefined ? null : (
          <>
            <div className="desk-row">
              <span className="desk-k">Desk status</span>
              <span className={`badge ${paused ? 'skipped' : 'planned'}`}>{paused ? 'paused' : 'trading'}</span>
            </div>
            {paused && data.tenant.pausedReason !== null && (
              <div className="desk-row"><span className="desk-k">Why</span><span className="muted">{data.tenant.pausedReason}</span></div>
            )}

            {paused ? (
              <div style={{ marginTop: 14 }}>
                {isOwner ? (
                  <div className="add-member-form" style={{ maxWidth: 360 }}>
                    <button className="btn" disabled={resume.isPending} onClick={() => resume.mutate()}>
                      {resume.isPending ? 'Resuming…' : 'Resume trading'}
                    </button>
                  </div>
                ) : (
                  <p className="muted" style={{ margin: 0 }}>Only an <strong>owner</strong> can resume, and only with a fresh second factor.</p>
                )}
              </div>
            ) : (
              <div style={{ marginTop: 14 }}>
                {canPause ? (
                  pausing ? (
                    <form
                      className="add-member-form"
                      onSubmit={(e) => { e.preventDefault(); if (reason.trim() !== '') pause.mutate(); }}
                    >
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Why are you pausing?"
                        aria-label="Pause reason"
                      />
                      <button className="btn danger btn-sm" type="submit" disabled={pause.isPending || reason.trim() === ''}>
                        {pause.isPending ? 'Pausing…' : 'Pause'}
                      </button>
                      <button className="btn ghost btn-sm" type="button" onClick={() => setPausing(false)}>Cancel</button>
                    </form>
                  ) : (
                    <button className="btn danger" onClick={() => setPausing(true)}>Pause trading</button>
                  )
                ) : (
                  <p className="muted" style={{ margin: 0 }}>A viewer cannot pause trading.</p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* platform mode + restricted markets */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Platform</h3>
        {data !== undefined && (
          <>
            <div className="desk-row">
              <span className="desk-k">Mode</span>
              <span className={`badge ${data.platform.mode === 'normal' ? 'planned' : 'skipped'}`}>{data.platform.mode}</span>
            </div>
            {data.platform.mode !== 'normal' && (
              <div className="desk-row"><span className="desk-k">Why</span><span className="muted">{data.platform.modeReason ?? 'no reason given'}</span></div>
            )}
            {data.platform.killSwitch && <p className="error">Platform-wide trading is halted.</p>}

            {data.restrictedMarkets.length > 0 ? (
              <>
                <div className="desk-k" style={{ marginTop: 14 }}>Restricted markets</div>
                <table style={{ marginTop: 8 }}>
                  <thead><tr><th>Market</th><th>Mode</th><th>Reason</th></tr></thead>
                  <tbody>
                    {data.restrictedMarkets.map((m) => (
                      <tr key={m.market}><td>{m.market}</td><td><span className="badge skipped">{m.mode}</span></td><td className="muted">{m.reason ?? '—'}</td></tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="muted" style={{ marginBottom: 0 }}>No markets are restricted.</p>
            )}
          </>
        )}
      </div>

      {/* caps */}
      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Limits</h3>
        {data !== undefined && (
          <>
            <div className="desk-row"><span className="desk-k">Per-order cap</span><span className="mono">{minorLabel(data.caps.perOrderNotionalMinor, 'INR')}</span></div>
            <div className="desk-row"><span className="desk-k">Daily cap</span><span className="mono">{minorLabel(data.caps.dailyNotionalMinor, 'INR')}</span></div>
            <p className="muted" style={{ marginBottom: 0, marginTop: 12 }}>
              Changing these caps requires the workspace owner and a fresh second factor — coming once 2FA enrolment lands.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
