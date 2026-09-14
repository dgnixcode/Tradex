// The ops readouts — plan/phase-13 T13.2.
//
// Assembles the DB-sourced signals the alert engine (packages/ops) evaluates.
// Deliberately returns raw numbers/bools; a signal that has no monitoring in this
// build is left absent (the engine treats an absent signal as "not evaluated",
// never a false fire). A11/A16/A18 are real from our own tables today; A3 (a
// running reconciler), A5/A6 (venue fills + a wired signer) and A15 (a 30-day
// notional p95) land when the Phase-14 processes exist.

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from './schema.js';
import { forTenant } from './tenant-scope.js';
import { verifyHoldings } from './ledger-repo.js';

export interface OpsReadouts {
  /** A11 — ms since the oldest unclaimed place job became due, or null. */
  readonly oldestPlaceJobMs: number | null;
  /** A16 — true when any kill switch / non-normal mode is engaged. */
  readonly killSwitchOn: boolean;
  /** A18 — true when the ledger L2 invariant fails for any scoped account. */
  readonly ledgerInvariantBroken: boolean | null;
}

/**
 * The DB-sourced alert signals, at `nowMs`.
 *
 * A11: the oldest `place` job still unclaimed and due.
 * A16: the platform kill switch / mode, the tenant's pause flag, or any
 *     market_state row flipped off normal.
 * A18: `verifyHoldings` over each of `accountIds` — the periodic L2 check the
 *     books must pass. Null when no accounts were scoped.
 */
export async function readOpsReadouts(
  db: Kysely<DB>,
  tenantId: string,
  accountIds: readonly string[],
  nowMs: number,
): Promise<OpsReadouts> {
  const now = new Date(nowMs);

  const place = await sql<Record<string, unknown>>`SELECT run_after FROM execution_job
        WHERE kind = 'place' AND locked_by IS NULL AND run_after <= ${now}
        ORDER BY run_after LIMIT 1`.execute(db);
  const placeRow = place.rows[0];
  const oldestPlaceJobMs = placeRow === undefined
    ? null
    : Math.max(0, nowMs - (placeRow['run_after'] as Date).getTime());

  const [platform, tenant, markets] = await Promise.all([
    sql`SELECT global_kill_switch, mode FROM platform_state LIMIT 1`.execute(db),
    sql`SELECT trading_paused FROM tenant_limit WHERE tenant_id = ${tenantId} LIMIT 1`.execute(db),
    sql`SELECT count(*)::int AS n FROM market_state WHERE mode <> 'normal'`.execute(db),
  ]);
  const p = (platform.rows as Array<Record<string, unknown>>)[0];
  const t = (tenant.rows as Array<Record<string, unknown>>)[0];
  const m = (markets.rows as Array<Record<string, unknown>>)[0];
  const killSwitchOn = (p !== undefined && (p['global_kill_switch'] === true || p['mode'] !== 'normal'))
    || (t !== undefined && t['trading_paused'] === true)
    || (m !== undefined && Number(m['n']) > 0);

  let ledgerInvariantBroken: boolean | null = null;
  if (accountIds.length > 0) {
    const tdb = forTenant(db, tenantId);
    ledgerInvariantBroken = false;
    for (const accountId of accountIds) {
      const res = await verifyHoldings(tdb, accountId);
      if (!res.ok) {
        ledgerInvariantBroken = true;
        break;
      }
    }
  }

  return { oldestPlaceJobMs, killSwitchOn, ledgerInvariantBroken };
}

export interface DeployBlockers {
  /** How many group trades are mid-execution right now. */
  readonly executingTrades: number;
  /** The oldest submitted_at of an executing trade, or null when none. */
  readonly oldestExecutingSince: Date | null;
}

/**
 * Deploy safety (T13.7 / research/20 F5): a deploy must not land mid-fan-out.
 * Refuse while any group_trade is still `executing` — the pre-deploy guard reads
 * this and blocks (scripts/deploy-guard.mjs).
 */
export async function readDeployBlockers(db: Kysely<DB>): Promise<DeployBlockers> {
  const res = await sql<Record<string, unknown>>`SELECT count(*)::int AS n, min(submitted_at) AS oldest
        FROM group_trade WHERE status = 'executing'`.execute(db);
  const row = res.rows[0];
  return {
    executingTrades: row === undefined ? 0 : Number(row['n']),
    oldestExecutingSince: row === undefined ? null : (row['oldest'] as Date | null),
  };
}
