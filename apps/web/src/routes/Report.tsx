import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchAnalytics, fetchAnalyticsCsv, fetchGroups } from '../api.ts';
import type { MetricValue } from '../api.ts';

// The report page (phase-12 T12.6): realised P&L, fee drag and estimated TDS over
// a window — defaulting to the current Indian financial year — from OUR ledger,
// with the metric values beside them. Every number is a metric/report object; the
// page only formats. Values the records cannot support render "not captured",
// never zero.

const quoteScaleOf = (quote: string): number => (quote === 'INR' ? 2 : 8);

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Quote minor → currency string with separators. */
function fmtMinor(minor: string, quote: string): string {
  const scale = quoteScaleOf(quote);
  const neg = minor.startsWith('-');
  const digits = neg ? minor.slice(1) : minor;
  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, -scale);
  const frac = padded.slice(-scale).replace(/0+$/, '');
  const body = `${groupThousands(whole)}${frac === '' ? '' : `.${frac}`}`;
  const sign = neg ? '−' : '';
  return quote === 'INR' ? `${sign}₹${body}` : `${sign}${body} ${quote}`;
}

const fmtSigned = (minor: string, quote: string): string =>
  (minor.startsWith('-') ? fmtMinor(minor, quote) : `+${fmtMinor(minor, quote)}`);

function fmtMs(ms: string): string {
  const s = Math.floor(Number(ms) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function MetricRow({ m }: { readonly m: MetricValue }) {
  return (
    <tr className={m.status === 'not_captured' ? 'skipped' : ''}>
      <td>
        <span className="mono">{m.metricId}</span> {m.label}
        {m.quoteAsset !== undefined && <span className="badge planned" style={{ fontSize: 10.5 }}>{m.quoteAsset}</span>}
        {m.approximate && <span className="badge skipped">approximate</span>}
        {m.metricId === 'M11' && <span className="badge skipped">estimated</span>}
      </td>
      <td className="mono" style={{ textAlign: 'right' }}>
        {m.value === null
          ? <span className="muted">not captured</span>
          : m.unit === 'minor' && m.quoteAsset !== undefined
            ? <span style={{ color: m.metricId === 'M6' ? (BigInt(m.value) >= 0n ? 'var(--ok)' : 'var(--danger)') : undefined }}>
                {m.metricId === 'M6' ? fmtSigned(m.value, m.quoteAsset) : fmtMinor(m.value, m.quoteAsset)}
              </span>
            : m.unit === 'bp'
              ? m.metricId === 'M20' ? `${(Number(m.value) / 100).toFixed(1)}%` : `${m.value} bp`
              : m.unit === 'ms' ? fmtMs(m.value) : m.value}
      </td>
      <td className="muted" style={{ fontSize: 12 }}>
        {m.status === 'not_captured' && m.reason !== undefined ? m.reason : ''}
      </td>
    </tr>
  );
}

const FY_OPTIONS = ['2025-26', '2024-25', '2023-24'];

export function Report() {
  const groups = useQuery({ queryKey: ['groups'], queryFn: fetchGroups });
  const [groupId, setGroupId] = useState('');
  const [fy, setFy] = useState('');
  const q = useQuery({
    queryKey: ['analytics', groupId, fy],
    queryFn: () => fetchAnalytics({ groupId: groupId === '' ? undefined : groupId, fy: fy === '' ? undefined : fy }),
  });

  const onDownload = async (): Promise<void> => {
    const { text, filename } = await fetchAnalyticsCsv({ groupId: groupId === '' ? undefined : groupId, fy: fy === '' ? undefined : fy });
    const blob = new Blob([text], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Report</h2>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="btn btn-sm" value={groupId} onChange={(e) => setGroupId(e.target.value)} aria-label="Scope">
            <option value="">All accounts</option>
            {(groups.data ?? []).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <select className="btn btn-sm" value={fy} onChange={(e) => setFy(e.target.value)} aria-label="Financial year">
            <option value="">Current FY</option>
            {FY_OPTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <button className="btn btn-sm" onClick={() => { void onDownload(); }} disabled={q.data === undefined}>
            ↓ CSV
          </button>
        </div>
      </div>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        What actually happened, from our records: {q.data === undefined ? '…' : q.data.window.label}
        {q.data?.approximate === true && <span className="badge skipped" style={{ marginLeft: 8 }}>contains unclassified adjustments</span>}
      </p>

      {q.isLoading && <p className="muted">Loading…</p>}
      {q.isError && <div className="error">{(q.error as Error).message}</div>}

      {q.isSuccess && q.data !== undefined && (
        <>
          <h3 style={{ marginTop: 0 }}>Realised P&amp;L, fees and TDS</h3>
          <table style={{ marginBottom: 22 }}>
            <thead>
              <tr>
                <th>Currency</th>
                <th style={{ textAlign: 'right' }}>Realised</th>
                <th style={{ textAlign: 'right' }}>Fee drag</th>
                <th style={{ textAlign: 'right' }}>TDS withheld (est.)</th>
              </tr>
            </thead>
            <tbody>
              {q.data.totals.filter((t) => t.realised !== '0' || t.feeDrag !== '0' || t.tds !== '0').map((t) => (
                <tr key={t.quoteAsset}>
                  <td><span className="badge planned">{t.quoteAsset}</span></td>
                  <td className="mono" style={{ textAlign: 'right', color: BigInt(t.realised) >= 0n ? 'var(--ok)' : 'var(--danger)' }}>
                    {fmtSigned(t.realised, t.quoteAsset)}
                  </td>
                  <td className="mono" style={{ textAlign: 'right' }}>{fmtMinor(t.feeDrag, t.quoteAsset)}</td>
                  <td className="mono" style={{ textAlign: 'right' }}>{fmtMinor(t.tds, t.quoteAsset)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3 style={{ marginTop: 0 }}>Metrics</h3>
          <table>
            <thead>
              <tr><th>Metric</th><th style={{ textAlign: 'right' }}>Value</th><th>Note</th></tr>
            </thead>
            <tbody>
              {q.data.metrics.map((m) => <MetricRow key={`${m.metricId}-${m.quoteAsset ?? 'x'}`} m={m} />)}
            </tbody>
          </table>
          <p className="sub muted" style={{ marginTop: 12 }}>
            TDS is always estimated until confirmed on your exchange statement. Win/loss, fill rate and other
            per-order figures show “not captured” until fills are linked to their orders.
          </p>
        </>
      )}
    </div>
  );
}
