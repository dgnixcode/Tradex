// T03.8, the pure half: the cross-check arithmetic and snapshot-bound conversion.
//
// The numbers below are the live 2026-09-04 sample from 10 F4. Reproducing them
// exactly is what makes the drift threshold meaningful — a threshold calibrated
// against arithmetic nobody checked is just a number.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FX_DRIFT_THRESHOLD_BP, FxError, convertMinor, crossCheck, fxSnapshot,
} from './fx.js';

/** The live sample: USDTINR 99.11, BTCUSDT 81,602, BTCINR 8,079,092 (10 F4). */
const LIVE = { asset: 'BTC', baseLegPrice: '81602', quoteLegPrice: '8079092', rate: '99.11' } as const;

describe('the venue cross-check (10 F4)', () => {
  it('reproduces the measured gap and does not alarm on it', () => {
    const out = crossCheck(LIVE);
    // 81,602 x 99.11 = 8,087,574.22 exactly.
    //
    // NOTE: research/10 F4 states this product as 8,087,594, which is an
    // arithmetic slip of 20 in the document — 81602 x 99 is 8,078,598 and
    // 81602 x 0.11 is 8,976.22, summing to 8,087,574.22. The document's
    // CONCLUSION is unaffected: the gap is still ~0.10%, which it rounds to
    // 0.11%, and still far below any sane alarm threshold.
    expect(out.impliedQuotePrice).toBe('8087574.22');
    // 8,482.22 on 8,079,092 is 10.499bp, which reports as 11.
    expect(out.driftBp).toBe('11');
    expect(out.thresholdBp).toBe(DEFAULT_FX_DRIFT_THRESHOLD_BP);
    expect(out.alarmed).toBe(false);
  });

  it('signs the drift by direction, so the dislocation is diagnosable', () => {
    // A lower rate makes the C2C route imply a LOWER price than the INR book.
    const low = crossCheck({ ...LIVE, rate: '99.00' });
    expect(low.driftBp.startsWith('-')).toBe(true);
    expect(low.driftBp).toBe('-1');
    expect(low.alarmed).toBe(false);
    // And the measured case is positive.
    expect(crossCheck(LIVE).driftBp).toBe('11');
  });

  it('alarms once the gap clears the threshold', () => {
    // Same C2C leg against a lower INR book: 8,087,574.22 vs 8,000,000 is 109.47bp.
    const out = crossCheck({ ...LIVE, quoteLegPrice: '8000000' });
    expect(out.driftBp).toBe('110');
    expect(out.alarmed).toBe(true);
  });

  it('does not alarm exactly AT the threshold, only above it', () => {
    const at = crossCheck({ asset: 'X', baseLegPrice: '101', quoteLegPrice: '100', rate: '1', thresholdBp: '100' });
    expect(at.driftBp).toBe('100'); // 1 on 100 is exactly 100bp
    expect(at.alarmed).toBe(false);
    const above = crossCheck({ asset: 'X', baseLegPrice: '101', quoteLegPrice: '100', rate: '1', thresholdBp: '99' });
    expect(above.alarmed).toBe(true);
  });

  it('rounds the drift magnitude UP, so a gap is never under-reported', () => {
    // Exactly 1bp stays 1bp — an exact value is not inflated.
    expect(crossCheck({ asset: 'X', baseLegPrice: '10001', quoteLegPrice: '10000', rate: '1' }).driftBp).toBe('1');
    // Half a basis point becomes one. Flooring would report 0bp and hide it.
    expect(crossCheck({ asset: 'X', baseLegPrice: '10000.5', quoteLegPrice: '10000', rate: '1' }).driftBp).toBe('1');
    // And the same on the negative side: magnitude, not value, rounds away from zero.
    expect(crossCheck({ asset: 'X', baseLegPrice: '9999.5', quoteLegPrice: '10000', rate: '1' }).driftBp).toBe('-1');
  });

  it('reports no drift when the two routes agree exactly', () => {
    const out = crossCheck({ asset: 'X', baseLegPrice: '100', quoteLegPrice: '10000', rate: '100' });
    expect(out.driftBp).toBe('0');
    expect(out.alarmed).toBe(false);
  });

  it('is deterministic — the same inputs give a byte-identical result', () => {
    expect(JSON.stringify(crossCheck(LIVE))).toBe(JSON.stringify(crossCheck(LIVE)));
  });

  it('refuses a threshold or a quote leg it cannot measure against', () => {
    expect(() => crossCheck({ ...LIVE, thresholdBp: '0' })).toThrow(FxError);
    expect(() => crossCheck({ ...LIVE, thresholdBp: '1.5' })).toThrow(FxError);
    expect(() => crossCheck({ ...LIVE, quoteLegPrice: '0' })).toThrow(FxError);
  });
});

