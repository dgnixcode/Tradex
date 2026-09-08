// Failure classification is the field most likely to cost money if it is wrong,
// so the table is asserted exhaustively rather than sampled.
// Source: 08-fanout-execution-engine.md F2, 03 F8, 06.

import { describe, expect, it } from 'vitest';
import { DOCUMENTED_STATUS, classify, isRetrySafe, needsResolve } from './classify.js';

describe('transport failures leave the order in doubt', () => {
  it.each(['timeout', 'reset'] as const)('%s means the order may exist', (transport) => {
    const f = classify({ transport });
    expect(f.class).toBe('timeout');
    expect(f.orderMayExist).toBe(true);
    expect(f.retrySafe).toBe(false);
    expect(needsResolve(f)).toBe(true);
  });

  it('never permits a blind retry — that is the duplicate-order bug', () => {
    expect(isRetrySafe(classify({ transport: 'timeout' }))).toBe(false);
  });
});

describe('a failure before the first byte is not in doubt at all', () => {
  // DNS resolution and TCP connect both complete before any request byte is
  // written, so no order can exist. Calling these ambiguous would put every DNS
  // blip through the resolve ladder — a cost with no information in return.
  it.each(['dns', 'connect'] as const)('%s proves the request never left', (transport) => {
    const f = classify({ transport });
    expect(f.class).toBe('connect_failure');
    expect(f.orderMayExist).toBe(false);
    expect(f.retrySafe).toBe(true);
    expect(needsResolve(f)).toBe(false);
    expect(f.detail).toMatch(/never reached the venue/);
  });

  it('is told apart from a reset, which can land after the write', () => {
    expect(classify({ transport: 'reset' }).class).not.toBe(classify({ transport: 'connect' }).class);
  });
});

describe('401 is split by cause, because a clock problem is not a bad key', () => {
  it('classifies a signature or timestamp rejection as retry-safe', () => {
    for (const message of ['Invalid signature', 'timestamp too old', 'Invalid credentials', 'You are not logged in']) {
      const f = classify({ status: 401, message });
      expect(f.class).toBe('signature_error');
      expect(f.retrySafe).toBe(true);
      expect(f.orderMayExist).toBe(false);
    }
  });

  it('classifies an unexplained 401 as a credential failure, never retried', () => {
    const f = classify({ status: 401, message: 'Unauthorized' });
    expect(f.class).toBe('auth_failure');
    expect(f.retrySafe).toBe(false);
    expect(f.detail).toMatch(/block the account/);
  });
});

describe('429 never executed, so it is safe to re-queue', () => {
  it('is retry-safe and cannot have created an order', () => {
    const f = classify({ status: 429, message: 'Too Many Requests' });
    expect(f.class).toBe('rate_limited');
    expect(f.retrySafe).toBe(true);
    expect(f.orderMayExist).toBe(false);
  });
});

describe('business rejections are never retried', () => {
  // Live messages from 03 F8, with their embedded numbers, so prefix matching is
  // exercised the way it will be in production.
  const cases: ReadonlyArray<readonly [string, string]> = [
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

  it.each(cases)('%s maps to %s', (message, code) => {
    for (const status of [400, 422]) {
      const f = classify({ status, message });
      expect(f.class).toBe('business_rejection');
      expect(f.code).toBe(code);
      expect(f.retrySafe, `${message} must never be retried`).toBe(false);
      expect(f.orderMayExist, `${message} means the venue refused, so no order exists`).toBe(false);
    }
  });

  it('still refuses to retry a 4xx whose message is unmapped', () => {
    const f = classify({ status: 400, message: 'Some new message nobody has seen' });
    expect(f.class).toBe('business_rejection');
    expect(f.code).toBe('unrecognised_rejection');
    expect(f.retrySafe).toBe(false);
    expect(f.detail).toMatch(/unmapped message/);
  });
});

describe('5xx is genuinely ambiguous', () => {
  it.each([500, 503])('%i means resolve before deciding', (status) => {
    const f = classify({ status, message: 'Internal Server Error' });
    expect(f.class).toBe('server_error');
    expect(f.orderMayExist).toBe(true);
    expect(f.retrySafe).toBe(false);
  });
});

describe('the body code wins over the HTTP status', () => {
  it('uses bodyCode when the two disagree', () => {
    // 06 records that the envelope is not uniform; `code` in the body is the
    // field to branch on.
    expect(classify({ status: 200, bodyCode: 429, message: 'Too Many Requests' }).class).toBe('rate_limited');
  });

  it('tolerates a missing errorCode, which 401 bodies omit', () => {
    expect(() => classify({ status: 401, message: 'Invalid credentials' })).not.toThrow();
    expect(classify({ status: 400, message: 'Invalid Request.', errorCode: 'BFF-SO-004' }).code).toBe('invalid_request');
  });
});

describe('unknown shapes fail safe', () => {
  it('assumes the order may exist', () => {
    const f = classify({ status: 418, message: "I'm a teapot" });
    expect(f.class).toBe('unknown');
    expect(f.orderMayExist).toBe(true);
    expect(f.retrySafe).toBe(false);
  });

  it('handles an empty failure without throwing', () => {
    const f = classify({});
    expect(f.class).toBe('unknown');
    expect(f.orderMayExist).toBe(true);
  });
});

describe('every documented status is classified, and none throws', () => {
  it.each(DOCUMENTED_STATUS)('status %i', (status) => {
    const f = classify({ status, message: 'anything' });
    expect(f.class).not.toBe('unknown');
    expect(typeof f.code).toBe('string');
    expect(f.detail.length).toBeGreaterThan(10);
  });

  it('never reports a failure as both retry-safe and order-may-exist', () => {
    // Both true at once would mean "safe to send again" AND "one may already
    // exist" — the combination that produces duplicates.
    const samples = [
      { transport: 'timeout' as const },
      { transport: 'reset' as const },
      { transport: 'dns' as const },
      { transport: 'connect' as const },
      { status: 401, message: 'Invalid signature' },
      { status: 401, message: 'Unauthorized' },
      { status: 429, message: 'x' },
      { status: 400, message: 'Insufficient funds' },
      { status: 500, message: 'x' },
      { status: 418, message: 'x' },
      {},
    ];
    for (const s of samples) {
      const f = classify(s);
      expect(f.retrySafe && f.orderMayExist, `${JSON.stringify(s)} is both retry-safe and ambiguous`).toBe(false);
    }
  });
});
