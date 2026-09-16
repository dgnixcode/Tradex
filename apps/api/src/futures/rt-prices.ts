// Real-time futures market prices from CoinDCX's public unauthenticated ticker feed.
// Single endpoint returns all 536 pairs with live mark price (mp) and last traded price (ls).

export interface FuturesRtPrice {
  readonly markPrice: string;
  readonly lastPrice: string;
  readonly priceChangePercent: number;
}

let cachedPrices: Map<string, FuturesRtPrice> | null = null;
let lastFetchMs = 0;
const CACHE_TTL_MS = 1500; // 1.5 second cache

export async function getFuturesRtPrices(baseUrl = 'https://public.coindcx.com'): Promise<Map<string, FuturesRtPrice>> {
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
      return map;
    }
  } catch {
    // If transient network error, return existing cached prices if available
    if (cachedPrices !== null) return cachedPrices;
  }
  return cachedPrices ?? new Map();
}
