// 06-clock-skew — plan/phase-06 T06.10 (offline half).
//
// A skewed signing host sends a timestamp the venue rejects, and the venue
// answers 401 — the SAME status as a genuinely bad credential. If the two are
// conflated, a clock problem would be misdiagnosed as a revoked key across every
// account at once (12 F7). This proves classify() tells them apart: a
// signature/timestamp message classifies as signature_error (clock-fixable,
// retry-safe), never as auth_failure. Pure — no key needed.

import { classify } from '../packages/exchange/dist/index.js';

export async function run(assert) {
  // A simulated 15 s skew → the venue's signature/timestamp 401.
  const skew = classify({ status: 401, message: 'Access Denied - Your timestamp is wrong' });
  assert(skew.class === 'signature_error', `a timestamp 401 must be signature_error, got ${skew.class}`);
  assert(skew.code === 'signature_or_timestamp', 'the signature/timestamp code must be distinct');
  assert(skew.retrySafe === true, 'a clock problem is fixable — re-sign at send time is safe');

  const sig = classify({ status: 401, message: 'Invalid signature' });
  assert(sig.class === 'signature_error', 'an invalid-signature 401 must be signature_error, not a credential error');

  // A genuine bad-credential 401 stays auth_failure — the two never merge. The
  // classifier maps 'Invalid credentials' to signature_error too, because that is
  // the venue's MISSING-AUTH-HEADER body (nothing was signed) — still a client
  // signing problem. The real revoked-key body is a different string.
  const cred = classify({ status: 401, message: 'Invalid Api Key' });
  assert(cred.class === 'auth_failure', `a revoked-key 401 must be auth_failure, got ${cred.class}`);
  assert(cred.retrySafe === false, 'a rejected credential must never be retried');
  assert(cred.class !== skew.class, 'a skew and a bad credential must classify differently');

  // The two also differ from every other class the engine sees on a send.
  const rej = classify({ status: 400, message: 'Quantity should be greater than 0.00001' });
  assert(rej.class === 'business_rejection' && rej.orderMayExist === false, 'a business rejection is not an auth/skew problem');
  const srv = classify({ status: 503 });
  assert(srv.class === 'server_error' && srv.orderMayExist === true, 'a 503 stays ambiguous, distinct from both 401 kinds');
}
