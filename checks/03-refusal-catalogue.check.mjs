// 03-refusal-catalogue — plan/phase-03 T03.7.
//
// "Refused" with no numbers is useless on a confirmation screen. The customer
// cannot tell whether they asked for slightly too much or a thousand times too
// much, and the single most important refusal in this system — the largest
// account in a group failing a percentage buy because the quantity exceeds
// `max_quantity_market` — is precisely the one that looks like a bug unless the
// offending value and the limit are both shown (09 F7 row 3).
//
// So this file asserts three things:
//
//  1. Every code has a template, and every template carries the interpolations
//     its category promises — numbers for a numeric refusal, a named subject for
//     a contextual one.
//  2. A rendered message never ships a leftover `{placeholder}`, and never ships
//     an empty gap where a number should be.
//  3. Every code in the closed enum is REACHABLE by a real call through `size()`,
//     `legalise()` or `resolveMarket()`. A catalogue with a dead code is a
//     catalogue that has drifted from the code that refuses, and the dead entry
//     reads as a guarantee nobody is providing.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapMarketsDetails } from '../packages/exchange-coindcx/dist/index.js';
import {
  DETAIL_REFUSALS, NUMERIC_REFUSALS, REFUSAL_CODES, REFUSAL_TEMPLATES,
  legalise, refuse, resolveMarket, size,
} from '../packages/sizing/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'markets_details.json'), 'utf8');

const BTCINR_ASK = '8077476.1';

/**
 * `PRICE_NOT_ON_TICK` is in the catalogue but cannot currently be raised, and
 * that is a known, deliberate gap rather than an oversight: `MarketRules` carries
 * `pricePrecision` but no tick-size field, because CoinDCX's `markets_details`
 * does not publish one (01 T01.4). The code is reserved so that adding a tick
 * source later does not need a new refusal to be invented mid-incident. Listing
 * it here is what stops the reachability sweep below quietly rotting into
 * "several codes are unreachable and nobody remembers why".
 */
const KNOWN_UNREACHABLE = new Set(['PRICE_NOT_ON_TICK']);

const balances = (inrMinor, usdtMinor) => [
  { currency: 'INR', freeMinor: inrMinor, lockedMinor: '0', scale: 2 },
  { currency: 'USDT', freeMinor: usdtMinor, lockedMinor: '0', scale: 8 },
];

