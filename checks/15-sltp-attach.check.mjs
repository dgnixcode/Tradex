// 15-sltp-attach — plan/phase-15 T15.5 (stop-loss + take-profit attach).
//
// Research/04 F12: `positions/create_tpsl` accepts SL alone, TP alone, or both.
// It is NOT an upsert — attaching a second SL to a position that already has
// one is a per-leg failure reported at HTTP 200 in the same body:
//
//   {"stop_loss":{...ORDER...},"take_profit":{"success":false,"error":"TP already exists"}}
//
// So the client MUST parse each leg separately; treating the whole response as
// pass/fail would silently miss half a bracket. This check drives that shape.

import {
  attachStopAndTake,
  FakeVenue,
  fetchFuturesPositions,
  submitFuturesOrder,
  updateFuturesLeverage,
} from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'sltp-key-abcdef0123456789';
const SECRET = 'sltp-secret-abcdef0123456789';

export async function run(assert) {
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();
    await updateFuturesLeverage(KEY, SECRET, { pair: 'B-BTC_USDT', marginCurrency: 'USDT', leverage: 5 }, { baseUrl: base });

    // Place + settle a synthetic position with a known id.
    const now = Date.now();
    const place = await submitFuturesOrder(KEY, SECRET, {
      pair: 'B-BTC_USDT', side: 'buy', orderType: 'market',
      quantity: '0.01', leverage: 5, marginCurrency: 'USDT',
      positionMarginType: 'isolated', reduceOnly: false,
      deadlineMs: now + 8_000,
    }, { baseUrl: base });
    assert(place.kind === 'accepted', 'entry order must place');

    const posId = venue.settleFuturesPosition({
      pair: 'B-BTC_USDT', marginCurrency: 'USDT',
      activePos: '0.01', avgEntryPrice: '8500000', markPrice: '8500000',
      leverage: '5',
    });
    assert(posId !== '', 'position exists after settle');

    // ---- 1. SL alone ----
    const slOnly = await attachStopAndTake(KEY, SECRET, {
      positionId: posId,
      stopLoss: { triggerPrice: '8000000', orderType: 'stop_market' },
    }, { baseUrl: base });
    assert(slOnly.ok === true, 'SL-only attach must succeed');
    if (slOnly.ok) {
      assert(slOnly.stopLoss?.ok === true, `SL leg must succeed, got ${JSON.stringify(slOnly.stopLoss)}`);
      assert(slOnly.takeProfit === undefined, 'TP must be absent when not requested');
    }

    // Position now carries the SL trigger.
    const afterSl = await fetchFuturesPositions(KEY, SECRET, ['USDT'], { baseUrl: base });
    assert(afterSl.ok === true && afterSl.positions[0]?.stopLossTrigger === '8000000',
      `stop_loss_trigger must be mirrored on the position after attach, got ${afterSl.ok && afterSl.positions[0]?.stopLossTrigger}`);

    // ---- 2. TP alone ----
    const tpOnly = await attachStopAndTake(KEY, SECRET, {
      positionId: posId,
      takeProfit: { triggerPrice: '9000000', orderType: 'take_profit_market' },
    }, { baseUrl: base });
    assert(tpOnly.ok === true, 'TP-only attach must succeed');
    if (tpOnly.ok) {
      assert(tpOnly.takeProfit?.ok === true, `TP leg must succeed, got ${JSON.stringify(tpOnly.takeProfit)}`);
      assert(tpOnly.stopLoss === undefined, 'SL must be absent when not requested');
    }
    const afterTp = await fetchFuturesPositions(KEY, SECRET, ['USDT'], { baseUrl: base });
    assert(afterTp.ok === true && afterTp.positions[0]?.takeProfitTrigger === '9000000',
      `take_profit_trigger must be mirrored after attach, got ${afterTp.ok && afterTp.positions[0]?.takeProfitTrigger}`);

    // ---- 3. Duplicate SL: per-leg failure at HTTP 200 (the T15.5 crux) ----
    const dupSl = await attachStopAndTake(KEY, SECRET, {
      positionId: posId,
      stopLoss: { triggerPrice: '7900000', orderType: 'stop_market' },
    }, { baseUrl: base });
    assert(dupSl.ok === true, 'a per-leg failure is still HTTP 200 (call-level ok:true)');
    if (dupSl.ok) {
      assert(dupSl.stopLoss?.ok === false, `re-attaching SL must be a per-leg failure, got ${JSON.stringify(dupSl.stopLoss)}`);
      assert(/already exists/i.test(dupSl.stopLoss.ok === false ? dupSl.stopLoss.reason : ''),
        'the failure reason must cite that the leg already exists');
    }

    // ---- 4. Both together on a fresh position: one succeeds, one duplicates ----
    // Open a second position (different pair) and attach both at once.
    const posId2 = venue.settleFuturesPosition({
      pair: 'B-ETH_USDT', marginCurrency: 'USDT',
      activePos: '1', avgEntryPrice: '400000', markPrice: '400000', leverage: '5',
    });
    const both = await attachStopAndTake(KEY, SECRET, {
      positionId: posId2,
      stopLoss: { triggerPrice: '380000', orderType: 'stop_market' },
      takeProfit: { triggerPrice: '420000', orderType: 'take_profit_market' },
    }, { baseUrl: base });
    assert(both.ok === true, 'attach both must succeed at call level');
    if (both.ok) {
      assert(both.stopLoss?.ok === true && both.takeProfit?.ok === true,
        'both legs must succeed on a fresh position');
    }

    // ---- 5. Attaching to an unknown position is a call-level failure (400) ----
    const missing = await attachStopAndTake(KEY, SECRET, {
      positionId: 'pos-does-not-exist',
      stopLoss: { triggerPrice: '1', orderType: 'stop_market' },
    }, { baseUrl: base });
    assert(missing.ok === false, `unknown position must return call-level failure, got ${JSON.stringify(missing)}`);
  } finally {
    await venue.stop();
  }
}
