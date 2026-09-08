// 03-market-resolution — plan/phase-03 T03.2, from 10 F3.
//
// A group trade names an ASSET. Each account funds in its own currencies, so the
// same "buy BTC" resolves to a different market per account — or to none — and
// every one of those outcomes has to be explainable to the customer whose account
// was skipped.
//
// The two assertions the phase doc asks for by name are in section 2: a USDT-only
// asset must skip an INR-funded account *carrying the currencies that would work*,
// and an account funded in both must pick INR *and record why*. The rest of the
// file exists because the interesting cases are the ones a hand-written example
// would not think to try: an asset whose markets are all halted, an account funded
// in both currencies that can afford neither, and the 10 F6 asymmetry where the
// same balance is enough on an INR market and not on a C2C one.
//
// Section 6 sweeps every asset in the real 963-market fixture, because "prefer
// INR" is a claim about all 900-odd assets, not about BTC.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexByAsset, mapMarketsDetails } from '../packages/exchange-coindcx/dist/index.js';
import { resolveMarket, size } from '../packages/sizing/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'markets_details.json'), 'utf8');

/** An account's balances. Only the FREE side funds anything (11 F1). */
const balances = (inrMinor, usdtMinor, opts = {}) => [
  { currency: 'INR', freeMinor: inrMinor, lockedMinor: opts.inrLocked ?? '0', scale: 2 },
  { currency: 'USDT', freeMinor: usdtMinor, lockedMinor: opts.usdtLocked ?? '0', scale: 8 },
];

/** Rs 1 crore and 10,000 USDT — enough for any market's minimum. */
const RICH = balances('1000000000000', '1000000000000');

