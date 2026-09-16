// 15-list-orders — the L4a read-back that resolves a futures ambiguity.
//
// Futures has no `client_order_id` and no order-status endpoint, so "did my order
// land?" can only be answered by listing orders and matching on
// (pair, side, order_type, total_quantity, price). THAT makes this read-back
// load-bearing in a way an ordinary read is not: a read that returns too little
// concludes "not placed" for an order that exists, and a read that is too loose
// adopts a stranger's order.
//
// Three traps are pinned here, each of which would silently produce a wrong answer:
//
//   1. A FRESH order is `initial`, which is in neither documented status set — so
//      a standard read-back cannot see it. That is real venue behaviour, and the
//      window it creates is exactly why L4 narrows its search by time.
//   2. `cancelled` (two L) is the request spelling; `CANCELED` (one L) is the
//      response spelling. Case-folding alone does not bridge that.
//   3. There is no "all statuses" value — a status the caller omits is invisible.
//
// Runs against the FakeVenue over real HTTP with real HMAC verification.

import {
  FakeVenue, hmacHex, listFuturesOrders, listFuturesOrdersSigned,
  submitFuturesOrder, submitFuturesOrderSigned,
} from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'list-key-abcdef0123456789';
const SECRET = 'list-secret-abcdef0123456789';

const PAIR = 'B-BTC_USDT';

const find = (orders, id) => orders.find((o) => o.venueOrderId === id);

