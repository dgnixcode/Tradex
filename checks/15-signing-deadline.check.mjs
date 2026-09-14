// 15-signing-deadline — plan/phase-15 T15.4 (venue-side 10s window).
//
// Research/03 F4: "Orders with a delay of more than 10 seconds will be rejected."
// This is the venue's own last line — we DO defend earlier with SIGN_GUARD_MS on
// the client, but this check proves the venue itself enforces the rule even
// when our client thinks it has budget. That matters because clock skew, a
// paused container, or a bug in the client-side guard could otherwise send a
// stale body without our knowing; the venue's 400 is the last brake.

import { FakeVenue, SIGN_GUARD_MS, submitFuturesOrder, updateFuturesLeverage } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'sd-key-abcdef0123456789';
const SECRET = 'sd-secret-abcdef0123456789';

export async function run(assert) {
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();
    await updateFuturesLeverage(KEY, SECRET, { pair: 'B-BTC_USDT', marginCurrency: 'USDT', leverage: 5 }, { baseUrl: base });

    const realNow = Date.now();
    const place = (nowMs, deadlineMs) => submitFuturesOrder(KEY, SECRET, {
      pair: 'B-BTC_USDT', side: 'buy', orderType: 'market',
      quantity: '0.01', leverage: 5, marginCurrency: 'USDT',
      positionMarginType: 'isolated', reduceOnly: false,
      deadlineMs,
    }, { baseUrl: base, nowMs: () => nowMs });

    // 1. Baseline — 8 s of budget, fresh signed body: accepted.
    const fresh = await place(realNow, realNow + 8_000);
    assert(fresh.kind === 'accepted', `a fresh signed body must be accepted, got ${JSON.stringify(fresh)}`);

    // 2. The client-side guard: a deadline within SIGN_GUARD_MS refuses BEFORE
    //    signing, so the venue never sees the request.
    const startingVenueCount = venue.futuresOrdersSnapshot().length;
    const tooClose = await place(realNow, realNow + Math.floor(SIGN_GUARD_MS / 2));
    assert(tooClose.kind === 'refused_deadline',
      `a deadline within SIGN_GUARD_MS must refuse, got ${JSON.stringify(tooClose)}`);
    assert(venue.futuresOrdersSnapshot().length === startingVenueCount,
      'the venue must NOT have seen a refused-to-sign request');

    // 3. The venue-side 10 s rule (the check's whole point). Simulate a body
    //    signed 15 s in the "past" by driving the client's clock backwards; the
    //    client guard sees budget (deadline 8s after its fake now) but the
    //    venue's real clock sees a stamped timestamp 15 s stale ⇒ 400.
    const pastNow = realNow - 15_000;
    const stale = await place(pastNow, pastNow + 8_000);
    assert(stale.kind === 'rejected',
      `a 15s-stale signed body must be rejected by the venue, got ${JSON.stringify(stale)}`);
    if (stale.kind === 'rejected') {
      assert(stale.failure.detail !== undefined && /10 seconds/i.test(stale.failure.detail ?? ''),
        `the failure detail must cite the 10-second rule, got ${JSON.stringify(stale.failure)}`);
    }

    // 4. 8-second-old timestamp still lands (inside the venue window).
    const eightAgo = realNow - 8_000;
    const nearlyStale = await place(eightAgo, eightAgo + 8_500);
    assert(nearlyStale.kind === 'accepted',
      `an 8s-old signed body must still be accepted, got ${JSON.stringify(nearlyStale)}`);

    // 5. Exactly at the boundary — 10s + a few ms — still gets 400.
    const tenPlus = realNow - 10_500;
    const boundary = await place(tenPlus, tenPlus + 8_500);
    assert(boundary.kind === 'rejected',
      `a 10.5s-old signed body must be rejected, got ${JSON.stringify(boundary)}`);
  } finally {
    await venue.stop();
  }
}
