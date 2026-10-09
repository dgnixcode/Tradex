import { describe, expect, it } from 'vitest';
import { floorQuantityToStep, planAdjustment } from './futures/adjust-service.js';
import { decimalEqual, findIntentOrder } from './futures/place-protocol.js';
import type { FuturesIntent, ListedOrder } from './futures/place-protocol.js';
import { validatePlanRequest } from './planning-service.js';
import type { PlanRequest } from './planning-service.js';
import { getMonthlyChunkFilePath, normalizeSymbol } from './algo/binance-history.js';

const plan: PlanRequest = { createdBy: 'user', asset: 'BTC', side: 'buy', orderType: 'market', sizingMode: 'base_quantity', sizingValue: '0.001' };
describe('trade input and exact decimals', () => {
  it('rejects historical data path traversal before filesystem access', () => {
    expect(() => normalizeSymbol('../../secrets')).toThrow();
    expect(() => getMonthlyChunkFilePath('BTCUSDT', '../../secrets', 2026, 10)).toThrow();
    expect(() => getMonthlyChunkFilePath('../BTCUSDT', '5m', 2026, 10)).toThrow();
    expect(() => getMonthlyChunkFilePath('BTCUSDT', '5m', 2026, 13)).toThrow();
  });
  it.each(['market', 'limit'] as const)('accepts a valid %s order', (orderType) => {
    expect(() => validatePlanRequest({ ...plan, orderType, limitPrice: '60000.01' })).not.toThrow();
  });
  it.each([
    { orderType: 'stop_market' }, { side: 'long' }, { asset: "BTC';DROP TABLE tenant;--" },
    { sizingValue: '1e5' }, { sizingValue: '-1' }, { sizingValue: '0' }, { sizingValue: '0.0000000000000000001' },
    { sizingMode: 'pct_allocated', percentBp: 10001 }, { sizingMode: 'pct_free', percentBp: 1.5 },
    { orderType: 'limit' }, { orderType: 'limit', limitPrice: 'Infinity' }, { isFutures: 'false' },
    { isFutures: true, leverage: '10.5', marginCurrency: 'USDT', positionMarginType: 'isolated' },
    { accountIds: ['not-an-account'] }, { sizingMode: 'quote_amount', sizingValue: '1.5' },
  ])('rejects malformed or unsafe input %j before planning', (overrides) => {
    expect(() => validatePlanRequest({ ...plan, ...overrides } as PlanRequest)).toThrow();
  });
  it('floors quantities beyond Number precision without rounding up', () => {
    expect(floorQuantityToStep('9007199254740993.123456789123456789', '0.000000000000000001')).toBe('9007199254740993.123456789123456789');
    expect(floorQuantityToStep('0.123456789123456789', '0.00001')).toBe('0.12345');
    expect(() => floorQuantityToStep('0.1', '0')).toThrow();
  });
  it('clamps an oversized reduce to the last legal step below a non-step position', () => {
    const result = planAdjustment({ direction: 'reduce', activePos: ' -0.105 ', quantity: '1', quantityIncrement: '0.01', minQuantity: '0.01', minNotional: '0', price: '100' });
    expect(result).toEqual({ ok: true, side: 'buy', quantity: '0.1', isFull: false });
  });
  it('compares plain decimals without floating point', () => {
    expect(decimalEqual('0001.0000', '1')).toBe(true);
    expect(decimalEqual('9007199254740992', '9007199254740993')).toBe(false);
    expect(decimalEqual('1e3', '1000')).toBe(false);
  });
});

describe('futures reconciliation identity', () => {
  const intent: FuturesIntent = { accountId: 'a', childOrderId: 'c', pair: 'B-BTC_USDT', marginCurrency: 'USDT', side: 'buy', orderType: 'limit', quantity: '0.001', price: '60000', sentAtMs: 100_000 };
  const order: ListedOrder = { venueOrderId: 'v1', pair: intent.pair, side: 'buy', orderType: 'limit', totalQuantity: '0.001000', price: '60000.00', createdAtMs: 100_001, statusRaw: 'open' };
  it('adopts only one timed match with exact decimal equivalence', () => {
    expect(findIntentOrder([order], intent, null)?.venueOrderId).toBe('v1');
    expect(findIntentOrder([order, { ...order, venueOrderId: 'v2' }], intent, null)).toBeUndefined();
  });
  it('never substitutes another order for a known venue id', () => {
    expect(findIntentOrder([order], intent, 'missing')).toBeUndefined();
  });
  it('does not adopt historical, future, or untimed orders', () => {
    for (const createdAtMs of [1, 200_000, null]) expect(findIntentOrder([{ ...order, createdAtMs }], intent, null)).toBeUndefined();
  });
});
