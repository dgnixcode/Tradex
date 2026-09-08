// Login and session resolution — the HTTP layer's front door.
//
// This is the missing half of the auth model: packages/auth verifies a password
// and a TOTP code and defines authorise()/Principal, packages/db stores sessions,
// and this service ties them together. It does two things:
//
//   login()          — verify the password and the second factor, then issue a
//                       session row and a signed cookie value.
//   principalFrom()  — turn a presented cookie back into a Principal, or null.
//
// TWO SECURITY DISCIPLINES.
//
// The TOTP check is INJECTED as a port (`verifySecondFactor`), not implemented
// here. The TOTP secret is KMS-encrypted in app_user.totp_secret_ct; decrypting
// it inside apps/api would put plaintext key material one import away from the
// SIGNER-ONLY-EXPOSE boundary. Injecting the verifier keeps this service free of
// key material and unit-testable with a fake.
//
// login() is deliberately UNIFORM on failure: a wrong email, a wrong password and
// a wrong code all return the same `invalid_credentials`, so the response leaks
// nothing about which was wrong or whether the account exists. Password
// verification runs even for an unknown email would be ideal; here the lookup is
// by email and a miss short-circuits, so a dummy-hash compare guards the timing.

import { createHash } from 'node:crypto';
import { verifyPassword } from '@tradex/auth';
import {
  generateSessionToken, hashSessionToken, readCookieValue, signCookieValue,
} from '@tradex/auth';
import type { Principal, Role } from '@tradex/auth';
import { createSession, loadPrincipalByToken, touchReauth } from '@tradex/db';
import type { DB } from '@tradex/db';
import type { Kysely } from 'kysely';

/** How long a fresh session lives. A working day; re-auth still gates the risky actions. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export type LoginResult =
  | { readonly ok: true; readonly cookieValue: string; readonly expiresAtMs: number; readonly principal: Principal }
  | { readonly ok: false; readonly code: 'invalid_credentials' | 'totp_required' };

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  /** The TOTP code. Required when the user has TOTP enrolled. */
  readonly totpCode?: string | undefined;
}

/** Verify a user's TOTP code. Injected so the KMS-encrypted secret never enters this service. */
export type SecondFactorVerifier = (userId: string, code: string, atMs: number) => Promise<boolean>;

export interface LoginDeps {
  readonly db: Kysely<DB>;
  readonly cookieSecret: Uint8Array;
  readonly verifySecondFactor: SecondFactorVerifier;
  readonly now?: (() => number) | undefined;
}

/** A dummy hash to compare against on an unknown email, so timing does not reveal existence. */
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export class LoginService {
  constructor(private readonly deps: LoginDeps) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const nowMs = (this.deps.now ?? (() => Date.now()))();

    const user = await this.deps.db.selectFrom('app_user')
      .select(['id', 'tenant_id', 'password_hash', 'role', 'totp_enabled', 'disabled_at'])
      .where('email', '=', input.email.trim().toLowerCase())
      .executeTakeFirst();

    // Always run a password verification, even on a miss, so the response time
    // does not distinguish "no such user" from "wrong password".
    const stored = user?.password_hash ?? DUMMY_HASH;
    const passwordOk = await verifyPassword(input.password, stored);

    if (user === undefined || user.disabled_at !== null || !passwordOk) {
      return { ok: false, code: 'invalid_credentials' };
    }

    // Second factor: required when enrolled. A missing code is a distinct signal
    // (the UI should prompt for it) but still authenticates nothing on its own.
    let reauthAt: Date | undefined;
    if (user.totp_enabled) {
      if (input.totpCode === undefined || input.totpCode === '') {
        return { ok: false, code: 'totp_required' };
      }
      const codeOk = await this.deps.verifySecondFactor(user.id, input.totpCode, nowMs);
      if (!codeOk) return { ok: false, code: 'invalid_credentials' };
      // The login itself satisfied the second factor, so the session starts
      // reauth-fresh — the risky actions do not immediately re-prompt.
      reauthAt = new Date(nowMs);
    }

    const token = generateSessionToken();
    const expiresAt = new Date(nowMs + SESSION_TTL_MS);
    await createSession(this.deps.db, {
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
      ...(reauthAt !== undefined ? { reauthAt } : {}),
    });

    const principal: Principal = {
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role as Role,
      totpEnabled: user.totp_enabled,
      ...(reauthAt !== undefined ? { reauthAt } : {}),
    };
    return {
      ok: true,
      cookieValue: signCookieValue(token, this.deps.cookieSecret),
      expiresAtMs: expiresAt.getTime(),
      principal,
    };
  }

  /**
   * Resolve a presented cookie value to a Principal, or null. Verifies the HMAC
   * first (rejecting a forged cookie with no DB hit), then loads the live session
   * by the token's hash. Returns null for any failure — forged, expired, revoked,
   * or unknown — so a caller cannot distinguish them.
   */
  async principalFrom(cookieValue: string | undefined, nowMs?: number): Promise<(Principal & { sessionId: string }) | null> {
    if (cookieValue === undefined || cookieValue === '') return null;
    const token = readCookieValue(cookieValue, this.deps.cookieSecret);
    if (token === null) return null;

    const at = new Date(nowMs ?? (this.deps.now ?? (() => Date.now()))());
    const tokenHash = createHash('sha256').update(token, 'utf8').digest();
    const session = await loadPrincipalByToken(this.deps.db, tokenHash, at);
    if (session === null) return null;

    return {
      sessionId: session.sessionId,
      userId: session.userId,
      tenantId: session.tenantId,
      role: session.role as Role,
      totpEnabled: session.totpEnabled,
      ...(session.reauthAt !== null ? { reauthAt: session.reauthAt } : {}),
    };
  }

  /** Record a fresh second factor on an existing session (step-up for a risky action). */
  async stepUp(sessionId: string, userId: string, code: string, nowMs?: number): Promise<boolean> {
    const at = nowMs ?? (this.deps.now ?? (() => Date.now()))();
    const ok = await this.deps.verifySecondFactor(userId, code, at);
    if (!ok) return false;
    await touchReauth(this.deps.db, sessionId, new Date(at));
    return true;
  }
}
