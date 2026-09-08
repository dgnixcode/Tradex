// Legalisation — plan/phase-03 T03.6, from 09 F5 step 5 and 03's ordering.
//
// The final gate: given a market, a side, an order type, a floored quantity and
// a price, decide whether the venue will accept it — and if not, say precisely
// why, with numbers. This is where the counter-intuitive refusal lives: a
// quantity that is fine for a LIMIT order is refused for a MARKET order because
// `max_quantity_market` is far tighter than `max_quantity` (BTCINR: 0.0158 vs 2).
//
// Order of checks is deliberate. Cheap structural checks first (active, exit,
// type), then quantity bounds by order type, then notional, then price, then the
// balance/holding sufficiency the caller supplies. The FIRST failure is returned,
// so the message names the most fundamental problem rather than a downstream one.

import { cmp, mul } from '@tradex/money';
import type { Scale, Scaled } from '@tradex/money';
import type { MarketRules, OrderSide, OrderType } from '@tradex/exchange';
import { nat, quoteScaleOf, toStr } from './decimal.js';
import { effectiveMinQty } from './effective-min.js';
import { refuse } from './refusals.js';
import type { Refusal } from './refusals.js';

export interface LegaliseInput {
  readonly rules: MarketRules;
  readonly side: OrderSide;
  readonly orderType: OrderType;
  /** Floored quantity, at the market's quantity precision. */
  readonly quantity: Scaled;
  /** Execution price used for notional: ask for a buy, bid for a sell (09). */
  readonly price: Scaled;
  /** For a market order, the market's own status flag from live metadata. */
  readonly exitOnly?: boolean | undefined;
  /** Sell only: the free holding of the asset. Buy only: the free quote balance. */
  readonly availableQuantity?: Scaled | undefined;
  readonly availableQuoteMinor?: Scaled | undefined;
}

export interface Legal {
  readonly ok: true;
  readonly notionalMinor: Scaled;
}

/** The ten-step legalisation. Returns the first failure, or the notional if legal. */
export function legalise(input: LegaliseInput): Legal | Refusal {
  const { rules, side, orderType, quantity, price } = input;
  const sym = rules.venueSymbol;
  const qtyStr = toStr(quantity);

  // 1. active
  if (!rules.tradable) return refuse('MARKET_INACTIVE', { detail: sym });
  // 2. not exit-only (a buy cannot open into an exit-only market)
  if (input.exitOnly === true && side === 'buy') return refuse('MARKET_EXIT_ONLY', { detail: sym });
  // 3. order type allowed
  if (!rules.allowedTypes.includes(orderType)) return refuse('ORDER_TYPE_NOT_ALLOWED', { detail: orderType });

  // 4. quantity is positive after flooring
  if (cmp(quantity, { v: 0n, scale: quantity.scale }) <= 0) return refuse('ZERO_QUANTITY');

  // 5. effective minimum (max of min_qty, precision, step, market-min)
  const min = effectiveMinQty(rules, orderType);
  if (cmp(quantity, min) < 0) {
    return refuse('BELOW_MIN_QTY', { offending: qtyStr, limit: toStr(min) });
  }

  // 6. maximum quantity, BY ORDER TYPE — the market cap is the tight one
  if (orderType === 'market' && rules.maxMarketQuantity !== null) {
    const maxMarket = nat(rules.maxMarketQuantity);
    if (cmp(quantity, maxMarket) > 0) {
      return refuse('ABOVE_MAX_QTY_MARKET', { offending: qtyStr, limit: rules.maxMarketQuantity });
    }
  }
  const maxQty = nat(rules.maxQuantity);
  if (cmp(quantity, maxQty) > 0) {
    return refuse('ABOVE_MAX_QTY', { offending: qtyStr, limit: rules.maxQuantity });
  }

  // 7. notional >= min_notional (quote minor units)
  const quoteScale = quoteScaleOf(rules.market.quote);
  const notionalMinor = notional(quantity, price, quoteScale);
  const minNotional: Scaled = { v: BigInt(rules.minNotionalMinor), scale: quoteScale };
  if (cmp(notionalMinor, minNotional) < 0) {
    return refuse('BELOW_MIN_NOTIONAL', { offending: toStr(notionalMinor), limit: toStr(minNotional) });
  }

  // 8-9. price tick and range — only meaningful for a limit order (a market order
  // has no submitted price). The price here is the execution estimate.
  if (orderType === 'limit') {
    const minPrice = nat(rules.minPrice);
    const maxPrice = nat(rules.maxPrice);
    if (cmp(price, minPrice) < 0 || cmp(price, maxPrice) > 0) {
      return refuse('PRICE_OUT_OF_RANGE', { offending: toStr(price), limit: `${rules.minPrice}..${rules.maxPrice}` });
    }
  }

  // 10. sufficiency — the caller supplies what the account actually has.
  if (side === 'sell' && input.availableQuantity !== undefined) {
    if (cmp(quantity, input.availableQuantity) > 0) {
      return refuse('INSUFFICIENT_HOLDING', { offending: toStr(input.availableQuantity), limit: qtyStr });
    }
  }
  if (side === 'buy' && input.availableQuoteMinor !== undefined) {
    if (cmp(notionalMinor, input.availableQuoteMinor) > 0) {
      return refuse('INSUFFICIENT_BALANCE', { offending: toStr(input.availableQuoteMinor), limit: toStr(notionalMinor) });
    }
  }

  return { ok: true, notionalMinor };
}

/** notional (quote minor units) = quantity × price, floored to the quote scale. */
export function notional(quantity: Scaled, price: Scaled, quoteScale: Scale): Scaled {
  // quantity is base at qty precision; price is quote-per-base at price precision.
  // The product is a quote amount; express it in minor units (scale = quoteScale).
  return mul(quantity, price, quoteScale);
}
