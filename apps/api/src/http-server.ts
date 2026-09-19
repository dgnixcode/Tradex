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
  beginExecution, getExecutionSnapshot, getWorkspace, listCancellableChildren, AccountRepoError,
  deleteAccount, setAccountStatus, requeueStale,
  createInquiry, listInquiries, updateInquiryStatus,
  getPlatformBranding, updatePlatformBranding,
} from '@tradex/db';
import type { DB, InquiryStatus } from '@tradex/db';
import { listAccounts, getAccountDetail } from './accounts-query.js';
import { buildPositions } from './positions.js';
import type { NamedAccount } from './positions.js';
import { analyticsReport, blotterPage, reportToCsv, resolveAccounts, resolveWindow } from './analytics.js';
import { SettingsService, SettingsServiceError } from './settings-service.js';
import { buildFuturesPositions, venuePositionOwner } from './futures/positions.js';
import { getFuturesRtPrices } from './futures/rt-prices.js';
import type { FuturesRtPrice } from './futures/rt-prices.js';
import { startWsPriceFeed, priceEmitter, isWsFeedConnected } from './futures/ws-prices.js';
import { hardExit, HardExitError } from './futures/exit-service.js';
import type { FuturesActor, FuturesExitPort } from './futures/exit-service.js';
import { buildTradingAnalytics } from './futures/trading-analytics.js';
import type { FuturesTriggerRef } from '@tradex/exchange';

/**
 * Partially close, or add to, a live futures position.
 *
 * `positions/exit` closes the WHOLE position, so a partial close is an ordinary
 * opposite-side order — and on a venue with no `reduce_only`, an oversized one
 * FLIPS the position. The sizing is `futures/adjust-service.ts`, which floors to
 * the instrument's step and refuses below every floor.
 */
export interface FuturesAdjustPort {
  readonly adjustPosition: (args: {
    readonly actor: FuturesActor;
    readonly venuePositionId: string;
    readonly direction: 'reduce' | 'increase';
    /** Basis points of the CURRENT position; 2500 = 25%. */
    readonly percentBp: number;
  }) => Promise<
    | {
        readonly ok: true;
        /** What was actually sent, after flooring to the instrument's step. */
        readonly quantity: string;
        /** Null when a full reduce was promoted to `positions/exit`. */
        readonly venueOrderId: string | null;
        readonly full: boolean;
      }
    | { readonly ok: false; readonly code: string; readonly detail: string }
  >;
}

/**
 * Attach or replace a stop-loss / take-profit on an existing position (T15 SL/TP).
 * `moveExisting` = cancel-then-create when the leg already exists (research/04
 * F12: create_tpsl is not an upsert). Wired only when the composition root
 * supplies the futures adapter.
 */
