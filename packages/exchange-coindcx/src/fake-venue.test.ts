// The fake venue is only useful if it is strict where the real one is strict.
// These tests are mostly about that: a signature the venue would reject must be
// rejected here too, with the same 401 body, or the fake becomes a way to ship
// a signing bug.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RateBudget, classify } from '@tradex/exchange';
import { FakeVenue } from './fake-venue.js';
import { destroyAllAgents, send } from './http.js';
import { mapMarketsDetails } from './market-rules.js';
import { bestBid, mapOrderBook } from './order-book.js';
import { cancelOrder, fetchActiveOrders, fetchOrderByClientId, submitOrder } from './order-client.js';
import { readRateFeedback } from './rate-headers.js';
import { signRequest } from './signing.js';

const KEY = 'fake-api-key';
const SECRET = 'fake-api-secret-0123456789abcdef';

let venue: FakeVenue;
let base: URL;

beforeEach(async () => {
  venue = new FakeVenue({ credentials: { [KEY]: SECRET }, rateLimit: { limit: 5_000, windowSeconds: 60 } });
  base = await venue.start();
});

afterEach(async () => {
  destroyAllAgents();
  await venue.stop();
});

const get = async (path: string) => send({ method: 'GET', url: new URL(path, base) });

const post = async (path: string, params: Record<string, unknown> = {}, secret = SECRET) => {
  const signed = signRequest(KEY, secret, params);
  return await send({ method: 'POST', url: new URL(path, base), body: signed.body, headers: signed.headers });
};

describe('the public routes serve the captured responses', () => {
  it('serves all 997 markets, exponent forms and skips included', async () => {
    const r = await get('/exchange/v1/markets_details');
    expect(r.status).toBe(200);
    const { rules, skipped } = mapMarketsDetails(r.body, 'fake-v1');
    expect(rules.length + skipped.length).toBe(997);
    expect(rules.length).toBe(963);
    // The exponent-form value that would have thrown in the money layer.
    expect(rules.find((m) => m.venueSymbol === 'ETHINR')?.minQuantity).toBe('0.0000001');
  });

  it('serves an order book whose first key is not the best bid', async () => {
    const r = await get('/market_data/orderbook?pair=B-BTC_USDT');
    const naive = Object.keys((JSON.parse(r.body) as { bids: Record<string, string> }).bids)[0];
    expect(bestBid(mapOrderBook(r.body))?.price).toBe('79749.99');
    expect(naive).toBe('79746');
  });

  it('routes INR and USDT pairs to their own books', async () => {
    const inr = mapOrderBook((await get('/market_data/orderbook?pair=I-BTC_INR')).body);
    const usdt = mapOrderBook((await get('/market_data/orderbook?pair=B-BTC_USDT')).body);
    expect(bestBid(inr)?.price).not.toBe(bestBid(usdt)?.price);
    expect(bestBid(inr)?.price).toMatch(/^78900/);
  });

  it('serves ticker, trades and candles', async () => {
    expect(JSON.parse((await get('/exchange/ticker')).body)).toHaveLength(997);
    expect(JSON.parse((await get('/market_data/trade_history?pair=B-BTC_USDT')).body)).toHaveLength(30);
    const candles = JSON.parse((await get('/market_data/candlesticks?pair=B-BTC_USDT')).body) as { s: string };
    expect(candles.s).toBe('ok');
  });

  it('marks the ticker as cached, because live it was', async () => {
    // 01 F2: /exchange/ticker returned cf-cache-status HIT and everything else
    // DYNAMIC. Metering off a cached response reads a stranger's counters.
    expect(readRateFeedback(200, (await get('/exchange/ticker')).headers).fromCache).toBe(true);
    expect(readRateFeedback(200, (await get('/exchange/v1/markets_details')).headers).fromCache).toBeUndefined();
  });

  it('rejects an orderbook request with no pair, as the venue does', async () => {
    const r = await get('/market_data/orderbook');
    expect(r.status).toBe(400);
    expect(r.body).toContain('Invalid Request.');
  });
});

