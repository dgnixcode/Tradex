// 07-ledger-fold — plan/phase-07 T07.2/T07.4 (L1, L6, L7, L8), pure.
//
// The fold is the books. These assertions pin the properties that make it safe to
// trade against:
//   - a hand-computed three-trade sequence reproduces realised P&L to the paisa;
//   - cost_total is zero exactly when qty is zero (L6);
//   - TDS never touches basis, proceeds or realised — only tds_withheld moves (L7);
//   - a conversion produces ZERO realised P&L (L8);
//   - replaying the same rows always gives the same projection (L1).

import { foldLedger } from '../packages/ledger/dist/index.js';

let seq = 0;
const T = (o) => { seq += 1; return { occurredAtMs: 1000 + seq, seq, ...o }; };
const BUY = (id, delta, price, fee, tds) => [
  T({ exchangeTradeId: id, kind: 'trade_buy', asset: 'BTC', quoteAsset: 'INR', deltaMinor: String(delta), scale: 8, price }),
  ...(fee !== null ? [T({ exchangeTradeId: id, kind: 'fee', asset: 'INR', quoteAsset: 'INR', deltaMinor: '0', scale: 2, price: null, feeMinor: String(fee), tdsMinor: null })] : []),
  ...(tds !== null ? [T({ exchangeTradeId: id, kind: 'tds', asset: 'INR', quoteAsset: 'INR', deltaMinor: '0', scale: 2, price: null, feeMinor: null, tdsMinor: String(tds), estimated: true })] : []),
];
const SELL = (id, delta, price, fee, tds) => [
  T({ exchangeTradeId: id, kind: 'trade_sell', asset: 'BTC', quoteAsset: 'INR', deltaMinor: String(delta), scale: 8, price }),
  ...(fee !== null ? [T({ exchangeTradeId: id, kind: 'fee', asset: 'INR', quoteAsset: 'INR', deltaMinor: '0', scale: 2, price: null, feeMinor: String(fee), tdsMinor: null })] : []),
  ...(tds !== null ? [T({ exchangeTradeId: id, kind: 'tds', asset: 'INR', quoteAsset: 'INR', deltaMinor: '0', scale: 2, price: null, feeMinor: null, tdsMinor: String(tds), estimated: true })] : []),
];

export async function run(assert) {
  // 0.1 BTC bought @ 8,000,000 (fee 200 INR), 0.05 sold @ 8,100,000 (fee 150, TDS 1%
  // of 405,000 INR = 4,050 INR), 0.05 sold @ 8,200,000 (fee 150, no TDS).
  const rows = [
    ...BUY('b1', 10_000_000, '8000000', 20_000, null),
    ...SELL('s1', -5_000_000, '8100000', 15_000, 405_000),
    ...SELL('s2', -5_000_000, '8200000', 15_000, null),
  ];
  const h = foldLedger(rows);
  const btc = h.find((x) => x.asset === 'BTC');
  assert(btc !== undefined, 'a holding for BTC must exist');
  assert(btc.qty === '0', `after selling all, qty must be 0, got ${btc.qty}`);
  assert(btc.costTotalMinor === '0', `cost must reset to zero when qty is zero (L6), got ${btc.costTotalMinor}`);
  // realised: (405000 + 410000) − (400100 + 400100) − (150+150) = 14500 INR = 1,450,000 paise
  assert(btc.realisedMinor === '1450000', `realised must be 14,500.00 INR to the paisa, got ${btc.realisedMinor}`);
  assert(btc.feeDragMinor === '30000', `exit-fee drag must be 300 INR, got ${btc.feeDragMinor}`);
  assert(btc.tdsWithheldMinor === '405000', `TDS withheld must be 4,050 INR, got ${btc.tdsWithheldMinor}`);

  // ---- L7: adding a TDS row to a trade must move ONLY tds_withheld.
  const withTds = foldLedger([...BUY('b1', 10_000_000, '8000000', 20_000, 50_000), ...SELL('s2', -5_000_000, '8200000', 15_000, null)]);
  const withoutTds = foldLedger([...BUY('b1', 10_000_000, '8000000', 20_000, null), ...SELL('s2', -5_000_000, '8200000', 15_000, null)]);
  const a = withTds.find((x) => x.asset === 'BTC');
  const b = withoutTds.find((x) => x.asset === 'BTC');
  assert(a.realisedMinor === b.realisedMinor, 'L7: TDS must not change realised P&L');
  assert(a.costTotalMinor === b.costTotalMinor, 'L7: TDS must not change cost basis');
  assert(a.feeDragMinor === b.feeDragMinor, 'L7: TDS must not change the fee drag');
  assert(a.tdsWithheldMinor === String(BigInt(b.tdsWithheldMinor) + 50_000n),
    'L7: TDS must land only in tds_withheld');

  // ---- L8: a conversion moves quantity/basis but realises ZERO.
  const conv = foldLedger([
    ...BUY('c1', 10_000_000, '8000000', 20_000, null),
    T({ exchangeTradeId: 'c2', kind: 'conversion_out', asset: 'BTC', quoteAsset: 'INR', deltaMinor: '-5000000', scale: 8, price: '8100000', feeMinor: null, tdsMinor: null }),
  ]);
  const hc = conv.find((x) => x.asset === 'BTC');
  assert(hc.realisedMinor === '0', `L8: a conversion must realise zero P&L, got ${hc.realisedMinor}`);
  assert(hc.qty === '0.05', `conversion must have left 0.05 BTC, got ${hc.qty}`);

  // ---- L1: replaying the same rows is deterministic.
  seq = 0;
  const again = foldLedger([...BUY('b1', 10_000_000, '8000000', 20_000, null), ...SELL('s1', -5_000_000, '8100000', 15_000, 405_000), ...SELL('s2', -5_000_000, '8200000', 15_000, null)]);
  const second = foldLedger(rows);
  assert(JSON.stringify(again) === JSON.stringify(second), 'L1: replaying the same rows must reproduce the projection exactly');
}
