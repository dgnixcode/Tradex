// The twelve gates, one trip each — plan/phase-04 T04.4.
//
// Every test starts from a state that PASSES all gates, then breaks exactly one
// field and asserts that gate — and only that gate — refuses. This is the
// property the phase demands: the gates are ordered cheapest-first, and a break
// at gate N must surface as N, not as a downstream symptom. The 04-gates check
// re-asserts this standalone; these lock it during development.

import { describe, expect, it } from 'vitest';
import type { MarketRules, OrderBook } from '@tradex/exchange';
import { planAccount } from './gates.js';
import type { GateState, PlanAccountInput } from './gates.js';
import type { Balance } from '@tradex/exchange';

// A mutable view of GateState so the one-trip-per-gate helper can break a single
// field. planAccount receives it as the readonly GateState — mutable is
// assignable to readonly, so no cast is needed at the call sites.
type MutableGateState = { -readonly [K in keyof GateState]: GateState[K] };

const BTCINR: MarketRules = {
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
  minNotionalMinor: '10000', // Rs 100.00
  minPrice: '1',
  maxPrice: '100000000',
  allowedTypes: ['market', 'limit'],
  venueCode: 'I',
  rulesVersion: '1',
};

const balances: Balance[] = [{ currency: 'INR', freeMinor: '10000000', lockedMinor: '0', scale: 2 }];

// A tight, deep book around 80,00,000.00 INR/BTC (price precision 2).
const book: OrderBook = {
  market: { asset: 'BTC', quote: 'INR' },
  asks: [{ price: '8000000', quantity: '5' }],
  bids: [{ price: '7999999', quantity: '5' }],
  observedAtMs: 1_725_000_000_000,
};

const passingState = (): MutableGateState => ({
  platformKillSwitch: false,
  platformMode: 'normal',
  tenantTradingPaused: false,
  accountStatus: 'active',
  credentialStatus: 'active',
  balances,
  candidateMarkets: [BTCINR],
  allocatedCapitalMinor: '10000000', // Rs 1,00,000
  freeQuoteMinor: '10000000',
  equityQuoteMinor: '10000000',
  perOrderCapMinor: '10000000',
  dailyCapMinor: '100000000',
  dailySpentMinor: '0',
  hasInFlightForMarket: false,
  book,
});

// A Rs 20,000 buy at 20% of allocated — the owner's worked example, shrunk.
const buy20pct = (state: GateState): PlanAccountInput => ({
  intent: { asset: 'BTC', side: 'buy', mode: 'pct_allocated', orderType: 'market', percent: { basisPoints: 2000 } },
  price: '8000000',
  priceSource: 'ask',
  state,
});

describe('planAccount — the passing baseline', () => {
  it('plans a legal order when every gate is satisfied', () => {
    const out = planAccount(buy20pct(passingState()));
    expect(out.planned).toBe(true);
    if (out.planned) {
      expect(out.sized.market).toBe('BTCINR');
      expect(out.chosenQuote).toBe('INR');
      expect(BigInt(out.sized.notionalMinor)).toBeGreaterThan(0n);
    }
  });
});

