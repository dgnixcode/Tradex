// Failure classification — plan/phase-01 T01.7, from 08-fanout-execution-engine.md F2.
//
// The `retrySafe` and `orderMayExist` fields are the whole point. Get them wrong
// in one direction and a group trade stalls; wrong in the other and a customer
// gets two real positions where they authorised one.
//
// Three rules, taken from the documented behaviour and verified against live
// probes recorded in 01 and 06:
//   1. Branch on the numeric `code`, never on `message` — two routes returned
//      two different strings for the same failure.
//   2. Treat `errorCode` (e.g. 'BFF-SO-004') as optional; it is absent on 401s.
//   3. An unrecognised shape becomes `unknown` with orderMayExist = true. The
//      safe default is to assume the order might exist and resolve it.

import type { ClassifiedFailure } from './adapter.js';

/** Documented codes (docs Errors section) plus 422, which is undocumented but real. */
export const DOCUMENTED_STATUS = [400, 401, 404, 422, 429, 500, 503] as const;

/**
 * Message prefixes that identify a business rejection. Matched on a normalised
 * prefix because the live messages embed numbers — "Minimum order value should
 * be x USDT", "Quantity should be greater than y" (03 F8).
 */
const BUSINESS_PREFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/insufficient\s+(funds|balance)/i, 'insufficient_balance'],
  [/minimum\s+order\s+value/i, 'below_min_notional'],
  [/min(imum)?\s+notional/i, 'below_min_notional'],
  [/quantity\s+should\s+be\s+greater/i, 'below_min_quantity'],
  [/quantity\s+for\s+(limit|market)\s+variant/i, 'above_max_quantity'],
  [/price\s+is\s+out\s+of\s+permissible\s+range/i, 'price_out_of_range'],
  [/please\s+enter\s+a\s+value\s+(lower|higher)/i, 'price_out_of_band'],
  [/price\s+should\s+be\s+divisible/i, 'price_not_on_tick'],
  [/order\s+type\s+not\s+allowed/i, 'order_type_not_allowed'],
  [/exit-only\s+mode/i, 'market_exit_only'],
  [/max\s+allowed\s+position/i, 'position_cap_exceeded'],
  [/leverage\s+must\s+be\s+equal/i, 'leverage_mismatch'],
  [/cannot\s+be\s+cancelled/i, 'order_not_cancellable'],
  [/client_order_id/i, 'duplicate_client_order_id'],
  [/invalid\s+request/i, 'invalid_request'],
];

const signatureish = (text: string): boolean =>
  /signature|timestamp|invalid\s+credentials|not\s+logged\s+in/i.test(text);

export interface RawFailure {
  /** HTTP status, or undefined for a transport-level failure. */
  readonly status?: number | undefined;
  /** Body `code` when present. CoinDCX repeats the status here. */
  readonly bodyCode?: number | undefined;
  readonly message?: string | undefined;
  /** Undocumented structured namespace, e.g. 'BFF-SO-004'. Optional. */
  readonly errorCode?: string | undefined;
  /**
   * True when nothing came back at all. The four kinds are not equivalent:
   * `dns` and `connect` fail *before* any byte reaches the venue, so no order
   * can exist and re-issuing is safe. `timeout` and `reset` can happen after
   * the request was written, so the outcome is genuinely unknown.
   */
  readonly transport?: 'timeout' | 'reset' | 'dns' | 'connect' | undefined;
}

/** Transport kinds where the request provably never reached the venue. */
const NEVER_SENT: ReadonlySet<string> = new Set(['dns', 'connect']);


const of = (
  cls: ClassifiedFailure['class'],
  code: string,
  detail: string,
  orderMayExist: boolean,
  retrySafe: boolean,
): ClassifiedFailure => ({ class: cls, code, detail, orderMayExist, retrySafe });

/**
 * Classify one failed exchange call.
 *
 * `orderMayExist` is true whenever we cannot rule out that the venue accepted
 * the order. That drives the resolve ladder in 08 F6, and erring toward true is
 * always the cheaper mistake: a needless status read costs one request, while a
 * wrongly-assumed non-existent order costs a duplicate position.
 */
export function classify(raw: RawFailure): ClassifiedFailure {
  const message = raw.message ?? '';

  // ---- transport: nothing came back ----
  if (raw.transport !== undefined) {
    if (NEVER_SENT.has(raw.transport)) {
      // Name resolution and connection establishment both complete before a
      // single request byte is written, so this is one of the few failures we
      // can call safe with certainty. Treating it as ambiguous would send every
      // DNS blip through the resolve ladder for no information.
      return of('connect_failure', `transport_${raw.transport}`,
        `never reached the venue (${raw.transport}) — no order was placed; re-sign and re-issue`,
        false, true);
    }
    return of('timeout', `transport_${raw.transport}`,
      `no response from the venue (${raw.transport}) — the order may or may not have been accepted`,
      true, false);
  }

  const status = raw.bodyCode ?? raw.status;

  switch (status) {
    case 401:
      // A signing or clock problem also arrives as 401, and must be told apart
      // from a revoked key or it will be misdiagnosed across every account at
      // once (12 F7).
      return signatureish(message)
        ? of('signature_error', 'signature_or_timestamp',
            'signature or timestamp rejected — re-sign at send time and check the clock', false, true)
        : of('auth_failure', 'credential_rejected',
            'the venue rejected the credential — do not retry, block the account and notify', false, false);

    case 429:
      return of('rate_limited', 'rate_limited',
        'rate limit reached — the request never executed; re-queue after the bucket refills', false, true);

    case 400:
    case 422: {
      const matched = BUSINESS_PREFIXES.find(([re]) => re.test(message));
      if (matched !== undefined) {
        return of('business_rejection', matched[1],
          `the venue refused this order: ${message}`, false, false);
      }
      // Unrecognised 4xx: still a rejection (the venue evaluated and refused),
      // so never retry — but surface it so the prefix table can be extended.
      return of('business_rejection', 'unrecognised_rejection',
        `refused with an unmapped message: ${message}`, false, false);
    }

    case 404:
      return of('not_found', 'not_found', `no such route or resource: ${message}`, false, false);

    case 500:
    case 503:
      // Documented as "a one-off error" and "downtime". Neither tells us
      // whether the order was accepted first (08 F2).
      return of('server_error', `server_${status}`,
        `the venue failed after receiving the request (${status}) — resolve before deciding`, true, false);

    default:
      return of('unknown', 'unclassified',
        `unrecognised failure${status === undefined ? '' : ` (status ${status})`}: ${message}`,
        true, false);
  }
}

/** True when this failure permits sending the same request again as-is. */
export const isRetrySafe = (f: ClassifiedFailure): boolean => f.retrySafe;

/**
 * True when the outcome is unknown and the order must be resolved by client id
 * before anything else happens for that account.
 */
export const needsResolve = (f: ClassifiedFailure): boolean => f.orderMayExist;