export async function run(assert) {
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  const baseUrl = (await venue.start()).toString();

  try {
    // ------------------------------------------------ 1. place one order
    // A LIMIT order on purpose: the sandbox fills a market order immediately (a
    // fill is what opens a position), so only a resting order exhibits the
    // `initial` window this check exists to pin.
    const placed = await submitFuturesOrder(KEY, SECRET, {
      pair: PAIR,
      side: 'buy',
      orderType: 'limit',
      price: '8000000',
      quantity: '0.001',
      leverage: 5,
      marginCurrency: 'USDT',
      positionMarginType: 'isolated',
      reduceOnly: false,
      deadlineMs: Date.now() + 5_000,
    }, { baseUrl });
    assert(placed.kind === 'accepted', `the futures order was not accepted: ${JSON.stringify(placed)}`);
    const venueOrderId = placed.order.venueOrderId;
    assert(typeof venueOrderId === 'string' && venueOrderId !== '', 'the create returned no order id');

    // ------------------------------------------------ 2. the `initial` window
    // The venue's create response says `initial`, and `initial` is not one of the
    // seven statuses the list accepts. So a read-back issued immediately — before
    // the venue has moved the order on — finds NOTHING, even though the order
    // exists. Pinned because "zero matches => not placed" is the dangerous
    // inference, and this is the window that makes it wrong.
    const fresh = await listFuturesOrders(KEY, SECRET, { pair: PAIR, side: 'buy' }, { baseUrl });
    assert(fresh.ok === true, `the orders list read failed: ${JSON.stringify(fresh)}`);
    assert(find(fresh.orders, venueOrderId) === undefined,
      'a freshly created order reported initial should not be visible to a standard status filter — '
      + 'if this now passes, the L4 time-window rationale needs re-reading (research/03 F6)');

    // ------------------------------------------------ 3. it becomes visible
    venue.settleFuturesOrder(venueOrderId, 'filled');
    const listed = await listFuturesOrders(KEY, SECRET, { pair: PAIR, side: 'buy' }, { baseUrl });
    assert(listed.ok === true, 'the orders list read failed after settling');
    const mine = find(listed.orders, venueOrderId);
    assert(mine !== undefined, 'the order was not found once the venue had moved it past initial');

    // The four fields L4 matches on must come back intact — a matcher that cannot
    // see them cannot match.
    assert(mine.pair === PAIR, `pair came back as ${mine.pair}`);
    assert(mine.side === 'buy', `side came back as ${mine.side}`);
    assert(mine.orderType === 'limit', `order_type came back as ${mine.orderType}`);
    assert(mine.totalQuantity === '0.001', `total_quantity came back as ${mine.totalQuantity}`);
    assert(mine.price === '8000000', `price came back as ${mine.price}`);
    assert(mine.status === 'filled', `status mapped to ${mine.status}, expected filled`);

    // ------------------------------------------------ 4. the read is narrow
    // A read-back that returned other pairs or sides would let the matcher adopt a
    // stranger's order — the worst possible failure here.
    const otherSide = await listFuturesOrders(KEY, SECRET, { pair: PAIR, side: 'sell' }, { baseUrl });
    assert(otherSide.ok === true && otherSide.orders.length === 0, 'the side filter leaked orders');
    const otherPair = await listFuturesOrders(KEY, SECRET, { pair: 'INR-ETH_INR', side: 'buy' }, { baseUrl });
    assert(otherPair.ok === true && otherPair.orders.length === 0, 'the pair filter leaked orders');

    // ------------------------------------------------ 5. the cancel spelling
    // Request says `cancelled`; response says `CANCELED`. Querying with the request
    // spelling must find an order the venue describes with the other one.
    venue.settleFuturesOrder(venueOrderId, 'CANCELED');
    const byCancelled = await listFuturesOrders(KEY, SECRET,
      { pair: PAIR, side: 'buy', status: 'cancelled' }, { baseUrl });
    assert(byCancelled.ok === true, 'the cancelled filter read failed');
    assert(find(byCancelled.orders, venueOrderId) !== undefined,
      'an order the venue reports as CANCELED was not found by the request spelling cancelled');

    // And the canonical mapper folds both spellings onto one value.
    const cancelled = find(byCancelled.orders, venueOrderId);
    assert(cancelled.status === 'cancelled', `CANCELED mapped to ${cancelled.status}, expected cancelled`);

    // ------------------------------------------------ 6. omitted status is invisible
    // There is no "all" value. Asking for a status the order is not in must not
    // return it — that is the property that makes the default CSV load-bearing.
    venue.settleFuturesOrder(venueOrderId, 'filled');
    const wrongStatus = await listFuturesOrders(KEY, SECRET,
      { pair: PAIR, side: 'buy', status: 'open' }, { baseUrl });
    assert(wrongStatus.ok === true && wrongStatus.orders.length === 0,
      'a status the order is not in still returned it — the filter is not being applied');

    // ------------------------------------------------ 7. the signer path
    // The production path never holds the secret: it hands the bytes to the signer
    // and gets back {apiKey, signature}. This closure IS what apps/signer does —
    // HMAC over the exact bytes — so a pass here means the seam is wired right.
    // FakeVenue verifies the HMAC, so a body mutated after signing would 401.
    const calls = [];
    const signer = async (body) => {
      calls.push(body);
      return { apiKey: KEY, signature: hmacHex(SECRET, body) };
    };
    const signedRead = await listFuturesOrdersSigned(signer, { pair: PAIR, side: 'buy' }, { baseUrl });
    assert(signedRead.ok === true, `the signed read failed: ${JSON.stringify(signedRead)}`);
    assert(find(signedRead.orders, venueOrderId) !== undefined, 'the signed read did not find the order');
    assert(calls.length === 1, `the signer was called ${calls.length} times for one request`);
    // The signature must cover exactly what was sent — including the stamp.
    const sent = JSON.parse(calls[0]);
    assert(typeof sent.timestamp === 'number', 'the signed body carried no timestamp');
    assert(sent.status !== undefined && sent.page !== undefined && sent.size !== undefined,
      'the signed body omitted one of the four mandatory list fields');

    // ------------------------------------------------ 8. no phantom reduce_only
    // The create body must NOT carry `reduce_only`. The futures API has no such
    // flag (research/04, verified by exhaustive grep), so sending it is either
    // ignored — leaving a reducing order free to FLIP the position — or rejected
    // outright, failing every order. Pinned on the BYTES rather than on a venue
    // echo, because the sandbox would happily echo whatever we sent.
    const createBodies = [];
    const capturingSigner = async (body) => {
      createBodies.push(body);
      return { apiKey: KEY, signature: hmacHex(SECRET, body) };
    };
    const placedViaSigner = await submitFuturesOrderSigned(capturingSigner, {
      pair: PAIR,
      side: 'buy',
      orderType: 'limit',
      price: '8100000',
      quantity: '0.002',
      leverage: 5,
      marginCurrency: 'USDT',
      positionMarginType: 'isolated',
      reduceOnly: false,           // accepted for type-compat, must never reach the wire
      deadlineMs: Date.now() + 5_000,
    }, { baseUrl });
    assert(placedViaSigner.kind === 'accepted', `the signed create failed: ${JSON.stringify(placedViaSigner)}`);
    assert(createBodies.length === 1, `expected one signed create body, got ${createBodies.length}`);
    const createBody = JSON.parse(createBodies[0]);
    const orderInBody = createBody.order ?? createBody;
    assert(!('reduce_only' in orderInBody),
      'the create body still carries reduce_only — the futures API has no such field, so this protects '
      + 'nothing and a reducing order sized above the position would flip it');
    assert(orderInBody.pair === PAIR && orderInBody.leverage === 5,
      'the create body lost a field it does need');

    console.log('     L4a read-back: initial-window invisible, narrow by pair+side, cancel alias, signer path');
  } finally {
    await venue.stop();
  }
}