describe('planAccount — one trip per gate', () => {
  const trip = (mutate: (s: MutableGateState) => void, code: string) => {
    const s = passingState();
    mutate(s);
    const out = planAccount(buy20pct(s));
    expect(out.planned).toBe(false);
    if (!out.planned) expect(out.refusal.code).toBe(code);
  };

  it('1 — platform kill switch', () => trip((s) => { s.platformKillSwitch = true; }, 'PLATFORM_KILLED'));
  it('1 — platform read-only mode', () => trip((s) => { s.platformMode = 'read_only'; }, 'PLATFORM_READ_ONLY'));
  it('1 — tenant paused', () => trip((s) => { s.tenantTradingPaused = true; }, 'TENANT_PAUSED'));
  it('2 — account not active', () => trip((s) => { s.accountStatus = 'suspended'; }, 'ACCOUNT_NOT_ACTIVE'));
  it('3 — credential not active', () => trip((s) => { s.credentialStatus = 'revoked'; }, 'CREDENTIAL_NOT_ACTIVE'));

  it('4 — asset not listed', () => {
    const s = passingState();
    s.candidateMarkets = [];
    const out = planAccount(buy20pct(s));
    expect(out.planned).toBe(false);
    if (!out.planned) expect(out.refusal.code).toBe('ASSET_NOT_LISTED');
  });

  it('5 — order type not allowed', () => {
    const s = passingState();
    s.candidateMarkets = [{ ...BTCINR, allowedTypes: ['limit'] }];
    const out = planAccount(buy20pct(s));
    expect(out.planned).toBe(false);
    if (!out.planned) expect(out.refusal.code).toBe('ORDER_TYPE_NOT_ALLOWED');
  });

  it('6-9 — below min notional (sizing refuses with numbers)', () => {
    // One step of BTC (0.00001) is a POSITIVE quantity, but at Rs 80,00,000/BTC
    // its value is Rs 80 — below the Rs 100 min notional. base_quantity is not
    // holdback-adjusted, so the quantity is exactly one step and the refusal is
    // BELOW_MIN_NOTIONAL, not the ZERO_QUANTITY a tiny percentage budget hits first.
    const out = planAccount({
      intent: { asset: 'BTC', side: 'buy', mode: 'base_quantity', orderType: 'market', baseQuantity: '0.00001' },
      price: '8000000',
      priceSource: 'ask',
      state: passingState(),
    });
    expect(out.planned).toBe(false);
    if (!out.planned) {
      expect(out.refusal.code).toBe('BELOW_MIN_NOTIONAL');
      expect(out.refusal.offending).toBeDefined();
      expect(out.refusal.limit).toBeDefined();
    }
  });

  it('9b — market order refused for a wide spread', () => {
    const s = passingState();
    s.book = {
      ...book,
      asks: [{ price: '8100000', quantity: '5' }],
      bids: [{ price: '7900000', quantity: '5' }], // ~250 bp spread
    };
    const out = planAccount(buy20pct(s));
    expect(out.planned).toBe(false);
    if (!out.planned) expect(out.refusal.code).toBe('SPREAD_TOO_WIDE');
  });

  it('10 — above the per-order cap', () => {
    const s = passingState();
    s.perOrderCapMinor = '100'; // Rs 1.00, far below a Rs 20,000 order
    const out = planAccount(buy20pct(s));
    expect(out.planned).toBe(false);
    if (!out.planned) {
      expect(out.refusal.code).toBe('ABOVE_ORDER_CAP');
      expect(out.refusal.limit).toBe('100');
    }
  });

  it('11 — above the daily cap', () => {
    const s = passingState();
    s.dailyCapMinor = '10000000';
    s.dailySpentMinor = '9999999'; // one paisa of headroom
    const out = planAccount(buy20pct(s));
    expect(out.planned).toBe(false);
    if (!out.planned) expect(out.refusal.code).toBe('ABOVE_DAILY_CAP');
  });

  it('12 — an order is already in flight for this market', () => {
    trip((s) => { s.hasInFlightForMarket = true; }, 'ORDER_IN_FLIGHT');
  });
});

describe('planAccount — a limit order skips the slippage guard', () => {
  it('does not refuse a limit order on a wide-spread book', () => {
    const s = passingState();
    s.book = { ...book, asks: [{ price: '8100000', quantity: '5' }], bids: [{ price: '7900000', quantity: '5' }] };
    const out = planAccount({
      intent: { asset: 'BTC', side: 'buy', mode: 'pct_allocated', orderType: 'limit', limitPrice: '8000000', percent: { basisPoints: 2000 } },
      price: '8000000',
      priceSource: 'limit',
      state: s,
    });
    // A limit order has a fixed price and cannot slip, so the wide spread is not
    // a refusal — it plans.
    expect(out.planned).toBe(true);
  });
});
