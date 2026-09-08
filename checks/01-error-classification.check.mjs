// 01-error-classification — plan/phase-01 T01.7, the check the phase doc names.
//
// Runnable in isolation during an incident, because the question it answers is
// operational: "the venue is returning this message — is it safe to retry, and
// might an order already exist?" Getting the second answer wrong in one
// direction stalls a group trade; in the other it produces a customer with two
// real positions where they authorised one.
//
// Every message here is one CoinDCX actually returned, recorded in 03 F8 and 06,
// with its embedded numbers intact so prefix matching is exercised as it will be.

import {
  DOCUMENTED_STATUS, classify, isRetrySafe, needsResolve,
} from '../packages/exchange/dist/index.js';

/** Live message -> the code it must map to. */
const BUSINESS = [
  ['Insufficient funds', 'insufficient_balance'],
  ['Minimum order value should be 5 USDT', 'below_min_notional'],
  ['Quantity should be greater than 0.001', 'below_min_quantity'],
  ['Quantity for market variant orders should be less than 9500.0', 'above_max_quantity'],
  ['Price is out of permissible range', 'price_out_of_range'],
  ['Please enter a value lower than 8100000', 'price_out_of_band'],
  ['Price should be divisible by 0.01', 'price_not_on_tick'],
  ['Order type not allowed', 'order_type_not_allowed'],
  ["Instrument is in exit-only mode. You can't add more position.", 'market_exit_only'],
  ["You've exceeded the max allowed position of 500000 USDT.", 'position_cap_exceeded'],
  ['Order leverage must be equal to position leverage', 'leverage_mismatch'],
  ['This order cannot be cancelled', 'order_not_cancellable'],
  ['client_order_id already used', 'duplicate_client_order_id'],
  ['Invalid Request.', 'invalid_request'],
];

export async function run(assert) {
  // ------------------------------------- the invariant that prevents duplicates
  // retrySafe and orderMayExist must never both be true. Together they say
  // "safe to send again" AND "one may already exist", which is the duplicate.
  const everyShape = [
    { transport: 'timeout' }, { transport: 'reset' }, { transport: 'dns' }, { transport: 'connect' },
    { status: 401, message: 'Invalid signature' }, { status: 401, message: 'Unauthorized' },
    { status: 429, message: 'Too Many Requests' }, { status: 404, message: 'Not Found' },
    { status: 400, message: 'Insufficient funds' }, { status: 422, message: 'Invalid Request.' },
    { status: 500, message: 'Internal Server Error' }, { status: 503, message: 'Service Unavailable' },
    { status: 418, message: "I'm a teapot" }, {},
    ...BUSINESS.map(([message]) => ({ status: 400, message })),
  ];
  for (const shape of everyShape) {
    const f = classify(shape);
    assert(!(f.retrySafe && f.orderMayExist),
      `${JSON.stringify(shape)} is BOTH retry-safe and possibly-placed — that combination produces duplicates`);
    assert(typeof f.code === 'string' && f.code.length > 0, `${JSON.stringify(shape)} has no code`);
    assert(f.detail.length > 10, `${JSON.stringify(shape)} has no usable detail`);
  }

  // ------------------------------------------------------- transport, split two ways
  for (const kind of ['timeout', 'reset']) {
    const f = classify({ transport: kind });
    assert(f.class === 'timeout', `${kind} should be class timeout, got ${f.class}`);
    assert(f.orderMayExist === true, `${kind} must be treated as possibly-placed`);
    assert(needsResolve(f), `${kind} must go through the resolve ladder`);
    assert(!isRetrySafe(f), `${kind} must never be retried blindly`);
  }
  for (const kind of ['dns', 'connect']) {
    // Name resolution, TCP connect and the TLS handshake all finish before a
    // request byte is written, so these provably placed nothing.
    const f = classify({ transport: kind });
    assert(f.class === 'connect_failure', `${kind} should be class connect_failure, got ${f.class}`);
    assert(f.orderMayExist === false, `${kind} cannot have placed an order`);
    assert(isRetrySafe(f), `${kind} is safe to re-issue`);
    assert(!needsResolve(f), `${kind} must not trigger a resolve`);
  }

  // ------------------------------------------- 401 is two failures, not one
  for (const message of ['Invalid signature', 'timestamp too old', 'Invalid credentials', 'You are not logged in']) {
    const f = classify({ status: 401, message });
    assert(f.class === 'signature_error', `401 "${message}" should be signature_error, got ${f.class}`);
    assert(f.retrySafe === true, `401 "${message}" is a signing problem and is retry-safe after re-signing`);
  }
  const badKey = classify({ status: 401, message: 'Unauthorized' });
  assert(badKey.class === 'auth_failure', 'an unexplained 401 must be treated as a credential failure');
  assert(badKey.retrySafe === false, 'a credential failure must never be retried');
  assert(/block the account/.test(badKey.detail), 'a credential failure must say to block the account');

  // ---------------------------------------------------- business rejections
  for (const [message, code] of BUSINESS) {
    for (const status of [400, 422]) {
      const f = classify({ status, message });
      assert(f.class === 'business_rejection', `${status} "${message}" -> ${f.class}, expected business_rejection`);
      assert(f.code === code, `"${message}" -> ${f.code}, expected ${code}`);
      assert(f.retrySafe === false, `"${message}" must never be retried`);
      assert(f.orderMayExist === false, `"${message}" means the venue refused, so no order exists`);
    }
  }

  const unmapped = classify({ status: 400, message: 'Some message nobody has seen before' });
  assert(unmapped.code === 'unrecognised_rejection', 'an unmapped 4xx must be surfaced, not silently bucketed');
  assert(unmapped.retrySafe === false, 'an unmapped 4xx is still a rejection and must not be retried');

  // -------------------------------------------------------- ambiguity and 429
  for (const status of [500, 503]) {
    const f = classify({ status, message: 'x' });
    assert(f.class === 'server_error' && f.orderMayExist === true,
      `${status} must be ambiguous: the venue failed AFTER receiving the request`);
    assert(f.retrySafe === false, `${status} must not be retried without resolving first`);
  }
  const limited = classify({ status: 429, message: 'Too Many Requests' });
  assert(limited.class === 'rate_limited' && limited.retrySafe === true && limited.orderMayExist === false,
    '429 never executed, so it is safe to re-queue');

  // The body code wins over the HTTP status: the envelope is not uniform (06).
  assert(classify({ status: 200, bodyCode: 429, message: 'Too Many Requests' }).class === 'rate_limited',
    'a 200 carrying code 429 in the body must classify as rate_limited');

  // ------------------------------------------- nothing documented may throw
  for (const status of DOCUMENTED_STATUS) {
    const f = classify({ status, message: 'anything' });
    assert(f.class !== 'unknown', `documented status ${status} fell through to unknown`);
  }
  const teapot = classify({ status: 418, message: 'x' });
  assert(teapot.class === 'unknown' && teapot.orderMayExist === true,
    'an unrecognised status must fail safe by assuming the order may exist');
  assert(classify({}).orderMayExist === true, 'an empty failure must fail safe');

  console.log(`     ${everyShape.length} failure shapes, ${BUSINESS.length} live messages, ${DOCUMENTED_STATUS.length} documented statuses`);
}
