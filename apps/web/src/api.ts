// The typed API client for the planning surface.
//
// The request and response shapes are imported as TYPES from @tradex/api, so the
// UI cannot drift from what the planning service actually accepts and returns —
// if the server contract changes, this file stops compiling. Types are erased at
// build, so no server code is bundled into the browser.
//
// This client exposes preview and confirm, plus the Phase-08 execution reads
// (report, live-progress stream, retry-failed). There is deliberately NO
// place/send method anywhere in the web app — the absence is structural, asserted
// by checks/04-no-submit-path.check.mjs. Confirm is the ONLY send-authorising
// action: the server decides (rung-0 dry-run, or a real fan-out behind the
// capability-gated engine) from the preview token; the browser never performs a
// send itself. The live-progress stream is an EventSource in the Execution page,
// not a fetch, so it carries no send shape.

import type { AccountListItem, ExecutionReport, PlanRequest, PositionsResponse, PreviewResult } from '@tradex/api';
import type { GroupHeader, GroupMember, GroupSummary } from '@tradex/db';

/** A minimal fetch wrapper that throws a readable error on a non-2xx response. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { message?: string };
      if (typeof body.message === 'string') detail = body.message;
    } catch {
      // non-JSON error body; keep the status text
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// --- auth ------------------------------------------------------------------
// The public front door. login() sets an httpOnly session cookie server-side;
// the browser never sees the token. fetchSession() is how the guard learns
// whether a session already exists (e.g. after a refresh) without a login form.

export interface SessionInfo {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: 'owner' | 'trader' | 'viewer';
  readonly totpEnabled: boolean;
}

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly totpCode?: string;
}

/** Log in. Throws ApiError with code 'totp_required' when a second factor is needed. */
export async function login(input: LoginInput): Promise<{ role: string; expiresAtMs: number }> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let message = 'login failed';
    let code: string | undefined;
    try {
      const body = (await res.json()) as { message?: string; code?: string };
      if (typeof body.message === 'string') message = body.message;
      if (typeof body.code === 'string') code = body.code;
    } catch { /* keep default */ }
    throw new ApiError(res.status, message, code);
  }
  return (await res.json()) as { role: string; expiresAtMs: number };
}

export interface SignupInput {
  readonly orgName: string;
  readonly email: string;
  readonly password: string;
}

/**
 * Create a workspace: a tenant, its owner user, and a session in one call. The
 * server sets the session cookie on success, so no separate login is needed.
 * Throws ApiError with code 'email_taken' (409) or 'weak_password'/'invalid_input'
 * (400) so the form can show the right message.
 */
export async function signup(input: SignupInput): Promise<{ role: string; expiresAtMs: number }> {
  const res = await fetch('/api/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let message = 'sign up failed';
    let code: string | undefined;
    try {
      const body = (await res.json()) as { message?: string; code?: string };
      if (typeof body.message === 'string') message = body.message;
      if (typeof body.code === 'string') code = body.code;
    } catch { /* keep default */ }
    throw new ApiError(res.status, message, code);
  }
  return (await res.json()) as { role: string; expiresAtMs: number };
}

/** Resolve the current session, or null if not logged in. */
export async function fetchSession(): Promise<SessionInfo | null> {
  const res = await fetch('/api/session');
  if (res.status === 401) return null;
  if (!res.ok) throw new ApiError(res.status, 'could not read the session');
  return (await res.json()) as SessionInfo;
}

/** Log out: clears the session cookie server-side. */
export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST' });
}

/** The groups a customer can trade, for the picker (T04.7). */
export const fetchGroups = (): Promise<readonly GroupSummary[]> =>
  request<readonly GroupSummary[]>('/groups');

/** The tradable assets, for the typeahead. */
export interface AssetOption {
  readonly asset: string;
  /** Which quote markets exist for this asset, e.g. ['INR','USDT']. */
  readonly quotes: readonly string[];
}
export const fetchAssets = (): Promise<readonly AssetOption[]> =>
  request<readonly AssetOption[]>('/assets');

/** Run the planning stage and get the preview. Never cached (the book ages). */
export const previewTrade = (req: PlanRequest): Promise<PreviewResult> =>
  request<PreviewResult>('/group-trades/preview', { method: 'POST', body: JSON.stringify(req) });

/** The persisted plan for a group trade, for the confirmation screen. */
export const fetchTrade = (groupTradeId: string): Promise<PreviewResult> =>
  request<PreviewResult>(`/group-trades/${groupTradeId}`);

