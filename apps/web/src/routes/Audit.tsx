import { useQuery } from '@tanstack/react-query';
import { fetchAudit } from '../api.ts';

// The tenant's audit trail (phase-05 T05.5: every switch, cap and mode change is
// visible in the tenant's own view). Owner and trader only — a viewer is refused
// by the server (view.audit). Each row is the actor + before/after of a change,
// newest first, so a customer can see who paused their desk and what moved.

const ACTION_LABEL: Record<string, string> = {
  'trading.pause': 'Paused trading',
  'trading.resume': 'Resumed trading',
  'limits.update': 'Changed limits',
  'account.totp.enable': 'Enabled 2FA',
};

/** A compact summary of a change's before/after. */
function changeSummary(row: { before: unknown; after: unknown }): string {
  const after = row.after as { pausedReason?: string; perOrderNotionalMinor?: string; dailyNotionalMinor?: string } | null;
  if (after !== null && after !== undefined && typeof after === 'object') {
    if (typeof after.pausedReason === 'string') return after.pausedReason;
    const order = after.perOrderNotionalMinor;
    const daily = after.dailyNotionalMinor;
    if (order !== undefined || daily !== undefined) {
      const parts: string[] = [];
      if (order !== undefined) parts.push(`per-order ${order}`);
      if (daily !== undefined) parts.push(`daily ${daily}`);
      return parts.join(' · ');
    }
  }
  // Fall back to a one-line JSON so nothing is silently hidden.
  const text = JSON.stringify(row.after ?? row.before);
  return text === undefined || text === '{}' || text === 'null' ? '—' : text.slice(0, 60);
}

const fmtTime = (iso: string): string => new Date(iso).toLocaleString(undefined, {
  day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
});

export function Audit() {
  const audit = useQuery({ queryKey: ['audit'], queryFn: fetchAudit });

  return (
    <div className="panel">
      <h2>Audit trail</h2>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        Every change to a switch, a limit or a mode — who did it and what moved.
      </p>

      {audit.isLoading && <p className="muted">Loading…</p>}
      {audit.isError && <div className="error">{(audit.error as Error).message}</div>}

      {audit.isSuccess && audit.data.length === 0 && (
        <div className="empty-state">
          <p className="muted">No changes recorded yet. Pause trading or change a limit and it will appear here.</p>
        </div>
      )}

      {audit.isSuccess && audit.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Action</th>
              <th>Detail</th>
              <th>Via</th>
            </tr>
          </thead>
          <tbody>
            {audit.data.map((r) => (
              <tr key={r.id}>
                <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.occurredAt)}</td>
                <td>{ACTION_LABEL[r.action] ?? r.action}</td>
                <td className="muted">{changeSummary(r)}</td>
                <td>{r.actorProcess}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
