// The role matrix — plan/phase-00 T00.9, from 19-accounts-groups-data-model.md F4.
//
// Enforced server-side. The UI hides what a role cannot do, but hiding is not
// enforcing, so every route consults `authorise()` and the check script asserts
// the whole matrix.
//
// One asymmetry is deliberate and worth reading twice: a `trader` may PAUSE
// trading without re-authentication, but only an `owner` may RESUME, and only
// with re-authentication. Stopping should always be easier than starting —
// 20 F3's runbooks all begin with "engage the kill switch", and a re-auth prompt
// at that moment is a delay when speed is the whole point.

export type Role = 'owner' | 'trader' | 'viewer';

export const ROLES: readonly Role[] = ['owner', 'trader', 'viewer'];

export type Action =
  | 'view.dashboards'
  | 'view.audit'
  | 'trade.place'
  | 'trade.place.large'
  | 'trade.cancel'
  | 'group.write'
  | 'credential.write'
  | 'account.allocated.write'
  | 'account.disconnect'
  | 'limits.write'
  | 'trading.pause'
  | 'trading.resume'
  | 'users.manage';

export interface Permission {
  readonly roles: readonly Role[];
  /** A fresh second factor is required, regardless of session age. */
  readonly requiresReauth: boolean;
  /** Why, in one line — surfaced in the 403 body so a denial is explicable. */
  readonly reason: string;
}

export const MATRIX: Readonly<Record<Action, Permission>> = {
  'view.dashboards': { roles: ['owner', 'trader', 'viewer'], requiresReauth: false, reason: 'read-only' },
  'view.audit': { roles: ['owner', 'trader'], requiresReauth: false, reason: 'audit is not visible to viewers' },

  'trade.place': { roles: ['owner', 'trader'], requiresReauth: false, reason: 'placing trades is a trader action' },
  'trade.place.large': {
    roles: ['owner', 'trader'],
    requiresReauth: true,
    reason: 'above the tenant typed-confirmation threshold',
  },
  'trade.cancel': { roles: ['owner', 'trader'], requiresReauth: false, reason: 'cancelling is a trader action' },
  'group.write': { roles: ['owner', 'trader'], requiresReauth: false, reason: 'groups are a trader action' },

  'credential.write': {
    roles: ['owner'],
    requiresReauth: true,
    reason: 'connecting or replacing an API key is the highest-value action in the product',
  },
  'account.allocated.write': {
    roles: ['owner'],
    requiresReauth: true,
    reason: 'allocated capital changes every future trade size without placing a trade',
  },
  'account.disconnect': {
    roles: ['owner'],
    requiresReauth: true,
    reason: 'disconnecting crypto-shreds the credential',
  },
  'limits.write': { roles: ['owner'], requiresReauth: true, reason: 'caps are the backstop against a mis-sized trade' },

  // The asymmetry. Read the module comment.
  'trading.pause': { roles: ['owner', 'trader'], requiresReauth: false, reason: 'stopping must never be gated' },
  'trading.resume': { roles: ['owner'], requiresReauth: true, reason: 'resuming after a pause is an owner decision' },

  'users.manage': { roles: ['owner'], requiresReauth: true, reason: 'user management is an owner action' },
};

export const ACTIONS = Object.keys(MATRIX) as Action[];

export interface Principal {
  readonly userId: string;
  readonly tenantId: string;
  readonly role: Role;
  /** When the second factor was last satisfied. Undefined means never. */
  readonly reauthAt?: Date | undefined;
  readonly totpEnabled: boolean;
}

/** How long a re-authentication stays fresh. */
export const REAUTH_TTL_MS = 5 * 60 * 1000;

export type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: 'forbidden_role' | 'reauth_required' | 'totp_not_enrolled'; readonly reason: string };

export function authorise(principal: Principal, action: Action, now: Date = new Date()): Decision {
  const permission = MATRIX[action];
  if (!permission.roles.includes(principal.role)) {
    return {
      allowed: false,
      code: 'forbidden_role',
      reason: `${principal.role} may not perform ${action}: ${permission.reason}`,
    };
  }
  if (!permission.requiresReauth) return { allowed: true };

  if (!principal.totpEnabled) {
    return {
      allowed: false,
      code: 'totp_not_enrolled',
      reason: `${action} requires two-factor authentication; enrol before continuing`,
    };
  }
  const at = principal.reauthAt;
  if (at === undefined || now.getTime() - at.getTime() > REAUTH_TTL_MS) {
    return { allowed: false, code: 'reauth_required', reason: `${action} requires a fresh second factor` };
  }
  return { allowed: true };
}

/** Convenience for routes: throws rather than returning a decision. */
export class AuthorisationError extends Error {
  override readonly name = 'AuthorisationError';
  constructor(
    readonly code: 'forbidden_role' | 'reauth_required' | 'totp_not_enrolled',
    message: string,
  ) {
    super(message);
  }
}

export function assertAuthorised(principal: Principal, action: Action, now: Date = new Date()): void {
  const decision = authorise(principal, action, now);
  if (!decision.allowed) throw new AuthorisationError(decision.code, decision.reason);
}

/** Actions a role can perform at all, ignoring re-auth. For rendering a UI. */
export const actionsFor = (role: Role): Action[] => ACTIONS.filter((a) => MATRIX[a].roles.includes(role));
