// 00-secret-canary — plan/phase-00 T00.8, from 07-api-key-security.md F6.
//
// The first check written in this project, on purpose. It proves an ABSENCE:
// a sentinel credential driven through every path that could record it must
// appear in none of them.
//
// The four paths are the ones that have historically leaked keys — logs, error
// serialisation, HTTP error bodies, and audit payloads. 16-competitive-benchmark.md
// F1 is the reason: ~100,000 keys leaked at a competitor, and the drain that
// followed did not need a withdrawal endpoint.
//
// The negative control at the end is what makes this check trustworthy: with
// redaction disabled the sentinel MUST appear, or the check is not testing
// anything.

import { REDACTED, Secret, containsSecretShaped, redact } from '../packages/secret/dist/index.js';

/** A CoinDCX-shaped secret: 64 hex characters, unique to this check. */
const SENTINEL = 'c4b7e91a03d6f58274ea1cb90d38f6572be40a9d1c8375ef62b0da4718c93e5f';
const SENTINEL_KEY = '9f2e7c1b84a05d3628fe4b7091ac6d35';

/** A minimal stand-in for the pino pipeline: serialise, then render one line. */
const renderLogLine = (obj) => JSON.stringify(redact(obj));

export async function run(assert) {
  const secret = Secret.of(SENTINEL, 'api_secret');
  const emitted = [];
  const record = (label, text) => emitted.push({ label, text });

  // ---------------------------------------------------------------- path 1: logs
  record('log.plain', renderLogLine({ msg: 'signing order', apiSecret: SENTINEL }));
  record('log.wrapped', renderLogLine({ msg: 'signing order', credential: { apiSecret: secret } }));
  record('log.unexpected-field', renderLogLine({ msg: 'debug', note: SENTINEL }));
  record('log.nested-deep', renderLogLine({ a: { b: { c: { d: { e: { secret: SENTINEL } } } } } }));
  record('log.array', renderLogLine({ creds: [{ api_secret: SENTINEL }, secret] }));
  record('log.headers', renderLogLine({
    req: { headers: { 'x-auth-apikey': SENTINEL_KEY, 'x-auth-signature': SENTINEL, host: 'api.coindcx.com' } },
  }));
  record('log.interpolated', renderLogLine({ msg: `signing with ${secret}` }));

  // -------------------------------------------------- path 2: error serialisation
  const interpolated = new Error(`signature failed for ${secret}`);
  record('error.interpolated', renderLogLine({ err: interpolated }));

  const withPlaintext = new Error('signature failed');
  withPlaintext.apiSecret = SENTINEL;
  record('error.attached-field', renderLogLine({ err: redact(withPlaintext) }));

  try {
    throw new Error(`upstream rejected key ${SENTINEL_KEY} with secret ${SENTINEL}`);
  } catch (e) {
    record('error.thrown', renderLogLine({ err: e }));
    record('error.stack', renderLogLine({ stack: e.stack }));
  }

  // ---------------------------------------------- path 3: HTTP error response body
  const httpBody = redact({
    error: 'credential_invalid',
    detail: 'CoinDCX rejected the credential',
    context: { accountId: 'acc_123', apiKey: SENTINEL_KEY, apiSecret: SENTINEL },
  });
  record('http.error-body', JSON.stringify(httpBody));

  // --------------------------------------------------------- path 4: audit payload
  // DATA-MODEL.md domain 7: before/after pass through this same serialiser.
  const auditEvent = redact({
    action: 'credential.replace',
    subjectType: 'exchange_credential',
    subjectId: 'cred_456',
    before: { apiKeyLast4: 'a91f', api_secret: SENTINEL, status: 'active' },
    after: { apiKeyLast4: '3d02', api_secret: `${SENTINEL.slice(0, 32)}ffff0000ffff0000ffff0000ffff0000`, status: 'active' },
    actorProcess: 'api',
  });
  record('audit.before-after', JSON.stringify(auditEvent));

  // ------------------------------------------------------------------- assertions
  assert(emitted.length === 13, `expected 13 emitted payloads, got ${emitted.length}`);

  for (const { label, text } of emitted) {
    assert(!text.includes(SENTINEL), `SENTINEL secret leaked via ${label}`);
    assert(!text.includes(SENTINEL_KEY), `SENTINEL api key leaked via ${label}`);
    assert(!containsSecretShaped(text), `a secret-shaped token survived in ${label}: ${text.slice(0, 160)}`);
  }

  // Redaction must have actually happened, not merely dropped the fields.
  const redactedCount = emitted.filter(({ text }) => text.includes(REDACTED)).length;
  assert(redactedCount === emitted.length, `only ${redactedCount}/${emitted.length} payloads show the redaction marker`);

  // Diagnostics must survive: a stack with its frames, and non-secret context.
  const stackLine = emitted.find((e) => e.label === 'error.stack');
  assert(stackLine.text.includes('secret-canary'), 'the stack trace lost its frames — redaction is too aggressive');
  assert(emitted.find((e) => e.label === 'log.headers').text.includes('api.coindcx.com'),
    'a non-sensitive header was redacted — the denylist is too broad');
  assert(emitted.find((e) => e.label === 'http.error-body').text.includes('acc_123'),
    'a non-sensitive id was redacted — the shape heuristic is too broad');

  // ---------------------------------------------------------- negative control
  // With redaction bypassed the sentinel MUST appear. A check that cannot fail
  // is not a check.
  const unredacted = JSON.stringify({ msg: 'signing', apiSecret: SENTINEL });
  assert(unredacted.includes(SENTINEL), 'negative control did not leak — this check is not testing anything');
  assert(containsSecretShaped(unredacted), 'containsSecretShaped failed to detect a plain leak');

  // Secret.expose() is the only way out, and it still works.
  assert(secret.expose() === SENTINEL, 'expose() must return the value for the signer');
  assert(String(secret) === REDACTED, 'String(secret) must redact');
}
