// 04-slippage-guard — plan/phase-04 T04.11.
//
// A market order is refused when the visible book would fill it far from the
// touch — either because the spread already exceeds the tolerance, or because
// walking the depth for the intended quantity deviates past it. The phase's
// named acceptance: DOGEINR at a measured 0.81% spread is refused at the default
// 0.5% tolerance; BTCUSDT (a tight, deep book) passes; and — the read/display
// boundary (ARCHITECTURE §6a) — the customer-facing warning carries NO
// CoinDCX-derived number.
//
// BTCUSDT is the real committed fixture, mapped through the adapter exactly as
// production would. DOGEINR is constructed at a spread of 81 bp, because there is
// no committed DOGEINR book fixture and the point is the THRESHOLD behaviour: 81
// bp is over the 50 bp default and under a 100 bp override, so it must refuse at
// the default and pass when the tolerance is raised.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapOrderBook } from '../packages/exchange-coindcx/dist/index.js';
import {
  DEFAULT_SLIPPAGE_TOLERANCE_BP, marketOrderSlippage, spreadBp, touchPrice,
} from '../packages/sizing/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Adapt the adapter's OrderBook (timestamp/asks/bids) to the sizing port shape. */
const toPort = (mapped, quote) => ({
  market: { asset: 'X', quote },
  asks: mapped.asks,
  bids: mapped.bids,
  observedAtMs: Number(mapped.timestamp),
});

/** A synthetic book with one deep level each side, at the given prices. */
const flatBook = (ask, bid, quote = 'INR') => ({
  market: { asset: 'DOGE', quote },
  asks: [{ price: ask, quantity: '100000000' }],
  bids: [{ price: bid, quantity: '100000000' }],
  observedAtMs: 1_788_649_000_000,
});

export async function run(assert) {
  assert(DEFAULT_SLIPPAGE_TOLERANCE_BP === 50, 'the default slippage tolerance should be 50 bp (0.5%)');

  // ---------------------------------------------------------------- BTCUSDT passes
  const btcusdtRaw = readFileSync(join(here, 'fixtures', 'orderbook_btcusdt.json'), 'utf8');
  const btcusdt = toPort(mapOrderBook(btcusdtRaw), 'USDT');
  const touch = touchPrice(btcusdt, 'buy');
  assert(touch !== null, 'BTCUSDT must have a best ask to price a buy');
  assert(touch.source === 'book_ask', 'a buy is priced at the best ask');

  const btcSpread = spreadBp(btcusdt);
  assert(btcSpread !== null, 'BTCUSDT must have a computable spread');
  assert(BigInt(btcSpread) < BigInt(DEFAULT_SLIPPAGE_TOLERANCE_BP),
    `BTCUSDT spread ${btcSpread}bp should be under the ${DEFAULT_SLIPPAGE_TOLERANCE_BP}bp tolerance`);

  const btcVerdict = marketOrderSlippage(btcusdt, 'buy', '0.01');
  assert(btcVerdict.ok === true, `a small BTCUSDT market buy should pass, got ${btcVerdict.ok ? 'ok' : btcVerdict.code}`);
  if (btcVerdict.ok) {
    assert(typeof btcVerdict.spreadBp === 'string', 'a passing verdict reports the spread for persistence');
    assert(typeof btcVerdict.slippageBp === 'string', 'a passing verdict reports the slippage for persistence');
  }

  // -------------------------------------------------------- DOGEINR at 0.81% refused
  // ask 100.405, bid 99.595 → 2*0.81/200 = 81 bp. Over the 50 bp default.
  const doge = flatBook('100.405', '99.595');
  const dogeSpread = spreadBp(doge);
  assert(dogeSpread === '81', `the DOGEINR book should measure 81 bp, got ${dogeSpread}`);

  const dogeDefault = marketOrderSlippage(doge, 'buy', '10');
  assert(dogeDefault.ok === false, 'DOGEINR at 81 bp must be refused at the 50 bp default tolerance');
  if (!dogeDefault.ok) {
    assert(dogeDefault.code === 'SPREAD_TOO_WIDE', `expected SPREAD_TOO_WIDE, got ${dogeDefault.code}`);
    // The read/display boundary: the customer-facing message shows NO number.
    assert(!/\d/.test(dogeDefault.message),
      `the qualitative warning must contain no derived number, got: "${dogeDefault.message}"`);
    assert(/limit order/i.test(dogeDefault.message), 'the warning should recommend a limit order');
  }

  // Raising the tolerance above the measured spread lets the same book pass —
  // proof the refusal is threshold-driven, not a property of the book alone.
  const dogeLoose = marketOrderSlippage(doge, 'buy', '10', 100);
  assert(dogeLoose.ok === true, 'DOGEINR at 81 bp should pass when the tolerance is raised to 100 bp');

  // -------------------------------------------------------- deviation from depth
  // A tight touch sitting on thin depth: 1 @ 100, then a wall at 106. The spread
  // is one tick (well under tolerance) but a 10-unit buy walks far above the ask.
  const thin = {
    market: { asset: 'DOGE', quote: 'INR' },
    asks: [{ price: '100', quantity: '1' }, { price: '106', quantity: '100000' }],
    bids: [{ price: '99.99', quantity: '100000' }],
    observedAtMs: 1_788_649_000_000,
  };
  const thinSpread = spreadBp(thin);
  assert(BigInt(thinSpread) < BigInt(DEFAULT_SLIPPAGE_TOLERANCE_BP), `thin-book spread ${thinSpread}bp should be tight`);
  const thinVerdict = marketOrderSlippage(thin, 'buy', '10');
  assert(thinVerdict.ok === false, 'a buy that walks past the tolerance on thin depth must be refused');
  if (!thinVerdict.ok) {
    assert(thinVerdict.code === 'EXCESSIVE_SLIPPAGE', `expected EXCESSIVE_SLIPPAGE, got ${thinVerdict.code}`);
    assert(!/\d/.test(thinVerdict.message), 'the slippage warning must contain no derived number');
    assert(BigInt(thinVerdict.slippageBp ?? '0') > BigInt(DEFAULT_SLIPPAGE_TOLERANCE_BP),
      'the persisted slippage figure should exceed the tolerance');
  }

  // -------------------------------------------------------- depth exhaustion
  const shallow = {
    market: { asset: 'DOGE', quote: 'INR' },
    asks: [{ price: '100', quantity: '1' }],
    bids: [{ price: '99.99', quantity: '100000' }],
    observedAtMs: 1_788_649_000_000,
  };
  const shallowVerdict = marketOrderSlippage(shallow, 'buy', '10');
  assert(shallowVerdict.ok === false, 'a buy larger than the whole visible book must be refused');
  if (!shallowVerdict.ok) {
    assert(shallowVerdict.code === 'INSUFFICIENT_DEPTH', `expected INSUFFICIENT_DEPTH, got ${shallowVerdict.code}`);
    assert(shallowVerdict.slippageBp === null, 'no slippage figure is computable when depth ran out');
    assert(!/\d/.test(shallowVerdict.message), 'the depth warning must contain no derived number');
  }

  // -------------------------------------------------------- sell prices at the bid
  const sellTouch = touchPrice(btcusdt, 'sell');
  assert(sellTouch !== null && sellTouch.source === 'book_bid', 'a sell is priced at the best bid');
}
