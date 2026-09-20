import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchAccountList, fetchBlotter, fetchBlotterGroups } from '../api.ts';
import type { BlotterChildRow, BlotterGroupItem } from '../api.ts';

// The blotter (phase-12 T12.4): supports Group Orders view (aggregated by group
// trade with in-place expansion to inspect 100s of accounts) and All Account Orders
// view (flat child list). Fully records trade ticket entries, futures hard exits,
// and partial adjustments.

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

function fmtPrice(p: string | null): string {
  if (!p || p === '0') return '—';
  const n = Number(p);
  if (!Number.isFinite(n)) return p;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

function fmtWhen(ms: number | null): string {
  if (ms === null) return '—';
  return new Date(ms).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
}

/* ── Flat Child Row (for All Account Orders view) ── */
function FlatChildRow({ r }: { readonly r: BlotterChildRow }) {
  return (
    <tr>
      <td>
        <Link to={`/app/accounts/${r.accountId}`} style={{ fontWeight: 600, color: 'var(--text)', textDecoration: 'none' }}>
          {r.accountName}
        </Link>
        <span className="muted" style={{ fontSize: 11, display: 'block' }}>{fmtWhen(r.createdAtMs)}</span>
      </td>
      <td>
        <span
          className="badge"
          style={{
            background: r.side === 'buy' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            color: r.side === 'buy' ? '#10b981' : '#ef4444',
            border: `1px solid ${r.side === 'buy' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            fontWeight: 700,
            textTransform: 'uppercase',
            fontSize: 10.5,
          }}
        >
          {r.side} {r.orderType}
        </span>
      </td>
      <td className="mono" style={{ fontWeight: 600 }}>{r.market}</td>
      <td className="mono" style={{ textAlign: 'right', fontWeight: 600 }}>{r.finalQuantity === null ? '—' : fmtQty(r.finalQuantity)}</td>
      <td>
        <span className={`badge ${badgeFor(r.state)}`}>{STATE_LABEL[r.state] ?? r.state}</span>
        {r.refusalCode !== null && <span className="muted" style={{ display: 'block', fontSize: 11 }}>{r.refusalCode}</span>}
      </td>
      <td className="muted" style={{ fontSize: 12 }}>
        {r.refusalDetail !== null ? r.refusalDetail : r.exchangeOrderId !== null ? `venue ${r.exchangeOrderId}` : '—'}
      </td>
      <td style={{ textAlign: 'right' }}>
        <Link to={`/app/activity/groups/${r.groupTradeId}`} style={{ fontSize: 11.5, color: 'var(--accent)', textDecoration: 'none' }}>
          Group →
        </Link>
      </td>
    </tr>
  );
}

/* ── Mobile Flat Card (<= 768px) ── */
function MobileBlotterCard({ r }: { readonly r: BlotterChildRow }) {
  return (
    <div className="pos-mobile-card">
      <div className="pos-mobile-card-top">
        <div>
          <Link
            to={`/app/accounts/${r.accountId}`}
            style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)', textDecoration: 'none' }}
          >
            {r.accountName}
          </Link>
          <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>{fmtWhen(r.createdAtMs)}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <span className={`badge ${badgeFor(r.state)}`}>{STATE_LABEL[r.state] ?? r.state}</span>
        </div>
      </div>

      <div className="pos-mobile-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
        <div className="pos-mobile-cell">
          <span className="pos-mobile-label">Market</span>
          <span className="pos-mobile-val mono" style={{ fontWeight: 700 }}>{r.market}</span>
        </div>
        <div className="pos-mobile-cell">
          <span className="pos-mobile-label">Order</span>
          <span className="pos-mobile-val" style={{ textTransform: 'uppercase', color: r.side === 'buy' ? 'var(--ok)' : 'var(--danger)', fontWeight: 700 }}>
            {r.side} {r.orderType}
          </span>
        </div>
        <div className="pos-mobile-cell">
          <span className="pos-mobile-label">Qty</span>
          <span className="pos-mobile-val mono">{r.finalQuantity === null ? '—' : fmtQty(r.finalQuantity)}</span>
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 11.5 }}>
        <span className="muted">
          {r.refusalDetail ?? (r.exchangeOrderId ? `Venue ID: ${r.exchangeOrderId}` : '—')}
        </span>
        <Link to={`/app/activity/groups/${r.groupTradeId}`} style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
          View Group Report →
        </Link>
      </div>
    </div>
  );
}

/* ── Group Order Item (with In-Place Expandable Account Table) ── */
function GroupOrderItem({
  g,
  isExpanded,
  onToggle,
}: {
  readonly g: BlotterGroupItem;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
}) {
  const isExit = g.isFutures && g.sizingMode === 'sell_all';
  const isReduce = g.isFutures && g.sizingMode === 'pct_position';
  const isAllFilled = g.failedCount === 0 && g.skippedCount === 0;

  const sideLabel = isExit
    ? `${g.side} (Exit)`
    : isReduce
      ? `${g.side} (Reduce)`
      : g.side;

  const sideBadgeColor = g.side === 'buy' ? '#10b981' : '#ef4444';
  const sideBadgeBg = g.side === 'buy' ? 'rgba(16, 185, 129, 0.14)' : 'rgba(239, 68, 68, 0.14)';
  const sideBadgeBorder = g.side === 'buy' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)';

  return (
    <div
      style={{
        background: 'var(--surface-2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--radius)',
        marginBottom: 12,
        overflow: 'hidden',
        transition: 'border-color 0.15s ease',
      }}
    >
      {/* Group Master Header Row */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          cursor: 'pointer',
          userSelect: 'none',
          gap: 12,
          flexWrap: 'wrap',
          background: isExpanded ? 'rgba(255, 255, 255, 0.03)' : 'transparent',
          borderBottom: isExpanded ? '1px solid var(--line)' : 'none',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* Expand/Collapse Chevron */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 4,
              background: 'rgba(255, 255, 255, 0.05)',
              transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform 0.18s ease',
            }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </div>

          {/* Group Name & Badge */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--text)' }}>
              {g.groupName}
            </span>
            <span
              style={{
                fontSize: 11,
                padding: '2px 7px',
                borderRadius: 4,
                background: 'rgba(124, 107, 255, 0.15)',
                color: '#c4b5fd',
                border: '1px solid rgba(124, 107, 255, 0.3)',
                fontWeight: 600,
              }}
            >
              {g.totalAccounts} {g.totalAccounts === 1 ? 'account' : 'accounts'}
            </span>
          </div>

          {/* Order Side / Action Badge */}
          <span
            className="badge"
            style={{
              background: sideBadgeBg,
              color: sideBadgeColor,
              borderColor: sideBadgeBorder,
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.02em',
            }}
          >
            {sideLabel} {g.orderType}
          </span>

          {/* Market */}
          <span
            className="mono"
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: '#38bdf8',
              background: 'rgba(56, 189, 248, 0.1)',
              padding: '2px 8px',
              borderRadius: 4,
              border: '1px solid rgba(56, 189, 248, 0.25)',
            }}
          >
            {g.market}
          </span>

          {/* Total Quantity */}
          <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
            Total Qty: <strong className="mono" style={{ color: '#f8fafc', fontWeight: 700 }}>{g.totalQuantity}</strong>
          </div>
        </div>

        {/* Right Side: Status Summary & Timestamp */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {isAllFilled ? (
            <span className="badge planned" style={{ fontSize: 11.5, fontWeight: 700 }}>
              {g.filledCount}/{g.totalAccounts} Filled
            </span>
          ) : (
            <span className="badge skipped" style={{ fontSize: 11.5, fontWeight: 700 }}>
              {g.filledCount} Filled{g.skippedCount > 0 ? `, ${g.skippedCount} Skipped` : ''}{g.failedCount > 0 ? `, ${g.failedCount} Failed` : ''}
            </span>
          )}

          <span style={{ fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
            {fmtWhen(g.createdAtMs)}
          </span>

          <Link
            to={`/app/activity/groups/${g.groupTradeId}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--accent)',
              textDecoration: 'none',
              padding: '3px 8px',
              borderRadius: 4,
              background: 'rgba(255, 255, 255, 0.04)',
              border: '1px solid var(--line)',
            }}
            title="Open dedicated execution report for this group trade"
          >
            Report →
          </Link>
        </div>
      </div>

      {/* Expanded Per-Account Orders Table */}
      {isExpanded && (
        <div style={{ padding: '8px 16px 14px', background: 'rgba(0,0,0,0.18)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0 10px', fontSize: 12, color: 'var(--muted)' }}>
            <span>
              All {g.children.length} account executions for this group order:
            </span>
            <span style={{ fontSize: 11.5 }}>
              Click an account to view its portfolio
            </span>
          </div>

          {/* Desktop Table (> 768px) */}
          <div className="table-scroll-container desktop-pos-table" style={{ margin: 0, borderRadius: 6, border: '1px solid var(--line)' }}>
            <table style={{ fontSize: 12 }}>
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Order</th>
                  <th>Market</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Execution Price</th>
                  <th>Outcome</th>
                  <th>Venue / Refusal Detail</th>
                </tr>
              </thead>
              <tbody>
                {g.children.map((child) => (
                  <tr key={child.id}>
                    <td>
                      <Link
                        to={`/app/accounts/${child.accountId}`}
                        style={{ fontWeight: 600, color: 'var(--text)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <span>{child.accountName}</span>
                        <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
                          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                          <polyline points="15 3 21 3 21 9" />
                          <line x1="10" y1="14" x2="21" y2="3" />
                        </svg>
                      </Link>
                    </td>
                    <td>
                      <span
                        className="badge"
                        style={{
                          background: child.side === 'buy' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                          color: child.side === 'buy' ? '#10b981' : '#ef4444',
                          border: `1px solid ${child.side === 'buy' ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)'}`,
                          fontSize: 10,
                          padding: '1px 5px',
                          fontWeight: 700,
                          textTransform: 'uppercase',
                        }}
                      >
                        {child.side} {child.orderType}
                      </span>
                    </td>
                    <td className="mono">{child.market}</td>
                    <td className="mono" style={{ textAlign: 'right', fontWeight: 600, color: '#f8fafc' }}>
                      {child.finalQuantity === null ? '—' : fmtQty(child.finalQuantity)}
                    </td>
                    <td className="mono" style={{ textAlign: 'right', color: '#94a3b8' }}>
                      {fmtPrice(child.priceUsed)}
                    </td>
                    <td>
                      <span className={`badge ${badgeFor(child.state)}`} style={{ fontSize: 10.5 }}>
                        {STATE_LABEL[child.state] ?? child.state}
                      </span>
                      {child.refusalCode !== null && (
                        <span className="muted" style={{ display: 'block', fontSize: 10.5, color: 'var(--danger)' }}>
                          {child.refusalCode}
                        </span>
                      )}
                    </td>
                    <td className="muted" style={{ fontSize: 11.5 }}>
                      {child.refusalDetail !== null
                        ? child.refusalDetail
                        : child.exchangeOrderId !== null
                          ? `venue ${child.exchangeOrderId}`
                          : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile View for Accounts (<= 768px) */}
          <div className="mobile-pos-cards" style={{ marginTop: 6 }}>
            {g.children.map((child) => (
              <div
                key={`m-child-${child.id}`}
                style={{
                  padding: '8px 10px',
                  background: 'var(--surface-3)',
                  border: '1px solid var(--line)',
                  borderRadius: 6,
                  marginBottom: 6,
                  fontSize: 12,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <Link
                    to={`/app/accounts/${child.accountId}`}
                    style={{ fontWeight: 700, color: 'var(--text)', textDecoration: 'none' }}
                  >
                    {child.accountName} →
                  </Link>
                  <span className={`badge ${badgeFor(child.state)}`} style={{ fontSize: 10 }}>
                    {STATE_LABEL[child.state] ?? child.state}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--text-dim)', fontSize: 11.5 }}>
                  <span>Qty: <strong className="mono" style={{ color: '#fff' }}>{child.finalQuantity ? fmtQty(child.finalQuantity) : '—'}</strong></span>
                  <span>Price: <strong className="mono">{fmtPrice(child.priceUsed)}</strong></span>
                  <span className="muted">{child.exchangeOrderId ? `#${child.exchangeOrderId}` : ''}</span>
                </div>
                {child.refusalDetail && (
                  <div style={{ fontSize: 10.5, color: 'var(--danger)', marginTop: 4 }}>{child.refusalDetail}</div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function Blotter() {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: fetchAccountList });
  const [viewMode, setViewMode] = useState<'group' | 'flat'>('group');
  const [accountId, setAccountId] = useState('');
  const [outcome, setOutcome] = useState('');
  const [market, setMarket] = useState('');

  // Flat view pagination
  const [flatExtra, setFlatExtra] = useState<readonly BlotterChildRow[]>([]);
  const [flatCursor, setFlatCursor] = useState<string | null>(null);

  // Group view pagination & expanded state
  const [groupExtra, setGroupExtra] = useState<readonly BlotterGroupItem[]>([]);
  const [groupCursor, setGroupCursor] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const filters = {
    accountId: accountId === '' ? undefined : accountId,
    outcome: outcome === '' ? undefined : outcome,
    market: market === '' ? undefined : market,
  };

  // 1. Group Orders Query
  const groupQuery = useQuery({
    queryKey: ['blotter-groups', accountId, outcome, market],
    queryFn: () => fetchBlotterGroups({ ...filters, limit: 25 }),
  });

  // 2. Flat Child Orders Query
  const flatQuery = useQuery({
    queryKey: ['blotter-flat', accountId, outcome, market],
    queryFn: () => fetchBlotter({ ...filters, limit: 50 }),
  });

  useEffect(() => {
    setFlatExtra([]);
    setFlatCursor(null);
    setGroupExtra([]);
    setGroupCursor(null);
  }, [accountId, outcome, market]);

  const toggleGroup = (id: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const expandAll = () => {
    const allIds = new Set(allGroups.map((g) => g.groupTradeId));
    setExpandedGroups(allIds);
  };

  const collapseAll = () => {
    setExpandedGroups(new Set());
  };

  // Grouped rows & cursor
  const allGroups = [...(groupQuery.data?.groups ?? []), ...groupExtra];
  const nextGroupCursor = groupCursor ?? groupQuery.data?.nextCursor ?? null;

  const loadMoreGroups = async (): Promise<void> => {
    const page = await fetchBlotterGroups({ ...filters, limit: 25, cursor: nextGroupCursor ?? undefined });
    setGroupExtra((prev) => [...prev, ...page.groups]);
    setGroupCursor(page.nextCursor);
  };

  // Flat rows & cursor
  const flatRows = [...(flatQuery.data?.rows ?? []), ...flatExtra];
  const nextFlatCursor = flatCursor ?? flatQuery.data?.nextCursor ?? null;

  const loadMoreFlat = async (): Promise<void> => {
    const page = await fetchBlotter({ ...filters, limit: 50, cursor: nextFlatCursor ?? undefined });
    setFlatExtra((prev) => [...prev, ...page.rows]);
    setFlatCursor(page.nextCursor);
  };

  const isLoading = viewMode === 'group' ? groupQuery.isLoading : flatQuery.isLoading;
  const isError = viewMode === 'group' ? groupQuery.isError : flatQuery.isError;
  const errorObj = viewMode === 'group' ? groupQuery.error : flatQuery.error;
  const isSuccess = viewMode === 'group' ? groupQuery.isSuccess : flatQuery.isSuccess;

  return (
    <div className="panel full-width-page">
      {/* Top Header & View Mode Switcher */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Orders</h2>

          {/* View Mode Switcher */}
          <div
            style={{
              display: 'inline-flex',
              background: 'var(--surface-2)',
              padding: 3,
              borderRadius: 'var(--radius)',
              border: '1px solid var(--line)',
            }}
          >
            <button
              type="button"
              className={`btn btn-sm ${viewMode === 'group' ? '' : 'ghost'}`}
              style={{
                padding: '4px 12px',
                fontSize: 12,
                borderRadius: 'calc(var(--radius) - 2px)',
                background: viewMode === 'group' ? 'var(--grad)' : 'transparent',
                color: viewMode === 'group' ? '#fff' : 'var(--text-dim)',
                fontWeight: viewMode === 'group' ? 700 : 500,
                border: 'none',
              }}
              onClick={() => setViewMode('group')}
            >
              Group Orders
            </button>
            <button
              type="button"
              className={`btn btn-sm ${viewMode === 'flat' ? '' : 'ghost'}`}
              style={{
                padding: '4px 12px',
                fontSize: 12,
                borderRadius: 'calc(var(--radius) - 2px)',
                background: viewMode === 'flat' ? 'var(--grad)' : 'transparent',
                color: viewMode === 'flat' ? '#fff' : 'var(--text-dim)',
                fontWeight: viewMode === 'flat' ? 700 : 500,
                border: 'none',
              }}
              onClick={() => setViewMode('flat')}
            >
              All Account Orders
            </button>
          </div>
        </div>

        {/* Filters */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="btn btn-sm" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Filter by account">
            <option value="">All accounts</option>
            {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select className="btn btn-sm" value={outcome} onChange={(e) => setOutcome(e.target.value)} aria-label="Filter by outcome">
            {OUTCOMES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <input
            className="btn btn-sm" placeholder="Market (e.g. BTCINR)" value={market}
            onChange={(e) => setMarket(e.target.value)}
            style={{ width: 140 }}
          />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <p className="sub muted" style={{ margin: 0 }}>
          Complete audit trail of all trade ticket orders, futures position exits, and partial adjustments across accounts.
        </p>

        {viewMode === 'group' && allGroups.length > 0 && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm secondary"
              style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={expandAll}
            >
              Expand All
            </button>
            <button
              type="button"
              className="btn btn-sm secondary"
              style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={collapseAll}
            >
              Collapse All
            </button>
          </div>
        )}
      </div>

      {isLoading && <p className="muted">Loading orders…</p>}
      {isError && <div className="error">{(errorObj as Error).message}</div>}

      {/* ── 1. GROUP ORDERS VIEW (Primary) ── */}
      {viewMode === 'group' && isSuccess && (
        <>
          {allGroups.length === 0 ? (
            <div className="empty-state">
              <p>No group orders found.</p>
              <p className="muted">When a group trade, position exit, or partial close is executed, it will appear here.</p>
            </div>
          ) : (
            <div>
              {allGroups.map((g) => (
                <GroupOrderItem
                  key={g.groupTradeId}
                  g={g}
                  isExpanded={expandedGroups.has(g.groupTradeId)}
                  onToggle={() => toggleGroup(g.groupTradeId)}
                />
              ))}

              {nextGroupCursor !== null && (
                <div style={{ marginTop: 16, textAlign: 'center' }}>
                  <button className="btn secondary btn-sm" onClick={() => { void loadMoreGroups(); }}>
                    Load older group orders
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── 2. ALL ACCOUNT ORDERS VIEW (Flat List) ── */}
      {viewMode === 'flat' && isSuccess && (
        <>
          {flatRows.length === 0 ? (
            <div className="empty-state">
              <p>No account orders found.</p>
              <p className="muted">Individual execution legs will appear here.</p>
            </div>
          ) : (
            <>
              {/* Desktop Table (> 768px) */}
              <div className="table-scroll-container desktop-pos-table">
                <table>
                  <thead>
                    <tr>
                      <th>Account</th>
                      <th>Order</th>
                      <th>Market</th>
                      <th style={{ textAlign: 'right' }}>Qty</th>
                      <th>Outcome</th>
                      <th>Venue / Refusal Detail</th>
                      <th style={{ textAlign: 'right' }}>Group Report</th>
                    </tr>
                  </thead>
                  <tbody>
                    {flatRows.map((r) => <FlatChildRow key={r.id} r={r} />)}
                  </tbody>
                </table>
              </div>

              {/* Mobile Order Cards (<= 768px) */}
              <div className="mobile-pos-cards">
                {flatRows.map((r) => <MobileBlotterCard key={`mobile-${r.id}`} r={r} />)}
              </div>

              {nextFlatCursor !== null && (
                <div style={{ marginTop: 14, textAlign: 'center' }}>
                  <button className="btn secondary btn-sm" onClick={() => { void loadMoreFlat(); }}>
                    Load older account orders
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
