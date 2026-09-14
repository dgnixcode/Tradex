// 15-liquidation-buffer — plan/phase-15 T15.6.
//
// The futures sizing gates run against injected scalars (§6a: sizing stays
// import-free of a live-price fetch). Three properties:
//   * MAX_LEVERAGE — the venue's tier cap; requesting 100x on a 1000-USDT
//     notional in a tier that only allows 20x refuses.
//   * ABOVE_MARGIN_CAP — the per-order cap applies to MARGIN, not notional
//     exposure. A 5x order of ₹1L notional risks ₹20k, and the cap should
//     bind on ₹20k. Two shapes: passes when cap accommodates margin; refuses
//     when it does not.
//   * LIQUIDATION_BUFFER_TOO_TIGHT — a 100x long sits ~100 bp from liquidation
//     (1/100 = 1%). If the customer set a 200 bp minimum buffer, that refuses.
//     Two shapes: passes at 5x (20% buffer) with a 200 bp floor; refuses at
//     100x.

import { bufferBp, futuresGates, liquidationPriceEstimate, marginMinorFor, tierFor } from '../packages/sizing/dist/index.js';

const TIERS = [
  { upToNotionalMinor: '10000000000', maxLeverage: 100 }, // 100 USDT * 1e8 minor
  { upToNotionalMinor: '2000000000000', maxLeverage: 20 }, // 20_000 USDT
  { upToNotionalMinor: '10000000000000', maxLeverage: 5 },
];

export async function run(assert) {
  // ---- Helper sanity ----
  assert(tierFor('5000000000', TIERS)?.maxLeverage === 100, '50 USDT notional falls into tier 100x');
  assert(tierFor('50000000000', TIERS)?.maxLeverage === 20, '500 USDT notional falls into tier 20x');
  assert(tierFor('999999999999999', TIERS)?.maxLeverage === 5, 'above the last threshold clamps to the last tier');

  assert(marginMinorFor('100000000', 5) === '20000000', 'margin = notional/leverage, floored');
  assert(marginMinorFor('100000000', 1) === '100000000', 'leverage 1 = full notional as margin');

  // A long at 100x sits ~1% below entry (100 bp = 1%). 10 bp of rounding wiggle
  // is fine; assert we're at or below 100 bp for a 100x long.
  const liq100 = liquidationPriceEstimate('8000000', 100, 'buy');
  assert(bufferBp('8000000', liq100) <= 100 && bufferBp('8000000', liq100) >= 80,
    `100x long buffer must be ~100 bp, got ${bufferBp('8000000', liq100)}`);

  const liq5 = liquidationPriceEstimate('8000000', 5, 'buy');
  const buf5 = bufferBp('8000000', liq5);
  assert(buf5 >= 1900 && buf5 <= 2100, `5x long buffer must be ~2000 bp (20%), got ${buf5}`);

  // A short's liquidation is above entry.
  const liq5Short = liquidationPriceEstimate('8000000', 5, 'sell');
  assert(Number(liq5Short) > Number('8000000'), `5x short liq must be above entry, got ${liq5Short}`);

  // ---- MAX_LEVERAGE ----
  const overLev = futuresGates({
    leverage: 100, leverageTiers: TIERS, notionalMinor: '50000000000',
    perOrderCapMinor: null, minLiqBufferBp: 0, side: 'buy', entryPrice: '8000000',
  });
  assert(overLev.some((r) => r.code === 'MAX_LEVERAGE'),
    `100x on a 20x tier must fire MAX_LEVERAGE, got ${JSON.stringify(overLev)}`);

  const okLev = futuresGates({
    leverage: 10, leverageTiers: TIERS, notionalMinor: '50000000000',
    perOrderCapMinor: null, minLiqBufferBp: 0, side: 'buy', entryPrice: '8000000',
  });
  assert(!okLev.some((r) => r.code === 'MAX_LEVERAGE'), '10x within 20x tier is legal');

  // ---- ABOVE_MARGIN_CAP ----
  // Notional 100_000 minor, leverage 5, margin = 20_000. Cap 15_000 rejects.
  const overMargin = futuresGates({
    leverage: 5, leverageTiers: TIERS, notionalMinor: '100000',
    perOrderCapMinor: '15000', minLiqBufferBp: 0, side: 'buy', entryPrice: '8000000',
  });
  assert(overMargin.some((r) => r.code === 'ABOVE_MARGIN_CAP'),
    `margin 20_000 vs cap 15_000 must fire ABOVE_MARGIN_CAP, got ${JSON.stringify(overMargin)}`);

  // Cap 25_000 lets margin 20_000 through — even though NOTIONAL is 100_000
  // (which is what the spot cap models). This is the whole point of the gate.
  const okMargin = futuresGates({
    leverage: 5, leverageTiers: TIERS, notionalMinor: '100000',
    perOrderCapMinor: '25000', minLiqBufferBp: 0, side: 'buy', entryPrice: '8000000',
  });
  assert(!okMargin.some((r) => r.code === 'ABOVE_MARGIN_CAP'),
    'ABOVE_MARGIN_CAP compares MARGIN (not notional) to the cap');

  // ---- LIQUIDATION_BUFFER_TOO_TIGHT ----
  // 100x long: ~100 bp buffer. 200 bp floor: refuses.
  const tight = futuresGates({
    leverage: 100, leverageTiers: TIERS, notionalMinor: '1000000000',
    perOrderCapMinor: null, minLiqBufferBp: 200, side: 'buy', entryPrice: '8000000',
  });
  assert(tight.some((r) => r.code === 'LIQUIDATION_BUFFER_TOO_TIGHT'),
    `100x with 200 bp floor must fire LIQUIDATION_BUFFER_TOO_TIGHT, got ${JSON.stringify(tight)}`);

  // Same 200 bp floor with 5x — 20% buffer passes.
  const roomy = futuresGates({
    leverage: 5, leverageTiers: TIERS, notionalMinor: '1000000000',
    perOrderCapMinor: null, minLiqBufferBp: 200, side: 'buy', entryPrice: '8000000',
  });
  assert(!roomy.some((r) => r.code === 'LIQUIDATION_BUFFER_TOO_TIGHT'),
    '5x has a 20% buffer so a 2% floor is comfortable');

  // A 0 bp floor disables the gate — 100x still passes.
  const disabled = futuresGates({
    leverage: 100, leverageTiers: TIERS, notionalMinor: '1000000000',
    perOrderCapMinor: null, minLiqBufferBp: 0, side: 'buy', entryPrice: '8000000',
  });
  assert(!disabled.some((r) => r.code === 'LIQUIDATION_BUFFER_TOO_TIGHT'),
    'a 0 bp floor disables the buffer gate');

  // ---- All three at once ----
  const all = futuresGates({
    leverage: 100, leverageTiers: TIERS, notionalMinor: '50000000000',
    perOrderCapMinor: '15000', minLiqBufferBp: 500, side: 'buy', entryPrice: '8000000',
  });
  const codes = new Set(all.map((r) => r.code));
  assert(codes.has('MAX_LEVERAGE') && codes.has('ABOVE_MARGIN_CAP') && codes.has('LIQUIDATION_BUFFER_TOO_TIGHT'),
    `a bad request must return all three refusals, got ${[...codes].join(',')}`);
}
