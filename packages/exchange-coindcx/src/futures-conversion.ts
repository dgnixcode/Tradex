import { classify } from '@tradex/exchange';
import { parseDecimalJson } from './decimal-json.js';
import { plainDecimal } from './market-rules.js';
import { send, TransportError } from './http.js';
import { DEFAULT_BASE_URL } from './probe.js';

/** CoinDCX's fixed futures settlement rate. Spot USDT/INR is not interchangeable. */
export async function fetchFuturesSettlementRate(opts: { baseUrl?: string; deadlineMs?: number } = {}) {
  try {
    const result = await send({ method: 'GET', url: new URL('/api/v1/derivatives/futures/data/conversions', opts.baseUrl ?? DEFAULT_BASE_URL), deadlineMs: opts.deadlineMs ?? 5000 });
    if (result.status !== 200) return { ok: false as const, failure: classify({ status: result.status, message: 'Futures settlement conversion is unavailable' }) };
    const parsed = parseDecimalJson(result.body);
    if (!Array.isArray(parsed)) throw new Error('Conversion response is not an array');
    const matching = parsed.filter(row => row !== null && typeof row === 'object' && !Array.isArray(row)
      && row['symbol'] === 'USDTINR' && row['margin_currency_short_name'] === 'INR' && row['target_currency_short_name'] === 'USDT');
    if (matching.length !== 1) throw new Error('Expected exactly one INR futures conversion');
    const row = matching[0] as Record<string, unknown>;
    const value = row['conversion_price'];
    if (typeof value !== 'string') throw new Error('Conversion price is not a decimal');
    const rate = plainDecimal(value, 'futures conversion price');
    if (!/^\d+(?:\.\d{1,18})?$/.test(rate) || !/[1-9]/.test(rate)) throw new Error('Conversion price is not positive');
    return { ok: true as const, rate, observedAtMs: Date.now() };
  } catch (error) {
    return { ok: false as const, failure: error instanceof TransportError ? classify({ transport: error.kind })
      : classify({ status: 502, message: 'Futures settlement conversion could not be verified' }) };
  }
}
