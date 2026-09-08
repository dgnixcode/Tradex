// 03-sizing-999-markets — plan/phase-03 T03.9, from 18 F4.
//
// The mitigation for "wrong order size" (R03) is not a handful of examples. It is
// every market the venue lists, crossed with a lattice of intents, checking the
// invariants that must hold whatever the numbers are. 963 markets x ~200 intents
// is roughly 190,000 cases, and it runs in seconds because sizing does no I/O.
//
// The invariants, numbered as 09's design table and 18 F4 state them:
//
//   S1  a BUY's notional x (1 + fee + tds) never exceeds the stated budget
//   S2  a SELL never exceeds the free holding
//   S3  every quantity is an exact step multiple within the market's precision
//   S4  every quantity sits inside the min/max band FOR ITS ORDER TYPE
//   S5  every order clears min_notional
//   S6  no float appears anywhere in the serialised output
//   S7  a percentage of zero is a refusal, never a zero-quantity order
//   S8  rounding is monotonic: a larger budget never yields a smaller quantity
//   S9  identical inputs yield identical output
//   S10 every refusal carries a known code and a human sentence
//
// Two things this file does that a naive sweep does not.
//
// It covers USDT markets, not just INR. 625 of the 963 markets are C2C, they
// carry the 1% TDS that INR markets do not, and S1 is the assertion that catches
// a holdback applied to the wrong side (11 F4, and R14 in the risk register).
//
// It proves the rounding direction per market, in section 4, rather than trusting
// that S1 would notice. For every market it constructs a quantity whose fraction
// is nine tenths of a step — a value round-half-up would round UP — and asserts
// the result is the floor. If flooring were ever flipped to nearest, that section
// fails on all 963 markets, which is the "fails on a deliberate rounding flip"
// clause of the phase's definition of done.
//
// No Math.random and no clock: the intent lattice is derived from small integers
// and every price is computed from the market's own band with BigInt, so a failure
// reproduces exactly from the printed market symbol.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapMarketsDetails } from '../packages/exchange-coindcx/dist/index.js';
import { REFUSAL_CODES, effectiveMinQty, size, toStr } from '../packages/sizing/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'markets_details.json'), 'utf8');

// ---------------------------------------------------------------- exact decimals
// Everything below is BigInt on the digit strings. A Number() anywhere here would
// make the checker less precise than the code it is checking.

/** Parse a plain decimal into { v, scale } exactly. */
const dec = (s) => {
  const dot = s.indexOf('.');
  const scale = dot === -1 ? 0 : s.length - dot - 1;
  return { v: BigInt(dot === -1 ? s : s.slice(0, dot) + s.slice(dot + 1)), scale };
};

/** Raise both to a common scale, returning [aValue, bValue, scale]. */
const align = (a, b) => {
  const s = a.scale > b.scale ? a.scale : b.scale;
  return [a.v * 10n ** BigInt(s - a.scale), b.v * 10n ** BigInt(s - b.scale), s];
};

const cmpDec = (a, b) => {
  const [av, bv] = align(dec(a), dec(b));
  return av < bv ? -1 : av > bv ? 1 : 0;
};

/** Decimal places actually present in a plain decimal string. */
const places = (s) => (s.includes('.') ? s.length - s.indexOf('.') - 1 : 0);

/** Is `qty` an exact multiple of `step`? */
const isStepMultiple = (qty, step) => {
  const [qv, sv] = align(dec(qty), dec(step));
  return sv > 0n && qv % sv === 0n;
};

/** Rescale { v, scale } to `to`, flooring when narrowing. */
const rescale = ({ v, scale }, to) => (to >= scale
  ? { v: v * 10n ** BigInt(to - scale), scale: to }
  : { v: v / 10n ** BigInt(scale - to), scale: to });

/** A rate string such as '0.005' as integer parts per million. */
const ppm = (rate) => {
  const d = dec(rate);
  return d.scale <= 6 ? d.v * 10n ** BigInt(6 - d.scale) : d.v / 10n ** BigInt(d.scale - 6);
};