describe('signatures are verified, which is the point of the fake', () => {
  it('accepts a correctly signed request', async () => {
    const r = await post('/exchange/v1/users/balances');
    expect(r.status).toBe(200);
    expect(venue.requests.at(-1)?.signatureValid).toBe(true);
    const balances = JSON.parse(r.body) as Array<{ currency: string }>;
    expect(balances.map((b) => b.currency)).toEqual(['INR', 'USDT', 'BTC', 'ETH']);
  });

  it('rejects a signature computed with the wrong secret', async () => {
    const r = await post('/exchange/v1/users/balances', {}, 'not-the-secret');
    expect(r.status).toBe(401);
    expect(r.body).toContain('Invalid signature');
  });

  it('rejects a body mutated after signing — the bug T01.2 exists to prevent', async () => {
    // Sign one body, send another. Against a stub this passes; against the real
    // venue it is an opaque 401 that looks like a revoked key (12 F7).
    const signed = signRequest(KEY, SECRET, { market: 'BTCINR' });
    const tampered = signed.body.replace('BTCINR', 'BTCUSDT');
    const r = await send({
      method: 'POST', url: new URL('/exchange/v1/users/balances', base), body: tampered, headers: signed.headers,
    });
    expect(r.status).toBe(401);
    expect(r.body).toContain('Invalid signature');
    expect(venue.requests.at(-1)?.signatureValid).toBe(false);
  });

  it('rejects a re-serialised body even when it is semantically identical', async () => {
    // Same fields, different key order. The venue verifies the HMAC over raw
    // bytes, so this is a different request as far as the signature is concerned.
    const signed = signRequest(KEY, SECRET, { a: 1, b: 2 });
    const parsed = JSON.parse(signed.body) as Record<string, unknown>;
    const reordered = JSON.stringify({ timestamp: parsed['timestamp'], b: 2, a: 1 });
    expect(reordered).not.toBe(signed.body);
    const r = await send({
      method: 'POST', url: new URL('/exchange/v1/users/balances', base), body: reordered, headers: signed.headers,
    });
    expect(r.status).toBe(401);
  });

  it('says "Invalid credentials" when no auth headers were sent at all', async () => {
    // Two different 401s: one means the key is wrong, the other means our signing
    // is broken. Conflating them misdiagnoses an outage across every account.
    const r = await send({ method: 'POST', url: new URL('/exchange/v1/users/balances', base), body: '{}' });
    expect(r.status).toBe(401);
    expect(r.body).toContain('Invalid credentials');
    expect(r.body).not.toContain('Invalid signature');
    expect(venue.requests.at(-1)?.signatureValid).toBeNull();
  });

  it('rejects an unknown api key', async () => {
    const signed = signRequest('someone-elses-key', SECRET, {});
    const r = await send({
      method: 'POST', url: new URL('/exchange/v1/users/balances', base), body: signed.body, headers: signed.headers,
    });
    expect(r.status).toBe(401);
    expect(r.body).toContain('Invalid signature');
  });

  it('does not accept a GET on an authenticated route', async () => {
    expect((await get('/exchange/v1/users/balances')).status).toBe(404);
  });

  it('requires a client_order_id on placement (Phase 06 order engine)', async () => {
    const r = await post('/exchange/v1/orders/create', { market: 'BTCINR', side: 'buy' });
    expect(r.status).toBe(400);
    expect(r.body).toContain('client_order_id');
  });
});

describe('fault injection reproduces every failure the classifier must handle', () => {
  it('injects a status and body, once', async () => {
    venue.injectFault({ status: 429, body: '{"code":429,"message":"Too Many Requests"}' });
    expect((await get('/exchange/ticker')).status).toBe(429);
    expect((await get('/exchange/ticker')).status).toBe(200); // the fault is spent
  });

  it('injects a fault a given number of times', async () => {
    venue.injectFault({ status: 500, body: '{}', times: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await get('/exchange/ticker')).status);
    expect(statuses).toEqual([500, 500, 200]);
  });

  it('scopes a fault to one route', async () => {
    venue.injectFault({ path: '/exchange/v1/users/balances', status: 503, body: '{}' });
    expect((await get('/exchange/ticker')).status).toBe(200);
    expect((await post('/exchange/v1/users/balances')).status).toBe(503);
  });

  it('produces the ambiguous case: accepted, then the socket dies', async () => {
    // The failure that costs money. The order may exist and nothing came back.
    venue.injectFault({ path: '/orders/create', hangUp: true });
    const err = await post('/exchange/v1/orders/create', { market: 'BTCINR' }).then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    expect((err as { mayHaveSent: boolean }).mayHaveSent).toBe(true);
    // The venue still recorded the request — which is exactly why it is ambiguous.
    expect(venue.requests.at(-1)?.path).toBe('/exchange/v1/orders/create');
    expect(venue.requests.at(-1)?.signatureValid).toBe(true);
  });

  it('produces a blackhole that only the client deadline ends', async () => {
    venue.injectFault({ blackhole: true });
    const err = await send({ method: 'GET', url: new URL('/exchange/ticker', base), deadlineMs: 150 })
      .then(() => null, (e: unknown) => e);
    expect((err as Error).message).toMatch(/deadline of 150ms/);
    expect((err as { mayHaveSent: boolean }).mayHaveSent).toBe(true);
  });

  it('produces a slow-but-successful response', async () => {
    venue.injectFault({ delayMs: 80, status: 200, body: '{"ok":1}' });
    const r = await get('/exchange/ticker');
    expect(r.status).toBe(200);
    expect(r.timing.ttfbMs).toBeGreaterThanOrEqual(70);
  });

  it('clears faults on reset', async () => {
    venue.injectFault({ status: 500, body: '{}', times: 99 });
    venue.reset();
    expect((await get('/exchange/ticker')).status).toBe(200);
    expect(venue.requests).toHaveLength(1);
  });
});

