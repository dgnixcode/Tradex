// 01-market-rules — plan/phase-01 T01.4.
//
// Maps the captured live markets_details response (997 markets) through the
// adapter and asserts the invariants the sizing layer will depend on. This is
// the check 18 F4 calls for: real data, not tidy invented data, because the
// pathological cases are all real ones.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  indexByAsset, mapMarketsDetails, parseDecimalJson, toMinorUnits,
} from '../packages/exchange-coindcx/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'markets_details.json'), 'utf8');

export async function run(assert) {
  // ------------------------------------------- decimal-safe parsing comes first
  const raw = parseDecimalJson(fixture);
  assert(Array.isArray(raw), 'fixture did not parse to an array');
  assert(raw.length > 900, `expected >900 markets in the fixture, got ${raw.length}`);

  // The parser must NOT have produced JS numbers anywhere.
  let numberCount = 0;
  const walk = (v) => {
    if (typeof v === 'number') numberCount += 1;
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(raw);
  assert(numberCount === 0, `${numberCount} values were parsed as JS numbers — precision was destroyed`);

  // A value JSON.parse would round must survive exactly.
  const wide = raw.find((m) => typeof m['max_quantity_market'] === 'string'
    && m['max_quantity_market'].replace(/^\d+\./, '').length >= 7);
  assert(wide !== undefined, 'no high-precision max_quantity_market found to test against');
  const asText = fixture.includes(`"max_quantity_market":${wide['max_quantity_market']}`);
  assert(asText, `max_quantity_market ${wide['max_quantity_market']} does not match the raw response text exactly`);

  // ---------------------------------------------------------------- the mapping
  const { rules, skipped, rulesVersion } = mapMarketsDetails(fixture, 'fixture-v1');
  assert(rulesVersion === 'fixture-v1', 'rulesVersion was not carried through');
  assert(rules.length > 800, `mapped only ${rules.length} markets`);
  assert(rules.length + skipped.length === raw.length,
    `${rules.length} mapped + ${skipped.length} skipped != ${raw.length} rows — a market vanished`);

  // Everything skipped must be skipped for a stated, expected reason.
  for (const s of skipped) {
    assert(/unsupported quote currency (BTC|ETH|USDC|TRX)/.test(s.reason) || /no supported order type/.test(s.reason),
      `${s.symbol} skipped for an unexpected reason: ${s.reason}`);
  }
  assert(skipped.length > 0, 'expected some BTC/ETH-quoted markets to be skipped for v1');

  // ----------------------------------------------- per-market invariants, all of them
  const seenSymbols = new Set();
  for (const r of rules) {
    assert(!seenSymbols.has(r.venueSymbol), `duplicate venueSymbol ${r.venueSymbol}`);
    seenSymbols.add(r.venueSymbol);

    assert(r.market.quote === 'INR' || r.market.quote === 'USDT',
      `${r.venueSymbol} mapped to unsupported quote ${r.market.quote}`);
    assert(r.market.asset.length > 0, `${r.venueSymbol} has an empty asset`);
    assert(Number.isInteger(r.quantityPrecision) && r.quantityPrecision >= 0,
      `${r.venueSymbol} quantityPrecision is ${r.quantityPrecision}`);
    assert(Number.isInteger(r.pricePrecision) && r.pricePrecision >= 0,
      `${r.venueSymbol} pricePrecision is ${r.pricePrecision}`);
    assert(/^\d+(\.\d+)?$/.test(r.quantityStep), `${r.venueSymbol} step is not a plain decimal: ${r.quantityStep}`);
    assert(/^\d+$/.test(r.minNotionalMinor), `${r.venueSymbol} minNotionalMinor is not an integer: ${r.minNotionalMinor}`);
    assert(r.allowedTypes.length > 0, `${r.venueSymbol} has no allowed order type`);
    for (const t of r.allowedTypes) assert(t === 'limit' || t === 'market', `${r.venueSymbol} has type ${t}`);
    assert(r.venueCode.length > 0, `${r.venueSymbol} has no venueCode`);
    assert(r.rulesVersion === 'fixture-v1', `${r.venueSymbol} lost its rulesVersion`);
    // No JS numbers in the decimal fields.
    for (const f of ['quantityStep', 'minQuantity', 'maxQuantity', 'minPrice', 'maxPrice', 'minNotionalMinor']) {
      assert(typeof r[f] === 'string', `${r.venueSymbol}.${f} is ${typeof r[f]}, must be a string`);
    }
  }

  // --------------------------------------------- the four markets 09 F6 measured
  const bySymbol = new Map(rules.map((r) => [r.venueSymbol, r]));

  const btcinr = bySymbol.get('BTCINR');
  assert(btcinr !== undefined, 'BTCINR is missing');
  assert(btcinr.market.quote === 'INR', 'BTCINR quote should be INR');
  assert(btcinr.quantityPrecision === 5, `BTCINR quantityPrecision is ${btcinr.quantityPrecision}, expected 5`);
  assert(btcinr.pricePrecision === 1, `BTCINR pricePrecision is ${btcinr.pricePrecision}, expected 1`);
  assert(btcinr.minNotionalMinor === '10000',
    `BTCINR minNotional should be Rs 100 = 10000 paise, got ${btcinr.minNotionalMinor}`);
  assert(btcinr.maxMarketQuantity !== null, 'BTCINR must expose max_quantity_market');
  assert(Number(btcinr.maxMarketQuantity) < Number(btcinr.maxQuantity),
    `max_quantity_market ${btcinr.maxMarketQuantity} should be far below max_quantity ${btcinr.maxQuantity}`);
  assert(btcinr.minMarketQuantity === null,
    'min_market_orders_qty is documented but absent live — it must map to null, not 0');

  // DOGEINR is the market that proves the effective minimum is a MAXIMUM.
  const doge = bySymbol.get('DOGEINR');
  assert(doge !== undefined, 'DOGEINR is missing');
  assert(doge.quantityPrecision === 0, `DOGEINR precision is ${doge.quantityPrecision}, expected 0`);
  assert(doge.quantityStep === '1', `DOGEINR step is ${doge.quantityStep}, expected 1`);
  assert(Number(doge.minQuantity) < 1,
    `DOGEINR min_quantity is ${doge.minQuantity}; the point of this case is that it is BELOW the real floor of 1`);

  const btcusdt = bySymbol.get('BTCUSDT');
  assert(btcusdt !== undefined, 'BTCUSDT is missing');
  assert(btcusdt.market.quote === 'USDT', 'BTCUSDT quote should be USDT');
  assert(btcusdt.minNotionalMinor === '500000000',
    `BTCUSDT minNotional should be 5 USDT = 500000000 at scale 8, got ${btcusdt.minNotionalMinor}`);

  // --------------------------------------- market coverage matches 10 F1's finding
  const index = indexByAsset(rules);
  const inrAssets = new Set(rules.filter((r) => r.market.quote === 'INR').map((r) => r.market.asset));
  const usdtAssets = new Set(rules.filter((r) => r.market.quote === 'USDT').map((r) => r.market.asset));
  const both = [...inrAssets].filter((a) => usdtAssets.has(a));
  const usdtOnly = [...usdtAssets].filter((a) => !inrAssets.has(a));

  assert(index.size === new Set([...inrAssets, ...usdtAssets]).size, 'the asset index lost or duplicated an asset');
  assert(inrAssets.size > 250, `only ${inrAssets.size} INR assets — expected 300+`);
  assert(usdtAssets.size > 500, `only ${usdtAssets.size} USDT assets — expected 600+`);
  assert(both.length > 250, `only ${both.length} assets on both quotes`);
  assert(usdtOnly.length > 200,
    `only ${usdtOnly.length} USDT-only assets; 10 F1 found 310, and skipping being NORMAL is the design premise`);
  assert(usdtOnly.length > inrAssets.size - both.length,
    'expected far more USDT-only assets than INR-only ones');

  // BTC must resolve to both books, which is what makes 10 F3 necessary.
  const btc = index.get('BTC');
  assert(btc !== undefined && btc.length >= 2, 'BTC should resolve to at least two markets');
  assert(new Set(btc.map((r) => r.market.quote)).size >= 2, 'BTC should be tradable on both INR and USDT');

  // venueCode segmentation — failures cluster by venue (10 F2).
  const venues = new Set(rules.map((r) => r.venueCode));
  assert(venues.size >= 2, `expected several venue codes, found ${[...venues].join(',')}`);
  assert(venues.has('I'), "CoinDCX's own INR book (ecode 'I') is missing");

  // ------------------------------------------------------- minor-unit conversion
  assert(toMinorUnits('100', 2) === '10000', 'Rs 100 should be 10000 paise');
  assert(toMinorUnits('5', 8) === '500000000', '5 USDT should be 500000000 at scale 8');
  assert(toMinorUnits('0.01', 2) === '1', '1 paisa');
  assert(toMinorUnits('19870.59', 2) === '1987059', 'Rs 19870.59');
  let refused = false;
  try { toMinorUnits('0.001', 2); } catch { refused = true; }
  assert(refused, 'converting Rs 0.001 to paise must refuse rather than truncate a limit silently');
}
