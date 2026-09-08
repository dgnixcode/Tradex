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
export function deriveFundingCurrencies(balances: readonly Balance[]): FundingCurrency[] {
  const out: FundingCurrency[] = [];
  for (const quote of FUNDING_CURRENCIES) {
    const held = balances.find((b) => b.currency === quote);
    if (held !== undefined && held.freeMinor !== '0') out.push(quote);
  }
  return out;
}

/** The free balance in one currency, minor units, or '0' if none is held. */
export function freeBalanceMinor(balances: readonly Balance[], currency: string): string {
  return balances.find((b) => b.currency === currency)?.freeMinor ?? '0';
}