describe('the whole stack runs against the fake with only the base URL changed', () => {
  it('meters, sends, classifies and reads feedback in one pass', async () => {
    const budget = new RateBudget();
    const outcomes: string[] = [];

    for (const path of ['/exchange/v1/markets_details', '/market_data/orderbook?pair=I-BTC_INR']) {
      await budget.acquire();
      const r = await get(path);
      budget.observe(readRateFeedback(r.status, r.headers));
      outcomes.push(`${r.status}`);
    }

    // A 429 must classify as retry-safe and park the meter.
    venue.injectFault({ status: 429, body: '{"code":429,"message":"Too Many Requests"}' });
    await budget.acquire();
    const throttled = await get('/exchange/ticker');
    const feedback = readRateFeedback(throttled.status, throttled.headers);
    const parked = budget.observe(feedback);
    const failure = classify({ status: throttled.status, message: 'Too Many Requests' });

    expect(outcomes).toEqual(['200', '200']);
    expect(feedback.throttled).toBe(true);
    expect(parked.parkedMs).toBe(60_000); // the fake's window
    expect(failure.class).toBe('rate_limited');
    expect(failure.retrySafe).toBe(true);
    expect(failure.orderMayExist).toBe(false);
    expect(budget.peekWaitMs()).toBeGreaterThan(0);
  });

  it('classifies a business rejection the venue would really send', async () => {
    venue.injectFault({
      path: '/orders/create',
      status: 400,
      body: '{"code":400,"message":"Minimum order value should be 5 USDT","status":"error"}',
    });
    const r = await post('/exchange/v1/orders/create', { market: 'BTCUSDT' });
    const failure = classify({
      status: r.status,
      message: (JSON.parse(r.body) as { message: string }).message,
    });
    expect(failure.class).toBe('business_rejection');
    expect(failure.code).toBe('below_min_notional');
    expect(failure.retrySafe).toBe(false);
  });

  it('reuses one connection across the whole run', async () => {
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await get('/market_data/trade_history?pair=B-BTC_USDT'));
    expect(results.map((r) => r.timing.reusedConnection)).toEqual([false, true, true, true, true]);
    expect(new Set(results.map((r) => r.timing.socketId)).size).toBe(1);
  });

  it('reports the fake venue as absent rather than hanging once stopped', async () => {
    await venue.stop();
    const err = await get('/exchange/ticker').then(() => null, (e: unknown) => e);
    // Never-sent, so no order can exist: the one transport case that is certain.
    expect((err as { kind: string }).kind).toBe('connect');
    expect((err as { mayHaveSent: boolean }).mayHaveSent).toBe(false);
    expect(classify({ transport: 'connect' }).orderMayExist).toBe(false);
  });
});

