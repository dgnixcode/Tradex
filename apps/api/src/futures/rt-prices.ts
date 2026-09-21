// Real-time futures market prices from CoinDCX's public unauthenticated ticker feed.
// Single endpoint returns all 536 pairs with live mark price (mp) and last traded price (ls).
//
// When the WebSocket feed is connected (ws-prices.ts), this returns the live in-memory
// map directly (sub-100ms freshness).  Falls back to REST polling with a 0.5s cache.

import { isWsFeedConnected, getLivePrices, seedPrices } from './ws-prices.js';

export interface FuturesRtPrice {
  readonly markPrice: string;
  readonly lastPrice: string;
  readonly priceChangePercent: number;
}

let cachedPrices: Map<string, FuturesRtPrice> | null = null;
let lastFetchMs = 0;
const CACHE_TTL_MS = 500; // 0.5 second cache — fast refresh for live trading

export async function getFuturesRtPrices(baseUrl = 'https://public.coindcx.com'): Promise<Map<string, FuturesRtPrice>> {
  // If WebSocket feed is connected and has data, return the live map directly
  const live = getLivePrices();
  if (isWsFeedConnected() && live.size > 0) {
    return live;
  }

  // Fallback: REST polling with cache
  const now = Date.now();
  if (cachedPrices !== null && (now - lastFetchMs) < CACHE_TTL_MS) {
    return cachedPrices;
  }
  try {
    const res = await fetch(`${baseUrl}/market_data/v3/current_prices/futures/rt`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json() as { prices?: Record<string, Record<string, unknown>> };
      const map = new Map<string, FuturesRtPrice>();
      if (data && typeof data.prices === 'object' && data.prices !== null) {
        for (const [pair, val] of Object.entries(data.prices)) {
          if (val && typeof val === 'object') {
            const mp = val['mp'];
            const ls = val['ls'];
            const pc = val['pc'];
            if (mp !== undefined && mp !== null) {
              map.set(pair, {
                markPrice: String(mp),
                lastPrice: ls !== undefined && ls !== null ? String(ls) : String(mp),
                priceChangePercent: typeof pc === 'number' ? pc : 0,
              });
            }
          }
        }
      }
      cachedPrices = map;
      lastFetchMs = now;
      // Seed the WS live map so it has initial data when WS connects
      seedPrices(map);
      return map;
    }
  } catch {
    // If transient network error, return existing cached prices if available
    if (cachedPrices !== null) return cachedPrices;
  }
  return cachedPrices ?? new Map();
}

export function normalizeFuturesPair(pairOrMarket: string | null | undefined): string {
  if (!pairOrMarket) return '';
  const s = String(pairOrMarket).trim().toUpperCase();
  if (s.startsWith('B-') && s.includes('_')) return s;
  const clean = s.replace(/^B-/, '').trim();
  if (clean.endsWith('USDT')) {
    const base = clean.slice(0, -4).replace(/[-_]$/, '');
    return `B-${base}_USDT`;
  }
  if (clean.endsWith('INR')) {
    const base = clean.slice(0, -3).replace(/[-_]$/, '');
    return `B-${base}_INR`;
  }
  if (clean.includes('-') || clean.includes('_')) {
    const parts = clean.split(/[-_]/);
    return `B-${parts[0]}_${parts[1] || 'USDT'}`;
  }
  return `B-${clean}_USDT`;
}

export function findRtPrice(
  rtPricesMap: Map<string, FuturesRtPrice>,
  pairOrMarket: string | null | undefined,
): FuturesRtPrice | undefined {
  if (!pairOrMarket) return undefined;
  const raw = String(pairOrMarket).trim();
  if (rtPricesMap.has(raw)) return rtPricesMap.get(raw);

  const norm = normalizeFuturesPair(raw);
  if (rtPricesMap.has(norm)) return rtPricesMap.get(norm);

  // Try raw without B- prefix (e.g. TAOUSDT, SOLUSDT)
  const clean = raw.replace(/^B-/, '').replace(/[-_]/g, '').toUpperCase();
  for (const [key, val] of rtPricesMap.entries()) {
    const keyClean = key.replace(/^B-/, '').replace(/[-_]/g, '').toUpperCase();
    if (keyClean === clean) return val;
  }

  // Base asset fallback
  const base = norm.replace(/^B-/, '').split('_')[0];
  if (base) {
    for (const [key, val] of rtPricesMap.entries()) {
      if (key.startsWith(`B-${base}_`)) return val;
    }
  }
  return undefined;
}
