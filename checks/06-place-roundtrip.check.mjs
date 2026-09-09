// 06-place-roundtrip — plan/phase-06 T06.5/T06.6, the send primitive over the
// FakeVenue (real signing, real HTTP, no network, no real key).
//
// The core claim of the phase: a send is never blind and never duplicated. This
// proves the four things that claim rests on —
//   - place returns `accepted` with an exchange_order_id, and the venue stored it
//     under our client_order_id;
//   - the SAME id resolves back to that order (the resolve primitive works);
//   - a duplicate client_order_id is a BUSINESS rejection — orderMayExist false,
//     retrySafe false, so it is NEVER re-sent;
//   - an ambiguous outcome (the response lost) is classified with orderMayExist
//     TRUE, and the worker then RESOLVES by coid rather than re-sending — which is
//     what makes a second order impossible.

import { FakeVenue, fetchOrderByClientId, submitOrder } from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'order-key-abcdef0123456789';
const SECRET = 'order-secret-abcdef0123456789';
const COID = 't' + 'a'.repeat(27);

export async function run(assert) {
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  const base = (await venue.start()).toString();
  try {
    // ------------------------------------------------ a clean send lands, signed
    const placed = await submitOrder(KEY, SECRET, {
      client_order_id: COID, side: 'buy', market_order: { market: 'BTCINR', side: 'buy', order_type: 'market_order', total_quantity: 1, price: 0 },
    }, { baseUrl: base });
    assert(placed.kind === 'accepted', `a valid order must be accepted, got ${placed.kind}`);
    if (placed.kind === 'accepted') {
      assert(placed.order.id !== '', 'an accepted order must carry an exchange_order_id');
      assert(placed.order.state.recognized === true && placed.order.state.state === 'open',
        'the fake should report the order as open');
    }
    const last = venue.requests[venue.requests.length - 1];
    assert(last.signatureValid === true, 'the create request must carry a valid signature');

    // ------------------------------------------------ resolve by the same id finds it
    const found = await fetchOrderByClientId(KEY, SECRET, COID, { baseUrl: base });
    assert(found.ok === true, 'resolving by client_order_id should succeed');
    if (found.ok) {
      assert(found.order !== null, 'the placed order must resolve');
      assert(found.order !== null && found.order.id === (placed.kind === 'accepted' ? placed.order.id : ''),
        'the resolved order must be the one that was placed');
    }

    // ------------------------------------------------ a duplicate coid is a business rejection
    const dupe = await submitOrder(KEY, SECRET, {
      client_order_id: COID, side: 'buy', market_order: { market: 'BTCINR', side: 'buy' },
    }, { baseUrl: base });
    assert(dupe.kind === 'rejected', 'a duplicate client_order_id must be rejected, not accepted');
    if (dupe.kind === 'rejected') {
      assert(dupe.failure.orderMayExist === false, 'a duplicate-coid rejection can never have created an order');
      assert(dupe.failure.retrySafe === false, 'a duplicate-coid rejection must never be retried');
      assert(dupe.failure.class === 'business_rejection', `expected business_rejection, got ${dupe.failure.class}`);
    }
    // The venue still holds exactly ONE order for that coid — no second order.
    const holding = venue.ordersSnapshot().filter((o) => o['client_order_id'] === COID);
    assert(holding.length === 1, `a duplicate send must not create a second order, venue holds ${holding.length}`);

    // ------------------------------------------------ a lost response is AMBIGUOUS, then resolved
    // The venue destroys the socket: no response. The client classifies it as
    // orderMayExist=true (the request bytes may have reached the venue) and MUST
    // resolve rather than re-send.
    venue.injectFault({ path: '/orders/create', hangUp: true });
    const lost = await submitOrder(KEY, SECRET, {
      client_order_id: COID + 'b', side: 'buy', market_order: { market: 'BTCINR', side: 'buy' },
    }, { baseUrl: base });
    assert(lost.kind === 'rejected', 'a lost response must not look accepted');
    if (lost.kind === 'rejected') {
      assert(lost.failure.orderMayExist === true, `a lost response must be ambiguous (orderMayExist true), got class ${lost.failure.class}`);
      assert(lost.failure.retrySafe === false, 'a lost response must never be blindly retried');
    }
    // The worker resolves by coid: the venue never stored it (the socket died
    // before the create handler ran), so resolution says no order — and the send
    // is NOT repeated, so no duplicate exists anywhere.
    const after = await fetchOrderByClientId(KEY, SECRET, COID + 'b', { baseUrl: base });
    assert(after.ok === true && after.ok && after.order === null,
      'resolving the ambiguous send must conclude the order never landed (no duplicate)');
  } finally {
    await venue.stop();
  }
}
