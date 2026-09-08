// Market resolution — plan/phase-03 T03.2, from 10 F1/F2/F3.
//
// A group trade names an ASSET ("BTC"), not a market. Each account funds in its
// own currencies, so the same asset resolves to a different concrete market per
// account — or to none. Five outcomes, all explicit:
//
//   - no market lists the asset             -> ASSET_NOT_LISTED
//   - listed, but every market is halted    -> MARKET_INACTIVE
//   - listed, but not in a currency this    -> NO_MARKET_FOR_FUNDING_CURRENCY,
//     account can fund                         carrying the currencies that WOULD work
//   - funded in both, neither holds enough   -> INSUFFICIENT_BALANCE_EITHER_CURRENCY
//     for the smallest legal order
//   - otherwise                             -> resolve, preferring INR
//
// INR is preferred over USDT (10 F1 as amended by 11 F7): an INR market carries
// no order-time TDS, which more than offsets its wider spread — roughly 2.4%
// against 3.0% per round trip. The choice and its reason are returned, because
// "why did this account trade INR when it holds both" is a question the audit
// trail must answer.
//
// Balances are the input rather than a pre-computed currency list, because 10 F3
// derives funding from balances (`funded = { ccy | balances.free[ccy] > 0 }`) and
// the affordability step needs the amounts anyway. One source of truth means a
// declared funding currency cannot disagree with the money actually present.

import type { Balance, MarketRules } from '@tradex/exchange';
import { deriveFundingCurrencies, freeBalanceMinor, isFundingCurrency } from '@tradex/exchange';
import { quoteScaleOf, toStr } from './decimal.js';
import { refuse } from './refusals.js';
import type { Refusal } from './refusals.js';

/** Quote-currency preference order. INR first, deliberately (11 F7). */
const PREFERENCE: readonly string[] = ['INR', 'USDT'];

export interface ResolvedMarket {
  readonly rules: MarketRules;
  /** The quote currency chosen, i.e. what this account will spend. */
  readonly chosenQuote: string;
  /** Funded, tradable quotes that were passed over. Part of the audit record. */
  readonly alternativeQuotes: readonly string[];
  readonly currencyChoiceReason: string;
}

/** Free balance in a currency as a major-unit decimal, for a human sentence. */
const majorFree = (balances: readonly Balance[], currency: string): string =>
  toStr({ v: BigInt(freeBalanceMinor(balances, currency)), scale: quoteScaleOf(currency) });

/** A minor-unit figure in the quote currency, as a major-unit decimal. */
const major = (minor: string, currency: string): string =>
  toStr({ v: BigInt(minor), scale: quoteScaleOf(currency) });

/**
 * Choose the market an asset trades on for one account.
 *
 * `candidates` is every market the venue lists (or the asset's slice of the
 * adapter's asset index); `balances` is what the account actually holds.
 */
