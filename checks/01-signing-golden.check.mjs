// 01-signing-golden — plan/phase-01 T01.2, the check the phase doc names.
//
// This exists to be run in isolation during an incident. When a fleet of 401s
// arrives, the first question is "is our signing still correct, or did the venue
// change something?" — and the answer has to be available without a test runner,
// a config file, or a network call.
//
// The vectors are fixed strings with fixed expected hexes. If these pass, the
// HMAC is right and the problem is elsewhere: the clock, the key, or the venue.

import {
  AUTH_KEY_HEADER, AUTH_SIGNATURE_HEADER, assertSendable, hmacHex, signRequest,
} from '../packages/exchange-coindcx/dist/index.js';

const SECRET = 'tradex_test_secret_do_not_use_in_production';
const KEY = 'tradex_test_key';

/** payload -> expected HMAC-SHA256 hex, under SECRET. */
const VECTORS = [
  // The documented sample body, verbatim from the docs.
  ['{"side":"buy","order_type":"limit_order","market":"SNTBTC","price_per_unit":"0.03244","total_quantity":400,"timestamp":1524211224}',
    'fa99436c4c2754f24c6c145e5fb8f235a29d3b590fe859e1fb5ed9db9470623a'],
  // A realistic Tradex spot order: quantity as a string, with a client id.
  ['{"side":"buy","order_type":"market_order","market":"BTCINR","total_quantity":"0.00246","client_order_id":"t7k2m9x4qp8rv3nc6ba5wy1ze0h","timestamp":1788442200000}',
    '7235e8735cba3e2134d4a912d0c1b4e8a2645b8fb13a98b90039b2d8f434be68'],
  // The minimal authenticated read, e.g. users/balances.
  ['{"timestamp":1788442200000}',
    '655c92b413c3c8cff6efdbf330e08864b39188fe9f0c2a32494b9fbcd05ba23c'],
];

export async function run(assert) {
  // ------------------------------------------------------------ golden vectors
  for (const [payload, expected] of VECTORS) {
    const got = hmacHex(SECRET, payload);
    assert(got === expected,
      `HMAC changed for ${payload.slice(0, 60)}...\n       expected ${expected}\n       got      ${got}`);
  }

  // One character of difference must change the whole digest.
  const a = hmacHex(SECRET, '{"timestamp":1788442200000}');
  const b = hmacHex(SECRET, '{"timestamp":1788442200001}');
  assert(a !== b, 'two different bodies produced the same signature');
  assert(/^[0-9a-f]{64}$/.test(a), `signature is not 64 lowercase hex chars: ${a}`);
  assert(hmacHex('other-secret', VECTORS[2][0]) !== VECTORS[2][1], 'the secret does not affect the signature');

  // ------------------------------------- the signed string IS the sent string
  const signed = signRequest(KEY, SECRET, { market: 'BTCINR', side: 'buy' });
  assert(signed.headers[AUTH_KEY_HEADER] === KEY, 'the api key header is missing or wrong');
  assert(signed.headers[AUTH_SIGNATURE_HEADER] === hmacHex(SECRET, signed.body),
    'the signature does not cover the body being returned');
  assert(signed.body.endsWith('}'), 'the signed body is not a JSON object');
  assert(/"timestamp":\d{13}\}$/.test(signed.body),
    `timestamp is not a 13-digit millisecond value at the end: ${signed.body}`);

  // Key order must be preserved exactly. Re-serialising is the classic bug: the
  // official JS sample signs a string then hands the OBJECT to the HTTP client.
  const reserialised = JSON.stringify(JSON.parse(signed.body));
  assert(hmacHex(SECRET, reserialised) === signed.headers[AUTH_SIGNATURE_HEADER],
    'a round trip through JSON.parse/stringify changed the bytes — key order is not stable');

  // ------------------------------------------------ refusals that prevent a 401
  const refuses = (fn, what) => {
    let threw = false;
    try { fn(); } catch { threw = true; }
    assert(threw, `${what} was accepted; it must be refused before it reaches the venue`);
  };
  refuses(() => signRequest('', SECRET, {}), 'an empty api key');
  refuses(() => signRequest(KEY, '', {}), 'an empty api secret');
  refuses(() => signRequest(KEY, SECRET, { timestamp: 1 }), 'a caller-supplied timestamp');
  refuses(() => signRequest(KEY, SECRET, { qty: undefined }), 'an undefined field JSON.stringify would drop');
  refuses(() => signRequest(KEY, SECRET, { qty: 1n }), 'a bigint that would not serialise');
  refuses(() => signRequest(KEY, SECRET, { price: Number.NaN }), 'a non-finite number');
  refuses(() => signRequest(KEY, SECRET, { price: Number.POSITIVE_INFINITY }), 'Infinity');

  // ----------------------------------------------------------- assertSendable
  const fresh = signRequest(KEY, SECRET, { market: 'BTCINR' });
  assertSendable(SECRET, fresh); // must not throw
  assert(true, 'a freshly signed request is sendable');

  const mutated = { body: fresh.body.replace('BTCINR', 'BTCUSDT'), headers: fresh.headers };
  refuses(() => assertSendable(SECRET, mutated), 'a body mutated after signing');

  const stale = signRequest(KEY, SECRET, { market: 'BTCINR' }, 1788442200000);
  refuses(() => assertSendable(SECRET, stale, { nowMs: 1788442260000 }), 'a body 60s old');
  refuses(() => assertSendable(SECRET, stale, { nowMs: 1788442100000 }), 'a body timestamped in the future');

  const noTimestamp = '{"market":"BTCINR"}';
  refuses(
    () => assertSendable(SECRET, { body: noTimestamp, headers: { [AUTH_SIGNATURE_HEADER]: hmacHex(SECRET, noTimestamp) } }),
    'a signed body with no timestamp',
  );

  console.log(`     ${VECTORS.length} golden vectors reproduce byte-identically`);
}