/** `major` units as minor units for a quote scale, e.g. '500' INR -> '50000'. */
const minorOf = (major, scale) => (BigInt(major) * 10n ** BigInt(scale)).toString();

const quoteScaleOf = (quote) => (quote === 'INR' ? 2 : 8);

/**
 * A deterministic representative price: the arithmetic midpoint of the market's
 * own min/max band, floored to its price precision, never zero.
 *
 * Midpoint rather than `minPrice`, because the dust markets quote a `min_price`
 * as low as 1e-11 and every order against it would refuse for min_notional,
 * which would test the refusal path 190,000 times and the sizing path never.
 */
const bandPrice = (rules) => {
  const [lo, hi, s] = align(dec(rules.minPrice), dec(rules.maxPrice));
  const mid = rescale({ v: (lo + hi) / 2n, scale: s }, rules.pricePrecision);
  return toStr({ v: mid.v === 0n ? 1n : mid.v, scale: mid.scale });
};

/** Multiply a { v, scale } by a whole number, rendered as a decimal string. */
const times = ({ v, scale }, n) => toStr({ v: v * BigInt(n), scale });

/** Floor a decimal string to a multiple of `step`, exactly. */
const floorToStepDec = (qty, step) => {
  const [qv, sv, s] = align(dec(qty), dec(step));
  return toStr({ v: (qv / sv) * sv, scale: s });
};

// -------------------------------------------------------------- the intent lattice
const CAPITALS_MAJOR = ['5', '50', '500', '5000', '50000', '500000', '5000000', '50000000'];
const PERCENTS_BP = [1, 50, 100, 500, 1000, 2000, 3300, 5000, 7500, 10000];
/** Holdings as whole multiples of the market's effective minimum. */
const HOLDING_MULTIPLES = [1, 2, 7, 50, 1000];
const SELL_PERCENTS_BP = [1000, 2500, 5000, 10000];

