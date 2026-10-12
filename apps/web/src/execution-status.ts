import type { ExecutionReportResponse } from './api.ts';

export const EXECUTION_PENDING = new Set(['planned', 'sending', 'ambiguous']);
const TERMINAL = new Set(['filled', 'skipped', 'rejected', 'not_placed', 'cancelled', 'partially_cancelled', 'unknown', 'needs_human']);

export function executionStarted(snapshot: ExecutionReportResponse): boolean {
  return snapshot.status === 'executing' || snapshot.status === 'completed'
    || snapshot.report.rows.some(row => row.state !== 'planned' && row.state !== 'skipped');
}

export function executionFinished(snapshot: ExecutionReportResponse): boolean {
  return snapshot.status === 'completed' || snapshot.status === 'abandoned'
    || (executionStarted(snapshot) && snapshot.report.rows.length > 0 && snapshot.report.rows.every(row => TERMINAL.has(row.state)));
}
