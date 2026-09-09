import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { fetchTrade, retryFailedTrade } from '../api.ts';
import type { PreviewRow } from '../api.ts';

// The live-execution progress screen (T08.6 / 21 F4). After a REAL confirm the
// operator lands here and the page opens an EventSource to
// GET /group-trades/:id/stream. The stream seeds every account's present state,
// then pushes one `state` event per leg as the worker settles it, and closes
// with a durable `report` + `done`. The worker persists FIRST and only then
// publishes, so this page is a live projection of already-durable rows — closing
// the page never affects the fan-out (the SSE route unsubscribes on close; the
// execution is the server's).
//
// The rows are the plan's child rows (which carry account names + markets),
// updated in place by the stream — the account-name join lives here, because the
// wire only carries accountId. Terminal transitions are appended to an aria
// `log` region so a screen reader (or an operator not staring at the table)
// hears each account land. When a leg is terminal-failed and the stream is done,
// a retry CTA offers to re-plan JUST those accounts as a fresh trade (T08.7).

/** A settle that is not a working state — worth announcing. */
const PENDING: ReadonlySet<string> = new Set(['planned', 'sending', 'ambiguous']);
/** States that mean the leg never got placed and may be retried (T08.7). */
const RETRYABLE: ReadonlySet<string> = new Set(['skipped', 'rejected', 'not_placed', 'needs_human', 'unknown']);
/** States that count as a placed order for the summary. */
const PLACED: ReadonlySet<string> = new Set(['acked', 'open', 'partially_filled', 'filled']);

/** A live child-order state merged from seed + events on the wire. */
interface LiveRow {
  readonly state: string;
  readonly exchangeOrderId: string | null;
  readonly refusalCode: string | null;
  readonly refusalDetail: string | null;
}

interface Announcement {
  readonly key: string;
  readonly accountId: string;
  readonly state: string;
  readonly detail: string | null;
}

type StreamPhase = 'connecting' | 'live' | 'done' | 'error';

