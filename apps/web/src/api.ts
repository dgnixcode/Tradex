// The typed API client for the planning surface.
//
// The request and response shapes are imported as TYPES from @tradex/api, so the
// UI cannot drift from what the planning service actually accepts and returns —
// if the server contract changes, this file stops compiling. Types are erased at
// build, so no server code is bundled into the browser.
//
// This client exposes exactly two planning actions: `preview` and `confirm`.
// There is deliberately NO place/send method anywhere in the web app — rung 0
// cannot send, and the absence is structural, asserted by
// checks/04-no-submit-path.check.mjs. Confirm is dry-run in this phase.

import type { PlanRequest, PreviewResult } from '@tradex/api';
import type { GroupSummary } from '@tradex/db';

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

/**
 * Confirm a previewed trade. In this phase this is DRY-RUN only: the server
 * records what would have been sent and suppresses the send. There is no
 * "place order" call — by design, and enforced by the no-submit-path check.
 */
export const confirmTrade = (groupTradeId: string, previewToken: string): Promise<{ status: string }> =>
  request<{ status: string }>(`/group-trades/${groupTradeId}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ previewToken }),
  });

export type { PlanRequest, PreviewResult } from '@tradex/api';
export type { GroupSummary } from '@tradex/db';
