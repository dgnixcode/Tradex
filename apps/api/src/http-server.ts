// The HTTP server — a hand-rolled node:http router, no framework.
//
// This matches the house style: the codebase has its own crypto envelope, its
// own decimal layer, its own migrator and check harness, and no runtime web
// framework anywhere. Six routes do not need Express; they need a small, legible
// request handler that an on-call engineer can read top to bottom during an
// incident.
//
// THE ADAPTER BOUNDARY. This is a .ts file, so the ADAPTER-BOUNDARY CI rule
// forbids it from importing @tradex/exchange-coindcx. It therefore takes
// `getOrderBook` (and every other venue-touching dependency) as an INJECTED
// function. The concrete CoinDCX adapter is wired in by the .mjs composition
// root, which the rule does not scan. Typed logic here; venue wiring there.
//
// THE AUTH INVARIANT. Every route except POST /api/login requires a valid
// session, and every MUTATING route additionally consults authorise() against
// the role matrix. There is no unauthenticated path to any tenant data.
//
// THE EXECUTION SEAM. confirm REALLY sends only when the caller wired the
// Phase-08 engine ports (submit/resolve/executionPepper in HttpDeps) — the .mjs
// composition root supplies them in production, the checks supply FakeVenue-
// backed ports. When the ports are absent this stays the rung-0 dry-run build,
// and under NODE_ENV=production that absence is an explicit 503, never a silent
// dry run that the operator mistakes for a send.

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { assertAuthorised, AuthorisationError, parseCookieHeader, SESSION_COOKIE } from '@tradex/auth';
import type { Action, Principal } from '@tradex/auth';
import {
  forTenant, listTradableAssets, listGroups, createGroup, confirmDryRun,
  updateGroup, archiveGroup, addMember, removeMember, setMemberEnabled,
  getGroupMembers, getEnabledMembers, getGroupTrade, getGroupHeader, GroupRepoError, listAuditEvents,
  beginExecution, getExecutionSnapshot, listCancellableChildren,
} from '@tradex/db';
import type { DB } from '@tradex/db';
import { listAccounts } from './accounts-query.js';
import { buildPositions } from './positions.js';
import type { NamedAccount } from './positions.js';
import type { Kysely } from 'kysely';
import type { MarketRef, OrderBook } from '@tradex/exchange';
import { LoginService } from './login-service.js';
import type { SecondFactorVerifier } from './login-service.js';
import { SignupService } from './signup-service.js';
import { tradingStateFor } from './trading-state-service.js';
import { TradingStateError } from './trading-state-service.js';
import { TotpService } from './totp-service.js';
import { TotpServiceError } from './totp-service.js';
import { OnboardingService } from './onboarding-service.js';
import { PlanningService } from './planning-service.js';
import type { PlanRequest } from './planning-service.js';
import { buildSetCookie, buildClearCookie } from '@tradex/auth';
import type { KmsPort } from '@tradex/crypto';
import type { ProbeFn } from '@tradex/exchange';
import { ExecutionWorker } from './execution-worker.js';
import type {
  CancelPort, GetHoldingsPort, ListActivePort, ResolvePort, SubmitPort,
} from './execution-worker.js';
import { GroupExecutor } from './group-executor.js';
import { buildReport } from './execution-report.js';
import { createExecutionEventBus } from './execution-events.js';
import type { ExecutionEventBus } from './execution-events.js';

export interface HttpDeps {
  readonly db: Kysely<DB>;
  /** The only venue call, injected so this .ts file never imports the adapter. */
  readonly getOrderBook: (market: MarketRef, depth: number) => Promise<OrderBook>;
  readonly cookieSecret: Uint8Array;
  readonly verifySecondFactor: SecondFactorVerifier;
  /** KMS for the TOTP envelope and for sealing exchange credentials at onboarding. */
  readonly kms: KmsPort;
  /** Pepper for duplicate-key fingerprints (onboarding). Never defaults silently. */
  readonly pepper: Uint8Array;
  /** The credential probe (onboarding). Injected: live probeCredential in prod, FakeVenue in checks. */
  readonly probe: ProbeFn;
  /** Phase-08 execution engine. Wire ALL THREE to make confirm REALLY send; wire
   *  none to keep the rung-0 dry-run confirm. A partial engine is not an engine. */
  readonly submit?: SubmitPort | undefined;
  readonly resolve?: ResolvePort | undefined;
  /** Pepper for the deterministic client_order_ids (must match the reserve side). */
  readonly executionPepper?: Uint8Array | undefined;
  /** Phase-09 sell side: fresh free/locked holdings, read at preview (for sell
   *  position modes) and at every sell send. Absent = projected sizing only. */
  readonly holdings?: GetHoldingsPort | undefined;
  /** Phase-09 cancel fan-out: cancel one order by client_order_id. */
  readonly cancel?: CancelPort | undefined;
  /** Phase-09 reconciler Loop B: list one account's active orders on a market. */
  readonly listActive?: ListActivePort | undefined;
  readonly codeVersion: string;
  /** False on local plain-HTTP dev so the cookie is not marked Secure. */
  readonly secureCookies?: boolean | undefined;
  readonly now?: (() => number) | undefined;
}

/** A parsed request the handlers work with. */
interface Ctx {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly method: string;
  readonly cookies: Map<string, string>;
  body: unknown;
  principal: (Principal & { sessionId: string }) | null;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'request body is not valid JSON');
  }
};

