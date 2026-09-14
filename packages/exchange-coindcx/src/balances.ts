// Balances mapping — plan/phase-02 T02.4 and T02.6, from 01 F6.1 and 11 F1.
//
// `POST /exchange/v1/users/balances` returns one object per currency the account
// holds: `{ currency, balance, locked_balance }`. Three traps live here.
//
//   1. The numbers are MAJOR units and the venue is inconsistent about quoting
//      them — `markets_details` quotes its decimals, `trade_history` does not
//      (progress finding 27). So this parses with the decimal-safe reader and
//      converts to minor units through `toMinorUnits`, which refuses to
//      truncate rather than silently losing a fraction of a balance.
//
//   2. The venue reports the WALLET's precision, which is finer than the
//      currency's tradable step — a real account returned INR `0.00508437692499`.
//      We store the balance exactly at whatever scale holds it, and it is
//      `freeBalanceMinor` (in the port) that projects onto the tradable scale
//      before anything sizes against it. Do not confuse the two scales.
//
//   3. `balance` is the FREE balance and `locked_balance` is what an open order
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
 * Preferred minor-unit scale per currency.
 *
 * INR is normally paise (2). Everything else is 8, the crypto convention and the
 * maximum `target_currency_precision` seen across the live markets. This is a
 * PREFERRED representation, not a ceiling — see `scaleToFit`.
 */
const SCALE_BY_CURRENCY: Readonly<Record<string, number>> = { INR: 2 };
const DEFAULT_SCALE = 8;

/** Every scale the money layer supports, ascending. */
const SCALES_ASC: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 18];

export const scaleFor = (currency: string): number => SCALE_BY_CURRENCY[currency] ?? DEFAULT_SCALE;

/**
 * SIGNIFICANT decimal places in a plain-decimal string — trailing zeros do not
 * count, because they lose nothing when dropped. `100.0000` is 0 significant
 * decimals (fine at INR's scale of 2); `100.005` is 3 (not fine). This mirrors
 * what `toMinorUnits` actually checks when it refuses to truncate.
 */
const decimalsOf = (plain: string): number => {
  const dot = plain.indexOf('.');
  if (dot === -1) return 0;
  return plain.slice(dot + 1).replace(/0+$/, '').length;
};

/**
 * The scale that holds `value` EXACTLY: the currency's preferred scale when it
 * fits, otherwise the smallest supported scale that does.
 *
 * The per-currency scale is a convention about how a currency is normally
 * written, not a limit on what a wallet can hold. A venue tracks its internal
 * ledger finer than the tradable step, and the live `users/balances` proves it:
 * a real account reported INR `0.00508437692499` (14 decimals) and a real YFI
 * dust balance reported `0.00000000534923`. Treating either as a venue bug and
 * refusing it hard-fails onboarding on dust the customer cannot do anything
 * about. Widening keeps every digit, so the never-silently-truncate rule is
 * intact; only a value finer than 18 decimals is a genuine error.
 *
 * This is NOT the scale that drives sizing. `freeBalanceMinor` projects the
 * stored balance onto the quote's tradable scale before anything sizes against
 * it. This scale exists so the balance is stored without loss.
 */
function scaleToFit(currency: string, value: string): number | null {
  const preferred = scaleFor(currency);
  const frac = decimalsOf(value);
  if (frac <= preferred) return preferred;
  return SCALES_ASC.find((s) => s >= frac) ?? null;
}

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

    const free = plainDecimal(requireScalar(row, 'balance'), `${currency}.balance`);
    // Some rows omit locked_balance entirely; absent means zero locked.
    const lockedRaw = optionalScalar(row, 'locked_balance');
    const locked = lockedRaw === null ? '0' : plainDecimal(lockedRaw, `${currency}.locked_balance`);

    // Widen the scale to fit what the venue actually reported (see scaleToFit).
    const freeScale = scaleToFit(currency, free);
    const lockedScale = scaleToFit(currency, locked);
    if (freeScale === null || lockedScale === null) {
      throw new BalanceMappingError(
        `cannot represent ${currency} balance without loss: ${free} / ${locked} carries more ` +
        `precision than the widest supported scale (${SCALES_ASC[SCALES_ASC.length - 1]}); ` +
        'refusing to truncate silently',
      );
    }
    const scale = Math.max(freeScale, lockedScale);

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
