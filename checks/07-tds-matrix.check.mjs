// 07-tds-matrix — plan/phase-07 T07.3.
//
// Decomposition row counts per the 11 F4 matrix: 0% TDS on an INR buy, 1% on an
// INR sell, 1% on BOTH legs of a C2C (USDT) trade. TDS rows are always estimated.
// 0.1 BTC @ 8,000,000 INR: notional = 800,000 INR = 80,000,000 paise; 1% TDS =
// 800,000 paise. A C2C 0.1 BTC @ 100,000 USDT: notional 10,000 USDT = 1e12 minor
// (scale 8); 1% = 1e10 minor.

import { decomposeFill, tdsBpOf } from '../packages/ledger/dist/index.js';

const base = (side, quote, price) => ({
  exchangeTradeId: 't1', side, asset: 'BTC', quote, qty: '0.1', price, feeMinor: '0',
  assetScale: 8, occurredAtMs: 1000, seq: 1,
});

export async function run(assert) {
  // INR buy: three rows, NO tds.
  const inrBuy = decomposeFill(base('buy', 'INR', '8000000'));
  assert(inrBuy.length === 3, `an INR buy must write 3 rows, got ${inrBuy.length}`);
  assert(!inrBuy.some((r) => r.kind === 'tds'), 'an INR buy must carry no TDS row');
  assert(tdsBpOf('buy', 'INR') === 0, 'the matrix must be 0% on an INR buy');

  // C2C buy: four rows, tds estimated.
  const c2cBuy = decomposeFill(base('buy', 'USDT', '100000'));
  assert(c2cBuy.length === 4, `a C2C buy must write 4 rows, got ${c2cBuy.length}`);
  const c2cTds = c2cBuy.find((r) => r.kind === 'tds');
  assert(c2cTds !== undefined, 'a C2C buy must carry a TDS row');
  assert(c2cTds.estimated === true, 'TDS rows must be estimated');
  assert(c2cTds.tdsMinor === '10000000000', `C2C 1% TDS must be 1e10 minor, got ${c2cTds.tdsMinor}`);
  assert(tdsBpOf('buy', 'USDT') === 100 && tdsBpOf('sell', 'USDT') === 100, '1% on both C2C legs');

  // INR sell: four rows, TDS 1% of 800,000 INR = 800,000 paise.
  const inrSell = decomposeFill(base('sell', 'INR', '8000000'));
  assert(inrSell.length === 4, `an INR sell must write 4 rows, got ${inrSell.length}`);
  const sellTds = inrSell.find((r) => r.kind === 'tds');
  assert(sellTds !== undefined && sellTds.tdsMinor === '800000', `INR sell 1% TDS must be 800,000 paise, got ${sellTds?.tdsMinor}`);

  // The asset leg carries the signed quantity; the cash leg the opposite notional.
  const leg = inrBuy.find((r) => r.kind === 'trade_buy');
  assert(leg !== undefined && leg.asset === 'BTC' && leg.deltaMinor === '10000000', 'the asset leg must carry 0.1 BTC as minor units');
  const cash = inrBuy.find((r) => r.kind === 'trade_sell');
  assert(cash !== undefined && cash.asset === 'INR' && cash.deltaMinor === '-80000000', 'the cash leg must carry −800,000 INR');
}
