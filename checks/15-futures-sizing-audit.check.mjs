// 15-futures-sizing-audit — verifies futures sizing and execution hardening.
import { planAccount, size, legalise } from '../packages/sizing/dist/index.js';

export async function run(assert) {
  const rules = {
    venueSymbol: 'B-BTC_USDT',
    venueCode: 'B-BTC_USDT',
    market: { asset: 'BTC', quote: 'USDT' },
    baseScale: 8,
    quoteScale: 8,
    minQuantity: '0.00001',
    minMarketQuantity: null,
    maxQuantity: '100',
    maxMarketQuantity: '10',
    quantityStep: '0.00001',
    quantityPrecision: 5,
    minPrice: '1000',
    maxPrice: '1000000',
    priceTick: '0.1',
    pricePrecision: 1,
    minNotionalMinor: '500000000', // 5 USDT at scale 8
    tradable: true,
    allowedTypes: ['market', 'limit'],
    rulesVersion: 'v1',
  };

  // TEST 1: Futures Short Sizing with pct_allocated (Margin Collateral)
  {
    const sized = size({
    intent: {
      asset: 'BTC',
      side: 'sell',
      orderType: 'market',
      mode: 'pct_allocated',
      percent: { basisPoints: 5000 }, // 50%
    },
    rules,
    price: '60000',
    priceSource: 'bid',
    isFutures: true,
    allocatedCapitalMinor: '10000000000', // 100 USDT (at scale 8)
    freeQuoteMinor: '10000000000',        // 100 USDT available margin
    positionQuantity: '0',                // Holds 0 BTC coins (derivative short)
    availableQuoteMinor: '10000000000',
  });

  assert(sized.ok === true, `Futures Short must size successfully, got ${JSON.stringify(sized)}`);
  assert(sized.side === 'sell', 'Side must be sell');
  assert(Number(sized.finalQuantity) > 0, 'Quantity must be positive');
  assert(BigInt(sized.notionalMinor) >= 500000000n, 'Notional must be >= 5 USDT');
  console.log('  -> Passed! Sized quantity:', sized.finalQuantity, 'notional:', sized.notionalMinor);
}

// TEST 2: Futures Short Sizing with base_quantity (Margin Collateral)
{
  console.log('Test 2: Futures Short with base_quantity sizing...');
  const sized = size({
    intent: {
      asset: 'BTC',
      side: 'sell',
      orderType: 'market',
      mode: 'base_quantity',
      baseQuantity: '0.001',
    },
    rules,
    price: '60000',
    priceSource: 'bid',
    isFutures: true,
    freeQuoteMinor: '10000000000',
    positionQuantity: '0', // 0 BTC held
    availableQuoteMinor: '10000000000',
  });

  assert(sized.ok === true, `Futures Short with base_quantity must succeed, got ${JSON.stringify(sized)}`);
  assert(sized.finalQuantity === '0.001', `Expected 0.001, got ${sized.finalQuantity}`);
  console.log('  -> Passed! Sized quantity:', sized.finalQuantity);
}

// TEST 3: Futures Short Sufficiency Check (Uses Margin, not Coin Holdings)
{
  console.log('Test 3: Futures Short Sufficiency Check...');
  const legal = legalise({
    rules,
    side: 'sell',
    orderType: 'market',
    isFutures: true,
    quantity: { v: 100n, scale: 5 }, // 0.001 BTC
    price: { v: 600000n, scale: 1 },    // 60,000 USDT -> notional 60 USDT <= 100 USDT available
    availableQuantity: { v: 0n, scale: 8 }, // 0 BTC held
    availableQuoteMinor: { v: 10000000000n, scale: 8 }, // 100 USDT margin available
  });

  assert(legal.ok === true, 'Legalise must pass for futures short with 0 coin holdings');
  console.log('  -> Passed! Short position approved without base holdings.');
}

// TEST 4: Min Notional Floor Rejection below 5 USDT
{
  console.log('Test 4: Min Notional Floor Rejection below 5 USDT...');
  const tiny = legalise({
    rules,
    side: 'sell',
    orderType: 'market',
    isFutures: true,
    quantity: { v: 1n, scale: 5 },   // 0.00001 BTC @ 10,000 = 0.1 USDT (< 5 USDT)
    price: { v: 100000n, scale: 1 },
    availableQuoteMinor: { v: 10000000000n, scale: 8 },
  });

  assert('code' in tiny, 'Tiny order must be refused');
  assert(tiny.code === 'BELOW_MIN_NOTIONAL', `Expected BELOW_MIN_NOTIONAL, got ${tiny.code}`);
  console.log('  -> Passed! Correctly rejected with BELOW_MIN_NOTIONAL.');
}

// TEST 5: Full Plan Account for Futures Short via Gates
{
  console.log('Test 5: Full Plan Account for Futures Short...');
  const outcome = planAccount({
    intent: {
      asset: 'BTC',
      side: 'sell',
      orderType: 'market',
      mode: 'pct_allocated',
      percent: { basisPoints: 2500 }, // 25%
    },
    price: '65000',
    priceSource: 'bid',
    state: {
      platformKillSwitch: false,
      platformMode: 'normal',
      tenantTradingPaused: false,
      accountStatus: 'active',
      credentialStatus: 'active',
      balances: [
        { currency: 'USDT', freeMinor: '5000000000', lockedMinor: '0', scale: 8 },
      ],
      candidateMarkets: [rules],
      preferredQuote: 'USDT',
      isFutures: true,
      allocatedCapitalMinor: '50000000000', // 500 USDT (scaled by leverage)
      freeQuoteMinor: '25000000000',        // 250 USDT purchasing power
      perOrderCapMinor: '100000000000',
      dailyCapMinor: '500000000000',
      dailySpentMinor: '0',
      hasInFlightForMarket: false,
      book: {
        market: { asset: 'BTC', quote: 'USDT' },
        bids: [{ price: '65000', quantity: '10' }],
        asks: [{ price: '65010', quantity: '10' }],
        observedAtMs: Date.now(),
      },
    },
  });

  assert(outcome.planned === true, `Plan account must succeed for futures short, got ${JSON.stringify(outcome)}`);
  assert(outcome.sized.side === 'sell', 'Sized side must be sell');
  console.log('  -> Passed! Planned futures short order:', outcome.sized.finalQuantity, 'BTC, notional:', outcome.sized.notionalMinor);
}
}

