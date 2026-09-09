// resizeSellForSend — plan/phase-09 T09.2/T09.3/T09.4, unit level.
//
// The venue is the only truth about a holding, so a sell is re-derived from a
// fresh free read immediately before send. These tests lock the four rules:
// free-only sizing, dust exclusion, HOLDING_LOCKED, and clamp-down-never-up with
// the clamp recorded.

import { describe, expect, it } from 'vitest';
import type { MarketRules } from '@tradex/exchange';
import { resizeSellForSend } from './sell-at-send.js';

// BTC on INR with a step of 0.001. effective_min = max(0.001 min, 10^-3
// precision, 0.001 step) = 0.001, so anything below a thousandth is dust.
const BTCINR: MarketRules = {
  market: { asset: 'BTC', quote: 'INR' },
  venueSymbol: 'BTCINR',
  tradable: true,
  quantityStep: '0.001',
  quantityPrecision: 3,
  pricePrecision: 2,
  minQuantity: '0.001',
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

const resize = (input: Partial<Parameters<typeof resizeSellForSend>[0]> = {}) =>
  resizeSellForSend({
    mode: 'sell_all', plannedQuantity: '0.005', free: '0.005', locked: '0',
    orderType: 'market', rules: BTCINR, ...input,
  });

describe('sell_all sizes from the fresh FREE read, not the plan (T09.2)', () => {
  it('sends the fresh holding when it equals the plan', () => {
    expect(resize()).toEqual({ kind: 'send', quantity: '0.005', clampedFromQuantity: null });
  });

  it('sells the LARGER fresh holding when it grew after preview — the fresh read wins', () => {
    const out = resize({ plannedQuantity: '0.005', free: '0.02' });
    expect(out.kind).toBe('send');
    if (out.kind === 'send') expect(out.quantity).toBe('0.02');
  });

  it('clamps DOWN and records the plan when the holding shrank after preview', () => {
    const out = resize({ plannedQuantity: '0.02', free: '0.006' });
    expect(out.kind).toBe('send');
    if (out.kind === 'send') {
      expect(out.quantity).toBe('0.006');
      expect(out.clampedFromQuantity).toBe('0.02');
    }
  });

  it('floors the fresh holding to the market step before sending', () => {
    const out = resize({ plannedQuantity: '0.005', free: '0.0055' });
    expect(out.kind).toBe('send');
    if (out.kind === 'send') expect(out.quantity).toBe('0.005');
  });
});

describe('a holding below the effective minimum is dust (T09.4)', () => {
  it('excludes a dust holding from sell-all as a labelled skip, not a failure', () => {
    const out = resize({ plannedQuantity: '0.005', free: '0.0004', locked: '0' });
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') {
      expect(out.code).toBe('DUST');
      expect(out.detail).toMatch(/effective minimum/);
    }
  });

  it('treats dust the same for a pct_position sell', () => {
    const out = resize({ mode: 'pct_position', percentBp: 5000, free: '0.0004' });
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') expect(out.code).toBe('DUST');
  });
});

describe('a holding fully locked by an open order is HOLDING_LOCKED (T09.4)', () => {
  it('offers to cancel the open order first when free is zero and locked is not', () => {
    const out = resize({ plannedQuantity: '0.005', free: '0', locked: '0.005' });
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') {
      expect(out.code).toBe('HOLDING_LOCKED');
      expect(out.detail).toMatch(/cancel it first/);
    }
  });

  it('is NO_HOLDING when there is nothing at all to sell', () => {
    const out = resize({ plannedQuantity: '0.005', free: '0', locked: '0' });
    expect(out.kind).toBe('skip');
    if (out.kind === 'skip') expect(out.code).toBe('NO_HOLDING');
  });
});

describe('a sized sell clamps down to the holding, never up (T09.3)', () => {
  it('clamps a fixed sell that exceeds the fresh holding, recording the plan', () => {
    const out = resize({ mode: 'fixed', plannedQuantity: '0.01', free: '0.006' });
    expect(out.kind).toBe('send');
    if (out.kind === 'send') {
      expect(out.quantity).toBe('0.006');
      expect(out.clampedFromQuantity).toBe('0.01');
    }
  });

  it('leaves a fixed sell within the holding untouched', () => {
    const out = resize({ mode: 'fixed', plannedQuantity: '0.004', free: '0.02' });
    expect(out.kind).toBe('send');
    if (out.kind === 'send') {
      expect(out.quantity).toBe('0.004');
      expect(out.clampedFromQuantity).toBeNull();
    }
  });

  it('floors a clamped-down fixed sell to the step', () => {
    const out = resize({ mode: 'fixed', plannedQuantity: '0.01', free: '0.0055' });
    expect(out.kind).toBe('send');
    if (out.kind === 'send') {
      expect(out.quantity).toBe('0.005');
      expect(out.clampedFromQuantity).toBe('0.01');
    }
  });

  it('never sends more than the fresh holding across a spread of holdings', () => {
    for (const free of ['0.001', '0.0025', '0.009', '0.0141', '0.33']) {
      for (const mode of ['sell_all', 'pct_position', 'fixed'] as const) {
        const out = resize({ mode, percentBp: 7000, plannedQuantity: '0.05', free, locked: '0.1' });
        if (out.kind === 'send') {
          expect(Number(out.quantity)).toBeLessThanOrEqual(Number(free));
          // A fixed sell must never exceed its plan either; sell_all/pct may sell a
          // grown holding but only up to the holding, which the line above asserts.
          if (mode === 'fixed') expect(Number(out.quantity)).toBeLessThanOrEqual(Number('0.05'));
        }
      }
    }
  });
});

describe('pct_position sells a fraction of the fresh holding', () => {
  it('sends half the current holding, floored to step', () => {
    const out = resize({ mode: 'pct_position', percentBp: 5000, plannedQuantity: '0.003', free: '0.006' });
    expect(out.kind).toBe('send');
    if (out.kind === 'send') {
      expect(out.quantity).toBe('0.003');
      expect(out.clampedFromQuantity).toBeNull();
    }
  });

  it('records a down-adjustment when the holding shrank since the plan', () => {
    const out = resize({ mode: 'pct_position', percentBp: 5000, plannedQuantity: '0.003', free: '0.004' });
    expect(out.kind).toBe('send');
    if (out.kind === 'send') {
      expect(out.quantity).toBe('0.002');
      expect(out.clampedFromQuantity).toBe('0.003');
    }
  });
});