export async function run(assert) {
  const started = Date.now();
  const { rules } = mapMarketsDetails(fixture, 'prop-v1');
  assert(rules.length > 900, `expected 900+ mapped markets, got ${rules.length}`);

  const inrCount = rules.filter((r) => r.market.quote === 'INR').length;
  const usdtCount = rules.filter((r) => r.market.quote === 'USDT').length;
  assert(inrCount > 300, `expected 300+ INR markets, got ${inrCount}`);
  assert(usdtCount > 500, `expected 500+ USDT markets in the sweep, got ${usdtCount}`);

  const codes = new Set(REFUSAL_CODES);
  let cases = 0;
  let sized = 0;
  let refused = 0;
  let asserts = 0;
  let sellCases = 0;
  let c2cSized = 0;
  const refusalTally = new Map();
  const bump = (cond, msg) => { asserts += 1; assert(cond, msg); };

  /** Assert the properties that must hold of ANY accepted order. */
  const checkSized = (out, r, orderType, min, price, label) => {
    // S6: nothing in the output may be a number. A float here is the silent,
    // cumulative wrongness that is hardest to notice later.
    for (const [k, v] of Object.entries(out)) {
      bump(typeof v === 'string' || typeof v === 'boolean' || v === null,
        `${r.venueSymbol} ${label}: output field ${k} is ${typeof v}, which admits float error`);
    }
    // S3: an exact step multiple, within the market's own precision.
    bump(isStepMultiple(out.finalQuantity, r.quantityStep),
      `${r.venueSymbol} ${label}: qty ${out.finalQuantity} is not a multiple of step ${r.quantityStep}`);
    bump(places(out.finalQuantity) <= r.quantityPrecision,
      `${r.venueSymbol} ${label}: qty ${out.finalQuantity} exceeds precision ${r.quantityPrecision}`);
    // S4: inside the band for THIS order type. The market cap is the tight one.
    bump(cmpDec(out.finalQuantity, toStr(min)) >= 0,
      `${r.venueSymbol} ${label}: qty ${out.finalQuantity} is below the effective minimum ${toStr(min)}`);
    bump(cmpDec(out.finalQuantity, r.maxQuantity) <= 0,
      `${r.venueSymbol} ${label}: qty ${out.finalQuantity} exceeds max ${r.maxQuantity}`);
    if (orderType === 'market' && r.maxMarketQuantity !== null) {
      bump(cmpDec(out.finalQuantity, r.maxMarketQuantity) <= 0,
        `${r.venueSymbol} ${label}: market qty ${out.finalQuantity} exceeds the market cap ${r.maxMarketQuantity}`);
    }
    // S5: clears the venue's minimum order value.
    bump(BigInt(out.notionalMinor) >= BigInt(r.minNotionalMinor),
      `${r.venueSymbol} ${label}: notional ${out.notionalMinor} is below min ${r.minNotionalMinor}`);
    bump(out.priceUsed === price, `${r.venueSymbol} ${label}: the price was not carried through`);
    bump(out.marketMetaVersion === r.rulesVersion,
      `${r.venueSymbol} ${label}: the metadata version was not recorded`);
  };

  const checkRefusal = (out, r, label) => {
    // S10: a known code and a sentence, every time.
    bump(typeof out.code === 'string' && codes.has(out.code),
      `${r.venueSymbol} ${label}: refused with ${out.code}, which is not in the catalogue`);
    bump(typeof out.message === 'string' && out.message.length > 0,
      `${r.venueSymbol} ${label}: refused with no sentence`);
    refusalTally.set(out.code, (refusalTally.get(out.code) ?? 0) + 1);
  };

  for (const r of rules) {
    const price = bandPrice(r);
    const quoteScale = quoteScaleOf(r.market.quote);
    const min = effectiveMinQty(r, 'market');
    // Size with an order type the market actually allows: 287 of the 338 INR
    // books are limit-only, and the property under test is the arithmetic, not
    // the order-type filter (which has its own assertion below).
    const orderType = r.allowedTypes.includes('market') ? 'market' : r.allowedTypes[0];
    const limitBits = orderType === 'limit' ? { limitPrice: price } : {};

    // The order-type filter is itself a property.
    if (!r.allowedTypes.includes('market')) {
      const mustRefuse = size({
        intent: { asset: r.market.asset, side: 'buy', mode: 'pct_allocated', orderType: 'market', percent: { basisPoints: 2000 } },
        rules: r, price, priceSource: 'ask', allocatedCapitalMinor: minorOf('20000', quoteScale),
      });
      bump(mustRefuse.ok !== true && mustRefuse.code === 'ORDER_TYPE_NOT_ALLOWED',
        `${r.venueSymbol} allows ${r.allowedTypes.join('/')} but did not refuse a market order by name`);
    }

    // S7: a percentage of an unfunded account is a refusal, never a zero order.
    const ofNothing = size({
      intent: { asset: r.market.asset, side: 'buy', mode: 'pct_free', orderType, percent: { basisPoints: 5000 }, ...limitBits },
      rules: r, price, priceSource: 'ask', freeQuoteMinor: '0',
    });
    bump(ofNothing.ok !== true, `${r.venueSymbol}: 50% of a zero balance produced an order`);
    bump(ofNothing.code === 'ZERO_QUANTITY' || ofNothing.code === 'BELOW_MIN_QTY' || ofNothing.code === 'BELOW_MIN_NOTIONAL',
      `${r.venueSymbol}: 50% of nothing refused as ${ofNothing.code}`);

    // ------------------------------------------------------------- buy lattice
    for (const mode of ['pct_allocated', 'pct_free']) {
      for (const capMajor of CAPITALS_MAJOR) {
        const capMinor = minorOf(capMajor, quoteScale);
        let lastQty = null;
        for (const bp of PERCENTS_BP) {
          const intent = { asset: r.market.asset, side: 'buy', mode, orderType, percent: { basisPoints: bp }, ...limitBits };
          const input = {
            intent, rules: r, price, priceSource: orderType === 'limit' ? 'limit' : 'ask',
            ...(mode === 'pct_allocated' ? { allocatedCapitalMinor: capMinor } : { freeQuoteMinor: capMinor }),
          };
          const out = size(input);
          cases += 1;

          if (out.ok === true) {
            sized += 1;
            if (r.market.quote !== 'INR') c2cSized += 1;
            checkSized(out, r, orderType, min, price, `${mode} ${capMajor}@${bp}bp`);

            // S1: the budget was never exceeded once fee and TDS are added back.
            // budget = floor(basis x bp / 10000), matching how sizing derives it.
            const budget = (BigInt(out.basisAmountMinor) * BigInt(bp)) / 10000n;
            const loaded = BigInt(out.notionalMinor) * (1_000_000n + ppm(out.feeRateAssumed) + ppm(out.tdsRateApplied));
            bump(loaded <= budget * 1_000_000n,
              `${r.venueSymbol} ${mode} ${capMajor}@${bp}bp: notional ${out.notionalMinor}`
              + ` plus fee ${out.feeRateAssumed} and TDS ${out.tdsRateApplied} exceeds the budget ${budget}`);
            // The TDS side must match the market: 0 on INR, 1% on C2C (11 F4).
            bump(out.tdsRateApplied === (r.market.quote === 'INR' ? '0' : '0.01'),
              `${r.venueSymbol}: TDS ${out.tdsRateApplied} is wrong for a ${r.market.quote} market`);

            // S8: monotonic in the percentage, at a fixed basis.
            if (lastQty !== null) {
              bump(cmpDec(out.finalQuantity, lastQty) >= 0,
                `${r.venueSymbol} ${mode} ${capMajor}: qty fell from ${lastQty} to ${out.finalQuantity} as the percentage rose`);
            }
            lastQty = out.finalQuantity;

            // S9: determinism, sampled to keep the sweep quick.
            if (cases % 10 === 0) {
              const again = size(input);
              bump(again.ok === true && again.finalQuantity === out.finalQuantity
                && again.notionalMinor === out.notionalMinor,
                `${r.venueSymbol} ${mode} ${capMajor}@${bp}bp: sizing is not deterministic`);
            }
          } else {
            refused += 1;
            checkRefusal(out, r, `${mode} ${capMajor}@${bp}bp`);
            lastQty = null; // a cap or notional refusal ends the monotonic chain
          }
        }
      }

      // quote_amount: the budget IS the amount, so S1 is at its tightest.
      for (const capMajor of CAPITALS_MAJOR) {
        const amount = minorOf(capMajor, quoteScale);
        const out = size({
          intent: { asset: r.market.asset, side: 'buy', mode: 'quote_amount', orderType, quoteAmountMinor: amount, ...limitBits },
          rules: r, price, priceSource: orderType === 'limit' ? 'limit' : 'ask',
        });
        cases += 1;
        if (out.ok === true) {
          sized += 1;
          checkSized(out, r, orderType, min, price, `quote_amount ${capMajor}`);
          const loaded = BigInt(out.notionalMinor) * (1_000_000n + ppm(out.feeRateAssumed) + ppm(out.tdsRateApplied));
          bump(loaded <= BigInt(amount) * 1_000_000n,
            `${r.venueSymbol} quote_amount ${capMajor}: notional plus fee and TDS exceeds the amount asked for`);
          bump(out.basisUsed === null, `${r.venueSymbol}: quote_amount should record no percentage basis`);
        } else {
          refused += 1;
          checkRefusal(out, r, `quote_amount ${capMajor}`);
        }
      }
    }

    // ------------------------------------------------------------ sell lattice
    for (const mult of HOLDING_MULTIPLES) {
      const holding = times(min, mult);
      for (const bp of SELL_PERCENTS_BP) {
        const out = size({
          intent: { asset: r.market.asset, side: 'sell', mode: 'pct_position', orderType, percent: { basisPoints: bp }, ...limitBits },
          rules: r, price, priceSource: orderType === 'limit' ? 'limit' : 'bid', positionQuantity: holding,
        });
        cases += 1;
        sellCases += 1;
        if (out.ok === true) {
          sized += 1;
          checkSized(out, r, orderType, min, price, `pct_position ${mult}x@${bp}bp`);
          // S2: never sell more than is actually held.
          bump(cmpDec(out.finalQuantity, holding) <= 0,
            `${r.venueSymbol}: selling ${out.finalQuantity} while holding only ${holding}`);
          bump(out.basisUsed === 'position', `${r.venueSymbol}: a pct_position sell lost its basis`);
        } else {
          refused += 1;
          checkRefusal(out, r, `pct_position ${mult}x@${bp}bp`);
        }
      }

      // sell_all, and the same quantity stated explicitly. Both must respect the
      // holding, and sell_all must never exceed it even by one step.
      for (const mode of ['sell_all', 'base_quantity']) {
        const intent = mode === 'sell_all'
          ? { asset: r.market.asset, side: 'sell', mode, orderType, ...limitBits }
          : { asset: r.market.asset, side: 'sell', mode, orderType, baseQuantity: holding, ...limitBits };
        const out = size({
          intent, rules: r, price, priceSource: orderType === 'limit' ? 'limit' : 'bid', positionQuantity: holding,
        });
        cases += 1;
        sellCases += 1;
        if (out.ok === true) {
          sized += 1;
          checkSized(out, r, orderType, min, price, `${mode} ${mult}x`);
          bump(cmpDec(out.finalQuantity, holding) <= 0,
            `${r.venueSymbol} ${mode}: selling ${out.finalQuantity} while holding only ${holding}`);
        } else {
          refused += 1;
          checkRefusal(out, r, `${mode} ${mult}x`);
        }
      }
    }
  }

  // ------------------------------------------------------------------- section 4
  // The rounding direction, proved per market.
  //
  // For each market, build the smallest step-aligned quantity that clears
  // min_notional, then add nine tenths of a step. Round-half-up would carry that
  // to the next step; flooring must not. Any market where the construction is not
  // representable is counted and reported rather than silently skipped.
  let flipProofs = 0;
  let flipSkipped = 0;
  for (const r of rules) {
    const price = bandPrice(r);
    const step = dec(r.quantityStep);
    if (step.scale >= 18 || step.v <= 0n) { flipSkipped += 1; continue; }
    const orderType = r.allowedTypes.includes('limit') ? 'limit' : r.allowedTypes[0];
    const min = effectiveMinQty(r, orderType);

    // The smallest step multiple that is >= the effective minimum AND clears
    // min_notional at this price.
    const [minV, stepV, s] = align(min, step);
    let unitsForMin = minV / stepV + (minV % stepV === 0n ? 0n : 1n);
    // notional(units) = units * step * price, floored to the quote scale.
    const quoteScale = quoteScaleOf(r.market.quote);
    const p = dec(price);
    const notionalMinorOf = (units) => {
      const raw = units * stepV * p.v; // scale = s + p.scale
      const from = s + p.scale;
      return from >= quoteScale ? raw / 10n ** BigInt(from - quoteScale) : raw * 10n ** BigInt(quoteScale - from);
    };
    const needed = BigInt(r.minNotionalMinor);
    if (notionalMinorOf(unitsForMin) < needed) {
      // Solve for the units that clear the minimum, then align up.
      const denom = stepV * p.v;
      if (denom <= 0n) { flipSkipped += 1; continue; }
      const from = s + p.scale;
      const scaled = from >= quoteScale
        ? needed * 10n ** BigInt(from - quoteScale)
        : needed / 10n ** BigInt(quoteScale - from);
      unitsForMin = scaled / denom + 1n;
    }
    const q0 = toStr({ v: unitsForMin * stepV, scale: s });
    // Must still be inside the band, or the order would refuse for a reason that
    // has nothing to do with rounding.
    if (cmpDec(q0, r.maxQuantity) > 0) { flipSkipped += 1; continue; }
    if (places(q0) > r.quantityPrecision) { flipSkipped += 1; continue; }

    // q0 plus nine tenths of a step, exactly, one scale deeper.
    const deeper = s + 1;
    if (deeper > 18) { flipSkipped += 1; continue; }
    const qFraction = toStr({ v: unitsForMin * stepV * 10n + stepV * 9n, scale: deeper });
    const expectedFloor = floorToStepDec(qFraction, r.quantityStep);
    const roundedUp = toStr({ v: (unitsForMin + 1n) * stepV, scale: s });

    // The construction is only meaningful if nearest really would differ.
    if (cmpDec(expectedFloor, roundedUp) === 0) { flipSkipped += 1; continue; }

    const out = size({
      intent: {
        asset: r.market.asset, side: 'buy', mode: 'base_quantity', orderType,
        baseQuantity: qFraction, ...(orderType === 'limit' ? { limitPrice: price } : {}),
      },
      rules: r, price, priceSource: orderType === 'limit' ? 'limit' : 'ask',
    });
    if (out.ok !== true) { flipSkipped += 1; continue; }

    bump(cmpDec(out.finalQuantity, expectedFloor) === 0,
      `${r.venueSymbol}: ${qFraction} should floor to ${expectedFloor}, got ${out.finalQuantity}`);
    bump(cmpDec(out.finalQuantity, roundedUp) !== 0,
      `${r.venueSymbol}: ${qFraction} was ROUNDED UP to ${out.finalQuantity} — flooring has been flipped to nearest`);
    bump(cmpDec(out.finalQuantity, qFraction) < 0,
      `${r.venueSymbol}: the result ${out.finalQuantity} is not strictly below the requested ${qFraction}`);
    flipProofs += 1;
  }

  bump(flipProofs > 800,
    `the rounding-direction proof only covered ${flipProofs} markets (${flipSkipped} skipped); it must cover the venue`);

  // ------------------------------------------------------------------- totals
  bump(cases > 150_000, `expected 150,000+ generated cases, got ${cases}`);
  bump(sized > 20_000, `expected many fills across the sweep, got ${sized}`);
  bump(refused > 10_000, `expected many refusals (tiny budgets, huge percentages), got ${refused}`);
  bump(sellCases > 20_000, `the sell side must be swept too, got ${sellCases} sell cases`);
  bump(c2cSized > 5_000, `C2C markets must produce fills so the 1% TDS holdback is exercised, got ${c2cSized}`);
  // Both of the refusals the phase is judged on must appear somewhere in a sweep
  // this wide, or the sweep is not reaching the interesting cases.
  bump((refusalTally.get('ABOVE_MAX_QTY_MARKET') ?? 0) > 0, 'no market-cap refusal in the whole sweep');
  bump((refusalTally.get('BELOW_MIN_NOTIONAL') ?? 0) > 0, 'no min-notional refusal in the whole sweep');

  const elapsed = Date.now() - started;
  const tally = [...refusalTally.entries()].sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c} ${n}`).join(', ');
  console.log(`     ${rules.length} markets (${inrCount} INR, ${usdtCount} USDT) x ~${Math.round(cases / rules.length)} intents`
    + ` = ${cases} cases in ${elapsed}ms: ${sized} sized (${c2cSized} C2C), ${refused} refused, ${sellCases} sells`);
  console.log(`     ${asserts} property assertions over the sweep`);
  console.log(`     rounding direction proved on ${flipProofs} markets (${flipSkipped} not constructible)`);
  console.log(`     refusals: ${tally}`);
}
