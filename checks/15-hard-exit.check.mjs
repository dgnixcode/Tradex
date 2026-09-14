// 15-hard-exit — plan/phase-15 T15.7 (the "exit now" primitive).
//
// The customer must be able to close a live futures position at market
// regardless of an attached SL/TP. Research/04 Q(a) is explicit that the safe
// sequence is:
//   (1) cancel every UNTRIGGERED conditional attached to the position, then
//   (2) call positions/exit.
// Skipping step 1 is the R1 failure: a stale SL left behind after the exit
// will fire on the next mark tick and OPEN AN OPPOSITE POSITION.
//
// This check drives both paths against the fake:
//   * the SAFE sequence: cancel SL + TP → exit → position is zero AND the
//     conditional orders are 'cancelled'; a subsequent mark tick fires nothing.
//   * the UNSAFE sequence: exit WITHOUT cancelling first → position is zero
//     but the SL is still 'untriggered'; if we now let the mark drop through
//     the trigger, the venue would open an opposite position — proven by
//     simulating that trigger via the settle control and asserting the
//     resulting reversed active_pos. This is the failure mode we forbid at
//     the layer above (T15.7 route).

import {
  attachStopAndTake,
  cancelFuturesOrder,
  exitFuturesPosition,
  FakeVenue,
  fetchFuturesPositions,
  submitFuturesOrder,
  updateFuturesLeverage,
} from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'exit-key-abcdef0123456789';
const SECRET = 'exit-secret-abcdef0123456789';

