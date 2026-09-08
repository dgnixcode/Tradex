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
// the role matrix. There is no unauthenticated path to any tenant data, and no
// place/send route exists at all — this phase cannot send.

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { assertAuthorised, AuthorisationError, parseCookieHeader, SESSION_COOKIE } from '@tradex/auth';
import type { Action, Principal } from '@tradex/auth';
import {
  forTenant, listTradableAssets, listGroups, createGroup, confirmDryRun,
  updateGroup, archiveGroup, addMember, removeMember, setMemberEnabled,
  getGroupMembers, getGroupHeader, GroupRepoError,
} from '@tradex/db';
import type { DB } from '@tradex/db';
import { listAccounts } from './accounts-query.js';
import type { Kysely } from 'kysely';
import type { MarketRef, OrderBook } from '@tradex/exchange';
import { LoginService } from './login-service.js';
import type { SecondFactorVerifier } from './login-service.js';
import { SignupService } from './signup-service.js';
import { PlanningService } from './planning-service.js';
import type { PlanRequest } from './planning-service.js';
import { buildSetCookie, buildClearCookie } from '@tradex/auth';

export interface HttpDeps {
  readonly db: Kysely<DB>;
  /** The only venue call, injected so this .ts file never imports the adapter. */
  readonly getOrderBook: (market: MarketRef, depth: number) => Promise<OrderBook>;
  readonly cookieSecret: Uint8Array;
  readonly verifySecondFactor: SecondFactorVerifier;
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
      ...(deps.now !== undefined ? { now: deps.now } : {}),
    });

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

    // ---- GET /api/session — who am I (for the UI to render roles) ----
    if (method === 'GET' && path === '/api/session') {
      sendJson(ctx.res, 200, { userId: principal.userId, tenantId: principal.tenantId, role: principal.role });
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

    // ---- GET /api/assets ----
    if (method === 'GET' && path === '/api/assets') {
      requireAction(principal, 'view.dashboards');
      sendJson(ctx.res, 200, await listTradableAssets(deps.db));
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

    // ---- GET /api/group-trades/:id ----
    const tradeMatch = /^\/api\/group-trades\/([0-9a-f-]{36})$/.exec(path);
    if (method === 'GET' && tradeMatch !== null) {
      requireAction(principal, 'view.dashboards');
      const plan = await planning.getPlan(tradeMatch[1] as string);
      if (plan === null) throw new HttpError(404, 'no such group trade');
      sendJson(ctx.res, 200, plan);
      return;
    }

    // ---- POST /api/group-trades/:id/confirm — dry-run only in this phase ----
    const confirmMatch = /^\/api\/group-trades\/([0-9a-f-]{36})\/confirm$/.exec(path);
    if (method === 'POST' && confirmMatch !== null) {
      requireAction(principal, 'trade.place');
      const body = (ctx.body ?? {}) as { previewToken?: string };
      if (typeof body.previewToken !== 'string') throw new HttpError(400, 'previewToken is required');
      try {
        await confirmDryRun(forTenant(deps.db, principal.tenantId), confirmMatch[1] as string, body.previewToken,
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

    throw new HttpError(404, 'not found');
  };

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost');
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
