// Self-serve signup — the other public door beside login.
//
// login() authenticates an EXISTING user; signup() creates the whole starting
// point: a tenant, its limit row, and an OWNER user, then issues a session so the
// new user lands straight in the app. No exchange key is required here —
// connecting a key is the separate onboarding step (OnboardingService), because
// a person should be able to create their workspace before they hold a key.
//
// This is a BOOTSTRAP write: there is no tenant context yet (we are creating the
// tenant), so the three rows are inserted on the unscoped db inside one
// transaction — the same way the seed script and the check harness create a
// tenant. The tenant-scoped query layer is the choke point for READS; creating
// the tenant itself legitimately runs unscoped.
//
// The account rows land atomically; the session is issued after, exactly as
// login does it — so a failure to write the session leaves a usable account the
// user can simply log in to, never a half-built tenant.

import { assertPasswordAcceptable, hashPassword, PasswordError } from '@tradex/auth';
import { generateSessionToken, hashSessionToken, signCookieValue } from '@tradex/auth';
import type { Principal } from '@tradex/auth';
import { createSession } from '@tradex/db';
import type { DB } from '@tradex/db';
import type { Kysely } from 'kysely';
import { SESSION_TTL_MS } from './login-service.js';

export type SignupResult =
  | { readonly ok: true; readonly cookieValue: string; readonly expiresAtMs: number; readonly principal: Principal }
  | { readonly ok: false; readonly code: 'email_taken' | 'weak_password' | 'invalid_input'; readonly message: string };

export interface SignupInput {
  /** The organisation / desk name — becomes the tenant name. */
  readonly orgName: string;
  readonly email: string;
  readonly password: string;
  readonly valuationCurrency?: 'INR' | 'USDT' | undefined;
}

export interface SignupDeps {
  readonly db: Kysely<DB>;
  readonly cookieSecret: Uint8Array;
  readonly now?: (() => number) | undefined;
}

/** Postgres unique-violation SQLSTATE — a duplicate email trips this. */
const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === UNIQUE_VIOLATION;

export class SignupService {
  constructor(private readonly deps: SignupDeps) {}

  async signup(input: SignupInput): Promise<SignupResult> {
    const nowMs = (this.deps.now ?? (() => Date.now()))();

    const orgName = input.orgName.trim();
    const email = input.email.trim().toLowerCase();
    if (orgName === '') return { ok: false, code: 'invalid_input', message: 'a workspace name is required' };
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, code: 'invalid_input', message: 'a valid email is required' };
    }
    // Length beats composition rules; the auth package owns the policy.
    try {
      assertPasswordAcceptable(input.password);
    } catch (e) {
      if (e instanceof PasswordError) return { ok: false, code: 'weak_password', message: e.message };
      throw e;
    }

    const passwordHash = await hashPassword(input.password);

    // Create tenant + limit + owner atomically. A duplicate email surfaces as a
    // unique violation and is mapped to a clean, uniform message.
    let userId: string;
    let tenantId: string;
    try {
      const created = await this.deps.db.transaction().execute(async (trx) => {
        const tenantRow = await trx.insertInto('tenant')
          .values({ name: orgName, valuation_currency: input.valuationCurrency ?? 'INR' } as never)
          .returning('id')
          .executeTakeFirst();
        if (tenantRow === undefined) throw new Error('tenant insert returned no id');
        const tId = (tenantRow as { id: string }).id;

        // The tenant's caps and its own kill switch. Defaults are fine to start.
        await trx.insertInto('tenant_limit').values({ tenant_id: tId } as never).execute();

        const userRow = await trx.insertInto('app_user')
          .values({ tenant_id: tId, email, password_hash: passwordHash, role: 'owner' } as never)
          .returning('id')
          .executeTakeFirst();
        if (userRow === undefined) throw new Error('app_user insert returned no id');
        return { tenantId: tId, userId: (userRow as { id: string }).id };
      });
      tenantId = created.tenantId;
      userId = created.userId;
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Uniform message: do not confirm which field collided beyond "email".
        return { ok: false, code: 'email_taken', message: 'an account with this email already exists' };
      }
      throw err;
    }

    // Issue the session, exactly as login does.
    const token = generateSessionToken();
    const expiresAt = new Date(nowMs + SESSION_TTL_MS);
    await createSession(this.deps.db, { userId, tokenHash: hashSessionToken(token), expiresAt });

    const principal: Principal = { userId, tenantId, role: 'owner', totpEnabled: false };
    return {
      ok: true,
      cookieValue: signCookieValue(token, this.deps.cookieSecret),
      expiresAtMs: expiresAt.getTime(),
      principal,
    };
  }
}
