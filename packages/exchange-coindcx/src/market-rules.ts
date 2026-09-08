// Market rules mapping — plan/phase-01 T01.4.
//
// Turns a CoinDCX `markets_details` row into our `MarketRules`, renaming as it
// goes. The renaming is the load-bearing part: CoinDCX inverts the industry's
// base/quote convention, so `base_currency_*` describes the PRICING asset (INR,
// USDT) and `target_currency_*` describes the asset being bought (01, F0).
// Reading those the usual way silently mis-sizes every order, which is why the
// inversion is undone exactly here and the venue's names never travel upward.

import type { MarketRules, OrderType } from '@tradex/exchange';
import type { DecimalJson } from './decimal-json.js';
import { JsonParseError, optionalScalar, parseDecimalJson, requireScalar } from './decimal-json.js';

/** Quote currencies Tradex trades in v1 (10 F1 decision). */
export const SUPPORTED_QUOTES = ['INR', 'USDT'] as const;
export type SupportedQuote = (typeof SUPPORTED_QUOTES)[number];

/** Minor-unit scale per quote currency. */
const QUOTE_SCALE: Readonly<Record<SupportedQuote, number>> = { INR: 2, USDT: 8 };

export class MarketMappingError extends Error {
  override readonly name = 'MarketMappingError';
}

/**
 * Expand a numeric literal to plain decimal text, exactly.
 *
 * 90 fields in the live `markets_details` response arrive in exponent form —
 * `min_quantity: 1e-7` on ETHINR, `step: 1e-7` on DEFIINR, `min_price: 1e-11`
 * on dust markets. `packages/money` refuses exponent notation on purpose (it is
 * the notation that hides how many digits you actually have), so every one of
 * those markets would throw the moment the sizing layer touched it.
 *
 * The expansion is done by moving the decimal point through the digit string,
 * never by arithmetic: `Number('5.34966666667e-7')` would reintroduce exactly
 * the rounding `decimal-json.ts` exists to prevent. `decimal-json` keeps the
 * venue's literal because a signed body must echo byte-for-byte; normalising
 * belongs here, at the boundary where venue vocabulary becomes ours.
 */
export function plainDecimal(text: string, field: string): string {
  if (/^-?\d+(\.\d+)?$/.test(text)) return text; // already plain — leave it byte-identical
  const m = /^(-?)(\d+)(?:\.(\d+))?[eE]([-+]?\d+)$/.exec(text);
  if (m === null) throw new MarketMappingError(`${field} is not a decimal number: ${text}`);
  const sign = m[1] ?? '';
  const whole = m[2] ?? '0';
  const frac = m[3] ?? '';
  const exp = Number.parseInt(m[4] ?? '0', 10);
  const digits = whole + frac;
  const point = whole.length + exp;

  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = digits + '0'.repeat(point - digits.length);
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;

  out = out.replace(/^0+(?=\d)/, '');
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return `${sign}${out}`;
}

/** CoinDCX order-type strings we support. Others are ignored for v1. */
const TYPE_MAP: Readonly<Record<string, OrderType>> = {
  limit_order: 'limit',
  market_order: 'market',
};

export interface MappedMarkets {
  readonly rules: readonly MarketRules[];
  /** Markets skipped, with the reason — never silently dropped. */
  readonly skipped: ReadonlyArray<{ readonly symbol: string; readonly reason: string }>;
  readonly rulesVersion: string;
}

/** Shift a major-unit decimal string to minor units, exactly, as an integer string. */
export function toMinorUnits(major: string, scale: number): string {
  if (!/^-?\d+(\.\d*)?$/.test(major)) {
    throw new MarketMappingError(`cannot convert ${major} to minor units: not a plain decimal`);
  }
  const neg = major.startsWith('-');
  const body = neg ? major.slice(1) : major;
  const [whole = '0', frac = ''] = body.split('.');
  if (frac.length > scale) {
    // Truncating here would understate a minimum, which would let an order
    // through that the venue then rejects. Floor is the safe direction for a
    // ceiling and the wrong one for a floor, so refuse instead of guessing.
    const trimmed = frac.slice(0, scale);
    const rest = frac.slice(scale);
    if (/[1-9]/.test(rest)) {
      throw new MarketMappingError(
        `${major} has more precision than ${scale} minor digits; refusing to truncate a limit silently`,
      );
    }
    return `${neg ? '-' : ''}${whole}${trimmed}`.replace(/^(-?)0+(?=\d)/, '$1');
  }
  return `${neg ? '-' : ''}${whole}${frac.padEnd(scale, '0')}`.replace(/^(-?)0+(?=\d)/, '$1');
}