describe('snapshot construction', () => {
  it('accepts the live sample', () => {
    const snap = fxSnapshot({
      base: 'USDT', quote: 'INR', rate: '99.11', source: 'coindcx_ticker_last', observedAtMs: 1_757_000_000_000,
    });
    expect(snap.rate).toBe('99.11');
    expect(snap.crossCheck).toBeUndefined();
  });

  it('refuses exponent notation, signs and a same-currency pair', () => {
    const base = { base: 'USDT', quote: 'INR', source: 'coindcx_ticker_last', observedAtMs: 0 } as const;
    // 1e2 is how a float artefact enters; money refuses it downstream anyway.
    expect(() => fxSnapshot({ ...base, rate: '9.911e1' })).toThrow(FxError);
    expect(() => fxSnapshot({ ...base, rate: '-99.11' })).toThrow(FxError);
    expect(() => fxSnapshot({ ...base, rate: '0' })).toThrow(FxError);
    expect(() => fxSnapshot({ ...base, rate: '' })).toThrow(FxError);
    expect(() => fxSnapshot({ base: 'INR', quote: 'INR', rate: '1', source: 'coindcx_ticker_last', observedAtMs: 0 }))
      .toThrow(FxError);
  });

  it('carries a cross-check when one was run alongside the sample', () => {
    const snap = fxSnapshot({
      base: 'USDT', quote: 'INR', rate: '99.11', source: 'coindcx_ticker_last',
      observedAtMs: 1_757_000_000_000, crossCheck: crossCheck(LIVE),
    });
    expect(snap.crossCheck?.driftBp).toBe('11');
    expect(snap.crossCheck?.alarmed).toBe(false);
  });
});

describe('conversion is bound to a snapshot (X10)', () => {
  const snap = fxSnapshot({
    base: 'USDT', quote: 'INR', rate: '99.11', source: 'coindcx_ticker_last', observedAtMs: 0,
  });

  it('converts USDT minor to INR minor', () => {
    // 100 USDT at scale 8, into paise: 100 x 99.11 = 9,911.00 = 991,100 paise.
    expect(convertMinor('10000000000', 'USDT', 'INR', snap)).toBe('991100');
  });

  it('converts INR minor to USDT minor', () => {
    expect(convertMinor('991100', 'INR', 'USDT', snap)).toBe('10000000000');
  });

  it('floors rather than rounding, in both directions', () => {
    // 1 paisa is 0.01 INR, which at 99.11 is 0.000100897... USDT. Floored to
    // USDT's scale of 8 that is 0.00010089, i.e. 10089 minor units — the eighth
    // decimal is dropped, not rounded up to 10090.
    expect(convertMinor('1', 'INR', 'USDT', snap)).toBe('10089');
    // 1 satoshi-scale USDT unit into paise floors to zero, and that is correct:
    // it is dust, not a rounding error to be corrected upward.
    expect(convertMinor('1', 'USDT', 'INR', snap)).toBe('0');
  });

  it('refuses a pair the snapshot does not cover — the 99x inversion bug', () => {
    // Passing the currencies the wrong way round on THIS pair would be a 99x
    // error, so direction is inferred from the snapshot rather than trusted.
    expect(() => convertMinor('100', 'INR', 'BTC', snap)).toThrow(FxError);
    expect(() => convertMinor('100', 'USDT', 'USDT', snap)).toThrow(FxError);
  });

  it('round-trips a representative amount without drift', () => {
    const inr = convertMinor('10000000000', 'USDT', 'INR', snap);
    expect(convertMinor(inr, 'INR', 'USDT', snap)).toBe('10000000000');
  });
});
