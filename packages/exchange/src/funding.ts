// Funding currencies — plan/phase-02 T02.6, venue-neutral domain logic.
//
// This lives in the port, not the adapter, on purpose. Which quote currencies a
// customer can size a percentage order against, and how much is spendable, is a
// fact about our product — not about CoinDCX. The adapter parses a venue's
// balance response into `Balance[]`; everything after that is domain, and the
// ADAPTER-BOUNDARY rule keeps it that way so a venue swap never touches sizing.

import type { Balance } from './adapter.js';

/** The quote currencies Tradex can fund a percentage-sized order with (10 F1). */
export const FUNDING_CURRENCIES = ['INR', 'USDT'] as const;
export type FundingCurrency = (typeof FUNDING_CURRENCIES)[number];

export const isFundingCurrency = (c: string): c is FundingCurrency =>
  (FUNDING_CURRENCIES as readonly string[]).includes(c);

/**
 * Derive funding currencies from observed balances (T02.6).
 *
 * A quote currency counts only if the account holds a positive FREE balance in
 * it. A customer with five lakh locked in open orders and nothing free cannot
 * fund a new percentage buy, and listing INR as "funding" there would let a
 * group trade size against money that is not spendable (11 F1).
 *
 * Never derived from what the customer typed — only from what the account holds.
 */
/*
 * A quote currency counts only if the account holds a positive FREE balance in
 * it. A customer with five lakh locked in open orders and nothing free cannot
 * fund a new percentage buy, and listing INR as "funding" there would let a
 * group trade size against money that is not spendable (11 F1).
 *
 * Positive means positive AFTER projection onto the tradable step — see
 * `freeBalanceMinor` below. A wallet holding 0.00508437692499 INR holds no paise,
 * so it cannot fund anything and must not win the derivation over a real USDT
 * balance just because the raw figure is non-zero.
 *
 * Never derived from what the customer typed — only from what the account holds.
 */
export function deriveFundingCurrencies(balances: readonly Balance[]): FundingCurrency[] {
  const out: FundingCurrency[] = [];
  for (const quote of FUNDING_CURRENCIES) {
    if (freeBalanceMinor(balances, quote) !== '0') out.push(quote);
  }
  return out;
}

/**
 * Minor-unit scale of a quote currency — the scale a SPENDABLE figure is stated in.
 *
 * Deliberately a local copy of `quoteScaleOf` (sizing/decimal.ts, ledger/fold.ts):
 * this package is the venue-neutral port and carries no workspace dependencies, and
 * importing `@tradex/sizing` from here would close a cycle — `@tradex/sizing`
 * already imports `freeBalanceMinor` from this file.
 */
const QUOTE_SCALE: Readonly<Record<string, number>> = { INR: 2, USDT: 8 };
const quoteScaleOf = (quote: string): number => QUOTE_SCALE[quote] ?? 8;

/**
 * Restate a minor-unit string from one scale to another, discarding anything below
 * the target scale.
 *
 * TWO SCALES LIVE ON A BALANCE and they are not the same number:
 *
 *   * the WALLET scale the venue reported (`Balance.scale`) — an internal ledger
 *     precision. A real account reported INR `0.00508437692499`, 14 decimals,
 *     because CoinDCX tracks its ledger finer than the rupee's tradable step.
 *   * the TRADABLE scale of the quote (`quoteScaleOf`) — paise for INR, which is
 *     the scale every downstream figure (sizing basis, caps, minNotional) is
 *     stated in.
 *
 * Discarding is safe here ONLY because the target is the venue's tradable step and
 * the dropped digits are by definition not tradable — half a paise cannot be spent
 * or ordered. The exact figure is never lost: `Balance.freeMinor` keeps it at the
 * wallet scale, and this is the projection of that onto what is usable. Widening
 * pads with zeros and is always exact.
 */
function projectToScale(minor: string, from: number, to: number): string {
  if (from === to) return minor;
  const negative = minor.startsWith('-');
  const digits = (negative ? minor.slice(1) : minor).replace(/^0+(?=\d)/, '');
  if (to > from) return `${negative ? '-' : ''}${digits}${'0'.repeat(to - from)}`;
  const kept = digits.length - (from - to);
  if (kept <= 0) return '0';
  return `${negative ? '-' : ''}${digits.slice(0, kept).replace(/^0+(?=\d)/, '')}`;
}

/**
 * The free balance in one currency, minor units, AT THE QUOTE'S TRADABLE SCALE —
 * or '0' if none is held.
 *
 * Returning quote-scale units is load-bearing, not cosmetic. Every caller treats
 * this as a spendable figure in the quote's own scale: `market-resolution` builds
 * `BigInt(freeBalanceMinor(...))` and compares it against `minNotionalMinor`, and
 * onboarding writes it straight to `allocated_capital_minor`. Handing back a
 * wallet-scale string there overstates the account's buying power by orders of
 * magnitude — a scale-18 dust INR row reads as ₹50,84,37,69,24,990 at scale 2.
 */
export function freeBalanceMinor(balances: readonly Balance[], currency: string): string {
  const held = balances.find((b) => b.currency === currency);
  if (held === undefined) return '0';
  return projectToScale(held.freeMinor, held.scale, quoteScaleOf(currency));
}
