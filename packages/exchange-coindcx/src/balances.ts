// Balances mapping — plan/phase-02 T02.4 and T02.6, from 01 F6.1 and 11 F1.
//
// `POST /exchange/v1/users/balances` returns one object per currency the account
// holds: `{ currency, balance, locked_balance }`. Two traps live here.
//
//   1. The numbers are MAJOR units and the venue is inconsistent about quoting
//      them — `markets_details` quotes its decimals, `trade_history` does not
//      (progress finding 27). So this parses with the decimal-safe reader and
//      converts to minor units through `toMinorUnits`, which refuses to
//      truncate rather than silently losing a fraction of a balance.
//
//   2. `balance` is the FREE balance and `locked_balance` is what an open order
//      is holding; the two are disjoint (01 F6.1). A sell sizes against `free`
//      alone (11 F1), so they are kept as separate fields and never summed here.
//
// Funding currencies are DERIVED from what the account actually holds in a quote
// currency, never from what the customer typed (T02.6). A percentage-of-capital
// order can only be placed in a currency the account can actually pay with.

import type { Balance } from '@tradex/exchange';
import type { DecimalJson } from './decimal-json.js';
import { JsonParseError, optionalScalar, parseDecimalJson, requireScalar } from './decimal-json.js';
import { MarketMappingError, plainDecimal, toMinorUnits } from './market-rules.js';

/**
 * Minor-unit scale per currency.
 *
 * INR is paise (2). Everything else is treated as 8, the crypto convention and
 * the maximum `target_currency_precision` seen across the live markets. A value
 * carrying more precision than its scale is refused by `toMinorUnits` rather
 * than rounded — a rounded balance is a wrong balance, and this one drives
 * sizing.
 */
const SCALE_BY_CURRENCY: Readonly<Record<string, number>> = { INR: 2 };
const DEFAULT_SCALE = 8;

export const scaleFor = (currency: string): number => SCALE_BY_CURRENCY[currency] ?? DEFAULT_SCALE;

export class BalanceMappingError extends Error {
  override readonly name = 'BalanceMappingError';
}

/**
 * Map a `users/balances` response into our `Balance[]`.
 *
 * A currency with both balances zero is dropped: the venue returns a row for
 * every currency the account has ever touched, and a wall of zero rows buries
 * the two or three that matter. A currency we cannot parse is an error, not a
 * skip — a balance we misread is worse than one we refuse to show.
 */
export function mapBalances(responseText: string): Balance[] {
  const parsed = parseDecimalJson(responseText);
  if (!Array.isArray(parsed)) throw new JsonParseError('users/balances did not return an array');

  const out: Balance[] = [];
  const seen = new Set<string>();
  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BalanceMappingError('a balance row is not an object');
    }
    const row = entry as { [key: string]: DecimalJson };
    const currency = requireScalar(row, 'currency').toUpperCase();
    if (seen.has(currency)) throw new BalanceMappingError(`currency ${currency} appears twice in one response`);
    seen.add(currency);

    const scale = scaleFor(currency);
    const free = plainDecimal(requireScalar(row, 'balance'), `${currency}.balance`);
    // Some rows omit locked_balance entirely; absent means zero locked.
    const lockedRaw = optionalScalar(row, 'locked_balance');
    const locked = lockedRaw === null ? '0' : plainDecimal(lockedRaw, `${currency}.locked_balance`);

    let freeMinor: string;
    let lockedMinor: string;
    try {
      freeMinor = toMinorUnits(free, scale);
      lockedMinor = toMinorUnits(locked, scale);
    } catch (err) {
      // A precision overflow here means the venue reported more decimals than
      // our scale for this currency — surface it, never round it away.
      const detail = err instanceof MarketMappingError ? err.message : String(err);
      throw new BalanceMappingError(`cannot represent ${currency} balance without loss: ${detail}`);
    }

    if (freeMinor === '0' && lockedMinor === '0') continue;
    out.push({ currency, freeMinor, lockedMinor, scale });
  }
  return out;
}
