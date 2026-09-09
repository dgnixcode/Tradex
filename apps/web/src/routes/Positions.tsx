import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchGroups, fetchPositions } from '../api.ts';
import type { PositionsResponse, PositionView, QuoteRollup } from '../api.ts';

// The Positions screen (phase-09 T09.6) — the BOOKS per account and asset, read
// straight from the `holding` projection (the fold of the ledger). Quantity,
// weighted-average cost, realised P&L, fees and TDS — never a mark-to-market value
// (the §6a boundary). A group selector narrows the roll-up to one group; the
// default is the whole tenant. Open orders are shown under the holding they lock.

const quoteScaleOf = (quote: string): number => (quote === 'INR' ? 2 : 8);

/** Group an integer digit string with thousands separators. */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Minor units of a quote → a currency string with separators, at the quote's scale. */
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

/** The exact quantity string, trailing zeros trimmed for display. */
function fmtQty(qty: string): string {
  const neg = qty.startsWith('-');
  const abs = neg ? qty.slice(1) : qty;
  const trimmed = abs.includes('.') ? abs.replace(/0+$/, '').replace(/\.$/, '') : abs;
  return `${neg ? '−' : ''}${trimmed}`;
}

const fmtSigned = (minor: string, quote: string): string =>
  (minor.startsWith('-') ? fmtMinor(minor, quote) : `+${fmtMinor(minor, quote)}`);

const STATE_LABEL: Record<string, string> = {
  open: 'open', acked: 'acked', partially_filled: 'partial',
};

