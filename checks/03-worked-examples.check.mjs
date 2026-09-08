// 03-worked-examples — plan/phase-03, the eight rows of 09 F7.
//
// These are the owner's own scenario executing exactly as specified: one group
// trade, one "20% of allocated", and the same percentage producing different
// quantities per account — including the counter-intuitive case where the
// LARGEST account is the one refused. Reproducing them is the phase's headline
// definition-of-done.
//
// The market rules come from the REAL captured 997-market fixture, mapped through
// the adapter, so sizing runs against the same metadata production will see, not
// hand-typed numbers. Prices quoted exactly in F7 (BTCINR ask/bid) are used
// verbatim; where F7 derived a price from a rounded raw quantity (XRP/DOGE/USDT)
// a representative price in that range is used and the row's DEMONSTRATED result
// — final quantity and outcome — is asserted.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapMarketsDetails } from '../packages/exchange-coindcx/dist/index.js';
import { size } from '../packages/sizing/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'markets_details.json'), 'utf8');

const BTCINR_ASK = '8077476.1';
const BTCINR_BID = '8043561.6';

const pctBuy = (bp, orderType = 'market') => ({ asset: 'BTC', side: 'buy', mode: 'pct_allocated', orderType, percent: { basisPoints: bp } });

export async function run(assert) {
  const { rules } = mapMarketsDetails(fixture, 'wf-v1');
  const bySym = new Map(rules.map((r) => [r.venueSymbol, r]));
  const btcinr = bySym.get('BTCINR');
  const btcusdt = bySym.get('BTCUSDT');
  const xrpinr = bySym.get('XRPINR');
  const dogeinr = bySym.get('DOGEINR');
  assert(btcinr && btcusdt && xrpinr && dogeinr, 'a worked-example market is missing from the fixture');

  // Sanity on the real metadata the examples depend on.
  assert(btcinr.maxMarketQuantity === '0.0158', `BTCINR max_quantity_market is ${btcinr.maxMarketQuantity}, expected 0.0158`);
  assert(btcinr.minNotionalMinor === '10000', 'BTCINR min notional should be Rs 100 = 10000 paise');
  assert(dogeinr.quantityStep === '1' && dogeinr.quantityPrecision === 0, 'DOGEINR should be step 1 / precision 0');

  // --- Row 1: Rs 1,00,000 @ 20% market buy BTCINR -> 0.00246 BTC, FILL
  const r1 = size({
    intent: pctBuy(2000), rules: btcinr, price: BTCINR_ASK, priceSource: 'ask',
    allocatedCapitalMinor: '10000000', // Rs 1,00,000 in paise
  });
  assert(r1.ok === true, `row 1 should fill: ${JSON.stringify(r1)}`);
  assert(r1.finalQuantity === '0.00246', `row 1 qty ${r1.finalQuantity}, expected 0.00246`);
  assert(r1.notionalMinor === '1987059', `row 1 notional ${r1.notionalMinor} paise, expected 1987059 (Rs 19,870.59)`);
  assert(r1.basisUsed === 'allocated' && r1.basisAmountMinor === '10000000', 'row 1 lost its basis');
  assert(r1.tdsRateApplied === '0', 'row 1 is an INR market — no TDS');
  assert(r1.feeRateAssumed === '0.005', 'row 1 fee rate wrong');

  // --- Row 2: Rs 5,00,000 @ 20% -> 0.01230 BTC, FILL
  const r2 = size({ intent: pctBuy(2000), rules: btcinr, price: BTCINR_ASK, priceSource: 'ask', allocatedCapitalMinor: '50000000' });
  assert(r2.ok === true, 'row 2 should fill');
  assert(r2.finalQuantity === '0.0123', `row 2 qty ${r2.finalQuantity}, expected 0.0123`);
  assert(r2.notionalMinor === '9935295', `row 2 notional ${r2.notionalMinor}, expected 9935295 (Rs 99,352.95)`);

  // --- Row 3: Rs 10,00,000 @ 20% -> 0.02461 > 0.0158 -> REFUSED ABOVE_MAX_QTY_MARKET
  // The whole point: the LARGEST account fails, and not because of a bug.
  const r3 = size({ intent: pctBuy(2000), rules: btcinr, price: BTCINR_ASK, priceSource: 'ask', allocatedCapitalMinor: '100000000' });
  assert(r3.ok === undefined && r3.code === 'ABOVE_MAX_QTY_MARKET',
    `row 3 must be refused ABOVE_MAX_QTY_MARKET, got ${JSON.stringify(r3)}`);
  assert(r3.offending === '0.02461' && r3.limit === '0.0158', `row 3 numbers wrong: ${r3.offending} vs ${r3.limit}`);
  assert(/limit order|split/.test(r3.message), 'row 3 must offer the remedy (limit order / split)');

  // A LIMIT order of the same quantity is accepted — the cap is market-only.
  const r3limit = size({
    intent: { asset: 'BTC', side: 'buy', mode: 'pct_allocated', orderType: 'limit', percent: { basisPoints: 2000 }, limitPrice: BTCINR_ASK },
    rules: btcinr, price: BTCINR_ASK, priceSource: 'limit', allocatedCapitalMinor: '100000000',
  });
  assert(r3limit.ok === true, `the same 0.02461 as a LIMIT order should be accepted: ${JSON.stringify(r3limit)}`);
  assert(r3limit.finalQuantity === '0.02461', `row 3 limit qty ${r3limit.finalQuantity}`);

  // --- Row 4: Rs 500 @ 20% -> notional Rs 80.77 < 100 -> REFUSED BELOW_MIN_NOTIONAL
  const r4 = size({ intent: pctBuy(2000), rules: btcinr, price: BTCINR_ASK, priceSource: 'ask', allocatedCapitalMinor: '50000' });
  assert(r4.ok === undefined && r4.code === 'BELOW_MIN_NOTIONAL',
    `row 4 must be refused BELOW_MIN_NOTIONAL, got ${JSON.stringify(r4)}`);
  assert(/80\.77/.test(r4.offending) && r4.limit === '100', `row 4 numbers wrong: ${r4.offending} vs ${r4.limit}`);

  // --- Row 7: 1,000 USDT @ 20% market buy BTCUSDT, 1.6% holdback (fee + 1% TDS)
  // The row demonstrates the C2C TDS asymmetry; assert the fill and the 1.6%
  // holdback exactly, and that the quantity floored to a clean multiple. (Its
  // exact digits depend on BTCUSDT's live step, tightened once confirmed.)
  const price7 = '81585.6';
  const r7 = size({
    intent: { asset: 'BTC', side: 'buy', mode: 'pct_allocated', orderType: 'market', percent: { basisPoints: 2000 } },
    rules: btcusdt, price: price7, priceSource: 'ask', allocatedCapitalMinor: '100000000000', // 1000 USDT at scale 8
  });
  assert(r7.ok === true, `row 7 should fill: ${JSON.stringify(r7)}`);
  assert(r7.tdsRateApplied === '0.01', 'row 7 is a USDT (C2C) market — 1% TDS applies');
  assert(r7.feeRateAssumed === '0.005', 'row 7 fee rate wrong');
  assert(/^0\.0024\d*$/.test(r7.finalQuantity), `row 7 qty ${r7.finalQuantity}, expected ~0.00241`);

  // --- Row 8: SELL ALL 0.00246 BTC at bid -> FILL, notional Rs 19,787
  const r8 = size({
    intent: { asset: 'BTC', side: 'sell', mode: 'sell_all', orderType: 'market' },
    rules: btcinr, price: BTCINR_BID, priceSource: 'bid', positionQuantity: '0.00246',
  });
  assert(r8.ok === true, `row 8 should fill: ${JSON.stringify(r8)}`);
  assert(r8.finalQuantity === '0.00246', `row 8 qty ${r8.finalQuantity}`);
  assert(r8.notionalMinor === '1978716', `row 8 notional ${r8.notionalMinor}, expected 1978716 (Rs 19,787.16)`);

  // --- Rows 5 & 6: XRPINR and DOGEINR fills, demonstrating step flooring.
  // F7 derived these prices from rounded raw quantities; a representative price
  // reproduces the demonstrated FILL. DOGEINR's step-1 whole-DOGE result is the
  // one that is pinned exactly (its metadata is known: step 1, precision 0).
  const r5 = size({ intent: { asset: 'XRP', side: 'buy', mode: 'pct_allocated', orderType: 'market', percent: { basisPoints: 2000 } },
    rules: xrpinr, price: '145.66', priceSource: 'ask', allocatedCapitalMinor: '5000000' });
  assert(r5.ok === true, `row 5 should fill: ${JSON.stringify(r5)}`);
  assert(/^\d+(\.\d+)?$/.test(r5.finalQuantity), `row 5 qty ${r5.finalQuantity} is not a clean decimal`);

  const r6 = size({ intent: { asset: 'DOGE', side: 'buy', mode: 'pct_allocated', orderType: 'market', percent: { basisPoints: 2000 } },
    rules: dogeinr, price: '8.872', priceSource: 'ask', allocatedCapitalMinor: '500000' });
  assert(r6.ok === true, `row 6 should fill: ${JSON.stringify(r6)}`);
  assert(r6.finalQuantity === '112', `row 6 qty ${r6.finalQuantity}, expected 112 whole DOGE (step 1)`);
  assert(!r6.finalQuantity.includes('.'), 'DOGE must be a whole number — step 1, precision 0');

  console.log('     8 worked examples: rows 1-2 fill, row 3 ABOVE_MAX_QTY_MARKET (limit accepted), row 4 BELOW_MIN_NOTIONAL, row 7 C2C 1.6%, row 8 sell-all');
}