export async function run(assert) {
  const { rules } = mapMarketsDetails(fixture, 'res-v1');
  const bySym = new Map(rules.map((r) => [r.venueSymbol, r]));
  const index = indexByAsset(rules);
  const btcinr = bySym.get('BTCINR');
  const btcusdt = bySym.get('BTCUSDT');
  assert(btcinr !== undefined && btcusdt !== undefined, 'BTC must be listed in both currencies in the fixture');
  assert(rules.length > 900, `expected 900+ markets, got ${rules.length}`);

  // Assets grouped by which currencies list them, from the real fixture.
  const quotesFor = (asset) => new Set((index.get(asset) ?? []).filter((m) => m.tradable).map((m) => m.market.quote));
  const assets = [...index.keys()];
  const usdtOnly = assets.filter((a) => { const q = quotesFor(a); return q.has('USDT') && !q.has('INR'); });
  const inrOnly = assets.filter((a) => { const q = quotesFor(a); return q.has('INR') && !q.has('USDT'); });
  const both = assets.filter((a) => { const q = quotesFor(a); return q.has('INR') && q.has('USDT'); });
  assert(usdtOnly.length > 100, `expected many USDT-only assets, got ${usdtOnly.length}`);
  assert(both.length > 50, `expected many dual-listed assets, got ${both.length}`);
  assert(inrOnly.length > 0, `expected at least one INR-only asset, got ${inrOnly.length}`);

  // ------------------------------------------------------- 1. nothing lists it
  const unknown = resolveMarket('NOTATHING', RICH, rules);
  assert(unknown.code === 'ASSET_NOT_LISTED', `an unlisted asset should be ASSET_NOT_LISTED, got ${unknown.code}`);
  assert(unknown.message.includes('NOTATHING'), 'the refusal must name the asset it could not find');
  assert(unknown.rules === undefined, 'a refusal must not carry a market');

  // ------------------------------- 2. the two acceptance cases from the phase doc
  // (a) a USDT-only asset skips an INR-funded account, WITH the remedy.
  const asset = usdtOnly[0];
  const skipped = resolveMarket(asset, balances('1000000', '0'), index.get(asset));
  assert(skipped.code === 'NO_MARKET_FOR_FUNDING_CURRENCY',
    `a USDT-only asset should skip an INR-funded account, got ${skipped.code}`);
  assert(Array.isArray(skipped.remedyCurrencies) && skipped.remedyCurrencies.includes('USDT'),
    'the skip must carry USDT as the currency that WOULD work — that list is the entire remedy');
  assert(!skipped.remedyCurrencies.includes('INR'), 'INR cannot be a remedy for an asset INR does not list');
  assert(skipped.message.includes('USDT'), `the sentence must name the currency that works: ${skipped.message}`);

  // (b) an account funded in both picks INR, and says why.
  const chose = resolveMarket('BTC', RICH, [btcinr, btcusdt]);
  assert(chose.code === undefined, `a dual-funded account should resolve, got ${JSON.stringify(chose)}`);
  assert(chose.chosenQuote === 'INR', `INR must win, got ${chose.chosenQuote}`);
  assert(chose.rules.venueSymbol === 'BTCINR', `expected BTCINR, got ${chose.rules.venueSymbol}`);
  assert(chose.alternativeQuotes.includes('USDT'), 'the passed-over currency must be recorded');
  assert(!chose.alternativeQuotes.includes('INR'), 'the chosen currency must not also be an alternative');
  assert(/TDS/.test(chose.currencyChoiceReason),
    `the reason must state why INR wins, got "${chose.currencyChoiceReason}"`);
  assert(/11 F7/.test(chose.currencyChoiceReason), 'the reason should cite the finding it rests on');

  // Order of the candidate list must not decide the outcome.
  const reversed = resolveMarket('BTC', RICH, [btcusdt, btcinr]);
  assert(reversed.chosenQuote === 'INR', 'the candidate order changed the choice — preference is not being applied');
  assert(reversed.rules.venueSymbol === chose.rules.venueSymbol, 'reversing the candidates changed the market');

  // --------------------------------------------------------- 3. halted markets
  const halted = resolveMarket('BTC', RICH, [{ ...btcinr, tradable: false }]);
  assert(halted.code === 'MARKET_INACTIVE',
    `an asset whose only market is halted should be MARKET_INACTIVE, got ${halted.code}`);
  assert(halted.message.includes('BTCINR'), 'the refusal must name the halted market');
  // A halted INR market must not stop a live USDT one being used.
  const oneHalted = resolveMarket('BTC', RICH, [{ ...btcinr, tradable: false }, btcusdt]);
  assert(oneHalted.chosenQuote === 'USDT', 'a halted INR market should fall through to the live USDT one');
  assert(oneHalted.alternativeQuotes.length === 0, 'a halted market is not an alternative that was passed over');

  // ------------------------------------------------- 4. funded means FREE, not held
  const lockedUp = resolveMarket('BTC', balances('0', '1000000000000', { inrLocked: '100000000' }), [btcinr, btcusdt]);
  assert(lockedUp.chosenQuote === 'USDT',
    'INR locked in open orders must not count as funding — it cannot be spent (11 F1)');
  const nothingFree = resolveMarket('BTC', balances('0', '0', { inrLocked: '100000000' }), [btcinr, btcusdt]);
  assert(nothingFree.code === 'NO_MARKET_FOR_FUNDING_CURRENCY',
    `an account with nothing free funds nothing, got ${nothingFree.code}`);

  // ------------------------------------------- 5. affordability, and the 10 F6 gap
  // Rs 200 free and 3 USDT free. BTCINR needs Rs 100; BTCUSDT needs 5 USDT
  // (roughly Rs 496). Same account, affordable on one venue and not the other —
  // which is why a small account looks arbitrarily skipped unless this is stated.
  assert(btcinr.minNotionalMinor === '10000', `BTCINR minimum should be Rs 100, got ${btcinr.minNotionalMinor}`);
  assert(btcusdt.minNotionalMinor === '500000000', `BTCUSDT minimum should be 5 USDT, got ${btcusdt.minNotionalMinor}`);
  const asymmetric = resolveMarket('BTC', balances('20000', '300000000'), [btcinr, btcusdt]);
  assert(asymmetric.chosenQuote === 'INR', 'Rs 200 clears the INR minimum; 3 USDT does not clear the C2C one');
  assert(asymmetric.alternativeQuotes.length === 0,
    'the unaffordable market should not be recorded as a passed-over alternative');
  assert(/affordable/.test(asymmetric.currencyChoiceReason),
    `the reason should say affordability decided it, got "${asymmetric.currencyChoiceReason}"`);

  // Funded in both, affording neither: the only path to EITHER_CURRENCY.
  const broke = resolveMarket('BTC', balances('1', '1'), [btcinr, btcusdt]);
  assert(broke.code === 'INSUFFICIENT_BALANCE_EITHER_CURRENCY',
    `both funded and neither affordable should be INSUFFICIENT_BALANCE_EITHER_CURRENCY, got ${broke.code}`);
  assert(broke.offending === '0.01', `the refusal should show Rs 0.01 free, got ${broke.offending}`);
  assert(broke.limit === '100', `the refusal should show the Rs 100 minimum, got ${broke.limit}`);
  assert(broke.message.includes('BTCINR'), 'the refusal should name the closest market');
  assert(broke.message.includes('0.01') && broke.message.includes('100'),
    `both numbers must appear in the sentence: ${broke.message}`);
  assert(Array.isArray(broke.remedyCurrencies) && broke.remedyCurrencies.length === 2,
    'the refusal should list both currencies that were tried');

  // With only ONE usable market, 10 F3 returns it WITHOUT testing affordability,
  // so that the refusal comes from legalisation with the actual numbers. Prove
  // both halves: resolution succeeds, and the specific refusal follows.
  const soleAsset = inrOnly.find((a) => (index.get(a) ?? []).some((m) => m.tradable));
  const sole = resolveMarket(soleAsset, balances('1', '0'), index.get(soleAsset));
  assert(sole.code === undefined,
    `a single usable market must resolve even when unaffordable, got ${JSON.stringify(sole)}`);
  assert(sole.alternativeQuotes.length === 0, 'a sole market has no alternatives');
  assert(/only INR is funded/.test(sole.currencyChoiceReason),
    `the reason should say only one currency was funded, got "${sole.currencyChoiceReason}"`);
  const thenRefused = size({
    intent: { asset: soleAsset, side: 'buy', mode: 'pct_free', orderType: sole.rules.allowedTypes[0], percent: { basisPoints: 10000 },
      ...(sole.rules.allowedTypes[0] === 'limit' ? { limitPrice: sole.rules.minPrice } : {}) },
    rules: sole.rules, price: sole.rules.minPrice, priceSource: 'ask', freeQuoteMinor: '1',
  });
  assert(thenRefused.ok === undefined, 'sizing an unaffordable order should refuse');
  assert(['BELOW_MIN_NOTIONAL', 'ZERO_QUANTITY', 'BELOW_MIN_QTY'].includes(thenRefused.code),
    `the follow-on refusal should be specific, got ${thenRefused.code}`);

  // ------------------------------------------------------------- 6. the sweep
  // "Prefer INR" is a claim about every asset, so test it against every asset.
  let resolved = 0;
  let inrChosen = 0;
  let usdtChosen = 0;
  let refusedHalted = 0;

  for (const a of assets) {
    const candidates = index.get(a);
    const quotes = quotesFor(a);
    const out = resolveMarket(a, RICH, candidates);

    if (quotes.size === 0) {
      // Every market for this asset is halted.
      assert(out.code === 'MARKET_INACTIVE', `${a}: all markets halted but got ${out.code}`);
      refusedHalted += 1;
      continue;
    }

    assert(out.code === undefined, `${a}: a richly funded account should resolve, got ${out.code}`);
    assert(out.rules.market.asset === a, `${a}: resolved to a market for ${out.rules.market.asset}`);
    assert(out.rules.tradable === true, `${a}: resolved to a market that is not tradable`);
    // The preference rule, asserted per asset.
    const expected = quotes.has('INR') ? 'INR' : 'USDT';
    assert(out.chosenQuote === expected, `${a}: expected ${expected}, chose ${out.chosenQuote}`);
    assert(!out.alternativeQuotes.includes(out.chosenQuote), `${a}: the chosen quote is also listed as an alternative`);
    assert(out.currencyChoiceReason.length > 0, `${a}: resolved with no recorded reason`);
    resolved += 1;
    if (out.chosenQuote === 'INR') inrChosen += 1; else usdtChosen += 1;

    // Determinism: same inputs, same market and same reason.
    const again = resolveMarket(a, RICH, candidates);
    assert(again.rules.venueSymbol === out.rules.venueSymbol && again.currencyChoiceReason === out.currencyChoiceReason,
      `${a}: resolution is not deterministic`);
  }

  // Measured against the committed fixture: 963 markets collapse to 648 distinct
  // assets (315 dual-listed, 23 INR-only, 310 USDT-only) and none are halted, so
  // every asset must resolve. Asserting the exact split rather than a floor is
  // what makes this sweep able to notice a preference regression: if INR ever
  // stopped winning, `inrChosen` would drop and `usdtChosen` would rise by the
  // same amount, which a "> 600 resolved" check would sail straight past.
  assert(resolved === assets.length, `expected all ${assets.length} assets to resolve, got ${resolved}`);
  assert(resolved > 600, `expected 600+ assets in the fixture, got ${resolved}`);
  assert(refusedHalted === 0, `the fixture has no halted markets, but ${refusedHalted} assets refused as halted`);
  assert(inrChosen === both.length + inrOnly.length,
    `INR should win for every asset it lists (${both.length + inrOnly.length}), won ${inrChosen}`);
  assert(usdtChosen === usdtOnly.length,
    `USDT should win only where INR does not list the asset (${usdtOnly.length}), won ${usdtChosen}`);
  assert(inrChosen + usdtChosen === assets.length, 'the two branches do not account for every asset');
  // The INR winners must equal the number of INR markets, since an asset is
  // listed against INR at most once. A mismatch means a duplicate INR listing,
  // which would make resolution ambiguous (10 F3).
  assert(inrChosen === rules.filter((r) => r.market.quote === 'INR').length,
    `${inrChosen} assets chose INR but the fixture has ${rules.filter((r) => r.market.quote === 'INR').length} INR markets`);

  // The mirror: with only USDT funded, every INR-only asset must skip with INR
  // named as the remedy, and every USDT asset must resolve to USDT.
  const usdtOnlyAccount = balances('0', '1000000000000');
  let mirrored = 0;
  for (const a of [...inrOnly.slice(0, 40), ...usdtOnly.slice(0, 40), ...both.slice(0, 40)]) {
    const out = resolveMarket(a, usdtOnlyAccount, index.get(a));
    const quotes = quotesFor(a);
    if (!quotes.has('USDT')) {
      assert(out.code === 'NO_MARKET_FOR_FUNDING_CURRENCY', `${a}: expected a funding skip, got ${out.code}`);
      assert(out.remedyCurrencies.includes('INR'), `${a}: the remedy should name INR`);
      assert(!out.remedyCurrencies.includes('USDT'), `${a}: USDT cannot be a remedy for an asset it does not list`);
    } else {
      assert(out.chosenQuote === 'USDT', `${a}: only USDT is funded but it chose ${out.chosenQuote}`);
    }
    mirrored += 1;
  }
  assert(mirrored === Math.min(40, inrOnly.length) + 40 + 40, 'the mirror sweep did not cover what it claimed');

  console.log(`     ${assets.length} assets swept: ${resolved} resolved (${inrChosen} INR, ${usdtChosen} USDT),`
    + ` ${refusedHalted} all-halted; ${usdtOnly.length} USDT-only, ${inrOnly.length} INR-only, ${both.length} dual-listed`);
}
