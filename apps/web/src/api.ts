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

import type { AccountListItem, AnalyticsReport, BlotterChildRow, ExecutionReport, PlanRequest, PreviewResult } from '@tradex/api';
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

export type { PlanRequest, PreviewResult, PreviewRow, AccountListItem, ExecutionReport, AnalyticsReport, BlotterChildRow, MetricValue, QuoteTotal } from '@tradex/api';
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
export const fetchAccounts = fetchAccountList;

/**
 * Re-read this account's balances from the exchange.
 *
 * Every later trade is sized from these numbers, so a withdrawal or deposit the
 * customer made since connecting is invisible without this.
 */
export const syncAccount = (accountId: string): Promise<{ currencies: string[]; balances: number }> =>
  request<{ currencies: string[]; balances: number }>(`/accounts/${accountId}/sync`, {
    method: 'POST', body: JSON.stringify({}),
  });

/**
 * One account, everything the detail page renders. `deletable` is false once the
 * account has traded, with `undeletableReason` carrying what to show instead —
 * the ledger is append-only, so such an account can never be removed.
 */
export interface AccountDetail extends AccountListItem {
  readonly createdAt: string;
  readonly confirmedAt: string | null;
  readonly balances: readonly AccountBalanceRow[];
  readonly groupCount: number;
  readonly groupNames: readonly string[];
  readonly deletable: boolean;
  readonly undeletableReason: string | null;
}

/** One stored balance: the venue's own figures, at the wallet scale it reported. */
export interface AccountBalanceRow {
  readonly currency: string;
  readonly freeMinor: string;
  readonly lockedMinor: string;
  readonly scale: number;
  readonly observedAt: string;
}

export const fetchAccount = (accountId: string): Promise<AccountDetail> =>
  request<AccountDetail>(`/accounts/${accountId}`);

/** Pause trading on one account. Reversible; the key and history are untouched. */
export const suspendAccount = (accountId: string): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>(`/accounts/${accountId}/suspend`, { method: 'POST', body: JSON.stringify({}) });

/** Resume a deactivated account. */
export const resumeAccount = (accountId: string): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>(`/accounts/${accountId}/resume`, { method: 'POST', body: JSON.stringify({}) });

/** Remove an account that has never traded. 409 — with the reason — once it has. */
export const deleteAccount = (accountId: string): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>(`/accounts/${accountId}`, { method: 'DELETE' });

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
  readonly apiKey: string;
  readonly apiSecret: string;
}

export interface Reconciliation {
  readonly accountId: string;
  readonly credentialId: string;
  readonly apiKeyLast4: string;
  /** Derived server-side from what the account can actually fund with. */
  readonly allocatedCurrency: 'INR' | 'USDT';
  /** The venue's own free balance in that currency, minor units. Nothing typed. */
  readonly realFreeMinor: string;
  readonly fundingCurrencies: readonly string[];
  readonly balances: readonly BalanceRow[];
}

/**
 * Validate an exchange key: seals it, probes the venue, and returns what the
 * account actually holds. Nothing is activated yet — confirm is the separate
 * step that turns the key on.
 */
export const validateAccount = (input: ValidateAccountInput): Promise<{ reconciliation: Reconciliation }> =>
  request<{ reconciliation: Reconciliation }>('/accounts/validate', { method: 'POST', body: JSON.stringify(input) });

/**
 * Switch a validated account on. Nothing about the account is sent: its sizing
 * basis, funding currencies and balances were all read from the venue during
 * validate and are already stored, so this is the whole payload.
 */
export const confirmAccount = (accountId: string): Promise<{ ok: boolean }> =>
  request<{ ok: boolean }>('/accounts/confirm', { method: 'POST', body: JSON.stringify({ accountId }) });

// --- phase 12: blotter + analytics (our own records, never a live price) ------

/** A `?a=1&b=2` string from a params object, dropping empties. */
function qs(params: object): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

