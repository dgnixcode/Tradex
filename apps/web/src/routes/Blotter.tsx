import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchAccountList, fetchBlotter } from '../api.ts';
import type { BlotterChildRow } from '../api.ts';

// The blotter (phase-12 T12.4): one row per child order, from OUR records, newest
// first, keyset-paginated. Filters narrow account / outcome / market. Every number
// here is a plan-or-execution fact — fill price is "not captured" until the
// child↔ledger link exists, never shown as zero.

const OUTCOMES: readonly { value: string; label: string }[] = [
  { value: '', label: 'All outcomes' },
  { value: 'working', label: 'Working' },
  { value: 'filled', label: 'Filled' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'needs_review', label: 'Needs review' },
];

const STATE_LABEL: Record<string, string> = {
  planned: 'planned', sending: 'sending', ambiguous: 'ambiguous', acked: 'acked',
  open: 'open', partially_filled: 'partial', filled: 'filled', cancelled: 'cancelled',
  partially_cancelled: 'partial-cancel', rejected: 'rejected', skipped: 'skipped',
  not_placed: 'not placed', unknown: 'unknown', needs_human: 'needs review',
};

const badgeFor = (state: string): string => {
  if (state === 'filled') return 'planned';
  if (state === 'open' || state === 'acked' || state === 'partially_filled') return 'planned';
  if (state === 'rejected' || state === 'skipped' || state === 'not_placed' || state === 'needs_human' || state === 'cancelled') return 'skipped';
  return 'skipped';
};

function fmtQty(q: string): string {
  const abs = q.replace(/^-/, '').includes('.') ? q.replace(/^-/, '').replace(/0+$/, '').replace(/\.$/, '') : q.replace(/^-/, '');
  return `${q.startsWith('-') ? '−' : ''}${abs}`;
}

function fmtWhen(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
}

function Row({ r }: { readonly r: BlotterChildRow }) {
  return (
    <tr>
      <td>
        <Link to={`/app/activity/groups/${r.groupTradeId}`} style={{ textDecoration: 'none' }}>
          {r.accountName}
        </Link>
        <span className="muted" style={{ fontSize: 11 }}><br />{fmtWhen(r.createdAtMs)}</span>
      </td>
      <td><span className="badge planned">{r.side} {r.orderType}</span></td>
      <td className="mono">{r.market}</td>
      <td className="mono">{r.finalQuantity === null ? '—' : fmtQty(r.finalQuantity)}</td>
      <td>
        <span className={`badge ${badgeFor(r.state)}`}>{STATE_LABEL[r.state] ?? r.state}</span>
        {r.refusalCode !== null && <span className="muted" style={{ display: 'block', fontSize: 11 }}>{r.refusalCode}</span>}
      </td>
      <td className="muted" style={{ fontSize: 12 }}>
        {r.refusalDetail !== null ? r.refusalDetail : r.exchangeOrderId !== null ? `venue ${r.exchangeOrderId}` : '—'}
      </td>
    </tr>
  );
}

export function Blotter() {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccountList });
  const [accountId, setAccountId] = useState('');
  const [outcome, setOutcome] = useState('');
  const [market, setMarket] = useState('');
  const [extra, setExtra] = useState<readonly BlotterChildRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);

  const filters = { accountId: accountId === '' ? undefined : accountId, outcome: outcome === '' ? undefined : outcome, market: market === '' ? undefined : market };
  const query = useQuery({
    queryKey: ['blotter', accountId, outcome, market],
    queryFn: () => fetchBlotter({ ...filters, limit: 50 }),
  });

  useEffect(() => { setExtra([]); setCursor(null); }, [accountId, outcome, market]);

  const rows = [...(query.data?.rows ?? []), ...extra];
  const next = cursor ?? query.data?.nextCursor ?? null;

  const loadMore = async (): Promise<void> => {
    const page = await fetchBlotter({ ...filters, limit: 50, cursor: next ?? undefined });
    setExtra((prev) => [...prev, ...page.rows]);
    setCursor(page.nextCursor);
  };

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2 style={{ margin: 0 }}>Activity</h2>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select className="btn btn-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Filter by account">
            <option value="">All accounts</option>
            {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select className="btn btn-sm" value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Filter by outcome">
            {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input
            className="btn btn-sm" placeholder="Market (BTCINR)" value={market}
            onChange={(e) => setMarket(e.target.value)}
            style={{ width: 150 }}
          />
        </div>
      </div>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        Every order this workspace has placed, from our own records. Fill prices are not captured until an
        order&apos;s fills are linked to it — never shown as zero.
      </p>

      {query.isLoading && <p className="muted">Loading…</p>}
      {query.isError && <div className="error">{(query.error as Error).message}</div>}

      {query.isSuccess && rows.length === 0 && (
        <div className="empty-state">
          <p className="empty-ico">📋</p>
          <p>No orders yet.</p>
          <p className="muted">When a group trade is confirmed, its legs appear here with their outcome.</p>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <table>
            <thead>
              <tr>
                <th>Account</th><th>Order</th><th>Market</th>
                <th style={{ textAlign: 'right' }}>Qty</th><th>Outcome</th><th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => <Row key={r.id} r={r} />)}
            </tbody>
          </table>
          {next !== null && (
            <div style={{ marginTop: 14, textAlign: 'center' }}>
              <button className="btn secondary btn-sm" onClick={() => { void loadMore(); }}>Load older</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
