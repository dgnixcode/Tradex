import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchExecutionReport, fetchTrade } from '../api.ts';

// The permanent group-trade detail (phase-12 T12.5): the same durable report the
// live progress screen renders, re-read from GET /group-trades/:id/report so it
// survives a reload. Account names come from the persisted plan.

const STATE_LABEL: Record<string, string> = {
  planned: 'planned', skipped: 'skipped', sending: 'sending', ambiguous: 'ambiguous',
  acked: 'acked', open: 'open', partially_filled: 'partial', filled: 'filled',
  cancelled: 'cancelled', partially_cancelled: 'partial-cancel', rejected: 'rejected',
  not_placed: 'not placed', unknown: 'unknown', needs_human: 'needs review',
};

const badgeFor = (state: string): string =>
  state === 'filled' || state === 'open' || state === 'acked' || state === 'partially_filled' ? 'planned' : 'skipped';

export function GroupDetailReport() {
  const { groupTradeId = '' } = useParams();
  const plan = useQuery({ queryKey: ['trade', groupTradeId], queryFn: () => fetchTrade(groupTradeId) });
  const report = useQuery({
    queryKey: ['execution-report', groupTradeId],
    queryFn: () => fetchExecutionReport(groupTradeId),
  });

  const names = new Map((plan.data?.rows ?? []).map((r) => [r.accountId, r.accountName]));
  const nameOf = (id: string): string => names.get(id) ?? id.slice(0, 8);

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Link to="/app/activity" className="btn secondary btn-sm">← Activity</Link>
        <h2 style={{ margin: 0, fontSize: 18 }}>Group trade {groupTradeId.slice(0, 8)}</h2>
        {report.data !== undefined && (
          <span className={`badge ${report.data.status === 'completed' ? 'planned' : 'skipped'}`}>
            {report.data.status}
            {report.data.dryRun ? ' · dry run' : ''}
          </span>
        )}
      </div>
      <p className="sub muted" style={{ marginTop: -6, marginBottom: 18 }}>
        The permanent record of what happened on this trade — identical to what the live progress
        screen shows, from our own records.
      </p>

      {report.isLoading && <p className="muted">Loading report…</p>}
      {report.isError && <div className="error">{(report.error as Error).message}</div>}

      {report.isSuccess && report.data !== undefined && (
        <>
          <div style={{ marginBottom: 16 }}>
            <span style={{ marginRight: 18 }}>Placed <strong>{report.data.report.placed}</strong></span>
            <span style={{ marginRight: 18 }}>Skipped <strong>{report.data.report.skipped}</strong></span>
            <span style={{ marginRight: 18 }}>Rejected <strong>{report.data.report.rejected}</strong></span>
            <span>Needs review <strong>{report.data.report.needsReview}</strong></span>
          </div>

          {/* A partial failure is the case that confuses most: the trade "worked"
              but some accounts did not. Saying so up top, with the count, beats
              making someone diff the rows. */}
          {!report.data.report.allPlaced && (
            <div className="spread-warning" style={{ marginBottom: 16 }}>
              <strong>
                {report.data.report.placed} of {report.data.report.planned}
                {' '}account{report.data.report.planned === 1 ? '' : 's'} placed.
              </strong>{' '}
              {report.data.report.needsReview > 0
                ? 'At least one leg needs a human — check the reasons below before re-trying.'
                : 'The reasons are listed per account below.'}
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th>Account</th><th>State</th><th>Market</th>
                <th style={{ textAlign: 'right' }}>Quantity</th><th>Exchange order</th><th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {report.data.report.rows.map((r) => (
                <tr key={`${r.accountId}-${r.market}`} className={badgeFor(r.state) === 'skipped' ? 'skipped' : ''}>
                  <td>{nameOf(r.accountId)}</td>
                  <td><span className={`badge ${badgeFor(r.state)}`}>{STATE_LABEL[r.state] ?? r.state}</span></td>
                  <td className="mono">{r.market ?? '—'}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{r.finalQuantity ?? '—'}</td>
                  <td className="mono">{r.exchangeOrderId ?? '—'}</td>
                  <td style={{ fontSize: 12 }}>
                    {/* The CODE first: it is the part that is always present on a
                        refusal, so a gate that refuses with a code and no prose no
                        longer renders a failure as a blank cell. */}
                    {r.refusalCode !== null && <span className="mono">{r.refusalCode}</span>}
                    {r.refusalCode !== null && r.reason !== null && ' — '}
                    {r.reason !== null && <span className="muted">{r.reason}</span>}
                    {r.refusalCode === null && r.reason === null && <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {report.data.report.groupedCauses.length > 0 && (
            <div style={{ marginTop: 16, fontSize: 13 }}>
              <div className="muted" style={{ marginBottom: 6 }}>Why legs failed, grouped by cause:</div>
              {report.data.report.groupedCauses.map((c) => (
                <div key={`${c.code}-${c.detail ?? ''}`} className="muted" style={{ marginBottom: 4 }}>
                  <strong>{c.count}×</strong> <span className="mono">{c.code}</span>
                  {c.detail !== '' && <> — {c.detail}</>}{' '}
                  {/* Names, not ids: "which account is broken" is the question this
                      block exists to answer. */}
                  <span style={{ opacity: 0.8 }}>({c.accounts.map(nameOf).join(', ')})</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