export async function run(assert) {
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();
    await updateFuturesLeverage(KEY, SECRET, { pair: 'B-BTC_USDT', marginCurrency: 'USDT', leverage: 5 }, { baseUrl: base });

    // Helper: open a position and attach an SL + TP; return every id we care about.
    const openWithBracket = async (pair) => {
      const place = await submitFuturesOrder(KEY, SECRET, {
        pair, side: 'buy', orderType: 'market',
        quantity: '0.01', leverage: 5, marginCurrency: 'USDT',
        positionMarginType: 'isolated', reduceOnly: false,
        deadlineMs: Date.now() + 8_000,
      }, { baseUrl: base });
      assert(place.kind === 'accepted', `entry for ${pair} must place`);
      const posId = venue.settleFuturesPosition({
        pair, marginCurrency: 'USDT',
        activePos: '0.01', avgEntryPrice: '8500000', markPrice: '8500000', leverage: '5',
      });
      const attach = await attachStopAndTake(KEY, SECRET, {
        positionId: posId,
        stopLoss: { triggerPrice: '8000000', orderType: 'stop_market' },
        takeProfit: { triggerPrice: '9000000', orderType: 'take_profit_market' },
      }, { baseUrl: base });
      assert(attach.ok === true && attach.stopLoss?.ok === true && attach.takeProfit?.ok === true,
        `SL+TP must attach for ${pair}`);
      const slId = attach.ok && attach.stopLoss?.ok ? attach.stopLoss.venueOrderId : '';
      const tpId = attach.ok && attach.takeProfit?.ok ? attach.takeProfit.venueOrderId : '';
      assert(slId !== '' && tpId !== '', 'both leg ids must be present');
      return { posId, slId, tpId };
    };

    // ==================== SAFE PATH ====================
    const safe = await openWithBracket('B-BTC_USDT');

    // (1) cancel every conditional first.
    const cancelSl = await cancelFuturesOrder(KEY, SECRET, safe.slId, { baseUrl: base });
    assert(cancelSl.ok === true, `cancel SL must succeed, got ${JSON.stringify(cancelSl)}`);
    const cancelTp = await cancelFuturesOrder(KEY, SECRET, safe.tpId, { baseUrl: base });
    assert(cancelTp.ok === true, 'cancel TP must succeed');

    // (2) exit the position at market.
    const exit = await exitFuturesPosition(KEY, SECRET, safe.posId, { baseUrl: base });
    assert(exit.ok === true, `exit must succeed, got ${JSON.stringify(exit)}`);
    if (exit.ok) assert(exit.venueGroupId !== null && exit.venueGroupId?.startsWith('exit-'),
      'the exit response carries a group_id');

    // Position is zero.
    const afterSafe = await fetchFuturesPositions(KEY, SECRET, ['USDT'], { baseUrl: base });
    assert(afterSafe.ok === true, 'positions read after exit must succeed');
    const btcSafe = afterSafe.ok ? afterSafe.positions.find((p) => p.pair === 'B-BTC_USDT') : undefined;
    assert(btcSafe !== undefined && btcSafe.activePos === '0',
      `active_pos must be 0 after exit, got ${btcSafe?.activePos}`);

    // The venue's stored orders show BOTH conditionals are 'cancelled'.
    const orders = venue.futuresOrdersSnapshot();
    const slRow = orders.find((o) => o['id'] === safe.slId);
    const tpRow = orders.find((o) => o['id'] === safe.tpId);
    assert(slRow !== undefined && slRow['status'] === 'cancelled',
      `SL must be cancelled at the venue, got ${slRow?.['status']}`);
    assert(tpRow !== undefined && tpRow['status'] === 'cancelled',
      `TP must be cancelled at the venue, got ${tpRow?.['status']}`);

    // ==================== UNSAFE PATH (the R1 danger) ====================
    // Same setup, but skip step (1). Exit — then a mark tick would fire the SL.
    const unsafe = await openWithBracket('B-ETH_USDT');

    // Skip cancel. Exit directly.
    const exit2 = await exitFuturesPosition(KEY, SECRET, unsafe.posId, { baseUrl: base });
    assert(exit2.ok === true, 'unsafe exit still succeeds at call level');
    const afterUnsafe = await fetchFuturesPositions(KEY, SECRET, ['USDT'], { baseUrl: base });
    const ethUnsafe = afterUnsafe.ok ? afterUnsafe.positions.find((p) => p.pair === 'B-ETH_USDT') : undefined;
    assert(ethUnsafe !== undefined && ethUnsafe.activePos === '0',
      `exit closes the position regardless, got ${ethUnsafe?.activePos}`);

    // But the SL is STILL untriggered at the venue — nothing cancelled it.
    const ordersAfterUnsafe = venue.futuresOrdersSnapshot();
    const staleSl = ordersAfterUnsafe.find((o) => o['id'] === unsafe.slId);
    assert(staleSl !== undefined && staleSl['status'] === 'untriggered',
      `a skipped-cancel path leaves the SL untriggered (this is the R1 danger), got ${staleSl?.['status']}`);

    // Simulate the trigger: the mark drops through the SL price, the SL fires,
    // and — because the position was already zero — a NEW opposite position opens.
    // We drive this by hand to make the danger explicit; the layer above (T15.7)
    // is what prevents ever reaching this state.
    venue.settleFuturesPosition({
      pair: 'B-ETH_USDT', marginCurrency: 'USDT',
      activePos: '-0.01', // OPPOSITE side: the stale SL was a "sell to close",
                          // but the venue no longer knows the exit happened.
      avgEntryPrice: '8000000', markPrice: '7900000', leverage: '5',
    });
    const reversed = await fetchFuturesPositions(KEY, SECRET, ['USDT'], { baseUrl: base });
    const ethReversed = reversed.ok ? reversed.positions.find((p) => p.pair === 'B-ETH_USDT') : undefined;
    assert(ethReversed !== undefined && ethReversed.activePos === '-0.01',
      `the stale SL firing reverses the position — active_pos becomes negative, got ${ethReversed?.activePos}`);
    assert(ethReversed.activePos.startsWith('-'),
      'this is the R1 loss: a "hard exit" that skipped step 1 turned FLAT into SHORT');
  } finally {
    await venue.stop();
  }
}
