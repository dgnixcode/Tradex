// The futures anti-duplicate lock repo — plan/phase-15 T15.4.
//
// The load-bearing correctness substitute for the missing `client_order_id` on
// CoinDCX futures (research/03 Verdict). Before any send-through path for a
// (account, pair) enters write-before-send, it MUST acquire this row. INSERT ON
// CONFLICT DO NOTHING makes the race atomic: exactly one holder wins; the other
// caller stands down (like spot's write-before-send `state='planned'` race).
//
// A crash between acquire and send leaves the row stale. The reaper releases
// any lock older than `staleMs` — default 30 s, comfortably outside the venue's
// 10-second signing window so a legitimately-in-flight send is never reaped.

import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DB } from './schema.js';

export interface AcquireArgs {
  readonly tenantId: string;
  readonly accountId: string;
  readonly pair: string;
  readonly childOrderId: string;
  readonly workerId: string;
  readonly now?: Date | undefined;
}

/** Attempt to acquire the (account, pair) lock. `true` = we hold it. */
export async function acquireFuturesLock(db: Kysely<DB>, args: AcquireArgs): Promise<boolean> {
  const now = args.now ?? new Date();
  const res = await sql<{ account_id: string }>`
    INSERT INTO futures_execution_lock
      (tenant_id, account_id, pair, child_order_id, acquired_at, locked_by)
    VALUES (${args.tenantId}, ${args.accountId}, ${args.pair}, ${args.childOrderId}, ${now}, ${args.workerId})
    ON CONFLICT (account_id, pair) DO NOTHING
    RETURNING account_id
  `.execute(db);
  return res.rows.length === 1;
}

/** Release a lock we hold. Never throws when the row is gone — the reaper may
 *  have already claimed it. */
export async function releaseFuturesLock(
  db: Kysely<DB>,
  args: { readonly accountId: string; readonly pair: string; readonly childOrderId: string },
): Promise<void> {
  await sql`
    DELETE FROM futures_execution_lock
    WHERE account_id = ${args.accountId} AND pair = ${args.pair} AND child_order_id = ${args.childOrderId}
  `.execute(db);
}

/**
 * The reaper: release any (account, pair) lock older than `staleMs`, in the
 * same shape as `requeueStale` for execution_job. Default 30 s is well outside
 * the venue's 10-second signing window, so a legitimate send in flight is not
 * reaped. Returns the released rows for observability + alert A17.
 */
export async function reapStaleFuturesLocks(
  db: Kysely<DB>,
  opts: { readonly staleMs?: number; readonly now?: Date } = {},
): Promise<ReadonlyArray<{ readonly accountId: string; readonly pair: string; readonly childOrderId: string; readonly acquiredAt: Date }>> {
  const staleMs = opts.staleMs ?? 30_000;
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - staleMs);
  const res = await sql<{
    account_id: string; pair: string; child_order_id: string; acquired_at: Date;
  }>`
    DELETE FROM futures_execution_lock
    WHERE acquired_at < ${cutoff}
    RETURNING account_id, pair, child_order_id, acquired_at
  `.execute(db);
  return res.rows.map((r) => ({
    accountId: String(r.account_id),
    pair: String(r.pair),
    childOrderId: String(r.child_order_id),
    acquiredAt: r.acquired_at,
  }));
}