/** What the confirm endpoint returns after authorising the trade. */
export interface ConfirmResult {
  readonly status: string;
  /** false = a real fan-out ran (engine build); true = the rung-0 dry run. */
  readonly dryRun: boolean;
  /** Engine builds report how many 'place' jobs were enqueued. */
  readonly enqueued?: number | undefined;
  /** Present when the engine really sent — the honest fan-out result. */
  readonly report?: ExecutionReport | undefined;
}

/**
 * Confirm a previewed trade. This is the ONE send-authorising action in the web
 * app, and the browser never performs the send — it hands the preview token to
 * the server, which decides behind that token: rung-0 dry-run when no execution
 * engine is wired, or a REAL fan-out when it is (and it refuses under
 * NODE_ENV=production with no engine). The confirm response says which world the
 * client is in: `dryRun:true` means nothing was sent and the plan was recorded;
 * `dryRun:false` means the fan-out already happened and the report is real.
 */
export const confirmTrade = (groupTradeId: string, previewToken: string): Promise<ConfirmResult> =>
  request<ConfirmResult>(`/group-trades/${groupTradeId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ previewToken }),
  });

/** The settled execution report for a trade (GET /report) — the durable whole. */
export interface ExecutionReportResponse {
  readonly status: string;
  readonly dryRun: boolean;
  readonly report: ExecutionReport;
}

/** Re-read a trade's execution report — after a reload, or to catch up. */
export const fetchExecutionReport = (groupTradeId: string): Promise<ExecutionReportResponse> =>
  request<ExecutionReportResponse>(`/group-trades/${groupTradeId}/report`);

/**
 * Retry the failed subset of a trade as a FRESH trade (T08.7). The server reads
 * the failed accounts of the given trade, re-plans them against the current book
 * as a brand-new preview, and returns that preview — the old trade is untouched.
 * The caller navigates the operator to the fresh confirmation screen.
 */
export const retryFailedTrade = (groupTradeId: string): Promise<PreviewResult> =>
  request<PreviewResult>(`/group-trades/${groupTradeId}/retry-failed`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

export type { PlanRequest, PreviewResult, PreviewRow, AccountListItem, ExecutionReport, PositionsResponse, PositionView, QuoteRollup } from '@tradex/api';
export type { GroupSummary, GroupMember, GroupHeader } from '@tradex/db';

// --- group management --------------------------------------------------------
// Full CRUD over groups and their members. The list/header types come from
// @tradex/db (the same shapes the server returns), so the UI and the data model
// cannot drift. Reads are dashboard actions; writes are group.write actions, both
// enforced server-side.

/** A group and every member (enabled + disabled) — the detail view's payload. */
export interface GroupDetail extends GroupHeader {
  readonly members: readonly GroupMember[];
}

/** Fetch one group with all its members. */
export const fetchGroup = (groupId: string): Promise<GroupDetail> =>
  request<GroupDetail>(`/groups/${groupId}`);

/** Create a group. Returns its id. */
export const createGroup = (name: string, description?: string): Promise<{ id: string }> =>
  request<{ id: string }>('/groups', {
    method: 'POST',
    body: JSON.stringify({ name, ...(description !== undefined && description !== '' ? { description } : {}) }),
  });

/** Rename a group or change its description. Pass `null` to clear the description. */
export const updateGroup = (groupId: string, patch: { name?: string; description?: string | null }): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>(`/groups/${groupId}`, { method: 'PATCH', body: JSON.stringify(patch) });

/** Archive a group. It disappears from the list; membership rows are retained. */
export const archiveGroup = (groupId: string): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>(`/groups/${groupId}`, { method: 'DELETE' });

/** Add an account to a group. Throws ApiError on duplicate_member / member_limit_reached. */
export const addGroupMember = (groupId: string, accountId: string): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>(`/groups/${groupId}/members`, {
    method: 'POST',
    body: JSON.stringify({ accountId }),
  });

/** Enable or disable a member. A disabled member is skipped by the fan-out. */
export const setGroupMemberEnabled = (groupId: string, accountId: string, enabled: boolean): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>(`/groups/${groupId}/members/${accountId}`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });

/** Remove an account from a group. */
export const removeGroupMember = (groupId: string, accountId: string): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>(`/groups/${groupId}/members/${accountId}`, { method: 'DELETE' });

/** The tenant's accounts, for the add-member picker. */
export const fetchAccountList = (): Promise<readonly AccountListItem[]> =>
  request<readonly AccountListItem[]>('/accounts');

/** The books per account/asset (phase-09 T09.6). Optional group narrows the roll-up. */
export const fetchPositions = (groupId?: string): Promise<PositionsResponse> =>
  request<PositionsResponse>(groupId === undefined || groupId === '' ? '/positions' : `/positions?groupId=${encodeURIComponent(groupId)}`);

// --- phase 05: trading state, pause, limits ----------------------------------

export interface TradingState {
  readonly platform: { killSwitch: boolean; mode: 'normal' | 'cancel_only' | 'read_only'; modeReason: string | null };
  readonly tenant: { tradingPaused: boolean; pausedReason: string | null };
  readonly caps: { perOrderNotionalMinor: string; dailyNotionalMinor: string };
  readonly restrictedMarkets: readonly { market: string; mode: string; reason: string | null }[];
}

/** The full state the UI renders: platform + tenant brakes, caps, restricted markets. */
export const fetchTradingState = (): Promise<TradingState> =>
  request<TradingState>('/trading/state');

/** Pause the desk. Trader can do this without re-auth (server enforces the role). */
export const pauseTrading = (reason: string): Promise<{ paused: boolean }> =>
  request<{ paused: boolean }>('/trading/pause', { method: 'POST', body: JSON.stringify({ reason }) });

/** Resume the desk. Owner + re-auth only (server enforces); 403 until then. */
export const resumeTrading = (): Promise<{ paused: boolean }> =>
  request<{ paused: boolean }>('/trading/resume', { method: 'POST', body: JSON.stringify({}) });

/** One row of the tenant's audit trail (switch/cap/mode changes). */
export interface AuditEventRow {
  readonly id: string;
  readonly actorProcess: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly occurredAt: string;
}

/** The tenant's own audit trail, newest first. Owner + trader (view.audit). */
export const fetchAudit = (): Promise<readonly AuditEventRow[]> =>
  request<readonly AuditEventRow[]>('/audit');

// --- own-account 2FA (phase 05 follow-on) -------------------------------------

export interface BeginTotpResult {
  /** The base32 secret, shown exactly once. */
  readonly secret: string;
  /** The otpauth:// URI an authenticator app scans. */
  readonly otpauthUri: string;
}

/** Start enrolling the signed-in user's 2FA. Returns the one-time secret + URI. */
export const beginTotp = (): Promise<BeginTotpResult> =>
  request<BeginTotpResult>('/account/totp/begin', { method: 'POST', body: JSON.stringify({}) });

/** Prove a code from the authenticator, then enable 2FA. */
export const confirmTotp = (code: string): Promise<{ enabled: boolean }> =>
  request<{ enabled: boolean }>('/account/totp/confirm', { method: 'POST', body: JSON.stringify({ code }) });

// --- connect an exchange account (onboarding) --------------------------------

/** A currency balance, as the server persists it (minor units). */
export interface BalanceRow {
  readonly currency: string;
  readonly freeMinor: string;
  readonly lockedMinor: string;
  readonly scale: number;
}

export interface ValidateAccountInput {
  readonly accountName: string;
  readonly allocatedCapitalMinor: string;
  readonly allocatedCurrency: 'INR' | 'USDT';
  readonly apiKey: string;
  readonly apiSecret: string;
}

export interface Reconciliation {
  readonly accountId: string;
  readonly credentialId: string;
  readonly apiKeyLast4: string;
  readonly allocatedCurrency: 'INR' | 'USDT';
  readonly typedCapitalMinor: string;
  readonly realFreeMinor: string;
  readonly diverges: boolean;
  readonly fundingCurrencies: readonly string[];
  readonly balances: readonly BalanceRow[];
}

/**
 * Validate an exchange key: seals it, probes the venue, and returns the
 * reconciliation (typed vs real capital). Nothing is activated yet — confirm is
 * the separate step where the customer keeps a basis. Owner + re-auth server-side.
 */
export const validateAccount = (input: ValidateAccountInput): Promise<{ reconciliation: Reconciliation }> =>
  request<{ reconciliation: Reconciliation }>('/accounts/validate', { method: 'POST', body: JSON.stringify(input) });

export interface ConfirmAccountInput {
  readonly accountId: string;
  readonly credentialId: string;
  readonly confirmedAgainstMinor: string;
  readonly adoptRealAsBasis: boolean;
  readonly fundingCurrencies: readonly string[];
  readonly balances: readonly BalanceRow[];
}

/** Activate a validated account, recording the customer's basis choice. */
export const confirmAccount = (input: ConfirmAccountInput): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>('/accounts/confirm', { method: 'POST', body: JSON.stringify(input) });