export function Execution() {
  const { groupTradeId = '' } = useParams();
  const navigate = useNavigate();

  // The plan provides the account names + markets to label the stream's rows.
  // The plan is fixed once previewed, so it is fetched once and never refetched.
  const trade = useQuery({
    queryKey: ['trade', groupTradeId],
    queryFn: () => fetchTrade(groupTradeId),
    staleTime: Infinity,
  });

  const [live, setLive] = useState<ReadonlyMap<string, LiveRow>>(new Map());
  const [header, setHeader] = useState<{ status: string; dryRun: boolean } | null>(null);
  const [phase, setPhase] = useState<StreamPhase>('connecting');
  const [log, setLog] = useState<readonly Announcement[]>([]);
  // The previous state per account, so a terminal transition is announced exactly
  // when it happens (never for the opening seed).
  const lastState = useRef(new Map<string, string>());

  useEffect(() => {
    let gotHeader = false;
    const es = new EventSource(`/api/group-trades/${groupTradeId}/stream`);

    /** One `state` frame: a per-account projection of a persisted child row. */
    const onState = (raw: Event) => {
      let frame: { accountId?: string; state?: string; exchangeOrderId?: string | null; refusalCode?: string | null; refusalDetail?: string | null };
      try {
        frame = JSON.parse((raw as MessageEvent).data as string) as typeof frame;
      } catch {
        return;
      }
      const { accountId, state } = frame;
      if (typeof accountId !== 'string' || typeof state !== 'string') return;
      setLive((prev) => {
        const next = new Map(prev);
        next.set(accountId, {
          state,
          exchangeOrderId: frame.exchangeOrderId ?? null,
          refusalCode: frame.refusalCode ?? null,
          refusalDetail: frame.refusalDetail ?? null,
        });
        return next;
      });
      const prevS = lastState.current.get(accountId);
      lastState.current.set(accountId, state);
      if (prevS !== undefined && prevS !== state && !PENDING.has(state)) {
        const key = `${accountId}:${state}`;
        setLog((old) =>
          old.some((a) => a.key === key)
            ? old
            : [...old.slice(-39), {
                key, accountId, state,
                detail: frame.refusalDetail ?? frame.refusalCode ?? null,
              }]);
      }
    };

    /** The `header` frame confirms the subscription + seed are done. */
    const onHeader = (raw: Event) => {
      let d: { status?: string; dryRun?: boolean };
      try {
        d = JSON.parse((raw as MessageEvent).data as string) as typeof d;
      } catch {
        return;
      }
      if (typeof d.status === 'string' && typeof d.dryRun === 'boolean') {
        gotHeader = true;
        setHeader({ status: d.status, dryRun: d.dryRun });
        setPhase('live');
      }
    };

    /** `report` then `done` close the stream after the last settle. */
    const onDone = () => {
      clearTimeout(timer);
      setPhase('done');
      es.close();
    };

    // If no header arrives in 12s the stream is not going to come up — show that
    // rather than hanging in "connecting" forever.
    const timer = setTimeout(() => {
      if (!gotHeader) {
        setPhase('error');
        es.close();
      }
    }, 12_000);

    es.addEventListener('state', onState);
    es.addEventListener('header', onHeader);
    es.addEventListener('report', onDone);
    es.addEventListener('done', onDone);
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        clearTimeout(timer);
        setPhase((p) => (p === 'done' ? p : 'error'));
      } else {
        // Transient reconnect — the browser reopens the stream itself.
        setPhase((p) => (p === 'done' ? p : 'connecting'));
      }
    };
    return () => {
      clearTimeout(timer);
      es.close();
    };
  }, [groupTradeId]);

  const retry = useMutation({
    mutationFn: () => retryFailedTrade(groupTradeId),
    // The fresh preview is pre-scoped to the failed accounts — land the operator
    // on its confirmation screen.
    onSuccess: (fresh) => navigate(`/app/trades/${fresh.groupTradeId}`),
  });

  const nameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const row of trade.data?.rows ?? []) m.set(row.accountId, row.accountName);
    return m;
  }, [trade.data]);

  if (trade.isLoading) return <div className="panel">Loading the plan…</div>;
  if (trade.isError) return <div className="panel error">{(trade.error as Error).message}</div>;
  const plan = trade.data;
  if (plan === undefined) return <div className="panel">No plan found for this trade.</div>;

  // Merge the plan row with the latest streamed state for that account. A leg the
  // stream has not spoken about yet keeps its planned/skipped row state.
  const rowState = (row: PreviewRow): LiveRow =>
    live.get(row.accountId) ?? {
      state: row.state,
      exchangeOrderId: null,
      refusalCode: row.refusalCode,
      refusalDetail: row.refusalDetail,
    };

  const placed = plan.rows.filter((r) => PLACED.has(rowState(r).state)).length;
  const working = plan.rows.filter((r) => PENDING.has(rowState(r).state)).length;
  const failed = plan.rows.filter((r) => RETRYABLE.has(rowState(r).state)).length;
  const allSettled = phase === 'done';
  const canRetry = failed > 0 && allSettled && !retry.isPending;

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Live execution</h2>
        <span className="mono muted">{plan.groupTradeId.slice(0, 8)}…</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {phase !== 'connecting' && <span className={`badge ${phaseBadge(phase)}`}>{phaseLabel(phase)}</span>}
          {header !== null && <span className="badge state">{header.status}</span>}
        </span>
      </div>

      {/* The summary strip — "placing… · N placed · M failed" updates live. */}
      <div className="row" style={{ marginBottom: 12, gap: 8 }}>
        <span className="muted">{working > 0 ? 'placing…' : allSettled ? 'settled' : 'settling'}</span>
        <span style={{ color: 'var(--ok)' }}>{placed} placed</span>
        {failed > 0 && <span style={{ color: 'var(--danger)' }}>{failed} failed</span>}
      </div>

      <table>
        <thead>
          <tr>
            <th>Account</th>
            <th>Status</th>
            <th>Market</th>
            <th className="mono">Quantity</th>
            <th className="mono">Exchange order</th>
            <th>Detail</th>
          </tr>
        </thead>
        <tbody>
          {plan.rows.map((row) => {
            const s = rowState(row);
            return (
              <tr key={row.accountId} className={RETRYABLE.has(s.state) ? 'skipped' : ''}>
                <td>{row.accountName}</td>
                <td><span className={`badge ${s.state}`}>{s.state}</span></td>
                <td>{row.market ?? '—'}</td>
                <td className="mono">{row.finalQuantity ?? '—'}</td>
                <td className="mono">{s.exchangeOrderId ?? '—'}</td>
                <td>{s.refusalDetail ?? s.refusalCode ?? (s.state === 'planned' ? describeBasis(row) : '')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* A live log region: screen readers announce each newly appended terminal
          transition, and the operator sees the account-by-account trail. Names
          are resolved at render time, so lines written before the plan arrived
          fill in once it does. */}
      <div role="log" aria-live="polite" className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        {log.map((a) => (
          <div key={a.key}>
            {nameById.get(a.accountId) ?? a.accountId.slice(0, 8)} → {a.state}
            {a.detail !== null ? ` — ${a.detail}` : ''}
          </div>
        ))}
      </div>

      {phase === 'error' && (
        <div className="error" style={{ marginTop: 8 }}>
          Live progress is unavailable — the execution engine may not be wired in this build.
          {header === null && ' The stream could not be opened.'}
        </div>
      )}

      {canRetry ? (
        <div className="row" style={{ marginTop: 12 }}>
          <div className="spread-warning" style={{ borderColor: 'var(--warn)' }}>
            {failed} account{failed === 1 ? '' : 's'} never got placed. Retrying opens a FRESH trade
            ticket pre-scoped to just those accounts, re-priced against the current book — the
            old trade is left exactly as it stands.
          </div>
          <button className="btn" onClick={() => retry.mutate()} disabled={retry.isPending}>
            {retry.isPending ? 'Re-previewing…' : `Retry the ${failed} failed`}
          </button>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn secondary" onClick={() => navigate(`/app/trades/${plan.groupTradeId}`)}>
            Back to the confirmation
          </button>
        </div>
      )}
      {retry.isError && <div className="error" style={{ marginTop: 8 }}>{(retry.error as Error).message}</div>}
    </div>
  );
}

function describeBasis(row: PreviewRow): string {
  const parts = [row.basisUsed, row.currencyChoiceReason].filter((s) => s !== null && s !== '');
  return parts.join(' · ');
}

function phaseLabel(phase: StreamPhase): string {
  return phase === 'connecting' ? 'connecting…' : phase === 'live' ? 'live' : phase === 'done' ? 'done' : 'unavailable';
}

function phaseBadge(phase: StreamPhase): string {
  return phase === 'live' ? 'open' : phase === 'done' ? 'skipped' : 'rejected';
}