export async function run(assert) {
  const { rules } = mapMarketsDetails(fixture, 'cat-v1');
  const bySym = new Map(rules.map((r) => [r.venueSymbol, r]));
  const btcinr = bySym.get('BTCINR');
  const xrpinr = bySym.get('XRPINR');
  const dogeinr = bySym.get('DOGEINR');
  assert(btcinr && xrpinr && dogeinr, 'a market the catalogue check needs is missing from the fixture');

  // ------------------------------------------------ 1. the enum is closed and sane
  assert(Array.isArray(REFUSAL_CODES) && REFUSAL_CODES.length >= 15,
    `expected a catalogue of at least 15 codes, got ${REFUSAL_CODES.length}`);
  assert(new Set(REFUSAL_CODES).size === REFUSAL_CODES.length, 'a refusal code appears twice');
  for (const code of REFUSAL_CODES) {
    assert(/^[A-Z][A-Z0-9_]*$/.test(code), `refusal code ${code} is not SCREAMING_SNAKE_CASE`);
    assert(Object.prototype.hasOwnProperty.call(REFUSAL_TEMPLATES, code),
      `refusal code ${code} has no message template`);
  }
  assert(Object.keys(REFUSAL_TEMPLATES).length === REFUSAL_CODES.length,
    'the template table and the code list have drifted apart');

  // Every category member must actually be a code.
  for (const code of [...NUMERIC_REFUSALS, ...DETAIL_REFUSALS]) {
    assert(REFUSAL_CODES.includes(code), `${code} is categorised but is not in REFUSAL_CODES`);
  }
  // And no code may be in both categories, or the sentence would need both and
  // the category assertions below would contradict each other.
  for (const code of NUMERIC_REFUSALS) {
    assert(!DETAIL_REFUSALS.includes(code) || code === 'INSUFFICIENT_BALANCE_EITHER_CURRENCY',
      `${code} is categorised as both numeric and contextual`);
  }

  // ------------------------------------- 2. templates carry what they promise
  for (const code of REFUSAL_CODES) {
    const t = REFUSAL_TEMPLATES[code];
    assert(typeof t === 'string' && t.trim().length > 0, `${code}'s template is empty`);
    assert(t.trim().endsWith('.'), `${code}'s template is not a complete sentence: ${t}`);
    assert(!/\s{2,}/.test(t.replace(/\n\s*/g, ' ')), `${code}'s template has doubled whitespace`);
    // No placeholder outside the three the renderer knows about; a typo like
    // {value} would render literally and look like a bug to a customer.
    for (const m of t.matchAll(/\{(\w+)\}/g)) {
      assert(['offending', 'limit', 'detail'].includes(m[1]),
        `${code}'s template names an unknown placeholder {${m[1]}}`);
    }
  }

  // The T03.7 acceptance, stated exactly: no numeric template omits its numbers.
  for (const code of NUMERIC_REFUSALS) {
    const t = REFUSAL_TEMPLATES[code];
    assert(t.includes('{offending}'), `${code} is a numeric refusal but its template omits the offending value`);
    assert(t.includes('{limit}'), `${code} is a numeric refusal but its template omits the limit`);
  }
  for (const code of DETAIL_REFUSALS) {
    assert(REFUSAL_TEMPLATES[code].includes('{detail}'),
      `${code} is a contextual refusal but its template names no subject`);
  }

  // ---------------------------------------------- 3. rendering leaves no gaps
  for (const code of REFUSAL_CODES) {
    const full = refuse(code, {
      offending: '1.23', limit: '4.56', detail: 'SUBJECT', remedyCurrencies: ['INR'],
    });
    assert(full.code === code, `refuse(${code}) returned code ${full.code}`);
    assert(!/\{|\}/.test(full.message), `${code} rendered with a leftover placeholder: ${full.message}`);
    assert(!/\s{2,}/.test(full.message), `${code} rendered with doubled whitespace: ${full.message}`);
    assert(full.message.trim() === full.message, `${code} rendered with surrounding whitespace`);
    assert(full.message.length > 10, `${code} rendered suspiciously short: ${full.message}`);

    if (NUMERIC_REFUSALS.includes(code)) {
      assert(full.message.includes('1.23'), `${code} did not interpolate the offending value`);
      assert(full.message.includes('4.56'), `${code} did not interpolate the limit`);
      assert(full.offending === '1.23' && full.limit === '4.56',
        `${code} did not carry its numbers as fields as well as prose`);
    }
    if (DETAIL_REFUSALS.includes(code)) {
      assert(full.message.includes('SUBJECT'), `${code} did not interpolate its subject`);
    }
    // An omitted value must not leave a visible hole like "the quantity  is".
    const bare = refuse(code);
    assert(!/\{|\}/.test(bare.message), `${code} leaks a placeholder when given nothing: ${bare.message}`);
    assert(!/\s{2,}/.test(bare.message), `${code} leaves a doubled space when given nothing: ${bare.message}`);
    assert(bare.offending === undefined && bare.limit === undefined,
      `${code} invented numbers it was not given`);
  }

  // The remedy currencies survive, since that is the entire content of the
  // NO_MARKET_FOR_FUNDING_CURRENCY remedy (10 F3).
  const remedy = refuse('NO_MARKET_FOR_FUNDING_CURRENCY', { detail: 'USDT', remedyCurrencies: ['USDT'] });
  assert(Array.isArray(remedy.remedyCurrencies) && remedy.remedyCurrencies[0] === 'USDT',
    'remedyCurrencies did not survive construction');

  // ------------------------------------------------- 4. every code is reachable
  const produced = new Map();
  const record = (out, label) => {
    assert(out.ok === undefined && typeof out.code === 'string', `${label} did not refuse: ${JSON.stringify(out)}`);
    assert(REFUSAL_CODES.includes(out.code), `${label} produced ${out.code}, which is not in the catalogue`);
    assert(typeof out.message === 'string' && out.message.length > 0, `${label} refused with no sentence`);
    assert(!/\{|\}/.test(out.message), `${label} refused with an unrendered placeholder: ${out.message}`);
    if (!produced.has(out.code)) produced.set(out.code, { label, out });
    return out;
  };

  const marketBuy = (bp) => ({ asset: 'BTC', side: 'buy', mode: 'pct_allocated', orderType: 'market', percent: { basisPoints: bp } });

  // --- resolution refusals
  record(resolveMarket('NOTATHING', balances('1000000', '100000000'), rules), 'an asset no market lists');

  const usdtOnly = rules.find((r) => r.market.quote === 'USDT'
    && !rules.some((o) => o.market.asset === r.market.asset && o.market.quote === 'INR'));
  assert(usdtOnly !== undefined, 'expected a USDT-only asset in the fixture');
  record(resolveMarket(usdtOnly.market.asset, balances('1000000', '0'), rules),
    'a USDT-only asset for an INR-funded account');

  const halted = { ...btcinr, tradable: false };
  record(resolveMarket('BTC', balances('1000000', '100000000'), [halted]), 'an asset whose only market is halted');

  // Funded in both, but neither currency holds the minimum order value. BTC is
  // listed in both INR and USDT, so there is a real choice and both fail.
  const btcusdt = bySym.get('BTCUSDT');
  assert(btcusdt !== undefined, 'BTCUSDT is missing from the fixture');
  record(resolveMarket('BTC', balances('1', '1'), [btcinr, btcusdt]),
    'both currencies funded, neither affordable');

  // --- legalisation refusals
  record(legalise({ rules: halted, side: 'buy', orderType: 'market', quantity: { v: 1n, scale: 5 }, price: { v: 80774761n, scale: 1 } }),
    'a halted market');
  record(legalise({
    rules: btcinr, side: 'buy', orderType: 'market', exitOnly: true,
    quantity: { v: 246n, scale: 5 }, price: { v: 80774761n, scale: 1 },
  }), 'a buy into an exit-only market');

  const limitOnly = rules.find((r) => !r.allowedTypes.includes('market'));
  assert(limitOnly !== undefined, 'expected a limit-only market in the fixture');
  record(size({
    intent: { asset: limitOnly.market.asset, side: 'buy', mode: 'pct_allocated', orderType: 'market', percent: { basisPoints: 2000 } },
    rules: limitOnly, price: limitOnly.minPrice, priceSource: 'ask', allocatedCapitalMinor: '100000000',
  }), 'a market order on a limit-only market');

  // BELOW_MIN_QTY needs a market whose effective minimum exceeds its step, or
  // every positive step multiple would already clear it. XRPINR is exactly that
  // case: min_quantity 1 against a step of 0.1.
  record(size({
    intent: { asset: 'XRP', side: 'buy', mode: 'base_quantity', orderType: 'market', baseQuantity: '0.5' },
    rules: xrpinr, price: '145.66', priceSource: 'ask',
  }), 'half an XRP against a one-XRP minimum');

  record(size({
    intent: { asset: 'BTC', side: 'buy', mode: 'base_quantity', orderType: 'limit', baseQuantity: '3', limitPrice: BTCINR_ASK },
    rules: btcinr, price: BTCINR_ASK, priceSource: 'limit',
  }), '3 BTC against a 2 BTC ceiling');

  record(size({ intent: marketBuy(2000), rules: btcinr, price: BTCINR_ASK, priceSource: 'ask', allocatedCapitalMinor: '100000000' }),
    'the Rs 10 lakh account at 20% (the 09 F7 row 3 refusal)');
  record(size({ intent: marketBuy(2000), rules: btcinr, price: BTCINR_ASK, priceSource: 'ask', allocatedCapitalMinor: '50000' }),
    'the Rs 500 account at 20% (the 09 F7 row 4 refusal)');

  record(size({
    intent: { asset: 'BTC', side: 'buy', mode: 'base_quantity', orderType: 'limit', baseQuantity: '0.001', limitPrice: '1000000' },
    rules: btcinr, price: '1000000', priceSource: 'limit',
  }), 'a limit price below the market floor');

  record(size({
    intent: { asset: 'DOGE', side: 'buy', mode: 'quote_amount', orderType: 'market', quoteAmountMinor: '100' },
    rules: dogeinr, price: '8.872', priceSource: 'ask',
  }), 'Rs 1 of DOGE, which floors to zero whole DOGE');

  // Deliberately inside the 0.0158 market-order cap: at 1 BTC this refuses as
  // ABOVE_MAX_QTY_MARKET instead, which would prove nothing about the holding
  // gate and would leave INSUFFICIENT_HOLDING unreached.
  record(size({
    intent: { asset: 'BTC', side: 'sell', mode: 'base_quantity', orderType: 'market', baseQuantity: '0.01' },
    rules: btcinr, price: BTCINR_ASK, priceSource: 'bid', positionQuantity: '0.005',
  }), 'selling 0.01 BTC while holding 0.005');

  record(size({
    intent: { asset: 'BTC', side: 'buy', mode: 'base_quantity', orderType: 'market', baseQuantity: '0.001' },
    rules: btcinr, price: BTCINR_ASK, priceSource: 'ask', availableQuoteMinor: '10000',
  }), 'a buy larger than the free balance');

  record(size({ intent: marketBuy(2000), rules: btcinr, price: BTCINR_ASK, priceSource: 'ask' }),
    'a percentage with no basis supplied');

  // The sweep's payoff: name every code that no real path produced.
  for (const code of REFUSAL_CODES) {
    if (KNOWN_UNREACHABLE.has(code)) {
      assert(!produced.has(code),
        `${code} is documented as unreachable but was just produced — remove it from KNOWN_UNREACHABLE`);
      continue;
    }
    assert(produced.has(code),
      `${code} is in the catalogue but no real call produced it — it is either dead or its path is untested`);
  }

  // Each of the reachable numeric refusals must arrive with its numbers filled
  // in from real data, not merely be capable of it in the template.
  for (const code of NUMERIC_REFUSALS) {
    if (KNOWN_UNREACHABLE.has(code) || !produced.has(code)) continue;
    const { label, out } = produced.get(code);
    assert(typeof out.offending === 'string' && out.offending.length > 0,
      `${code} (${label}) refused without the offending value`);
    assert(typeof out.limit === 'string' && out.limit.length > 0,
      `${code} (${label}) refused without the limit`);
    assert(out.message.includes(out.offending),
      `${code} (${label}) carries offending ${out.offending} but its sentence omits it`);
    assert(out.message.includes(out.limit),
      `${code} (${label}) carries limit ${out.limit} but its sentence omits it`);
    // Both figures must be exact decimal strings — no float notation, no units
    // glued on, because these fields are read by machines as well as people.
    assert(/^-?\d+(\.\d+)?$/.test(out.offending), `${code} offending is not a plain decimal: ${out.offending}`);
    assert(/^-?\d+(\.\d+)?(\.\.-?\d+(\.\d+)?)?$/.test(out.limit),
      `${code} limit is not a plain decimal or range: ${out.limit}`);
  }

  const reached = REFUSAL_CODES.filter((c) => produced.has(c)).length;
  console.log(`     ${REFUSAL_CODES.length} codes, ${reached} reached by a real call,`
    + ` ${KNOWN_UNREACHABLE.size} reserved (${[...KNOWN_UNREACHABLE].join(', ')})`);
}
