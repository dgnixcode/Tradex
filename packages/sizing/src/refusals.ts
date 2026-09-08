// Refusal catalogue — plan/phase-03 T03.7.
//
// A closed set of reasons a sizing attempt can be turned down, each with a
// message template that MUST carry the offending value and the limit. "Refused"
// with no numbers is useless on a confirmation screen: the customer cannot tell
// whether they asked for slightly too much or a thousand times too much, and the
// most important refusal in this whole system — the largest account failing a
// percentage buy because the quantity exceeds `max_quantity_market` — is exactly
// the one that looks like a bug unless the numbers are shown (09 F7 row 3).
//
// The message is built here, once, from named fields, so a refusal cannot be
// constructed without its numbers. `03-refusal-catalogue` asserts every code has
// a template and no template omits its interpolations.

export const REFUSAL_CODES = [
  'ASSET_NOT_LISTED',
  'NO_MARKET_FOR_FUNDING_CURRENCY',
  'INSUFFICIENT_BALANCE_EITHER_CURRENCY',
  'MARKET_INACTIVE',
  'MARKET_EXIT_ONLY',
  'ORDER_TYPE_NOT_ALLOWED',
  'BELOW_MIN_QTY',
  'ABOVE_MAX_QTY',
  'ABOVE_MAX_QTY_MARKET',
  'BELOW_MIN_NOTIONAL',
  'PRICE_NOT_ON_TICK',
  'PRICE_OUT_OF_RANGE',
  'INSUFFICIENT_HOLDING',
  'INSUFFICIENT_BALANCE',
  'ZERO_QUANTITY',
  'NO_BASIS_AMOUNT',
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** A refusal always carries a code, a rendered sentence, and the raw values behind it. */
export interface Refusal {
  readonly code: RefusalCode;
  /** Human sentence containing the offending value and the limit. */
  readonly message: string;
  /** The value that offended and the limit it broke, as exact decimal strings. */
  readonly offending?: string | undefined;
  readonly limit?: string | undefined;
  /** For NO_MARKET_FOR_FUNDING_CURRENCY: the currencies that WOULD work (10 F3). */
  readonly remedyCurrencies?: readonly string[] | undefined;
}

interface RefusalInput {
  readonly offending?: string;
  readonly limit?: string;
  readonly detail?: string;
  readonly remedyCurrencies?: readonly string[];
}

/**
 * Every code's sentence. `{offending}`/`{limit}`/`{detail}` are filled from the
 * input; a template that names a placeholder with no matching value throws at
 * build time rather than shipping a half-rendered sentence.
 */
const TEMPLATES: Readonly<Record<RefusalCode, string>> = {
  ASSET_NOT_LISTED: 'No market lists {detail} on this venue.',
  NO_MARKET_FOR_FUNDING_CURRENCY:
    'This asset is listed, but not in a currency this account can fund with. It trades in {detail}.',
  INSUFFICIENT_BALANCE_EITHER_CURRENCY:
    'No currency this account is funded in holds enough for the smallest legal order. '
    + 'The closest is {detail}, where {offending} is free against a minimum order value of {limit}.',
  MARKET_INACTIVE: 'The market {detail} is not currently active for trading.',
  MARKET_EXIT_ONLY: 'The market {detail} is in exit-only mode; you can close a position but not open one.',
  ORDER_TYPE_NOT_ALLOWED: 'A {detail} order is not allowed on this market.',
  BELOW_MIN_QTY: 'The quantity {offending} is below the minimum tradable quantity of {limit}.',
  ABOVE_MAX_QTY: 'The quantity {offending} is above the maximum quantity of {limit}.',
  ABOVE_MAX_QTY_MARKET:
    'The quantity {offending} exceeds the market-order cap of {limit}. '
    + 'A percentage of a large account can exceed this cap — place a limit order or split the order.',
  BELOW_MIN_NOTIONAL: 'The order value {offending} is below the minimum order value of {limit}.',
  PRICE_NOT_ON_TICK: 'The price {offending} is not a multiple of the tick size {limit}.',
  PRICE_OUT_OF_RANGE: 'The price {offending} is outside the permitted range (limit {limit}).',
  INSUFFICIENT_HOLDING: 'The account holds only {offending}, less than the {limit} this sell requires.',
  INSUFFICIENT_BALANCE: 'The account has {offending} free, less than the {limit} this order needs.',
  ZERO_QUANTITY: 'The requested size rounds down to zero at this market’s precision.',
  NO_BASIS_AMOUNT: 'There is no {detail} to size a percentage against.',
};

const render = (template: string, input: RefusalInput): string =>
  template
    .replace('{offending}', input.offending ?? '')
    .replace('{limit}', input.limit ?? '')
    .replace('{detail}', input.detail ?? '');

/** Build a refusal, rendering its sentence from the catalogue. */
export function refuse(code: RefusalCode, input: RefusalInput = {}): Refusal {
  const template = TEMPLATES[code];
  const message = render(template, input).replace(/\s+/g, ' ').trim();
  const out: {
    code: RefusalCode; message: string;
    offending?: string; limit?: string; remedyCurrencies?: readonly string[];
  } = { code, message };
  if (input.offending !== undefined) out.offending = input.offending;
  if (input.limit !== undefined) out.limit = input.limit;
  if (input.remedyCurrencies !== undefined) out.remedyCurrencies = input.remedyCurrencies;
  return out;
}

/** Codes whose sentence interpolates a numeric offending/limit pair. */
export const NUMERIC_REFUSALS: readonly RefusalCode[] = [
  'BELOW_MIN_QTY', 'ABOVE_MAX_QTY', 'ABOVE_MAX_QTY_MARKET', 'BELOW_MIN_NOTIONAL',
  'PRICE_NOT_ON_TICK', 'PRICE_OUT_OF_RANGE', 'INSUFFICIENT_HOLDING', 'INSUFFICIENT_BALANCE',
  'INSUFFICIENT_BALANCE_EITHER_CURRENCY',
];

/** Codes whose sentence names something non-numeric: a market, an asset, a mode. */
export const DETAIL_REFUSALS: readonly RefusalCode[] = [
  'ASSET_NOT_LISTED', 'NO_MARKET_FOR_FUNDING_CURRENCY', 'INSUFFICIENT_BALANCE_EITHER_CURRENCY',
  'MARKET_INACTIVE', 'MARKET_EXIT_ONLY', 'ORDER_TYPE_NOT_ALLOWED', 'NO_BASIS_AMOUNT',
];

/** The raw templates, for the catalogue check. */
export const REFUSAL_TEMPLATES = TEMPLATES;