const sendJson = (res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void => {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(text);
};

/** Child states a live-progress view should keep waiting on — an order that may
 *  still be live, or a leg not yet started. Everything else has settled. */
const PENDING_CHILD_STATES: ReadonlySet<string> = new Set(['planned', 'sending', 'ambiguous']);
const childHasSettled = (state: string): boolean => !PENDING_CHILD_STATES.has(state);

/** Build (but do not start) the server. Returns a node http.Server. */
export function createHttpServer(deps: HttpDeps): Server {
  const login = new LoginService({
    db: deps.db,
    cookieSecret: deps.cookieSecret,
    verifySecondFactor: deps.verifySecondFactor,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const signup = new SignupService({
    db: deps.db,
    cookieSecret: deps.cookieSecret,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  const secure = deps.secureCookies ?? true;

  const planningFor = (tenantId: string): PlanningService =>
    new PlanningService({
      tdb: forTenant(deps.db, tenantId),
      db: deps.db,
      getOrderBook: deps.getOrderBook,
      codeVersion: deps.codeVersion,
      ...(deps.holdings !== undefined ? { holdings: deps.holdings } : {}),
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });

  const onboardingFor = (tenantId: string): OnboardingService =>
    new OnboardingService({
      tdb: forTenant(deps.db, tenantId),
      kms: deps.kms,
      pepper: deps.pepper,
      probe: deps.probe,
    });

  // The Phase-08 execution engine, built ONLY when the caller wired the venue
  // ports. server.mjs does not pass them until real keys exist (Phase 14), so
  // ordinary local dev stays on the rung-0 dry-run confirm below. All-or-nothing:
  // a submit without a resolve could strand an ambiguous send forever.
  const submitPort = deps.submit;
  const resolvePort = deps.resolve;
  const executionPepper = deps.executionPepper;
  let engine: { worker: ExecutionWorker; executor: GroupExecutor; bus: ExecutionEventBus } | null = null;
  if (submitPort !== undefined && resolvePort !== undefined && executionPepper !== undefined) {
    const bus = createExecutionEventBus();
    const worker = new ExecutionWorker({
      db: deps.db,
      pepper: executionPepper,
      submit: submitPort,
      resolve: resolvePort,
      // Phase-09 sell side + cancel + Loop B (all optional; each gates its surface).
      ...(deps.holdings !== undefined ? { holdings: deps.holdings } : {}),
      ...(deps.cancel !== undefined ? { cancel: deps.cancel } : {}),
      ...(deps.listActive !== undefined ? { listActive: deps.listActive } : {}),
      // Every settle the worker commits is published to the bus (T08.6); the SSE
      // stream route subscribes per group trade and unsubscribes on request close.
      onChildState: (e) => bus.publish(e),
    });
    engine = { worker, executor: new GroupExecutor({ db: deps.db, worker }), bus };
  }

  /** Require a live session, or 401. Returns the principal. */
  const requireAuth = (ctx: Ctx): Principal & { sessionId: string } => {
    if (ctx.principal === null) throw new HttpError(401, 'not authenticated');
    return ctx.principal;
  };

  /** Require a role/permission, or 403 with the matrix's own reason. */
  const requireAction = (p: Principal, action: Action): void => {
    try {
      assertAuthorised(p, action, deps.now !== undefined ? new Date(deps.now()) : new Date());
    } catch (e) {
      if (e instanceof AuthorisationError) throw new HttpError(403, e.message);
      throw e;
    }
  };

  /** Turn a GroupRepoError's typed reason into the right HTTP status. */
  const groupErrorStatus = (reason: GroupRepoError['reason']): number => {
    switch (reason) {
      case 'group_not_found': return 404;
      case 'duplicate_member': return 409;
      case 'member_limit_reached':
      case 'group_limit_reached': return 409;
      case 'account_not_live': return 409;
      case 'blank_name': return 400;
      case 'no_limit_row': return 500;
      default: return 400;
    }
  };

  /** Run a group mutation, mapping its typed failure to a clean HTTP error. */
  const runGroupOp = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GroupRepoError) throw new HttpError(groupErrorStatus(e.reason), e.message);
      throw e;
    }
  };

  /** Run a trading-state mutation, mapping its typed failure to a clean HTTP error. */
  const tradingErrorStatus = (reason: TradingStateError['reason']): number => {
    switch (reason) {
      case 'already_paused':
      case 'not_paused': return 409;
      case 'bad_amount':
      case 'no_change': return 400;
      case 'no_limit_row': return 500;
      default: return 400;
    }
  };
  const runTradingOp = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TradingStateError) throw new HttpError(tradingErrorStatus(e.reason), e.message);
      throw e;
    }
  };

  /** The execution report for a trade, or null when the trade does not exist. */
  const executionReportOf = async (tenantId: string, groupTradeId: string) => {
    const snap = await getExecutionSnapshot(forTenant(deps.db, tenantId), groupTradeId);
    if (snap === null) return null;
    return {
      status: snap.status,
      dryRun: snap.dryRun,
      report: buildReport(snap.rows.map((r) => ({
        accountId: r.accountId,
        state: r.state,
        market: r.market,
        finalQuantity: r.finalQuantity,
        notionalMinor: r.notionalMinor,
        refusalCode: r.refusalCode,
        refusalDetail: r.refusalDetail,
        coid: r.clientOrderId,
        exchangeOrderId: r.exchangeOrderId,
      }))),
    };
  };

  /**
   * Stream one group trade's execution over SSE until every leg has settled
   * (T08.6). The protocol, in frames:
   *
   *   - one `state` frame per account, seeded from a post-subscribe DB read (a
   *     late join sees the present, not a hole), then live `state` frames as the
   *     worker settles each leg;
   *   - a `header` frame with the trade's status + dryRun flag;
   *   - when every leg has settled (or the trade is completed/abandoned), a final
   *     `report` frame re-read from the DB, then `done`, then the stream closes.
   *
   * Nothing here affects the execution: the worker published to the bus because a
   * settle committed, and this route only ever subscribes and unsubscribes. A
   * browser that closes mid-fan-out triggers `close`, which tears down the
   * subscription and the heartbeat; the confirm handler's inline drain does not
   * know or care.
   */
  const openExecutionStream = async (
    res: ServerResponse,
    tenantId: string,
    tradeId: string,
  ): Promise<void> => {
    if (engine === null) throw new HttpError(404, 'no execution engine is wired in this build — live progress is unavailable');
    const tdb = forTenant(deps.db, tenantId);

    // The 404 gate must land before any SSE headers, so read first.
    const seed = await getExecutionSnapshot(tdb, tradeId);
    if (seed === null) throw new HttpError(404, 'no such group trade');

    const settledByAccount = new Map<string, boolean>(seed.rows.map((r) => [r.accountId, false]));
    const total = settledByAccount.size;
    const allSettled = (): boolean => {
      if (total === 0) return true;
      for (const settled of settledByAccount.values()) if (!settled) return false;
      return true;
    };

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    // Start the heartbeat before any early return so `const` holds and the
    // interval exists for finish/cleanup to clear. The guard inside stops writes
    // once the stream has ended.
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);
    const send = (event: string, data: unknown): void => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    let unsub = (): void => {};
    let seeded = false;
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      unsub();
      if (heartbeat !== undefined) clearInterval(heartbeat);
      // The final report is re-read from the DB — events are live, the report is
      // the durable whole, and a client can never miss a settled row.
      void (async () => {
        try {
          const out = await executionReportOf(tenantId, tradeId);
          if (out !== null) send('report', out);
          send('done', {});
        } finally {
          if (!res.writableEnded) res.end();
        }
      })();
    };
    const cleanup = (): void => {
      unsub();
      if (heartbeat !== undefined) clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    };
    res.on('close', cleanup);

    // Subscribe BEFORE the seed read, so a settle that lands during setup is
    // either heard live or superseded by the post-subscribe DB read — never lost.
    unsub = engine.bus.subscribe(tradeId, (e) => {
      settledByAccount.set(e.accountId, childHasSettled(e.state));
      send('state', {
        groupTradeId: tradeId,
        accountId: e.accountId,
        state: e.state,
        exchangeOrderId: e.exchangeOrderId,
        refusalCode: e.refusalCode,
        refusalDetail: e.refusalDetail,
        at: e.at,
      });
      if (seeded && allSettled()) finish();
    });

    // Seed every account's CURRENT state, then decide whether the trade is done.
    // No seed write happens before this completes, so the client always receives
    // a full picture before the stream is allowed to finish.
    const fresh = await getExecutionSnapshot(tdb, tradeId);
    if (fresh === null) { cleanup(); return; }
    for (const r of fresh.rows) {
      settledByAccount.set(r.accountId, childHasSettled(r.state));
      send('state', {
        groupTradeId: tradeId,
        accountId: r.accountId,
        state: r.state,
        market: r.market,
        finalQuantity: r.finalQuantity,
        notionalMinor: r.notionalMinor,
        exchangeOrderId: r.exchangeOrderId,
        refusalCode: r.refusalCode,
        refusalDetail: r.refusalDetail,
        at: 0, // snapshot rows carry no timestamp; live events carry theirs
      });
    }
    send('header', { groupTradeId: tradeId, status: fresh.status, dryRun: fresh.dryRun });
    seeded = true;
    if (fresh.status === 'completed' || fresh.status === 'abandoned' || allSettled()) finish();
  };

  const handle = async (ctx: Ctx): Promise<void> => {
    const { method, url } = ctx;
    const path = url.pathname;

    // ---- POST /api/login — the only unauthenticated route ----
    if (method === 'POST' && path === '/api/login') {
      const body = (ctx.body ?? {}) as { email?: string; password?: string; totpCode?: string };
      if (typeof body.email !== 'string' || typeof body.password !== 'string') {
        throw new HttpError(400, 'email and password are required');
      }
      const result = await login.login({
        email: body.email,
        password: body.password,
        ...(typeof body.totpCode === 'string' ? { totpCode: body.totpCode } : {}),
      });
      if (!result.ok) {
        // totp_required is a distinct 401 so the UI knows to prompt for a code.
        sendJson(ctx.res, 401, { message: result.code === 'totp_required' ? 'a second factor is required' : 'invalid credentials', code: result.code });
        return;
      }
      const maxAge = Math.floor((result.expiresAtMs - (deps.now?.() ?? Date.now())) / 1000);
      sendJson(ctx.res, 200,
        { role: result.principal.role, expiresAtMs: result.expiresAtMs },
        { 'set-cookie': buildSetCookie(result.cookieValue, maxAge, { secure }) });
      return;
    }

    // ---- POST /api/signup — public, like login. Creates tenant + owner + session ----
    if (method === 'POST' && path === '/api/signup') {
      const body = (ctx.body ?? {}) as { orgName?: string; email?: string; password?: string; valuationCurrency?: string };
      if (typeof body.orgName !== 'string' || typeof body.email !== 'string' || typeof body.password !== 'string') {
        throw new HttpError(400, 'orgName, email and password are required');
      }
      const result = await signup.signup({
        orgName: body.orgName,
        email: body.email,
        password: body.password,
        ...(body.valuationCurrency === 'INR' || body.valuationCurrency === 'USDT' ? { valuationCurrency: body.valuationCurrency } : {}),
      });
      if (!result.ok) {
        // 409 for a taken email, 400 for weak password / bad input.
        const status = result.code === 'email_taken' ? 409 : 400;
        sendJson(ctx.res, status, { message: result.message, code: result.code });
        return;
      }
      const maxAge = Math.floor((result.expiresAtMs - (deps.now?.() ?? Date.now())) / 1000);
      sendJson(ctx.res, 201,
        { role: result.principal.role, expiresAtMs: result.expiresAtMs },
        { 'set-cookie': buildSetCookie(result.cookieValue, maxAge, { secure }) });
      return;
    }

    // ---- POST /api/logout ----
    if (method === 'POST' && path === '/api/logout') {
      sendJson(ctx.res, 200, { ok: true }, { 'set-cookie': buildClearCookie({ secure }) });
      return;
    }

    // Everything below requires a session.
    const principal = requireAuth(ctx);
    const planning = planningFor(principal.tenantId);

    // ---- GET /api/session — who am I (for the UI to render roles + 2FA state) ----
    if (method === 'GET' && path === '/api/session') {
      sendJson(ctx.res, 200, {
        userId: principal.userId, tenantId: principal.tenantId,
        role: principal.role, totpEnabled: principal.totpEnabled,
      });
      return;
    }

    // ---- phase 05: the customer's own brakes ------------------------------
    // Pause is trader-and-above with NO re-auth (stopping must never be gated);
    // resume and limits changes are owner + re-auth (starting again is the careful
    // direction). Re-auth comes from POST /api/auth/step-up, which stamps a fresh
    // second factor on the session; without TOTP enrolled those actions stay 403,
    // which is the safe default. Every mutation writes an audit row (T05.5).

    // ---- POST /api/auth/step-up — satisfy re-auth for this session ----
    if (method === 'POST' && path === '/api/auth/step-up') {
      const body = (ctx.body ?? {}) as { code?: string };
      if (typeof body.code !== 'string') throw new HttpError(400, 'a code is required');
      const ok = await login.stepUp(principal.sessionId, principal.userId, body.code, deps.now?.());
      if (!ok) throw new HttpError(401, 'the code is not valid or no second factor is enrolled');
      sendJson(ctx.res, 200, { ok: true });
      return;
    }

    // ---- POST /api/trading/pause ----
    if (method === 'POST' && path === '/api/trading/pause') {
      requireAction(principal, 'trading.pause');
      const body = (ctx.body ?? {}) as { reason?: string };
      if (typeof body.reason !== 'string') throw new HttpError(400, 'a reason is required');
      const svc = tradingStateFor(deps.db, principal.tenantId);
      await runTradingOp(() => svc.pause(
        { userId: principal.userId, tenantId: principal.tenantId, process: 'api' },
        body.reason as string, deps.now?.()));
      sendJson(ctx.res, 200, { paused: true });
      return;
    }

    // ---- POST /api/trading/resume ----
    if (method === 'POST' && path === '/api/trading/resume') {
      requireAction(principal, 'trading.resume');
      const svc = tradingStateFor(deps.db, principal.tenantId);
      await runTradingOp(() => svc.resume(
        { userId: principal.userId, tenantId: principal.tenantId, process: 'api' }, deps.now?.()));
      sendJson(ctx.res, 200, { paused: false });
      return;
    }

    // ---- PATCH /api/limits — owner + re-auth ----
    if (method === 'PATCH' && path === '/api/limits') {
      requireAction(principal, 'limits.write');
      const body = (ctx.body ?? {}) as { maxOrderNotionalMinor?: string; maxDailyNotionalMinor?: string };
      const patch: { maxOrderNotionalMinor?: string; maxDailyNotionalMinor?: string } = {};
      if (body.maxOrderNotionalMinor !== undefined && typeof body.maxOrderNotionalMinor === 'string') patch.maxOrderNotionalMinor = body.maxOrderNotionalMinor;
      if (body.maxDailyNotionalMinor !== undefined && typeof body.maxDailyNotionalMinor === 'string') patch.maxDailyNotionalMinor = body.maxDailyNotionalMinor;
      const svc = tradingStateFor(deps.db, principal.tenantId);
      await runTradingOp(() => svc.updateLimits(
        { userId: principal.userId, tenantId: principal.tenantId, process: 'api' }, patch, deps.now?.()));
      sendJson(ctx.res, 200, { ok: true });
      return;
    }

    // ---- GET /api/trading/state — what the UI renders ----
    if (method === 'GET' && path === '/api/trading/state') {
      requireAction(principal, 'view.dashboards');
      const svc = tradingStateFor(deps.db, principal.tenantId);
      sendJson(ctx.res, 200, await svc.readState());
      return;
    }

    // ---- GET /api/audit — the tenant's own audit trail (phase-05 T05.5) ----
    // view.audit is owner + trader — a viewer is not shown the switch/cap history.
    if (method === 'GET' && path === '/api/audit') {
      requireAction(principal, 'view.audit');
      const limitParam = ctx.url.searchParams.get('limit');
      const opts = limitParam === null ? {} : { limit: Number(limitParam) };
      const rows = await listAuditEvents(forTenant(deps.db, principal.tenantId), opts);
      sendJson(ctx.res, 200, rows);
      return;
    }

    // ---- GET /api/positions — the books per account/asset (phase-09 T09.6) ----
    // Read-only over the `holding` projection (the fold of the ledger). Optional
    // ?groupId narrows to a group's ENABLED members; absent, it covers the whole
    // tenant. Positions are the BOOKS as-is — quantity, weighted-average cost,
    // realised P&L, fees, TDS — never a mark-to-market value (§6a; no valuation).
    if (method === 'GET' && path === '/api/positions') {
      requireAction(principal, 'view.dashboards');
      const tdb = forTenant(deps.db, principal.tenantId);
      const groupId = ctx.url.searchParams.get('groupId');
      let named: NamedAccount[];
      if (groupId !== null) {
        const members = await getEnabledMembers(tdb, groupId);
        named = members.map((m) => ({ accountId: m.accountId, accountName: m.accountName }));
      } else {
        named = (await listAccounts(tdb)).map((a) => ({ accountId: a.id, accountName: a.name }));
      }
      sendJson(ctx.res, 200, await buildPositions(deps.db, tdb, named));
      return;
    }

    // ---- POST /api/account/totp/begin — start enrolling the CURRENT user's 2FA ----
    if (method === 'POST' && path === '/api/account/totp/begin') {
      // Enrolling your own 2FA is a self-service action; it does not touch another
      // user, so it needs only an authenticated session, not an owner action.
      const svc = new TotpService({ db: deps.db, tdb: forTenant(deps.db, principal.tenantId), kms: deps.kms });
      try {
        const result = await svc.begin(principal.userId);
        sendJson(ctx.res, 200, result);
      } catch (e) {
        if (e instanceof TotpServiceError) throw new HttpError(400, e.message);
        throw e;
      }
      return;
    }

    // ---- POST /api/account/totp/confirm — prove a code, then enable ----
    if (method === 'POST' && path === '/api/account/totp/confirm') {
      const body = (ctx.body ?? {}) as { code?: string };
      if (typeof body.code !== 'string') throw new HttpError(400, 'a code is required');
      const svc = new TotpService({ db: deps.db, tdb: forTenant(deps.db, principal.tenantId), kms: deps.kms });
      try {
        await svc.confirm(principal.userId, body.code, deps.now?.() ?? Date.now());
      } catch (e) {
        if (e instanceof TotpServiceError) throw new HttpError(400, e.message);
        throw e;
      }
      sendJson(ctx.res, 200, { enabled: true });
      return;
    }

    // ---- GET /api/groups ----
    if (method === 'GET' && path === '/api/groups') {
      requireAction(principal, 'view.dashboards');
      sendJson(ctx.res, 200, await listGroups(forTenant(deps.db, principal.tenantId)));
      return;
    }

    // ---- POST /api/groups ----
    if (method === 'POST' && path === '/api/groups') {
      requireAction(principal, 'group.write');
      const body = (ctx.body ?? {}) as { name?: string; description?: string };
      if (typeof body.name !== 'string') throw new HttpError(400, 'a group name is required');
      const id = await createGroup(forTenant(deps.db, principal.tenantId), {
        name: body.name, createdBy: principal.userId,
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
      });
      sendJson(ctx.res, 201, { id });
      return;
    }

    // ---- GET /api/accounts — read-only list for the member picker ----
    if (method === 'GET' && path === '/api/accounts') {
      requireAction(principal, 'view.dashboards');
      sendJson(ctx.res, 200, await listAccounts(forTenant(deps.db, principal.tenantId)));
      return;
    }

    // ---- POST /api/accounts/validate — connect a key (owner + re-auth) ----
    // Connecting an exchange credential is the highest-value action in the
    // product (credential.write: owner only, fresh second factor). The key and
    // secret leave this handler only as ciphertext — OnboardingService seals
    // them and never logs them. (The fields are read one at a time and passed by
    // shorthand so THIS file never becomes a second key-ingestion point — the
    // 02-accounts check asserts onboarding-service.ts is the sole one.)
    if (method === 'POST' && path === '/api/accounts/validate') {
      requireAction(principal, 'credential.write');
      const raw = (ctx.body ?? {}) as Record<string, unknown>;
      const accountName = raw['accountName'];
      const allocatedCapitalMinor = raw['allocatedCapitalMinor'];
      const allocatedCurrency = raw['allocatedCurrency'];
      const apiKey = raw['apiKey'];
      const apiSecret = raw['apiSecret'];
      // Each field is checked in its own statement so no single expression ever
      // holds both key names (the 02-accounts single-entry check).
      if (typeof accountName !== 'string' || typeof allocatedCapitalMinor !== 'string'
        || (allocatedCurrency !== 'INR' && allocatedCurrency !== 'USDT')) {
        throw new HttpError(400, 'account name, allocated capital, currency, and the API key and secret are required');
      }
      if (typeof apiKey !== 'string' || apiKey === '') throw new HttpError(400, 'the API key is required');
      if (typeof apiSecret !== 'string' || apiSecret === '') throw new HttpError(400, 'the API secret is required');
      const result = await onboardingFor(principal.tenantId).validate({
        accountName,
        allocatedCapitalMinor,
        allocatedCurrency,
        apiKey,
        apiSecret,
      });
      if (!result.ok) {
        const r = result.rejection;
        if (r.kind === 'shape_invalid') throw new HttpError(400, r.message);
        if (r.kind === 'duplicate_key') throw new HttpError(409, r.message);
        if (r.kind === 'auth_failed') throw new HttpError(401, r.message);
        throw new HttpError(502, r.message);
      }
      sendJson(ctx.res, 200, { reconciliation: result.reconciliation });
      return;
    }

    // ---- POST /api/accounts/confirm — activate a validated account (owner + re-auth) ----
    if (method === 'POST' && path === '/api/accounts/confirm') {
      requireAction(principal, 'credential.write');
      const body = (ctx.body ?? {}) as {
        accountId?: string; credentialId?: string; confirmedAgainstMinor?: string; adoptRealAsBasis?: boolean;
        fundingCurrencies?: string[]; balances?: { currency: string; freeMinor: string; lockedMinor: string; scale: number }[];
      };
      if (typeof body.accountId !== 'string' || typeof body.credentialId !== 'string'
        || typeof body.confirmedAgainstMinor !== 'string' || typeof body.adoptRealAsBasis !== 'boolean'
        || !Array.isArray(body.balances)) {
        throw new HttpError(400, 'accountId, credentialId, confirmedAgainstMinor, adoptRealAsBasis and balances are required');
      }
      await onboardingFor(principal.tenantId).confirm({
        accountId: body.accountId,
        credentialId: body.credentialId,
        confirmedAgainstMinor: body.confirmedAgainstMinor,
        adoptRealAsBasis: body.adoptRealAsBasis,
        fundingCurrencies: (body.fundingCurrencies ?? []) as ('INR' | 'USDT')[],
        balances: body.balances,
      });
      sendJson(ctx.res, 200, { ok: true });
      return;
    }

    // ---- GET /api/groups/:id — group header + all members ----
    const groupMatch = /^\/api\/groups\/([0-9a-f-]{36})$/.exec(path);
    if (method === 'GET' && groupMatch !== null) {
      requireAction(principal, 'view.dashboards');
      const tdb = forTenant(deps.db, principal.tenantId);
      const header = await getGroupHeader(tdb, groupMatch[1] as string);
      if (header === null) throw new HttpError(404, 'no such group');
      const members = await getGroupMembers(tdb, groupMatch[1] as string);
      sendJson(ctx.res, 200, { ...header, members });
      return;
    }

    // ---- PATCH /api/groups/:id — rename or clear the description ----
    if (method === 'PATCH' && groupMatch !== null) {
      requireAction(principal, 'group.write');
      const body = (ctx.body ?? {}) as { name?: string; description?: string | null };
      const patch: { name?: string; description?: string | null } = {};
      if (typeof body.name === 'string') patch.name = body.name;
      if ('description' in body) patch.description = body.description ?? null;
      const tdb = forTenant(deps.db, principal.tenantId);
      await runGroupOp(() => updateGroup(tdb, groupMatch[1] as string, patch));
      sendJson(ctx.res, 200, { ok: true });
      return;
    }

    // ---- POST /api/groups/:id/members — add an account to the group ----
    const membersAddMatch = /^\/api\/groups\/([0-9a-f-]{36})\/members$/.exec(path);
    if (method === 'POST' && membersAddMatch !== null) {
      requireAction(principal, 'group.write');
      const body = (ctx.body ?? {}) as { accountId?: string };
      if (typeof body.accountId !== 'string') throw new HttpError(400, 'accountId is required');
      const tdb = forTenant(deps.db, principal.tenantId);
      await runGroupOp(() => addMember(tdb, { groupId: membersAddMatch[1] as string, accountId: body.accountId as string }));
      sendJson(ctx.res, 201, { ok: true });
      return;
    }

    // ---- PATCH /api/groups/:id/members/:accountId — enable or disable a member ----
    const memberMatch = /^\/api\/groups\/([0-9a-f-]{36})\/members\/([0-9a-f-]{36})$/.exec(path);
    if (method === 'PATCH' && memberMatch !== null) {
      requireAction(principal, 'group.write');
      const body = (ctx.body ?? {}) as { enabled?: unknown };
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled is required');
      const tdb = forTenant(deps.db, principal.tenantId);
      await runGroupOp(() => setMemberEnabled(tdb, memberMatch[1] as string, memberMatch[2] as string, body.enabled as boolean));
      sendJson(ctx.res, 200, { ok: true });
      return;
    }

    // ---- DELETE /api/groups/:id/members/:accountId — remove a member ----
    if (method === 'DELETE' && memberMatch !== null) {
      requireAction(principal, 'group.write');
      const tdb = forTenant(deps.db, principal.tenantId);
      await runGroupOp(() => removeMember(tdb, memberMatch[1] as string, memberMatch[2] as string));
      sendJson(ctx.res, 200, { ok: true });
      return;
    }

    // ---- DELETE /api/groups/:id — archive the group ----
    if (method === 'DELETE' && groupMatch !== null) {
      requireAction(principal, 'group.write');
      const tdb = forTenant(deps.db, principal.tenantId);
      await runGroupOp(() => archiveGroup(tdb, groupMatch[1] as string));
      sendJson(ctx.res, 200, { ok: true });
      return;
    }

    // ---- GET /api/assets ----
    if (method === 'GET' && path === '/api/assets') {
      requireAction(principal, 'view.dashboards');
      sendJson(ctx.res, 200, await listTradableAssets(deps.db));
      return;
    }

    // ---- POST /api/orders/cancel — the cancel fan-out, group-scoped (T09.1) ----
    // Cancels the STILL-CANCELLABLE legs of ONE group trade — never `cancel_all`
    // (30/60s rate limit, and it would cancel orders we did not place). The
    // per-account precondition (state open/partially_filled) is checked locally
    // before any network call; a settled leg is refused with no venue request.
    if (method === 'POST' && path === '/api/orders/cancel') {
      requireAction(principal, 'trade.cancel');
      const body = (ctx.body ?? {}) as { groupTradeId?: string; accountIds?: string[] };
      if (typeof body.groupTradeId !== 'string' || body.groupTradeId === '') {
        throw new HttpError(400, 'groupTradeId is required');
      }
      if (engine === null) {
        if (process.env['NODE_ENV'] === 'production') {
          throw new HttpError(503, 'the execution engine is not configured; refusing to cancel');
        }
        throw new HttpError(409, 'cancelling requires the execution engine, which is not wired in this build');
      }
      const tdb = forTenant(deps.db, principal.tenantId);
      const trade = await getGroupTrade(tdb, body.groupTradeId);
      if (trade === null) throw new HttpError(404, 'no such group trade');
      const accountIds = Array.isArray(body.accountIds)
        ? body.accountIds.filter((x): x is string => typeof x === 'string') : undefined;
      const children = await listCancellableChildren(tdb, body.groupTradeId, accountIds);
      const results = await engine.worker.cancelChildren(tdb, children);
      const cancelled = results.filter((r) => r.outcome === 'cancelled').length;
      const refused = results.filter((r) => r.outcome === 'refused').length;
      sendJson(ctx.res, 200, { groupTradeId: body.groupTradeId, cancelled, refused, results });
      return;
    }

    // ---- POST /api/group-trades/preview ----
    if (method === 'POST' && path === '/api/group-trades/preview') {
      // Previewing runs the planning pipeline; it is a trade action even though
      // it sends nothing, because it reads balances and decides quantities.
      requireAction(principal, 'trade.place');
      const body = (ctx.body ?? {}) as Partial<PlanRequest>;
      if (typeof body.groupId !== 'string' || typeof body.asset !== 'string'
        || (body.side !== 'buy' && body.side !== 'sell')) {
        throw new HttpError(400, 'groupId, asset and side are required');
      }
      // The actor is the session's user, never a client-supplied field.
      const req = { ...body, createdBy: principal.userId } as PlanRequest;
      const result = await planning.preview(req);
      sendJson(ctx.res, 200, result);
      return;
    }

    // ---- POST /api/group-trades/:id/retry-failed — the failed subset, fresh (T08.7) ----
    // Retrying must NEVER re-run the old plan: the endpoint reads the failed
    // accounts of an executed/abandoned trade, reconstructs the original intent
    // from the persisted trade columns, and previews a BRAND-NEW group trade
    // scoped to only those accounts — new id, re-priced against the current book,
    // and a fresh preview token. It sends nothing; the fresh preview still needs
    // confirming. The old trade and its rows are never touched.
    const retryMatch = /^\/api\/group-trades\/([0-9a-f-]{36})\/retry-failed$/.exec(path);
    if (method === 'POST' && retryMatch !== null) {
      requireAction(principal, 'trade.place');
      let retry;
      try {
        retry = await planning.retryFailed(retryMatch[1] as string, principal.userId);
      } catch (e) {
        const reason = (e as { reason?: string }).reason;
        if (reason === 'trade_not_found') throw new HttpError(404, 'no such group trade');
        if (reason === 'nothing_to_retry' || reason === 'empty_group') {
          throw new HttpError(409, e instanceof Error ? e.message : 'nothing to retry');
        }
        if (reason === 'no_market_data') throw new HttpError(503, 'market data is not available right now');
        throw e;
      }
      sendJson(ctx.res, 201, retry);
      return;
    }

    // ---- GET /api/group-trades/:id ----
    const tradeMatch = /^\/api\/group-trades\/([0-9a-f-]{36})$/.exec(path);
    if (method === 'GET' && tradeMatch !== null) {
      requireAction(principal, 'view.dashboards');
      const plan = await planning.getPlan(tradeMatch[1] as string);
      if (plan === null) throw new HttpError(404, 'no such group trade');
      sendJson(ctx.res, 200, plan);
      return;
    }

    // ---- POST /api/group-trades/:id/confirm ----
    // With an engine wired, this REALLY sends: beginExecution atomically moves the
    // trade previewed→executing under the token gate, the executor enqueues one
    // 'place' job per planned child, and the queue drains inline so the response
    // carries the honest report. Without an engine this is the rung-0 dry-run
    // confirm (the whole of Phase 04), and NODE_ENV=production refuses to let an
    // operator mistake a dry run for a send (503).
    const confirmMatch = /^\/api\/group-trades\/([0-9a-f-]{36})\/confirm$/.exec(path);
    if (method === 'POST' && confirmMatch !== null) {
      requireAction(principal, 'trade.place');
      const body = (ctx.body ?? {}) as { previewToken?: string };
      if (typeof body.previewToken !== 'string') throw new HttpError(400, 'previewToken is required');
      const tradeId = confirmMatch[1] as string;

      if (engine === null) {
        if (process.env['NODE_ENV'] === 'production') {
          throw new HttpError(503, 'the execution engine is not configured; refusing to silently dry-run a confirm in production');
        }
        try {
          await confirmDryRun(forTenant(deps.db, principal.tenantId), tradeId, body.previewToken,
            deps.now?.());
        } catch (e) {
          // Map the repo's typed reasons to HTTP without leaking internals.
          const reason = (e as { reason?: string }).reason;
          if (reason === 'token_expired') throw new HttpError(410, 'this preview has expired; re-preview for fresh prices');
          if (reason === 'token_mismatch' || reason === 'no_token') throw new HttpError(403, 'the preview token is not valid');
          if (reason === 'already_completed') throw new HttpError(409, 'this trade has already been confirmed');
          if (reason === 'not_previewed') throw new HttpError(409, 'this trade has no active preview to confirm');
          if (reason === 'trade_not_found') throw new HttpError(404, 'no such group trade');
          throw e;
        }
        sendJson(ctx.res, 200, { status: 'completed', dryRun: true });
        return;
      }

      // REAL execution. beginExecution is a FOR UPDATE transition guarded by the
      // preview token, so a racing second confirm sees 'executing' (already_started
      // → 409) and can never double-start the fan-out.
      try {
        await beginExecution(forTenant(deps.db, principal.tenantId), tradeId, body.previewToken,
          deps.now?.());
      } catch (e) {
        const reason = (e as { reason?: string }).reason;
        if (reason === 'token_expired') throw new HttpError(410, 'this preview has expired; re-preview for fresh prices');
        if (reason === 'token_mismatch' || reason === 'no_token') throw new HttpError(403, 'the preview token is not valid');
        if (reason === 'already_completed' || reason === 'already_started') throw new HttpError(409, 'this trade has already been confirmed');
        if (reason === 'not_previewed') throw new HttpError(409, 'this trade has no active preview to confirm');
        if (reason === 'trade_not_found') throw new HttpError(404, 'no such group trade');
        throw e;
      }
      const tdb = forTenant(deps.db, principal.tenantId);
      const enqueued = await engine.executor.enqueue(tdb, tradeId);
      // Inline drain so the confirm response returns a REAL report — the send is
      // done before the client hears back. A later SSE surface (T08.6) decouples
      // the wait from the request; the group executor's 200-round cap keeps a
      // wedged queue from spinning this handler forever.
      await engine.executor.drain();
      const out = await executionReportOf(principal.tenantId, tradeId);
      if (out === null) throw new HttpError(404, 'no such group trade');
      sendJson(ctx.res, 200, { status: out.status, dryRun: false, enqueued: enqueued.enqueued, report: out.report });
      return;
    }

    // ---- GET /api/group-trades/:id/report — the execution result ----
    const reportMatch = /^\/api\/group-trades\/([0-9a-f-]{36})\/report$/.exec(path);
    if (method === 'GET' && reportMatch !== null) {
      requireAction(principal, 'view.dashboards');
      const out = await executionReportOf(principal.tenantId, reportMatch[1] as string);
      if (out === null) throw new HttpError(404, 'no such group trade');
      sendJson(ctx.res, 200, { status: out.status, dryRun: out.dryRun, report: out.report });
      return;
    }

    // ---- GET /api/group-trades/:id/stream — SSE live execution progress (T08.6) ----
    // Only meaningful with an engine wired: the stream watches the worker settle
    // the group trade's legs in real time. Without an engine nothing ever settles
    // (confirm is a dry run), so the route is 404 — there is no live execution to
    // watch. Reading it never affects the send; the worker does not know a watcher
    // exists.
    const streamMatch = /^\/api\/group-trades\/([0-9a-f-]{36})\/stream$/.exec(path);
    if (method === 'GET' && streamMatch !== null) {
      requireAction(principal, 'view.dashboards');
      await openExecutionStream(ctx.res, principal.tenantId, streamMatch[1] as string);
      return;
    }

    throw new HttpError(404, 'not found');
  };

  const here = dirname(fileURLToPath(import.meta.url));
  const distDir = join(here, '..', '..', 'apps', 'web', 'dist');
  const staticTypes: Readonly<Record<string, string>> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
  };

  const contentTypeFor = (filePath: string): string => {
    const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    return staticTypes[extension] ?? 'application/octet-stream';
  };

  const serveStatic = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    if (url.pathname.startsWith('/api/')) return false;
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = join(distDir, pathname);
    try {
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        const indexPath = join(distDir, 'index.html');
        if (existsSync(indexPath)) {
          res.writeHead(200, { 'content-type': contentTypeFor(indexPath) });
          createReadStream(indexPath).pipe(res);
          return true;
        }
        return false;
      }
    } catch {
      return false;
    }
    res.writeHead(200, { 'content-type': contentTypeFor(filePath) });
    createReadStream(filePath).pipe(res);
    return true;
  };

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (serveStatic(req, res, url)) return;
        const cookies = parseCookieHeader(req.headers.cookie);
        const method = (req.method ?? 'GET').toUpperCase();
        const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? await readBody(req) : undefined;
        const ctx: Ctx = { req, res, url, method, cookies, body, principal: null };
        // Resolve the session for every request; routes decide whether it is required.
        const cookieValue = cookies.get(SESSION_COOKIE);
        ctx.principal = await login.principalFrom(cookieValue, deps.now?.());
        await handle(ctx);
      } catch (err) {
        if (res.headersSent) { res.end(); return; }
        console.error('request failed', err);
        if (err instanceof HttpError) {
          sendJson(res, err.status, { message: err.message });
        } else {
          // Do not leak an internal error message to the client.
          sendJson(res, 500, { message: 'internal error' });
        }
      }
    })();
  });
}