function mapRow(row: { [key: string]: DecimalJson }, rulesVersion: string): MarketRules {
  const symbol = requireScalar(row, 'symbol');
  const quote = requireScalar(row, 'base_currency_short_name'); // their "base" is our quote
  const asset = requireScalar(row, 'target_currency_short_name');
  if (!(SUPPORTED_QUOTES as readonly string[]).includes(quote)) {
    throw new MarketMappingError(`unsupported quote currency ${quote}`);
  }
  const q = quote as SupportedQuote;

  const rawTypes = row['order_types'];
  if (!Array.isArray(rawTypes)) throw new JsonParseError('order_types is not an array');
  const allowedTypes: OrderType[] = [];
  for (const t of rawTypes) {
    if (typeof t !== 'string') continue;
    const mapped = TYPE_MAP[t];
    if (mapped !== undefined && !allowedTypes.includes(mapped)) allowedTypes.push(mapped);
  }
  if (allowedTypes.length === 0) throw new MarketMappingError(`no supported order type among ${rawTypes.join(',')}`);

  const precision = (key: string): number => {
    const v = requireScalar(row, key);
    if (!/^\d+$/.test(v)) throw new MarketMappingError(`${key} is ${v}, expected a non-negative integer`);
    return Number.parseInt(v, 10);
  };

  /** Required decimal field, normalised out of exponent form. */
  const dec = (key: string): string => plainDecimal(requireScalar(row, key), key);
  /** Optional decimal field: absent stays absent, present is normalised. */
  const optDec = (key: string): string | null => {
    const v = optionalScalar(row, key);
    return v === null ? null : plainDecimal(v, key);
  };

  return {
    market: { asset, quote: q },
    venueSymbol: symbol,
    tradable: requireScalar(row, 'status') === 'active',
    quantityStep: dec('step'),
    // The inversion, undone: their base precision is our PRICE precision.
    pricePrecision: precision('base_currency_precision'),
    quantityPrecision: precision('target_currency_precision'),
    minQuantity: dec('min_quantity'),
    maxQuantity: dec('max_quantity'),
    // Documented but absent from every live row — must stay nullable (09 F6).
    minMarketQuantity: optDec('min_market_orders_qty'),
    maxMarketQuantity: optDec('max_quantity_market'),
    minNotionalMinor: toMinorUnits(dec('min_notional'), QUOTE_SCALE[q]),
    minPrice: dec('min_price'),
    maxPrice: dec('max_price'),
    allowedTypes,
    venueCode: requireScalar(row, 'ecode'),
    rulesVersion,
  };
}

/**
 * Map a whole `markets_details` response. A market we cannot represent is
 * SKIPPED with a reason rather than dropped or defaulted, because a silently
 * missing market becomes a confusing "asset not listed" for a customer.
 */
export function mapMarketsDetails(responseText: string, rulesVersion: string): MappedMarkets {
  const parsed = parseDecimalJson(responseText);
  if (!Array.isArray(parsed)) throw new JsonParseError('markets_details did not return an array');

  const rules: MarketRules[] = [];
  const skipped: Array<{ symbol: string; reason: string }> = [];

  for (const entry of parsed) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      skipped.push({ symbol: '(unknown)', reason: 'row is not an object' });
      continue;
    }
    const row = entry as { [key: string]: DecimalJson };
    const symbol = typeof row['symbol'] === 'string' ? row['symbol'] : '(no symbol)';
    try {
      rules.push(mapRow(row, rulesVersion));
    } catch (err) {
      skipped.push({ symbol, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { rules, skipped, rulesVersion };
}

/** Index for market resolution (10 F3): asset -> the markets that trade it. */
export function indexByAsset(rules: readonly MarketRules[]): Map<string, MarketRules[]> {
  const out = new Map<string, MarketRules[]>();
  for (const r of rules) {
    const list = out.get(r.market.asset);
    if (list === undefined) out.set(r.market.asset, [r]);
    else list.push(r);
  }
  return out;
}
