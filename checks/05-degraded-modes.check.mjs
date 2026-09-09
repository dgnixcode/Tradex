// 05-degraded-modes — plan/phase-05 T05.4 (22 F7).
//
// A table-driven assertion of what each degraded mode permits. The platform has
// three modes (normal, cancel_only, read_only); the per-account frozen state is
// the fourth. Because nothing in v1 CAN cancel yet (no order is ever sent), every
// mode's practical question is "may a NEW order be planned?" — and the table below
// answers it for both sides and for the account/market scopes.
//
// This is PURE: it drives the real planAccount() gate with constructed state, so
// the matrix is asserted without a database and stays fast.

import { planAccount } from '../packages/sizing/dist/index.js';

// ---- a passing world (deep BTCINR book, Rs 1,00,000 free) -------------------
const BTCINR = {
  market: { asset: 'BTC', quote: 'INR' },
  venueSymbol: 'BTCINR',
  tradable: true,
  quantityStep: '0.00001',
  quantityPrecision: 5,
  pricePrecision: 2,
  minQuantity: '0.00001',
  maxQuantity: '2',
  minMarketQuantity: null,
  maxMarketQuantity: '1',
  minNotionalMinor: '10000',
  minPrice: '1',
  maxPrice: '100000000',
  allowedTypes: ['market', 'limit'],
  venueCode: 'I',
  rulesVersion: '1',
};
const balances = [{ currency: 'INR', freeMinor: '10000000', lockedMinor: '0', scale: 2 }];
const book = {
  market: { asset: 'BTC', quote: 'INR' },
  asks: [{ price: '8000000', quantity: '5' }],
  bids: [{ price: '7999999', quantity: '5' }],
  observedAtMs: 1_725_000_000_000,
};

function baseState() {
  return {
    platformKillSwitch: false,
    platformMode: 'normal',
    tenantTradingPaused: false,
    marketModes: {},
    accountStatus: 'active',
    credentialStatus: 'active',
    accountFrozenReason: null,
    balances,
    candidateMarkets: [BTCINR],
    allocatedCapitalMinor: '10000000',
    freeQuoteMinor: '10000000',
    positionQuantity: '0.01', // the sell basis, so a sell_all has something to size against
    book,
    perOrderCapMinor: '20000000',
    dailyCapMinor: '50000000',
    dailySpentMinor: '0',
    hasInFlightForMarket: false,
  };
}

function plan(side, state) {
  const intent = side === 'buy'
    ? { asset: 'BTC', side: 'buy', mode: 'pct_allocated', orderType: 'market', percent: { basisPoints: 2000 } }
    : { asset: 'BTC', side: 'sell', mode: 'sell_all', orderType: 'market' };
  return planAccount({
    intent,
    price: side === 'buy' ? '8000000' : '7999999',
    priceSource: side === 'buy' ? 'ask' : 'bid',
    state,
  });
}

/** Each row: a mode, and which of buy/sell the mode PERMITS (opens allowed). */
const MATRIX = [
  { mode: 'platform normal', build: (s) => s, buyAllowed: true, sellAllowed: true },
  { mode: 'platform cancel_only', build: (s) => { s.platformMode = 'cancel_only'; return s; }, buyAllowed: false, sellAllowed: false },
  { mode: 'platform read_only', build: (s) => { s.platformMode = 'read_only'; return s; }, buyAllowed: false, sellAllowed: false },
  { mode: 'account frozen', build: (s) => { s.accountFrozenReason = 'review'; return s; }, buyAllowed: false, sellAllowed: false },
  { mode: 'market cancel_only', build: (s) => { s.marketModes = { BTCINR: { mode: 'cancel_only', reason: 'venue' } }; return s; }, buyAllowed: false, sellAllowed: false },
  { mode: 'market read_only', build: (s) => { s.marketModes = { BTCINR: { mode: 'read_only', reason: 'suspicious' } }; return s; }, buyAllowed: false, sellAllowed: false },
];

export async function run(assert) {
  // read_only / cancel_only permit NEITHER opens NOR cancels — and since every
  // new order is an open, both must refuse a buy AND a sell.
  for (const row of MATRIX) {
    const buy = plan('buy', row.build(baseState()));
    const sell = plan('sell', row.build(baseState()));
    assert(buy.planned === row.buyAllowed, `[${row.mode}] buy ${row.buyAllowed ? 'should plan' : 'must be refused'}, got ${buy.planned ? 'planned' : buy.refusal?.code}`);
    assert(sell.planned === row.sellAllowed, `[${row.mode}] sell ${row.sellAllowed ? 'should plan' : 'must be refused'}, got ${sell.planned ? 'planned' : sell.refusal?.code}`);
    if (!row.buyAllowed && !buy.planned) {
      assert(buy.refusal.message !== undefined && buy.refusal.message.length > 0, `[${row.mode}] the refusal must carry a message`);
    }
  }

  // Exit from a degraded mode is MANUAL: the gate never self-clears. A normal
  // world is allowed (already proven above); the modes themselves are what block.
  // And the codes are distinct per scope, so the UI can show what actually broke.
  const frozen = plan('buy', (() => { const s = baseState(); s.accountFrozenReason = 'x'; return s; })());
  assert(!frozen.planned && frozen.refusal.code === 'ACCOUNT_FROZEN', 'account frozen must refuse with ACCOUNT_FROZEN');
  const ro = plan('buy', (() => { const s = baseState(); s.platformMode = 'read_only'; return s; })());
  assert(!ro.planned && ro.refusal.code === 'PLATFORM_READ_ONLY', 'platform read_only must refuse with PLATFORM_READ_ONLY');
  const mro = plan('buy', (() => { const s = baseState(); s.marketModes = { BTCINR: { mode: 'read_only', reason: 'x' } }; return s; })());
  assert(!mro.planned && mro.refusal.code === 'MARKET_READ_ONLY', 'market read_only must refuse with MARKET_READ_ONLY');
}