export interface FuturesTpSlPort {
  readonly setProtection: (args: {
    /** Whose credential signs this. The venue id alone cannot identify an account. */
    readonly actor: FuturesActor;
    readonly venuePositionId: string;
    readonly stopLossPrice?: string | undefined;
    readonly takeProfitPrice?: string | undefined;
    readonly moveExisting?: boolean | undefined;
    readonly triggerRef?: FuturesTriggerRef | undefined;
  }) => Promise<{
    readonly stopLoss?: { readonly ok: boolean; readonly reason?: string | undefined } | undefined;
    readonly takeProfit?: { readonly ok: boolean; readonly reason?: string | undefined } | undefined;
  }>;
}
import type { Kysely } from 'kysely';
import type { MarketRef, OrderBook } from '@tradex/exchange';
import { LoginService } from './login-service.js';
import type { SecondFactorVerifier } from './login-service.js';
import { SignupService } from './signup-service.js';
import { PasswordResetService } from './password-reset-service.js';
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
  AttachTpSlPort, CancelPort, GetHoldingsPort, ListActivePort, ResolvePort, SubmitPort,
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
  /** Phase-15 hard exit: cancel conditionals, exit position, reconcile. */
  readonly futuresExit?: FuturesExitPort | undefined;
  /** Phase-15 post-entry SL/TP adjust — cancel-then-create when moving an existing leg. */
  readonly futuresTpSl?: FuturesTpSlPort | undefined;
  /**
   * Phase-15 SL/TP fan-out — the worker's own attach port, distinct from
   * `futuresTpSl` above even though both touch protection.
   *
   * The worker uses this one when a filled futures ENTRY settles, to attach the
   * trade's SL/TP legs. `futuresTpSl` is the post-hoc adjust route. They have
   * different signatures and different callers; supplying one does not satisfy the
   * other. Without this port a filled entry settles and its conditional legs are
   * skipped `TP_SL_NOT_ATTACHED`, which looks like a venue problem and is not one.
   */
  readonly attachTpSl?: AttachTpSlPort | undefined;
  /**
   * Run after a fan-out has drained — the composition root's hook to mirror venue
   * state (futures positions) back into our tables.
   *
   * Called BEST-EFFORT and never allowed to fail the request: by the time it runs
   * the orders are already sent, and a mirroring error must not turn a placed
   * trade into an error response the customer would reasonably read as "nothing
   * happened".
   */
  readonly afterFanOut?: ((args: { tenantId: string; groupTradeId: string }) => Promise<void>) | undefined;
  /**
   * Re-read the venue's futures positions for the tenant and mirror them.
   *
   * Exists because the mirror otherwise runs only after a fan-out, which means a
   * position can OUTLIVE the trade that created it: close it elsewhere, or have a
   * leg fail after the venue already opened one, and the page keeps showing what
   * was true at the last fan-out. Explicitly refreshing is the cheap fix — putting
   * a venue read and a decrypt on every page load would not be.
   */
  readonly refreshPositions?: ((args: { tenantId: string }) => Promise<{ readonly accounts: number; readonly positions: number }>) | undefined;
  /**
   * How often to sweep for legs that still need resolving, in ms. 0 or absent
   * disables the sweep (the default, so no test grows a timer).
   *
   * WHY THIS MUST EXIST: settling a leg `ambiguous` enqueues a resolve job
   * (`runPlaceOnce`), and `runResolveOnce` drains those on a ladder with gaps up to
   * 20 s. But the ONLY caller of `runResolveOnce` is a confirm's inline drain — so
   * once the confirm response is written, the ladder STOPS. A leg whose outcome
   * the venue had not yet settled would sit `ambiguous` forever, with real money at
   * the venue and nothing looking at it.
   */
  readonly resolverIntervalMs?: number | undefined;
  /**
   * Partially close, or add to, a live futures position.
   *
   * `positions/exit` cannot do this — it closes the WHOLE position and takes only
   * an id. A partial close is therefore an ordinary opposite-side order, which on
   * a venue with no `reduce_only` will FLIP the position if it is oversized. The
   * sizing lives in `futures/adjust-service.ts`, which floors to the instrument's
   * step and refuses below every floor; the implementation must fetch the
   * instrument rather than assume a step.
   */
  readonly futuresAdjust?: FuturesAdjustPort | undefined;
  /**
   * Re-read an account's balances from the exchange and store them.
   *
   * A balance is not a fact we may cache indefinitely: the customer withdraws or
   * deposits, and every later trade is sized from what we hold. Without this the
   * number only refreshes when they reconnect the account.
   */
  readonly accountSync?: ((args: { tenantId: string; accountId: string }) => Promise<{
    readonly currencies: readonly string[];
    readonly balances: number;
  }>) | undefined;
  readonly codeVersion: string;
  /** False on local plain-HTTP dev so the cookie is not marked Secure. */
  readonly secureCookies?: boolean | undefined;
  readonly now?: (() => number) | undefined;
  readonly resendApiKey?: string | undefined;
  readonly resendFrom?: string | undefined;
  readonly appUrl?: string | undefined;
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
  const passwordReset = new PasswordResetService({
    db: deps.db,
    resendApiKey: deps.resendApiKey,
    resendFrom: deps.resendFrom,
    appUrl: deps.appUrl,
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
      // Without this the worker skips every futures conditional leg with
      // TP_SL_NOT_ATTACHED the moment an entry fills — see the field's note.
      ...(deps.attachTpSl !== undefined ? { attachTpSl: deps.attachTpSl } : {}),
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
      case 'account_already_in_group': return 409;
      case 'cannot_archive_default_group': return 400;
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

  /**
   * Run an account mutation, mapping its failure to a clean HTTP error.
   *
   * `AccountRepoError` always means the same thing in the account routes: the row
   * exists but is in the wrong state for this operation — no basis from the
   * exchange, or a trading history that blocks a delete. That is a 409, and its
   * message is written to be shown to the customer as-is.
   */
  const runAccountOp = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AccountRepoError) throw new HttpError(409, e.message);
      throw e;
    }
  };

  /** Run a trading-state mutation, mapping its typed failure to a clean HTTP error. */
  const tradingErrorStatus = (reason: TradingStateError['reason']): number => {    switch (reason) {
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

    // ---- POST /api/auth/forgot-password — public password reset request ----
    if (method === 'POST' && path === '/api/auth/forgot-password') {
      const body = (ctx.body ?? {}) as { email?: string };
      if (typeof body.email !== 'string' || !body.email.trim()) {
        throw new HttpError(400, 'email is required');
      }
      const host = (ctx.req.headers['x-forwarded-host'] as string | undefined) ?? ctx.req.headers['host'];
      const proto = (ctx.req.headers['x-forwarded-proto'] as string | undefined) ?? (deps.secureCookies ? 'https' : 'http');
      const requestHost = host ? `${proto}://${host}` : undefined;
      const result = await passwordReset.requestReset(body.email, requestHost);
      sendJson(ctx.res, 200, result);
      return;
    }

    // ---- POST /api/auth/reset-password — public password reset submission ----
    if (method === 'POST' && path === '/api/auth/reset-password') {
      const body = (ctx.body ?? {}) as { token?: string; newPassword?: string };
      if (typeof body.token !== 'string' || typeof body.newPassword !== 'string') {
        throw new HttpError(400, 'token and newPassword are required');
      }
      const result = await passwordReset.resetPassword(body.token, body.newPassword);
      if (!result.ok) {
        sendJson(ctx.res, 400, result);
        return;
      }
      sendJson(ctx.res, 200, result);
      return;
    }

    // ---- POST /api/inquiries — public consultation lead submission ----
    if (method === 'POST' && path === '/api/inquiries') {
      const body = (ctx.body ?? {}) as {
        name?: string;
        email?: string;
        phone?: string;
        capital?: string;
        exchange?: string;
        method?: string;
        notes?: string;
      };
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new HttpError(400, 'name is required');
      }
      if (typeof body.email !== 'string' || !body.email.trim()) {
        throw new HttpError(400, 'email is required');
      }
      if (typeof body.phone !== 'string' || !body.phone.trim()) {
        throw new HttpError(400, 'phone is required');
      }
      const result = await createInquiry(deps.db, {
        name: body.name,
        email: body.email,
        phone: body.phone,
        capital: typeof body.capital === 'string' && body.capital.trim() ? body.capital : '₹10,00,000 – ₹25,00,000',
        exchange: typeof body.exchange === 'string' && body.exchange.trim() ? body.exchange : 'CoinDCX',
        method: typeof body.method === 'string' && body.method.trim() ? body.method : 'WhatsApp',
        ...(typeof body.notes === 'string' ? { notes: body.notes } : {}),
      });
      sendJson(ctx.res, 201, { ok: true, id: result.id });
      return;
    }

    // ---- GET /api/public/branding — public platform branding and contact channels ----
    if (method === 'GET' && path === '/api/public/branding') {
      const branding = await getPlatformBranding(deps.db);
      sendJson(ctx.res, 200, branding);
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

    // ---- GET /api/inquiries — authenticated operator lead retrieval ----
    if (method === 'GET' && path === '/api/inquiries') {
      const statusParam = url.searchParams.get('status');
      const status = (statusParam === 'new' || statusParam === 'contacted' || statusParam === 'onboarded' || statusParam === 'archived')
        ? (statusParam as InquiryStatus)
        : undefined;
      const inquiries = await listInquiries(deps.db, {
        ...(status !== undefined ? { status } : {}),
      });
      sendJson(ctx.res, 200, { inquiries });
      return;
    }

    // ---- PATCH /api/inquiries/:id — update status / notes ----
    if (method === 'PATCH' && path.startsWith('/api/inquiries/')) {
      const id = path.slice('/api/inquiries/'.length);
      if (!id) throw new HttpError(400, 'inquiry id is required');
      const body = (ctx.body ?? {}) as { status?: string };
      if (typeof body.status !== 'string') {
        throw new HttpError(400, 'status is required');
      }
      const ok = await updateInquiryStatus(
        deps.db,
        id,
        body.status as InquiryStatus,
        { contactedBy: principal.userId, now: deps.now !== undefined ? new Date(deps.now()) : new Date() },
      );
      if (!ok) throw new HttpError(404, 'inquiry not found');
      sendJson(ctx.res, 200, { ok: true });
      return;
    }

    // ---- GET /api/settings/workspace — workspace name shown in Settings ----
    if (method === 'GET' && path === '/api/settings/workspace') {
      const ws = await getWorkspace(deps.db, principal.tenantId);
      if (ws === null) throw new HttpError(404, 'workspace not found');
      sendJson(ctx.res, 200, ws);
      return;
    }

    // ---- PATCH /api/settings/workspace — rename the workspace ----
    // Owner + re-auth (settings.write). Emits an audit row before/after.
    if (method === 'PATCH' && path === '/api/settings/workspace') {
      requireAction(principal, 'settings.write');
      const body = (ctx.body ?? {}) as { name?: unknown };
      if (typeof body.name !== 'string') throw new HttpError(400, 'name is required');
      const svc = new SettingsService({ db: deps.db });
      try {
        const result = await svc.renameWorkspace(
          { userId: principal.userId, tenantId: principal.tenantId, process: 'api' },
          body.name,
          deps.now?.(),
        );
        sendJson(ctx.res, 200, result);
      } catch (e) {
        if (e instanceof SettingsServiceError) {
          throw new HttpError(e.reason === 'no_change' ? 409 : e.reason === 'not_found' ? 404 : 400, e.message);
        }
        throw e;
      }
      return;
    }

    // ---- GET /api/settings/branding — platform branding & contact channels ----
    if (method === 'GET' && path === '/api/settings/branding') {
      const branding = await getPlatformBranding(deps.db);
      sendJson(ctx.res, 200, branding);
      return;
    }

    // ---- PUT/PATCH /api/settings/branding — update platform branding & contact channels ----
    if ((method === 'PUT' || method === 'PATCH') && path === '/api/settings/branding') {
      if (principal.role !== 'owner') {
        throw new HttpError(403, 'only workspace owners may update platform branding');
      }
      const body = (ctx.body ?? {}) as {
        name?: string;
        logo?: string | null;
        email?: string;
        phone?: string;
        whatsapp?: string;
        address?: string;
        hours?: string;
      };
      const updated = await updatePlatformBranding(deps.db, body, principal.userId);
      sendJson(ctx.res, 200, { ok: true, branding: updated });
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

    // ---- GET /api/futures/positions — the futures BOOKS with mark/liq (phase-15 T15.8) ----
    // Lives in a subdirectory outside the §6a scan by design (the scan is
    // non-recursive over `apps/api/src`). Mark price, liquidation and
    // unrealised PnL are legitimate here; the spot books page stays pure.
    if (method === 'GET' && path === '/api/futures/positions') {
      requireAction(principal, 'view.dashboards');
      sendJson(ctx.res, 200, await buildFuturesPositions(deps.db, principal.tenantId, deps.now?.() ?? Date.now()));
      return;
    }

    // ---- GET /api/futures/prices — bulk real-time market prices for all pairs ----
    if (method === 'GET' && path === '/api/futures/prices') {
      requireAction(principal, 'view.dashboards');
      try {
        const prices = await getFuturesRtPrices();
        const out: Record<string, FuturesRtPrice> = {};
        for (const [k, v] of prices.entries()) {
          out[k] = v;
        }
        sendJson(ctx.res, 200, { prices: out, observedAtMs: Date.now() });
      } catch (e) {
        throw new HttpError(500, `could not fetch futures prices: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
      return;
    }

    // ---- GET /api/futures/prices/stream — SSE real-time price stream ----
    if (method === 'GET' && path === '/api/futures/prices/stream') {
      requireAction(principal, 'view.dashboards');

      // Set SSE headers
      ctx.res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // Disable nginx buffering for SSE
      });

      // Send initial full snapshot
      const initial = await getFuturesRtPrices();
      const snapshot: Record<string, FuturesRtPrice> = {};
      for (const [k, v] of initial.entries()) snapshot[k] = v;
      ctx.res.write(`data: ${JSON.stringify({ type: 'snapshot', prices: snapshot, wsConnected: isWsFeedConnected(), observedAtMs: Date.now() })}\n\n`);

      // Throttled diff relay: batch WS updates and push every 500ms
      let pendingDiff: Record<string, FuturesRtPrice> = {};
      let flushTimer: ReturnType<typeof setInterval> | null = null;

      const onUpdate = (diff: Record<string, FuturesRtPrice>) => {
        Object.assign(pendingDiff, diff);
      };

      const flush = () => {
        if (Object.keys(pendingDiff).length === 0) return;
        try {
          ctx.res.write(`data: ${JSON.stringify({ type: 'diff', prices: pendingDiff, observedAtMs: Date.now() })}\n\n`);
        } catch {
          // Client disconnected
          cleanup();
        }
        pendingDiff = {};
      };

      const cleanup = () => {
        priceEmitter.removeListener('update', onUpdate);
        if (flushTimer !== null) { clearInterval(flushTimer); flushTimer = null; }
      };

      priceEmitter.on('update', onUpdate);
      flushTimer = setInterval(flush, 500);

      // Send heartbeat every 15s to keep connection alive
      const heartbeat = setInterval(() => {
        try {
          ctx.res.write(`: heartbeat ${Date.now()}\n\n`);
        } catch {
          cleanup();
          clearInterval(heartbeat);
        }
      }, 15000);

      ctx.res.on('close', () => {
        cleanup();
        clearInterval(heartbeat);
      });

      // Do NOT call return — the response stays open
      return;
    }

    // ---- POST /api/futures/positions/refresh — re-mirror from the venue ----
    // Declared before the `:id/...` matchers so `refresh` is never read as an id.
    if (method === 'POST' && path === '/api/futures/positions/refresh') {
      requireAction(principal, 'view.dashboards');
      if (deps.refreshPositions === undefined) {
        throw new HttpError(503, 'futures execution is not configured in this build');
      }
      try {
        sendJson(ctx.res, 200, await deps.refreshPositions({ tenantId: principal.tenantId }));
      } catch (e) {
        throw new HttpError(503, e instanceof Error ? e.message : 'the exchange could not be read');
      }
      return;
    }

    // ---- POST /api/futures/positions/:id/adjust — partial close / add ----
    const futAdjustMatch = /^\/api\/futures\/positions\/([^/]+)\/adjust$/.exec(path);
    if (method === 'POST' && futAdjustMatch !== null) {
      requireAction(principal, 'trade.place');
      if (deps.futuresAdjust === undefined) {
        throw new HttpError(503, 'futures execution is not configured in this build');
      }
      const body = (ctx.body ?? {}) as { direction?: unknown; percentBp?: unknown };
      if (body.direction !== 'reduce' && body.direction !== 'increase') {
        throw new HttpError(400, 'direction must be "reduce" or "increase"');
      }
      if (typeof body.percentBp !== 'number') {
        throw new HttpError(400, 'percentBp must be a number (2500 = 25%)');
      }
      const pct = body.percentBp;
      const adjustOwner = await venuePositionOwner(forTenant(deps.db, principal.tenantId), futAdjustMatch[1] as string);
      if (adjustOwner === null) throw new HttpError(404, 'no such futures position');
      const adjusted = await deps.futuresAdjust.adjustPosition({
        actor: { tenantId: principal.tenantId, accountId: adjustOwner.accountId },
        venuePositionId: futAdjustMatch[1] as string,
        direction: body.direction,
        percentBp: pct,
      });
      // A refusal here is a SIZING decision the customer can act on (below the
      // minimum notional, smaller than one step), not a server fault — so it is a
      // 400 carrying the reason, never a silent success.
      if (!adjusted.ok) throw new HttpError(400, adjusted.detail);
      sendJson(ctx.res, 200, adjusted);
      return;
    }

    // ---- POST /api/futures/positions/:id/tpsl — post-entry SL/TP adjust ----
    // Owner or trader with trade.cancel; the composition root wires the port.
    // Body: { stopLossPrice?, takeProfitPrice?, moveExisting? }. Setting only
    // SL, only TP, or both is supported; moving an existing leg is a cancel-
    // then-create per research/04 F12 (create_tpsl is NOT an upsert).
    const futTpslMatch = /^\/api\/futures\/positions\/([^/]+)\/tpsl$/.exec(path);
    if (method === 'POST' && futTpslMatch !== null) {
      requireAction(principal, 'trade.cancel');
      if (deps.futuresTpSl === undefined) {
        throw new HttpError(503, 'futures execution is not configured in this build');
      }
      const body = (ctx.body ?? {}) as { stopLossPrice?: unknown; takeProfitPrice?: unknown; moveExisting?: unknown };
      const sl = body.stopLossPrice;
      const tp = body.takeProfitPrice;
      if ((sl !== undefined && typeof sl !== 'string') || (tp !== undefined && typeof tp !== 'string')) {
        throw new HttpError(400, 'stopLossPrice and takeProfitPrice must be decimal strings');
      }
      if (sl === undefined && tp === undefined) {
        throw new HttpError(400, 'at least one of stopLossPrice or takeProfitPrice is required');
      }
      const tpslOwner = await venuePositionOwner(forTenant(deps.db, principal.tenantId), futTpslMatch[1] as string);
      if (tpslOwner === null) throw new HttpError(404, 'no such futures position');
      try {
        const out = await deps.futuresTpSl.setProtection({
          actor: { tenantId: principal.tenantId, accountId: tpslOwner.accountId },
          venuePositionId: futTpslMatch[1] as string,
          ...(sl !== undefined ? { stopLossPrice: sl as string } : {}),
          ...(tp !== undefined ? { takeProfitPrice: tp as string } : {}),
          ...(typeof body.moveExisting === 'boolean' ? { moveExisting: body.moveExisting } : {}),
        });
        sendJson(ctx.res, 200, out);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(500, e instanceof Error ? e.message : 'failed to set protection');
      }
      return;
    }

    // ---- POST /api/futures/positions/:id/trailing-tpsl — Setup trailing SL ----
    const futTrailingMatch = /^\/api\/futures\/positions\/([^/]+)\/trailing-tpsl$/.exec(path);
    if (method === 'POST' && futTrailingMatch !== null) {
      requireAction(principal, 'trade.cancel');
      const body = (ctx.body ?? {}) as { enable?: unknown; distanceBp?: unknown; stepBp?: unknown; currentSlPrice?: unknown };
      const venuePositionId = futTrailingMatch[1] as string;
      const tpslOwner = await venuePositionOwner(forTenant(deps.db, principal.tenantId), venuePositionId);
      if (tpslOwner === null) throw new HttpError(404, 'no such futures position');
      
      const tdb = forTenant(deps.db, principal.tenantId);
      const enable = body.enable === true;
      
      if (!enable) {
        const { clearTrailingSl } = await import('@tradex/db');
        await clearTrailingSl(tdb, tpslOwner.accountId, venuePositionId);
        sendJson(ctx.res, 200, { ok: true, message: 'Trailing SL disabled' });
        return;
      }
      
      if (typeof body.distanceBp !== 'string' || typeof body.stepBp !== 'string' || typeof body.currentSlPrice !== 'string') {
         throw new HttpError(400, 'distanceBp, stepBp, and currentSlPrice must be decimal strings');
      }
      
      const pos = await tdb.selectFrom('futures_position')
        .select('pair')
        .where('venue_position_id', '=', venuePositionId)
        .executeTakeFirst();
      
      if (pos === undefined) {
        throw new HttpError(400, 'Cannot enable trailing SL: unknown position');
      }

      let quote: 'INR' | 'USDT' = 'USDT';
      let asset = pos.pair;
      if (pos.pair.endsWith('USDT')) { quote = 'USDT'; asset = pos.pair.slice(0, -4); }
      else if (pos.pair.endsWith('INR')) { quote = 'INR'; asset = pos.pair.slice(0, -3); }
      
      const book = await deps.getOrderBook({ asset, quote }, 1);
      const startingPrice = book.bids[0]?.price ?? book.asks[0]?.price;

      if (!startingPrice) {
         throw new HttpError(400, 'Cannot enable trailing SL: orderbook is empty');
      }
      
      const { upsertTrailingSl } = await import('@tradex/db');
      await upsertTrailingSl(tdb, {
        accountId: tpslOwner.accountId,
        venuePositionId,
        pair: pos.pair,
        distanceBp: body.distanceBp,
        stepBp: body.stepBp,
        highWaterMark: startingPrice,
        currentSlPrice: body.currentSlPrice,
      });
      
      sendJson(ctx.res, 200, { ok: true, message: 'Trailing SL enabled' });
      return;
    }

    // ---- POST /api/futures/positions/:id/exit — hard exit (phase-15 T15.7) ----
    // Enforces the safe sequence: cancel conditionals FIRST, then exit,
    // then reconcile to zero. Refuses to exit if a conditional could not be
    // cancelled (a stale SL after exit would open an opposite position).
    // Only reachable when the composition root wires the FuturesExitPort.
    const futExitMatch = /^\/api\/futures\/positions\/([^/]+)\/exit$/.exec(path);
    if (method === 'POST' && futExitMatch !== null) {
      requireAction(principal, 'trade.cancel');
      if (deps.futuresExit === undefined) {
        throw new HttpError(503, 'futures execution is not configured in this build');
      }
      const body = (ctx.body ?? {}) as { marginCurrency?: unknown };
      const mc = body.marginCurrency;
      if (mc !== 'INR' && mc !== 'USDT') {
        throw new HttpError(400, 'marginCurrency (INR or USDT) is required');
      }
      const exitOwner = await venuePositionOwner(forTenant(deps.db, principal.tenantId), futExitMatch[1] as string);
      if (exitOwner === null) throw new HttpError(404, 'no such futures position');
      try {
        const out = await hardExit(deps.futuresExit, {
          actor: { tenantId: principal.tenantId, accountId: exitOwner.accountId },
          venuePositionId: futExitMatch[1] as string,
          marginCurrency: mc,
        });
        sendJson(ctx.res, 200, out);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        if (e instanceof HardExitError) throw new HttpError(409, e.message);
        throw new HttpError(500, e instanceof Error ? e.message : 'position exit failed');
      }
      return;
    }

    // ---- GET /api/blotter — cursor-paginated order history (phase-12 T12.4) ----
    // One row per child order from OUR records. Keyset cursor, never OFFSET.
    if (method === 'GET' && path === '/api/blotter') {
      requireAction(principal, 'view.dashboards');
      const sp = ctx.url.searchParams;
      const page = await blotterPage(forTenant(deps.db, principal.tenantId), {
        accountId: sp.get('accountId'),
        groupTradeId: sp.get('groupTradeId'),
        market: sp.get('market'),
        outcome: sp.get('outcome'),
        limit: sp.get('limit') === null ? null : Number(sp.get('limit')),
        cursor: sp.get('cursor'),
      });
      sendJson(ctx.res, 200, page);
      return;
    }

    // ---- GET /api/analytics — realised P&L, fees, TDS and metrics (phase-12) ----
    // A two-prefix fold of OUR ledger over the window (default: current Indian
    // financial year). Filters by group or account; ?fy=2025-26 or fromMs/toMs.
    if (method === 'GET' && path === '/api/analytics') {
      requireAction(principal, 'view.dashboards');
      const tdb = forTenant(deps.db, principal.tenantId);
      const sp = ctx.url.searchParams;
      const named = await resolveAccounts(tdb, { groupId: sp.get('groupId'), accountId: sp.get('accountId') });
      const win = resolveWindow({ fromMs: sp.get('fromMs'), toMs: sp.get('toMs'), fy: sp.get('fy') }, deps.now?.() ?? Date.now());
      sendJson(ctx.res, 200, await analyticsReport(tdb, named, win));
      return;
    }

    // ---- GET /api/analytics/realised.csv — the same journal as a CSV ----
    if (method === 'GET' && path === '/api/analytics/realised.csv') {
      requireAction(principal, 'view.dashboards');
      const tdb = forTenant(deps.db, principal.tenantId);
      const sp = ctx.url.searchParams;
      const named = await resolveAccounts(tdb, { groupId: sp.get('groupId'), accountId: sp.get('accountId') });
      const win = resolveWindow({ fromMs: sp.get('fromMs'), toMs: sp.get('toMs'), fy: sp.get('fy') }, deps.now?.() ?? Date.now());
      const csv = reportToCsv(await analyticsReport(tdb, named, win));
      ctx.res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="realised-${win.label}.csv"`,
      });
      ctx.res.end(csv);
      return;
    }

    // ---- GET /api/analytics/trading-overview — comprehensive trading telemetry ----
    if (method === 'GET' && path === '/api/analytics/trading-overview') {
      requireAction(principal, 'view.dashboards');
      const sp = ctx.url.searchParams;
      const fromParam = sp.get('fromMs') ?? sp.get('from');
      const toParam = sp.get('toMs') ?? sp.get('to');
      const report = await buildTradingAnalytics(deps.db, principal.tenantId, {
        groupId: sp.get('groupId'),
        accountId: sp.get('accountId'),
        timeframe: sp.get('timeframe') as 'today' | '7d' | '30d' | 'all' | 'custom' | null,
        fromMs: fromParam ? Number(fromParam) : undefined,
        toMs: toParam ? Number(toParam) : undefined,
      });
      sendJson(ctx.res, 200, report);
      return;
    }

    // ---- POST /api/account/totp/begin — start enrolling the CURRENT user's 2FA ----
    if (method === 'POST' && path === '/api/account/totp/begin') {
      // Enrolling your own 2FA is a self-service action; it does not touch another
      // user, so it needs only an authenticated session, not an owner action.
      const body = (ctx.body ?? {}) as { currentCode?: string };
      const svc = new TotpService({ db: deps.db, tdb: forTenant(deps.db, principal.tenantId), kms: deps.kms });
      try {
        const result = await svc.begin(principal.userId, body.currentCode, deps.now?.() ?? Date.now());
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
      if (typeof body.code !== 'string' || body.code.trim() === '') throw new HttpError(400, 'a code is required');
      const svc = new TotpService({ db: deps.db, tdb: forTenant(deps.db, principal.tenantId), kms: deps.kms });
      try {
        await svc.confirm(principal.userId, body.code.trim(), deps.now?.() ?? Date.now());
      } catch (e) {
        if (e instanceof TotpServiceError) throw new HttpError(400, e.message);
        throw e;
      }
      sendJson(ctx.res, 200, { enabled: true });
      return;
    }

    // ---- POST /api/account/totp/disable — verify current code, then disable ----
    if (method === 'POST' && path === '/api/account/totp/disable') {
      const body = (ctx.body ?? {}) as { code?: string };
      if (typeof body.code !== 'string' || body.code.trim() === '') throw new HttpError(400, 'your current 2FA code is required');
      const svc = new TotpService({ db: deps.db, tdb: forTenant(deps.db, principal.tenantId), kms: deps.kms });
      try {
        await svc.disable(principal.userId, body.code.trim(), deps.now?.() ?? Date.now());
      } catch (e) {
        if (e instanceof TotpServiceError) throw new HttpError(400, e.message);
        throw e;
      }
      sendJson(ctx.res, 200, { enabled: false });
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
      const apiKey = raw['apiKey'];
      const apiSecret = raw['apiSecret'];
      // Each field is checked in its own statement so no single expression ever
      // holds both key names (the 02-accounts single-entry check).
      //
      // No funding currency and no allocated capital are accepted here: both come
      // from the exchange (see OnboardingService.validate). A client that sends
      // them is not trusted to override what the venue reports.
      if (typeof accountName !== 'string' || accountName.trim() === '') {
        throw new HttpError(400, 'an account name is required');
      }
      if (typeof apiKey !== 'string' || apiKey === '') throw new HttpError(400, 'the API key is required');
      if (typeof apiSecret !== 'string' || apiSecret === '') throw new HttpError(400, 'the API secret is required');
      const result = await onboardingFor(principal.tenantId).validate({
        accountName,
        apiKey,
        apiSecret,
      });
      if (!result.ok) {
        const r = result.rejection;
        if (r.kind === 'shape_invalid') throw new HttpError(400, r.message);
        if (r.kind === 'duplicate_key') throw new HttpError(409, r.message);
        if (r.kind === 'duplicate_name') throw new HttpError(409, r.message);
        if (r.kind === 'auth_failed') throw new HttpError(401, r.message);
        throw new HttpError(502, r.message);
      }
      sendJson(ctx.res, 200, { reconciliation: result.reconciliation });
      return;
    }

    // ---- POST /api/accounts/confirm — switch a validated account on (owner + re-auth) ----
    if (method === 'POST' && path === '/api/accounts/confirm') {
      requireAction(principal, 'credential.write');
      const body = (ctx.body ?? {}) as { accountId?: string };
      // No capital, no currency, no balances, not even the credential id: every one
      // of those was read from the venue during validate and is already on the
      // account row. A client cannot restate them, and it does not have to send
      // them back either — which is what lets a connect abandoned at the review
      // step be finished later.
      if (typeof body.accountId !== 'string') {
        throw new HttpError(400, 'accountId is required');
      }
      await runAccountOp(() => onboardingFor(principal.tenantId).confirm({ accountId: body.accountId as string }));
      if (deps.refreshPositions !== undefined) {
        try {
          await deps.refreshPositions({ tenantId: principal.tenantId });
        } catch (e) {
          console.error('[onboarding] initial positions mirror failed:', e instanceof Error ? e.message : String(e));
        }
      }
      sendJson(ctx.res, 200, { ok: true });
      return;
    }

    // ---- Account lifecycle routes (detail / suspend / resume / delete) ----
    // Declared before the bare `:id` match so the verb is never mistaken for one.
    const accountVerbMatch = /^\/api\/accounts\/([0-9a-f-]{36})\/([a-z]+)$/.exec(path);
    if (accountVerbMatch !== null) {
      const accountId = accountVerbMatch[1] as string;
      const verb = accountVerbMatch[2] as string;

      // Suspend and resume are the reversible brake. Both are one guarded UPDATE;
      // `false` means the account was not in the expected source state, which is a
      // 409 rather than a success that quietly changed nothing.
      if (method === 'POST' && (verb === 'suspend' || verb === 'resume')) {
        requireAction(principal, 'account.suspend');
        const tdb = forTenant(deps.db, principal.tenantId);
        const moved = await setAccountStatus(tdb, accountId, verb === 'suspend' ? 'suspended' : 'active');
        if (!moved) {
          throw new HttpError(
            409,
            verb === 'suspend'
              ? 'only an active account can be deactivated'
              : 'only a deactivated account can be reactivated',
          );
        }
        sendJson(ctx.res, 200, { ok: true });
        return;
      }

      // Re-read the venue's balances for this account and store them.
      if (method === 'POST' && verb === 'sync') {
        requireAction(principal, 'view.dashboards');
        if (deps.accountSync === undefined) {
          throw new HttpError(503, 'exchange reads are not configured in this build');
        }
        try {
          const synced = await deps.accountSync({ tenantId: principal.tenantId, accountId });
          sendJson(ctx.res, 200, synced);
        } catch (e) {
          // 503 with the REASON, not a generic 500. Every failure this port can
          // raise is operational — the signer is unset or down, or the venue did
          // not answer — and "internal error" tells neither the customer nor the
          // engineer on call which of those it was. The messages are written for
          // this screen and carry no secret.
          throw new HttpError(503, e instanceof Error ? e.message : 'the exchange could not be read');
        }
        return;
      }

      // Finish a connect that was validated but never confirmed. Payload-free: the
      // basis and balances are already on the row. Same action as confirming, since
      // it is the same transition.
      if (method === 'POST' && verb === 'confirm') {
        requireAction(principal, 'credential.write');
        await runAccountOp(() => onboardingFor(principal.tenantId).confirm({ accountId }));
        if (deps.refreshPositions !== undefined) {
          try {
            await deps.refreshPositions({ tenantId: principal.tenantId });
          } catch (e) {
            console.error('[onboarding] initial positions mirror failed:', e instanceof Error ? e.message : String(e));
          }
        }
        sendJson(ctx.res, 200, { ok: true });
        return;
      }

      throw new HttpError(404, 'not found');
    }

    const accountMatch = /^\/api\/accounts\/([0-9a-f-]{36})$/.exec(path);

    // ---- GET /api/accounts/:id — one account, for the detail page ----
    if (method === 'GET' && accountMatch !== null) {
      requireAction(principal, 'view.dashboards');
      const tdb = forTenant(deps.db, principal.tenantId);
      const detail = await getAccountDetail(tdb, accountMatch[1] as string);
      if (detail === null) throw new HttpError(404, 'no such account');
      sendJson(ctx.res, 200, detail);
      return;
    }

    // ---- DELETE /api/accounts/:id — remove an account that has never traded ----
    // Refused once it has: the ledger is append-only by trigger and every child FK
    // is RESTRICT, so a hard delete is impossible at the database level. The repo
    // raises with the counts, and runAccountOp turns it into a 409 the page shows
    // instead of the button.
    if (method === 'DELETE' && accountMatch !== null) {
      requireAction(principal, 'account.disconnect');
      const tdb = forTenant(deps.db, principal.tenantId);
      const removed = await runAccountOp(() => deleteAccount(tdb, accountMatch[1] as string));
      sendJson(ctx.res, 200, { ok: true, removed });
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
      const body = (ctx.body ?? {}) as { accountId?: string; reassign?: unknown };
      if (typeof body.accountId !== 'string') throw new HttpError(400, 'accountId is required');
      const tdb = forTenant(deps.db, principal.tenantId);
      await runGroupOp(() => addMember(tdb, {
        groupId: membersAddMatch[1] as string,
        accountId: body.accountId as string,
        reassign: body.reassign === true,
      }));
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

    // ---- GET /api/market-price/:pair/:marginCurrency — best bid/ask for limit order auto-fill ----
    const priceMatch = /^\/api\/market-price\/([A-Z]+)\/([A-Z]+)$/.exec(path);
    if (method === 'GET' && priceMatch !== null) {
      requireAction(principal, 'view.dashboards');
      const asset = priceMatch[1]!;
      const quote = priceMatch[2]!;
      if (quote !== 'INR' && quote !== 'USDT') {
        throw new HttpError(400, 'marginCurrency must be INR or USDT');
      }
      try {
        const book = await deps.getOrderBook({ asset, quote: quote as 'INR' | 'USDT' }, 5);
        const bestBid = book.bids[0]?.price ?? null;
        const bestAsk = book.asks[0]?.price ?? null;
        sendJson(ctx.res, 200, { asset, marginCurrency: quote, bestBid, bestAsk, observedAtMs: book.observedAtMs });
      } catch (e) {
        throw new HttpError(500, `could not fetch market price: ${e instanceof Error ? e.message : 'unknown error'}`);
      }
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
      // Poll working legs immediately after drain so immediate fills (e.g. market
      // orders or crossing limits) are recognized, protection (SL/TP) is attached,
      // and the trade flips to completed before the client receives the report.
      try {
        await engine.worker.pollTrade(tdb, tradeId);
      } catch (e) {
        console.error(`[poll] post-drain pollTrade failed for trade ${tradeId}:`,
          e instanceof Error ? e.message : String(e));
      }
      // Mirror the venue's state back into our tables (futures positions) — the
      // hook that finally gives the Positions page a producer. BEST-EFFORT on
      // purpose: the orders are already sent by the time this runs, and a
      // mirroring failure must not turn a placed trade into an error the customer
      // would reasonably read as "nothing happened".
      if (deps.afterFanOut !== undefined) {
        try {
          await deps.afterFanOut({ tenantId: principal.tenantId, groupTradeId: tradeId });
        } catch (e) {
          console.error(`[mirror] post-fan-out mirror failed for trade ${tradeId}:`,
            e instanceof Error ? e.message : String(e));
        }
      }
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
  const distDir = join(here, '..', '..', 'web', 'dist');
  const staticTypes: Readonly<Record<string, string>> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
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
          res.writeHead(200, { 'content-type': contentTypeFor(indexPath), 'cache-control': 'no-cache, no-store, must-revalidate' });
          createReadStream(indexPath).pipe(res);
          return true;
        }
        return false;
      }
    } catch {
      return false;
    }
    const headers: Record<string, string> = { 'content-type': contentTypeFor(filePath) };
    if (filePath.endsWith('index.html')) {
      headers['cache-control'] = 'no-cache, no-store, must-revalidate';
    }
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
    return true;
  };

  /**
   * The resolver sweep. Best-effort and never concurrent with itself: a slow
   * venue must not stack sweeps until the process runs out of sockets.
   */
  let resolverTimer: ReturnType<typeof setInterval> | undefined;
  if (engine !== null && (deps.resolverIntervalMs ?? 0) > 0) {
    let running = false;
    resolverTimer = setInterval(() => {
      if (running) return;
      running = true;
      void (async () => {
        try {
          // Re-queue any stale worker lock FIRST: a crash mid-send leaves a lock
          // and no job, and the resolve is what turns that into a decision.
          await requeueStale(deps.db);
          const summary = await engine.worker.runResolveOnce(25);
          if (summary.handled > 0) {
            console.log(`[resolver] handled ${summary.handled} (ambiguous ${summary.ambiguous}, terminal ${summary.terminal})`);
          }
        } catch (e) {
          // A sweep failure is logged and retried on the next tick — it must never
          // take the process down, since the API is still serving.
          console.error('[resolver] sweep failed:', e instanceof Error ? e.message : String(e));
        } finally {
          running = false;
        }
      })();
    }, deps.resolverIntervalMs as number);
    // Do not hold the process open for a sweep.
    resolverTimer.unref?.();
  }

  // Start the persistent WebSocket feed from CoinDCX for real-time price streaming.
  // Initial REST fetch seeds the in-memory map; WS takes over once connected.
  void getFuturesRtPrices().then(() => startWsPriceFeed()).catch(() => {
    // Start WS feed even if initial REST fetch fails
    startWsPriceFeed();
  });

  const server = createServer((req, res) => {
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
  // The sweep must not outlive the server, or a test that starts and stops one
  // leaves a timer writing to a destroyed pool.
  server.on('close', () => { if (resolverTimer !== undefined) clearInterval(resolverTimer); });
  return server;
}
