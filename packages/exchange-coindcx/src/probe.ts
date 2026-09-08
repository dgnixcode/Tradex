// Credential probe — plan/phase-02 T02.4, the live-validation call from 19 F3.
//
// Onboarding needs to prove a key works BEFORE it is trusted for a real order,
// and the credential is `pending_validation` at that moment — which the signer
// refuses (isUsable requires `active`). That refusal is correct, so the probe
// does NOT go through the signer: it signs a `users/balances` read with the
// plaintext key and secret the customer just typed, still held in memory, using
// the same `signRequest` the live path uses. Nothing is decrypted; nothing is
// stored by this function.
//
// The probe is the single point where an onboarding auth failure is classified.
// `users/balances` is the right validation call: it is read-only (no order, no
// rate-limit risk beyond one request), it needs a valid signature (so it proves
// both key and secret), and its success payload is exactly the balances the
// reconciliation panel needs — one round trip does both jobs.

import { classify } from '@tradex/exchange';
import type { CredentialProbe } from '@tradex/exchange';
import { mapBalances } from './balances.js';
import { parseDecimalJson } from './decimal-json.js';
import { TransportError, send } from './http.js';
import { signRequest } from './signing.js';

/** Where authenticated reads live. Overridable so the fake venue can stand in. */
export const DEFAULT_BASE_URL = 'https://api.coindcx.com';
const BALANCES_PATH = '/exchange/v1/users/balances';

/**
 * Pull the venue's error message out of a non-200 body, tolerating both the
 * `{message}` envelope and a bare string. Best-effort: classification must not
 * itself throw on a malformed error body.
 */
function messageFrom(body: string): string {
  try {
    const parsed = parseDecimalJson(body);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = parsed as { [key: string]: unknown };
      if (typeof row['message'] === 'string') return row['message'];
    }
  } catch {
    // fall through
  }
  return body.slice(0, 200);
}

/**
 * Validate a plaintext key/secret against the live venue by reading balances.
 *
 * Never throws for an ordinary auth or venue failure — those are returned as a
 * classified `failure` so the onboarding sequence can branch on them. Only a
 * programming error (an unsignable payload) would throw.
 */
export async function probeCredential(
  apiKey: string,
  apiSecret: string,
  opts: { baseUrl?: string; deadlineMs?: number } = {},
): Promise<CredentialProbe> {
  const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
  const signed = signRequest(apiKey, apiSecret, {});
  const url = new URL(BALANCES_PATH, baseUrl);

  let result;
  try {
    result = await send({
      method: 'POST',
      url,
      body: signed.body,
      headers: signed.headers,
      deadlineMs: opts.deadlineMs ?? 15_000,
    });
  } catch (err) {
    if (err instanceof TransportError) {
      // A never-sent failure (DNS, connect) placed no order and read nothing —
      // it is a "try again" for the customer, not a bad key.
      const neverSent = !err.mayHaveSent;
      return {
        ok: false,
        neverSent,
        failure: classify({ transport: err.kind }),
      };
    }
    throw err;
  }

  if (result.status === 200) {
    // A 200 with a body we cannot parse is NOT a success: returning ok here
    // would activate a credential we never really validated.
    try {
      return { ok: true, balances: mapBalances(result.body) };
    } catch (err) {
      return {
        ok: false,
        failure: classify({ status: 502, message: `balances response could not be parsed: ${String(err)}` }),
      };
    }
  }

  return { ok: false, failure: classify({ status: result.status, message: messageFrom(result.body) }) };
}

/** True when the failure was the venue rejecting the credential, not our transport. */
export const isAuthFailure = (probe: CredentialProbe): boolean =>
  probe.failure?.class === 'auth_failure' || probe.failure?.class === 'signature_error';
