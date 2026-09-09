// Trading-state service — plan/phase-05 T05.2, T05.3, T05.4, T05.5.
//
// Makes the tenant's OWN brakes real and auditable: the customer pause (trader
// can pause without re-auth; only owner can resume, with re-auth — the asymmetry
// from packages/auth/roles.ts, enforced at the route, not here), the per-tenant
// limits, and the read of the whole trading state for the UI.
//
// This service never decides WHO may act — the route consults authorise() for
// that, because a role check needs the request's Principal. What this service
// owns is the WRITE and its audit trail: every change to a switch or a cap lands
// an audit row with the actor and the before/after state (T05.5), so a customer
// can see who paused their desk and when.
//
// Account-frozen and market_state changes are operator/internal actions and are
// deliberately NOT here: the account-frozen fields and market_state table exist
// for the GATE to read, and the gate-check (05-kill-switch) drives them by
// writing rows directly, exactly as an internal operator tool would.

import { forTenant, insertAuditEvent, readPlatformFlags, readTenantCaps } from '@tradex/db';
import type { DB, TenantDb } from '@tradex/db';
import type { Kysely } from 'kysely';

export class TradingStateError extends Error {
  override readonly name = 'TradingStateError';
  constructor(
    message: string,
    readonly reason: 'not_paused' | 'already_paused' | 'bad_amount' | 'no_limit_row' | 'no_change',
  ) {
    super(message);
  }
}

export interface TradingState {
  readonly platform: { killSwitch: boolean; mode: 'normal' | 'cancel_only' | 'read_only'; modeReason: string | null };
  readonly tenant: { tradingPaused: boolean; pausedReason: string | null };
  readonly caps: { perOrderNotionalMinor: string; dailyNotionalMinor: string };
  /** Markets not in normal mode, with their mode and reason — the UI shows these. */
  readonly restrictedMarkets: readonly { market: string; mode: string; reason: string | null }[];
}

export interface AuditActor {
  readonly userId: string;
  readonly tenantId: string;
  /** e.g. 'api' — the process acting on the customer's behalf. */
  readonly process: string;
}

const NONEMPTY_REASON = (r: string): string => {
  const t = r.trim();
  if (t === '') throw new TradingStateError('a reason is required', 'bad_amount');
  return t;
};

const MINOR_AMOUNT = (v: string, field: string): string => {
  if (!/^\d+$/.test(v) || v === '0') {
    throw new TradingStateError(`${field} must be a positive integer amount in minor units`, 'bad_amount');
  }
  return v;
};

export class TradingStateService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly tdb: TenantDb,
  ) {}

  /** The full state the UI renders (GET /api/trading/state). */
  async readState(): Promise<TradingState> {
    const platform = await readPlatformFlags(this.db);
    const caps = await readTenantCaps(this.tdb);
    // Which markets are currently restricted — a market_state row in normal mode is
    // not shown; only the ones an operator has switched need customer visibility.
    const rows = await this.db.selectFrom('market_state')
      .select(['market', 'mode', 'reason'])
      .where('mode' as never, '<>', 'normal' as never)
      .orderBy('market' as never)
      .execute();
    return {
      platform: { ...platform },
      tenant: { tradingPaused: caps.tradingPaused, pausedReason: caps.pausedReason },
      caps: { perOrderNotionalMinor: caps.perOrderNotionalMinor, dailyNotionalMinor: caps.dailyNotionalMinor },
      restrictedMarkets: (rows as ReadonlyArray<{ market: string; mode: string; reason: string | null }>)
        .map((r) => ({ market: r.market, mode: r.mode, reason: r.reason })),
    };
  }

  /** Pause the whole desk. Trader may do this with no re-auth (route enforces). */
  async pause(actor: AuditActor, reason: string, atMs?: number): Promise<void> {
    const at = new Date(atMs ?? Date.now());
    const cleanReason = NONEMPTY_REASON(reason);
    const caps = await readTenantCaps(this.tdb);
    if (caps.tradingPaused) {
      throw new TradingStateError('trading is already paused', 'already_paused');
    }
    await this.tdb.updateTable('tenant_limit')
      .set({ trading_paused: true, paused_at: at, paused_reason: cleanReason } as never)
      .execute();
    await insertAuditEvent(this.db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      actorProcess: actor.process,
      action: 'trading.pause',
      subjectType: 'tenant',
      subjectId: actor.tenantId,
      before: { tradingPaused: false },
      after: { tradingPaused: true, pausedReason: cleanReason, pausedAt: at.toISOString() },
      occurredAt: at,
    });
  }

  /** Resume the desk. Owner only, with re-auth (route enforces both). */
  async resume(actor: AuditActor, atMs?: number): Promise<void> {
    const at = new Date(atMs ?? Date.now());
    const caps = await readTenantCaps(this.tdb);
    if (!caps.tradingPaused) {
      throw new TradingStateError('trading is not paused', 'not_paused');
    }
    const wasReason = caps.pausedReason;
    await this.tdb.updateTable('tenant_limit')
      .set({ trading_paused: false, paused_at: null, paused_reason: null } as never)
      .execute();
    await insertAuditEvent(this.db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      actorProcess: actor.process,
      action: 'trading.resume',
      subjectType: 'tenant',
      subjectId: actor.tenantId,
      before: { tradingPaused: true, pausedReason: wasReason },
      after: { tradingPaused: false },
      occurredAt: at,
    });
  }

  /**
   * Update the tenant's limits (owner + re-auth at the route). Any subset of the
   * caps may be provided; the audit row records before/after for the whole set so
   * a viewer can see exactly what moved.
   */
  async updateLimits(
    actor: AuditActor,
    patch: { maxOrderNotionalMinor?: string; maxDailyNotionalMinor?: string },
    atMs?: number,
  ): Promise<void> {
    const at = new Date(atMs ?? Date.now());
    const caps = await readTenantCaps(this.tdb);
    const set: Record<string, unknown> = {};
    const next = {
      perOrderNotionalMinor: caps.perOrderNotionalMinor,
      dailyNotionalMinor: caps.dailyNotionalMinor,
    };
    if (patch.maxOrderNotionalMinor !== undefined) {
      const v = MINOR_AMOUNT(patch.maxOrderNotionalMinor, 'maxOrderNotionalMinor');
      set['max_order_notional_minor'] = v;
      next.perOrderNotionalMinor = v;
    }
    if (patch.maxDailyNotionalMinor !== undefined) {
      const v = MINOR_AMOUNT(patch.maxDailyNotionalMinor, 'maxDailyNotionalMinor');
      set['max_daily_notional_minor'] = v;
      next.dailyNotionalMinor = v;
    }
    if (Object.keys(set).length === 0) throw new TradingStateError('nothing to change', 'no_change');

    await this.tdb.updateTable('tenant_limit').set(set as never).execute();
    await insertAuditEvent(this.db, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      actorProcess: actor.process,
      action: 'limits.update',
      subjectType: 'tenant',
      subjectId: actor.tenantId,
      before: {
        perOrderNotionalMinor: caps.perOrderNotionalMinor,
        dailyNotionalMinor: caps.dailyNotionalMinor,
      },
      after: next,
      occurredAt: at,
    });
  }
}

/** Convenience: a service scoped to a tenant from a raw db + tenant id. */
export const tradingStateFor = (db: Kysely<DB>, tenantId: string): TradingStateService =>
  new TradingStateService(db, forTenant(db, tenantId));
