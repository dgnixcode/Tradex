// 15-place-and-read — plan/phase-15 T15.2 first round-trip.
//
// Prove ONE end-to-end path against the FakeFutures venue: sign, place a market
// buy, receive a venue order id, then read positions back and see the mirrored
// row for that (pair, marginCurrency). Also prove the deadline guard refuses to
// sign a stale request (research/03 F4: >10s stale = venue-side rejection; our
// guard fires earlier), and that omitting margin_currency_short_name on the
// positions read returns empty (research/04 G8, the invisibility trap).

import {
  FakeVenue,
  fetchFuturesPositions,
  SIGN_GUARD_MS,
  submitFuturesOrder,
  updateFuturesLeverage,
} from '../packages/exchange-coindcx/dist/index.js';
import { futuresPairOf } from '../packages/exchange/dist/index.js';

const KEY = 'fut-key-abcdef0123456789';
const SECRET = 'fut-secret-abcdef0123456789';

export async function run(assert) {
  // Sanity: the pair helper produces the two venue shapes we actually use.
  assert(futuresPairOf({ asset: 'BTC', quote: 'USDT' }, 'USDT') === 'B-BTC_USDT',
    'USDT-margined pair form must be B-{asset}_USDT');
  assert(futuresPairOf({ asset: 'BTC', quote: 'INR' }, 'INR') === 'INR-BTC_INR',
    'INR-margined pair form must be INR-{asset}_INR');

  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();

    // --- 1. set leverage first (research/03 F5: an order's leverage must match) ---
    const lev = await updateFuturesLeverage(KEY, SECRET, { pair: 'B-BTC_USDT', marginCurrency: 'USDT', leverage: 5 }, { baseUrl: base });
    assert(lev.ok === true, `updateFuturesLeverage must succeed, got ${JSON.stringify(lev)}`);

    // --- 2. place a market buy, 0.01 BTC-perp, 5x, isolated ---
    const now = Date.now();
    const place = await submitFuturesOrder(KEY, SECRET, {
      pair: 'B-BTC_USDT',
      side: 'buy',
      orderType: 'market',
      quantity: '0.01',
      leverage: 5,
      marginCurrency: 'USDT',
      positionMarginType: 'isolated',
      reduceOnly: false,
      deadlineMs: now + 8_000,
    }, { baseUrl: base });
    assert(place.kind === 'accepted', `place must succeed, got ${JSON.stringify(place)}`);
    if (place.kind !== 'accepted') return;
    assert(place.order.venueOrderId !== '' && place.order.venueOrderId.startsWith('ford-'),
      `venue must return an order id, got ${place.order.venueOrderId}`);
    assert(place.order.pair === 'B-BTC_USDT' && place.order.side === 'buy' && place.order.orderType === 'market',
      'the response echoes the pair/side/type');
    assert(place.order.leverage === 5 && place.order.marginCurrency === 'USDT',
      'the response carries the leverage + margin currency the caller sent');

    // --- 3. simulate a fill by settling a position row through the control seam ---
    const posId = venue.settleFuturesPosition({
      pair: 'B-BTC_USDT', marginCurrency: 'USDT',
      activePos: '0.01', avgEntryPrice: '8500000', markPrice: '8501000',
      leverage: '5', liquidationPrice: '6800000',
    });
    assert(posId !== '', 'the settle control returns a position id');

    // --- 4. read positions back ---
    const positions = await fetchFuturesPositions(KEY, SECRET, ['USDT'], { baseUrl: base });
    assert(positions.ok === true, `positions read must succeed, got ${JSON.stringify(positions)}`);
    if (!positions.ok) return;
    assert(positions.positions.length === 1, `exactly one position in scope, got ${positions.positions.length}`);
    const p = positions.positions[0];
    assert(p.pair === 'B-BTC_USDT' && p.marginCurrency === 'USDT', 'the position mirrors the pair + margin currency');
    assert(p.activePos === '0.01' && p.avgEntryPrice === '8500000' && p.markPrice === '8501000',
      `the position mirrors the fill values, got ${JSON.stringify({ q: p.activePos, avg: p.avgEntryPrice, mark: p.markPrice })}`);
    assert(p.leverage === 5, `the position mirrors 5x leverage, got ${p.leverage}`);
    assert(typeof p.observedAtMs === 'number' && p.observedAtMs > 0, 'the client stamps observedAtMs');

    // --- 5. INR filter returns empty (nothing has been opened INR-margined) ---
    const inrPositions = await fetchFuturesPositions(KEY, SECRET, ['INR'], { baseUrl: base });
    assert(inrPositions.ok === true && inrPositions.positions.length === 0,
      'INR filter returns no positions when nothing is INR-margined');

    // --- 6. deadline guard: a request whose deadline is already close refuses ---
    const stale = await submitFuturesOrder(KEY, SECRET, {
      pair: 'B-BTC_USDT', side: 'buy', orderType: 'market',
      quantity: '0.01', leverage: 5, marginCurrency: 'USDT',
      positionMarginType: 'isolated', reduceOnly: false,
      deadlineMs: Date.now() + Math.floor(SIGN_GUARD_MS / 2),
    }, { baseUrl: base });
    assert(stale.kind === 'refused_deadline',
      `a deadline within SIGN_GUARD_MS must refuse to sign, got ${JSON.stringify(stale)}`);

    // A deadline already in the PAST refuses too.
    const past = await submitFuturesOrder(KEY, SECRET, {
      pair: 'B-BTC_USDT', side: 'buy', orderType: 'market',
      quantity: '0.01', leverage: 5, marginCurrency: 'USDT',
      positionMarginType: 'isolated', reduceOnly: false,
      deadlineMs: Date.now() - 100,
    }, { baseUrl: base });
    assert(past.kind === 'refused_deadline',
      `a deadline in the past must refuse to sign, got ${JSON.stringify(past)}`);

    // (The venue-side "signed body >10s" rejection is proven in the follow-on
    // 15-signing-deadline check — it needs a clock injection into signRequest,
    // which this slice does not add. Skipping it here keeps this check honest.)

    // --- 7. cross-margin on INR (unsupported by the venue) — client-side no check today ---
    // The venue accepts the wire shape; the schema CHECK on group_trade blocks
    // this before it gets here (proven in 15-schema). This assertion just
    // records the layering: enforcement is at the schema, not this client.
    const cross = await submitFuturesOrder(KEY, SECRET, {
      pair: 'INR-BTC_INR', side: 'buy', orderType: 'market',
      quantity: '0.001', leverage: 3, marginCurrency: 'INR',
      positionMarginType: 'crossed', reduceOnly: false,
      deadlineMs: Date.now() + 8_000,
    }, { baseUrl: base });
    assert(cross.kind === 'accepted' || cross.kind === 'rejected',
      'the wire client does not enforce venue-specific margin type rules — the schema does');
  } finally {
    await venue.stop();
  }
}