describe('the Phase 09 sell side: cancel, fills and holdings (T09.1/T09.7/T09.2)', () => {
  // `base` is reassigned to a fresh URL+port in EVERY beforeEach, so it cannot be
  // captured here — the describe body runs once at registration, before any
  // beforeEach has fired. A getter resolves it at access time instead.
  const urlOpts = { get baseUrl(): string { return base.toString(); } };

  const place = async (coid: string, overrides: Record<string, unknown> = {}) => {
    const outcome = await submitOrder(KEY, SECRET, {
      market: 'BTCINR',
      side: 'sell',
      order_type: 'limit',
      total_quantity: '0.001',
      price_per_unit: '6000000',
      client_order_id: coid,
      ...overrides,
    }, urlOpts);
    expect(outcome.kind).toBe('accepted');
    return outcome.kind === 'accepted' ? outcome.order : null;
  };

  const poll = async (coid: string) => (await fetchOrderByClientId(KEY, SECRET, coid, urlOpts));

  it('cancels an open order, and a status poll observes the cancellation', async () => {
    const order = await place('c1');
    expect(order).not.toBeNull();
    expect(order!.state.state).toBe('open');

    const cancelled = await cancelOrder(KEY, SECRET, 'c1', urlOpts);
    expect(cancelled).toEqual({ kind: 'cancelled' });

    // The venue's cancel returns no order object — the poll is the truth (01 F8.10).
    const polled = await poll('c1');
    expect(polled.ok).toBe(true);
    expect(polled.ok && polled.order?.state.state).toBe('cancelled');
    // A settled order has left the active set.
    const active = await fetchActiveOrders(KEY, SECRET, 'BTCINR', urlOpts);
    expect(active.ok).toBe(true);
    expect(active.ok && active.orders).toHaveLength(0);
  });

  it('refuses to cancel an order the venue considers settled — before any engine logic', async () => {
    await place('c2');
    venue.settleOrder('c2', 'filled');

    const refused = await cancelOrder(KEY, SECRET, 'c2', urlOpts);
    expect(refused.kind).toBe('rejected');
    if (refused.kind === 'rejected') {
      expect(refused.failure.class).toBe('business_rejection');
      expect(refused.failure.code).toBe('order_not_cancellable');
      expect(refused.failure.retrySafe).toBe(false);
    }
    // The refusal changed nothing at the venue.
    const polled = await poll('c2');
    expect(polled.ok && polled.order?.state.state).toBe('filled');
  });

  it('returns a distinguishable not-found when the venue never heard of the order', async () => {
    const refused = await cancelOrder(KEY, SECRET, 'never-created', urlOpts);
    expect(refused.kind).toBe('rejected');
    if (refused.kind === 'rejected') expect(refused.failure.class).toBe('not_found');
  });

  it('settleOrder drives an order to filled/partially_filled for completion-on-fills (T09.7)', async () => {
    const coid = 'settle-1';
    await place(coid, { side: 'buy', market: 'BTCINR' });
    venue.settleOrder(coid, 'partially_filled');
    let polled = await poll(coid);
    expect(polled.ok && polled.order?.state.state).toBe('partially_filled');
    venue.settleOrder(coid, 'filled');
    polled = await poll(coid);
    expect(polled.ok && polled.order?.state.state).toBe('filled');
    // Filled orders are no longer "active".
    const active = await fetchActiveOrders(KEY, SECRET, 'BTCINR', urlOpts);
    expect(active.ok && active.orders).toHaveLength(0);
  });

  it('active_orders is per-market and excludes working orders on other markets', async () => {
    await place('m1', { market: 'BTCINR' });
    await place('m2', { market: 'BTCUSDT' });
    const btcInr = await fetchActiveOrders(KEY, SECRET, 'BTCINR', urlOpts);
    expect(btcInr.ok && btcInr.orders.map((o) => o.clientOrderId)).toEqual(['m1']);
    const btcUsdt = await fetchActiveOrders(KEY, SECRET, 'BTCUSDT', urlOpts);
    expect(btcUsdt.ok && btcUsdt.orders.map((o) => o.clientOrderId)).toEqual(['m2']);
    // No orders on a market we never touched.
    const eth = await fetchActiveOrders(KEY, SECRET, 'ETHINR', urlOpts);
    expect(eth.ok && eth.orders).toHaveLength(0);
  });

  it('setBalance shapes the users/balances read a sell sizes against (T09.2)', async () => {
    venue.setBalance('BTC', 0.0025, 0.001);
    const r = await post('/exchange/v1/users/balances');
    const rows = JSON.parse(r.body) as Array<{ currency: string; balance: number; locked_balance: number }>;
    const btc = rows.find((row) => row.currency === 'BTC');
    expect(btc?.balance).toBe(0.0025);
    expect(btc?.locked_balance).toBe(0.001);
  });

  it('rejects an active_orders request with no market, as the venue requires', async () => {
    const signed = signRequest(KEY, SECRET, {});
    const r = await send({
      method: 'POST', url: new URL('/exchange/v1/orders/active_orders', base), body: signed.body, headers: signed.headers,
    });
    expect(r.status).toBe(400);
    expect(r.body).toContain('market');
  });
});