function RollupTable({ rollup }: { readonly rollup: readonly QuoteRollup[] }) {
  return (
    <table style={{ marginBottom: 4 }}>
      <thead>
        <tr>
          <th>Currency</th><th>Accounts</th><th>Open positions</th><th>Dust</th>
          <th style={{ textAlign: 'right' }}>Cost basis</th>
          <th style={{ textAlign: 'right' }}>Realised</th>
          <th style={{ textAlign: 'right' }}>Fees</th>
          <th style={{ textAlign: 'right' }}>TDS</th>
        </tr>
      </thead>
      <tbody>
        {rollup.map((r) => (
          <tr key={r.quoteAsset}>
            <td><span className="badge planned">{r.quoteAsset}</span></td>
            <td>{r.accountCount}</td>
            <td>{r.openPositionCount}</td>
            <td>{r.dustCount > 0 ? <span className="danger-text" style={{ color: 'var(--danger)' }}>{r.dustCount} dust</span> : <span className="muted">none</span>}</td>
            <td className="mono" style={{ textAlign: 'right' }}>{fmtMinor(r.costTotalMinor, r.quoteAsset)}</td>
            <td className="mono" style={{ textAlign: 'right', color: BigInt(r.realisedPnlMinor) >= 0n ? 'var(--ok)' : 'var(--danger)' }}>
              {fmtSigned(r.realisedPnlMinor, r.quoteAsset)}
            </td>
            <td className="mono" style={{ textAlign: 'right' }}>{fmtMinor(r.feeDragMinor, r.quoteAsset)}</td>
            <td className="mono" style={{ textAlign: 'right' }}>{fmtMinor(r.tdsWithheldMinor, r.quoteAsset)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PositionRow({ p }: { readonly p: PositionView }) {
  return (
    <tr className={p.dust ? 'skipped' : ''}>
      <td>
        <strong>{p.asset}</strong>{' '}
        <span className="badge planned" style={{ fontSize: 10.5 }}>{p.quoteAsset}</span>{' '}
        {p.dust && <span className="badge skipped">dust — below min qty</span>}
      </td>
      <td className="mono">{fmtQty(p.qty)}</td>
      <td className="mono">{p.avgPriceMinor === null ? <span className="muted">—</span> : fmtMinor(p.avgPriceMinor, p.quoteAsset)}</td>
      <td className="mono">{fmtMinor(p.costTotalMinor, p.quoteAsset)}</td>
      <td className="mono" style={{ color: BigInt(p.realisedPnlMinor) >= 0n ? 'var(--ok)' : 'var(--danger)' }}>
        {fmtSigned(p.realisedPnlMinor, p.quoteAsset)}
      </td>
      <td className="mono muted">{fmtMinor(p.feeDragMinor, p.quoteAsset)}</td>
      <td className="mono muted">{fmtMinor(p.tdsWithheldMinor, p.quoteAsset)}</td>
    </tr>
  );
}

export function Positions() {
  const groupsQ = useQuery({ queryKey: ['groups'], queryFn: fetchGroups });
  const [groupId, setGroupId] = useState('');
  const positionsQ = useQuery({
    queryKey: ['positions', groupId],
    queryFn: () => fetchPositions(groupId === '' ? undefined : groupId),
  });

  const data: PositionsResponse | undefined = positionsQ.data;
  const hasAny = (data?.accounts.some((a) => a.positions.length > 0) ?? false) || (data?.rollup.length ?? 0) > 0;

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Positions</h2>
        <select
          className="btn btn-sm"
          style={{ marginLeft: 'auto', height: 32 }}
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
          aria-label="Filter to a group"
        >
          <option value="">All accounts</option>
          {(groupsQ.data ?? []).map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </div>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        What each account holds, priced at its own weighted-average cost — the ledger books, never a
        live mark. A dust holding is below the market&apos;s minimum quantity and can&apos;t be sold on its own.
      </p>

      {positionsQ.isLoading && <p className="muted">Loading positions…</p>}
      {positionsQ.isError && <div className="error">{(positionsQ.error as Error).message}</div>}

      {positionsQ.isSuccess && !hasAny && (
        <div className="empty-state">
          <p className="empty-ico">📊</p>
          <p>No open positions.</p>
          <p className="muted">
            When a group trade fills, the ledger records each account&apos;s holding here — quantity, cost
            basis and realised P&L — until it is sold.
          </p>
        </div>
      )}

      {positionsQ.isSuccess && hasAny && (
        <>
          {data !== undefined && data.rollup.length > 0 && (
            <section style={{ marginBottom: 24 }}>
              <h3 style={{ marginTop: 0 }}>Roll-up</h3>
              <RollupTable rollup={data.rollup} />
            </section>
          )}

          {data?.accounts.filter((a) => a.positions.length > 0).map((acc) => (
            <section key={acc.accountId} style={{ marginBottom: 26 }}>
              <h3 style={{ marginTop: 0 }}>
                {acc.accountName}
                {acc.openOrders.length > 0 && (
                  <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>
                    {' '}· {acc.openOrders.length} open order{acc.openOrders.length === 1 ? '' : 's'} locking free balance
                  </span>
                )}
              </h3>
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th style={{ textAlign: 'right' }}>Quantity</th>
                    <th style={{ textAlign: 'right' }}>Avg cost</th>
                    <th style={{ textAlign: 'right' }}>Cost basis</th>
                    <th style={{ textAlign: 'right' }}>Realised</th>
                    <th style={{ textAlign: 'right' }}>Fees</th>
                    <th style={{ textAlign: 'right' }}>TDS</th>
                  </tr>
                </thead>
                <tbody>
                  {acc.positions.map((p) => <PositionRow key={p.asset} p={p} />)}
                </tbody>
              </table>

              {acc.openOrders.length > 0 && (
                <div style={{ marginTop: 8, fontSize: 12.5 }}>
                  {acc.openOrders.map((o) => (
                    <span key={`${o.market}-${o.quantity}-${o.state}`} className="muted" style={{ marginRight: 14 }}>
                      🔒 {o.side === 'buy' ? 'buying' : 'selling'} {fmtQty(o.quantity)} {o.asset}
                      {' '}on {o.market} <span className="badge skipped">{STATE_LABEL[o.state] ?? o.state}</span>
                    </span>
                  ))}
                </div>
              )}
            </section>
          ))}

          {data !== undefined && data.rollup.length === 0 && (
            <div className="muted">No accounts hold anything yet.</div>
          )}
        </>
      )}
    </div>
  );
}