export interface BlotterQuery {
  readonly accountId?: string | undefined;
  readonly groupTradeId?: string | undefined;
  readonly market?: string | undefined;
  readonly outcome?: string | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

export interface BlotterPage {
  readonly rows: readonly BlotterChildRow[];
  readonly nextCursor: string | null;
}

/** One page of the order blotter (cursor-paginated, newest first). */
export const fetchBlotter = (q: BlotterQuery = {}): Promise<BlotterPage> =>
  request<BlotterPage>(`/blotter${qs(q)}`);

export interface AnalyticsQuery {
  readonly groupId?: string | undefined;
  readonly accountId?: string | undefined;
  /** Indian financial-year label like '2025-26', or 'current'. */
  readonly fy?: string | undefined;
  readonly fromMs?: number | undefined;
  readonly toMs?: number | undefined;
}

/** The realised-P&L / fees / TDS report + metric values over a window. */
export const fetchAnalytics = (q: AnalyticsQuery = {}): Promise<AnalyticsReport> =>
  request<AnalyticsReport>(`/analytics${qs(q)}`);

/** Download the same window as a CSV and hand the caller a Blob-ready result. */
export async function fetchAnalyticsCsv(q: AnalyticsQuery = {}): Promise<{ text: string; filename: string }> {
  const res = await fetch(`/api/analytics/realised.csv${qs(q)}`);
  if (!res.ok) throw new ApiError(res.status, 'could not download the CSV');
  const text = await res.text();
  const cd = res.headers.get('content-disposition') ?? '';
  const m = /filename="?([^";]+)"?/.exec(cd);
  return { text, filename: m === null ? 'realised.csv' : m[1] };
}


// --- workspace settings -----------------------------------------------------

export interface WorkspaceInfo {
  readonly tenantId: string;
  readonly name: string;
  readonly valuationCurrency: 'INR' | 'USDT';
  readonly status: 'active' | 'suspended' | 'closed';
}

/** Read the workspace this session belongs to (name, currency). */
export const fetchWorkspace = (): Promise<WorkspaceInfo> =>
  request<WorkspaceInfo>('/settings/workspace');

/** Rename the workspace. Owner + fresh 2FA (server enforces both). */
export const renameWorkspace = (name: string): Promise<{ oldName: string; newName: string }> =>
  request<{ oldName: string; newName: string }>('/settings/workspace', {
    method: 'PATCH', body: JSON.stringify({ name }),
  });