export function resolveMarket(
  asset: string,
  balances: readonly Balance[],
  candidates: readonly MarketRules[],
): ResolvedMarket | Refusal {
  const forAsset = candidates.filter((m) => m.market.asset === asset);
  if (forAsset.length === 0) {
    return refuse('ASSET_NOT_LISTED', { detail: asset });
  }

  // 10 F3 filters on `status == "active"` as part of building the candidate set,
  // which would make an entirely halted asset report ASSET_NOT_LISTED. That
  // sentence would be false — the asset IS listed, it just cannot be traded right
  // now — so the halted case gets its own refusal. The customer's next action is
  // different too: wait, rather than fund a different currency.
  const tradable = forAsset.filter((m) => m.tradable);
  if (tradable.length === 0) {
    return refuse('MARKET_INACTIVE', { detail: forAsset.map((m) => m.venueSymbol).sort().join(', ') });
  }

  // v1 trades against INR and USDT only. `MarketRules.market.quote` is already
  // typed to those two, so this filter is a guard against a third quote arriving
  // through a future adapter rather than a live branch today.
  const inScope = tradable.filter((m) => isFundingCurrency(m.market.quote));
  if (inScope.length === 0) {
    return refuse('NO_MARKET_FOR_FUNDING_CURRENCY', {
      detail: [...new Set(tradable.map((m) => m.market.quote))].sort().join(', '),
      remedyCurrencies: [...new Set(tradable.map((m) => m.market.quote))].sort(),
    });
  }

  const funded = deriveFundingCurrencies(balances);
  const usable = inScope.filter((m) => (funded as readonly string[]).includes(m.market.quote));
  if (usable.length === 0) {
    const listedIn = [...new Set(inScope.map((m) => m.market.quote))].sort();
    return refuse('NO_MARKET_FOR_FUNDING_CURRENCY', {
      detail: listedIn.join(', '),
      remedyCurrencies: listedIn,
    });
  }

  // With exactly one usable market there is nothing to choose between, so 10 F3
  // returns it WITHOUT testing affordability — and that is the better behaviour,
  // not an oversight. Letting it through means the refusal comes from
  // `legalise()` as BELOW_MIN_NOTIONAL or INSUFFICIENT_BALANCE, naming the actual
  // quantity and limit, instead of a vaguer "you cannot afford this market". It is
  // also why the code below is named EITHER_CURRENCY: it is reachable only when
  // there was a real choice and every option failed.
  if (usable.length === 1) {
    const only = usable[0] as MarketRules;
    return {
      rules: only,
      chosenQuote: only.market.quote,
      alternativeQuotes: [],
      currencyChoiceReason: `only ${only.market.quote} is funded for ${asset}`,
    };
  }

  // `required_notional(m)` is the venue's minimum order value, which is already in
  // the quote currency's minor units — the same units as the free balance, so no
  // price and no fx conversion is involved. This is where 10 F6's asymmetry bites:
  // Rs 100 on an INR market against 5 USDT (roughly Rs 496) on a C2C one, so a
  // small account is affordable in INR and not in USDT.
  const affordable = usable.filter(
    (m) => BigInt(freeBalanceMinor(balances, m.market.quote)) >= BigInt(m.minNotionalMinor),
  );
  if (affordable.length === 0) {
    const closest = [...usable].sort((a, b) => {
      const shortfallA = BigInt(a.minNotionalMinor) - BigInt(freeBalanceMinor(balances, a.market.quote));
      const shortfallB = BigInt(b.minNotionalMinor) - BigInt(freeBalanceMinor(balances, b.market.quote));
      return shortfallA === shortfallB ? 0 : shortfallA < shortfallB ? -1 : 1;
    })[0] as MarketRules;
    return refuse('INSUFFICIENT_BALANCE_EITHER_CURRENCY', {
      detail: closest.venueSymbol,
      offending: majorFree(balances, closest.market.quote),
      limit: major(closest.minNotionalMinor, closest.market.quote),
      remedyCurrencies: [...new Set(usable.map((m) => m.market.quote))].sort(),
    });
  }

  // Prefer INR, then USDT, then whatever is left in a stable order.
  const ranked = [...affordable].sort((a, b) => rank(a.market.quote) - rank(b.market.quote));
  const chosen = ranked[0] as MarketRules;
  const alternatives = ranked.slice(1).map((m) => m.market.quote);
  const reason = alternatives.length === 0
    ? `only ${chosen.market.quote} is affordable for ${asset}`
    : `chose ${chosen.market.quote} over ${alternatives.join('/')} `
      + '(INR avoids order-time TDS, 11 F7)';
  return {
    rules: chosen,
    chosenQuote: chosen.market.quote,
    alternativeQuotes: alternatives,
    currencyChoiceReason: reason,
  };
}

const rank = (quote: string): number => {
  const i = PREFERENCE.indexOf(quote);
  return i === -1 ? PREFERENCE.length : i;
};
