import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  exactQuantityForWire, fetchFuturesInstrument, fetchFuturesPositionsSigned,
  listFuturesOrdersSigned, submitFuturesOrderSigned,
  changeFuturesMarginSigned, fetchFuturesFreeBalanceSigned,
} from './futures-order-client.js';
import { destroyAllAgents } from './http.js';
import { plainDecimal } from './market-rules.js';
import { requestBody } from './signing.js';

let server: Server | undefined;
afterEach(async () => {
  destroyAllAgents();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});
async function serve(body: string): Promise<string> {
  server = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(body); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test address');
  return `http://127.0.0.1:${address.port}`;
}
const sign = async (_body: string) => ({ apiKey: 'test', signature: 'test' });

describe('futures decimal precision at the exchange boundary', () => {
  it('sends an exact native amount to add_margin, without leverage or order fields', async () => {
    const baseUrl = await serve('{"message":"success","status":200,"code":200}');
    let payload = '';
    const result = await changeFuturesMarginSigned(async body => { payload = body; return sign(body); },
      { positionId: 'inr-position', amount: '500', direction: 'add' }, { baseUrl });
    expect(result.ok).toBe(true);
    expect(JSON.parse(payload)).toMatchObject({ id: 'inr-position', amount: 500 });
    expect(Object.keys(JSON.parse(payload)).sort()).toEqual(['amount', 'id', 'timestamp']);
  });
  it('preserves eight-place USDT amount bytes for remove_margin', async () => {
    const baseUrl = await serve('{"message":"success","status":200,"code":200}');
    let payload = '';
    await changeFuturesMarginSigned(async body => { payload = body; return sign(body); },
      { positionId: 'usdt-position', amount: '0.00000001', direction: 'remove' }, { baseUrl });
    expect(payload).toContain('"amount":0.00000001');
  });
  it('does not treat a business refusal inside HTTP 200 as success', async () => {
    const baseUrl = await serve('{"message":"Insufficient funds","status":422,"code":422}');
    const result = await changeFuturesMarginSigned(sign, { positionId: 'position', amount: '500', direction: 'add' }, { baseUrl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.orderMayExist).toBe(false);
  });
  it('keeps an unreadable successful HTTP response ambiguous', async () => {
    const baseUrl = await serve('not-json');
    const result = await changeFuturesMarginSigned(sign, { positionId: 'position', amount: '500', direction: 'add' }, { baseUrl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.orderMayExist).toBe(true);
  });
  it('reads only native futures wallet free funds and floors wallet precision', async () => {
    const baseUrl = await serve('[{"currency_short_name":"INR","balance":"500.01999","locked_balance":"999999"}]');
    expect(await fetchFuturesFreeBalanceSigned(sign, 'INR', { baseUrl })).toEqual({ ok: true, freeMinor: '50001' });
    expect(await fetchFuturesFreeBalanceSigned(sign, 'USDT', { baseUrl })).toEqual({ ok: false });
  });
  it('normalizes venue fee percentages to fractional notional rates', async () => {
    const baseUrl = await serve('{"maker_fee":0.02,"taker_fee":0.06}');
    const result = await fetchFuturesInstrument('B-SOL_USDT','INR',{ baseUrl });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.instrument.makerFee).toBe('0.0002'); expect(result.instrument.takerFee).toBe('0.0006'); }
  });
  it('sends null price for a market order even if a caller supplied an off-tick estimate', async () => {
    const baseUrl = await serve('{"id":"entry"}');
    let body = '';
    await submitFuturesOrderSigned(async payload => { body = payload; return sign(payload); },{
      pair:'B-BNB_USDT',side:'buy',orderType:'market',quantity:'1',price:'712.1865',leverage:5,
      marginCurrency:'INR',positionMarginType:'isolated',reduceOnly:false,deadlineMs:Date.now()+10000,
    },{ baseUrl });
    const wire = JSON.parse(body).order;
    expect(wire.price).toBeNull(); expect(wire).not.toHaveProperty('time_in_force');
    expect(wire.margin_currency_short_name).toBe('INR');
  });
  it('reads dynamic leverage limits and ignores deprecated 100x fields', async () => {
    const baseUrl = await serve('{"max_leverage_long":100,"max_leverage_short":100,"dynamic_position_leverage_details":{"10":500000,"20":100000}}');
    const result = await fetchFuturesInstrument('B-ETH_USDT', 'USDT', { baseUrl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.instrument.leverageTiers).toEqual([{ upToNotional: '100000', maxLeverage: 20 }, { upToNotional: '500000', maxLeverage: 10 }]);
  });
  it('leaves missing dynamic leverage limits unavailable', async () => {
    const baseUrl = await serve('{"max_leverage_long":100,"max_leverage_short":100}');
    const result = await fetchFuturesInstrument('B-ETH_USDT', 'INR', { baseUrl });
    if (result.ok) expect(result.instrument.leverageTiers).toEqual([]);
    else throw new Error('instrument should parse');
  });
  it('refuses rules for a different pair or margin wallet', async () => {
    const baseUrl = await serve('{"pair":"B-BTC_USDT","margin_currency_short_name":"INR","dynamic_position_leverage_details":{"100":100000}}');
    const result = await fetchFuturesInstrument('B-ETH_USDT', 'USDT', { baseUrl });
    expect(result.ok).toBe(false);
  });
  it('signs the exact numeric quantity without rounding upward or changing the venue type', () => {
    expect(requestBody({ order: { total_quantity: exactQuantityForWire('09007199254740993.123456789123456789') } }, 1))
      .toBe('{"order":{"total_quantity":9007199254740993.123456789123456789},"timestamp":1}');
    for (const invalid of ['0', '-1', '1e-8', '1, "side":"sell"', '0.1234567891234567891', 'NaN']) {
      expect(() => exactQuantityForWire(invalid)).toThrow();
    }
  });
  it('preserves create-response quantity and prices sent as JSON numbers', async () => {
    const baseUrl = await serve('{"id":"entry","total_quantity":0.123456789123456789,"avg_price":9007199254740993.12}');
    let signedBody = '';
    const result = await submitFuturesOrderSigned(async (body) => { signedBody = body; return sign(body); }, {
      pair: 'B-BTC_USDT', side: 'buy', orderType: 'market', quantity: '0.123456789123456789',
      leverage: 5, marginCurrency: 'USDT', positionMarginType: 'isolated', reduceOnly: false, deadlineMs: Date.now() + 10_000,
    }, { baseUrl });
    expect(signedBody).toContain('"total_quantity":0.123456789123456789');
    expect(result.kind).toBe('accepted');
    if (result.kind === 'accepted') {
      expect(result.order.quantity).toBe('0.123456789123456789');
      expect(result.order.avgFillPrice).toBe('9007199254740993.12');
    }
  });
  it('keeps the position quantity exact and expands venue exponent notation', async () => {
    const baseUrl = await serve('[{"id":"pos","pair":"B-BTC_USDT","margin_currency_short_name":"USDT","active_pos":-0.123456789123456789,"mark_price":1.23456789123456789e-8,"funding_rate_bp":0.25}]');
    const result = await fetchFuturesPositionsSigned(sign, ['USDT'], { baseUrl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.positions[0]?.activePos).toBe('-0.123456789123456789');
      expect(result.positions[0]?.markPrice).toBe('0.0000000123456789123456789');
      expect(result.positions[0]?.fundingRateBp).toBe(0.25);
    }
  });
  it('calculates partial fills exactly and leaves missing fill evidence unknown', async () => {
    const baseUrl = await serve('[{"id":"partial","pair":"B-BTC_USDT","status":"partially_filled","total_quantity":0.123456789123456789,"remaining_quantity":0.123456789123456788,"cancelled_quantity":0},{"id":"open","pair":"B-BTC_USDT","status":"open","total_quantity":1}]');
    const result = await listFuturesOrdersSigned(sign, { side: 'buy' }, { baseUrl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.orders[0]?.filledQuantity).toBe('0.000000000000000001');
      expect(result.orders[1]?.filledQuantity).toBeNull();
    }
  });
  it('reads exact instrument increments and bounds exponent expansion', async () => {
    const baseUrl = await serve('{"quantity_increment":1e-8,"price_increment":0.123456789123456789}');
    const result = await fetchFuturesInstrument('B-BTC_USDT', 'USDT', { baseUrl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.instrument.quantityIncrement).toBe('0.00000001');
      expect(result.instrument.priceIncrement).toBe('0.123456789123456789');
    }
    expect(() => plainDecimal('1e999999999', 'quantity')).toThrow(/limit/);
  });
});