/** Satisfy the re-authentication requirement for the current session. */
export async function stepUp(code: string): Promise<{ ok: boolean }> {
  const res = await fetch('/api/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    let msg = 'step-up failed';
    try { const b = (await res.json()) as { message?: string }; if (typeof b.message === 'string') msg = b.message; } catch { /* keep */ }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as { ok: boolean };
}

// --- phase-15 futures ---------------------------------------------------------

export interface FuturesPositionRow {
  readonly venuePositionId: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly groupName?: string | null;
  readonly pair: string;
  readonly marginCurrency: 'INR' | 'USDT';
  readonly side: 'long' | 'short' | 'flat';
  readonly quantity: string;
  readonly avgEntryPrice: string | null;
  readonly markPrice: string | null;
  readonly liquidationPrice: string | null;
  readonly unrealisedPnlMinor: string | null;
  readonly liqBufferBp: number | null;
  readonly leverage: string | null;
  readonly lockedMarginMinor: string | null;
  readonly stopLossTrigger: string | null;
  readonly takeProfitTrigger: string | null;
  readonly fundingRateBp: number | null;
  readonly settlementCurrencyAvgPrice?: string | null;
  readonly markStaleForMs: number | null;
}

export interface FuturesPositionsResponse {
  readonly views: readonly FuturesPositionRow[];
  readonly at: string;
}

/**
 * Partially close, or add to, a live futures position. `percentBp` is of the
 * CURRENT position (2500 = 25%). The server floors to the instrument's step and
 * refuses below the venue's minimums rather than nudging the size up.
 */
export const adjustFuturesPosition = (
  venuePositionId: string, direction: 'reduce' | 'increase', percentBp: number,
): Promise<{ quantity: string; venueOrderId: string | null; full: boolean }> =>
  request<{ quantity: string; venueOrderId: string | null; full: boolean }>(
    `/futures/positions/${venuePositionId}/adjust`,
    { method: 'POST', body: JSON.stringify({ direction, percentBp }) },
  );

/**
 * Re-read the venue's positions and mirror them. The mirror otherwise refreshes
 * only after a fan-out, so a position can outlive the trade that made it.
 */
export const refreshFuturesPositions = (): Promise<{ accounts: number; positions: number }> =>
  request<{ accounts: number; positions: number }>('/futures/positions/refresh', {
    method: 'POST', body: JSON.stringify({}),
  });

export const fetchFuturesPositions = (): Promise<FuturesPositionsResponse> =>
  request<FuturesPositionsResponse>('/futures/positions');

export interface FuturesRtPriceItem {
  readonly markPrice: string;
  readonly lastPrice: string;
  readonly priceChangePercent: number;
}

export interface FuturesPricesResponse {
  readonly prices: Record<string, FuturesRtPriceItem>;
  readonly observedAtMs: number;
}

export const fetchFuturesPrices = (): Promise<FuturesPricesResponse> =>
  request<FuturesPricesResponse>('/futures/prices');

/**
 * Fetch the current market price (best bid/ask) for a futures pair.
 * Used to auto-fill the limit price field on the trade ticket.
 */
export const fetchMarketPrice = (asset: string, marginCurrency: 'INR' | 'USDT'): Promise<{
  readonly asset: string;
  readonly marginCurrency: string;
  readonly bestBid: string | null;
  readonly bestAsk: string | null;
  readonly observedAtMs: number;
}> =>
  request<{
    readonly asset: string;
    readonly marginCurrency: string;
    readonly bestBid: string | null;
    readonly bestAsk: string | null;
    readonly observedAtMs: number;
  }>(`/market-price/${asset}/${marginCurrency}`);

/**
 * Hard-exit a position at market. The server cancels every conditional attached
 * to the position FIRST, then calls positions/exit, then reconciles to zero.
 * A 503 means the composition root has not wired the futures execution engine.
 * A 409 means the safe sequence could not complete (e.g. a conditional could
 * not be cancelled) — the position is untouched.
 */
export const exitFuturesPosition = (venuePositionId: string, marginCurrency: 'INR' | 'USDT'): Promise<{
  readonly cancelled: readonly string[];
  readonly cancelFailures: readonly { readonly venueOrderId: string; readonly reason: string }[];
  readonly exited: boolean;
  readonly venueGroupId: string | null;
  readonly finalActivePos: string;
}> =>
  request(`/futures/positions/${encodeURIComponent(venuePositionId)}/exit`, {
    method: 'POST',
    body: JSON.stringify({ marginCurrency }),
  });

/**
 * Attach or move a stop-loss / take-profit on an existing position. `moveExisting`
 * = the server should cancel the current SL/TP first (research/04 F12: create_tpsl
 * is not an upsert). Set only SL, only TP, or both.
 */
export const setFuturesProtection = (
  venuePositionId: string,
  body: { readonly stopLossPrice?: string; readonly takeProfitPrice?: string; readonly moveExisting?: boolean },
): Promise<{
  readonly stopLoss?: { readonly ok: boolean; readonly reason?: string } | undefined;
  readonly takeProfit?: { readonly ok: boolean; readonly reason?: string } | undefined;
}> =>
  request(`/futures/positions/${encodeURIComponent(venuePositionId)}/tpsl`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

export const setTrailingProtection = (
  venuePositionId: string,
  body: { readonly enable: boolean; readonly distanceBp?: string; readonly stepBp?: string; readonly currentSlPrice?: string },
): Promise<{ readonly ok: boolean; readonly message?: string }> =>
  request(`/futures/positions/${encodeURIComponent(venuePositionId)}/trailing-tpsl`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
