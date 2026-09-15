/**
 * useLiveTicker — polls our backend for fresh best-bid/ask every 3 seconds.
 *
 * WHY POLLING INSTEAD OF A DIRECT WEBSOCKET?
 * CoinDCX's Socket.IO server rejects cross-origin WebSocket connections from
 * any non-CoinDCX origin (tested on localhost, AWS IP, and custom domains).
 * The architecture doc (research/21) also mandates "browsers must not touch
 * the exchange". So we poll our own /api/market-price endpoint, which reads
 * from CoinDCX's public order book on the backend (no CORS, no Origin check).
 *
 * 3-second polling is well within the 5000/60s rate limit on the public
 * orderbook endpoint, and eliminates the 5-10s price lag vs CoinDCX's own UI.
 */
import { useEffect, useRef, useState } from 'react';
import { fetchMarketPrice } from '../api.ts';

export interface LiveTicker {
  /** Best bid (highest buy order) — what you'd sell at. */
  readonly bestBid: string | null;
  /** Best ask (lowest sell order) — what you'd buy at. */
  readonly bestAsk: string | null;
  /** Millisecond timestamp of the last successful fetch. */
  readonly updatedAtMs: number | null;
  /** Whether the ticker is actively receiving data. */
  readonly connected: boolean;
}

const POLL_INTERVAL_MS = 3_000;

/**
 * Hook: auto-poll live best-bid/ask for a trading pair.
 *
 * @param asset          e.g. 'BTC', 'ETH'. Empty string = no polling.
 * @param marginCurrency 'INR' or 'USDT'.
 */
export function useLiveTicker(asset: string, marginCurrency: 'INR' | 'USDT'): LiveTicker {
  const [ticker, setTicker] = useState<LiveTicker>({
    bestBid: null, bestAsk: null, updatedAtMs: null, connected: false,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Track consecutive failures — mark disconnected after 2 in a row.
  const failCountRef = useRef(0);

  useEffect(() => {
    if (asset === '') {
      setTicker({ bestBid: null, bestAsk: null, updatedAtMs: null, connected: false });
      return;
    }

    let cancelled = false;

    const poll = (): void => {
      fetchMarketPrice(asset, marginCurrency)
        .then((price) => {
          if (cancelled) return;
          failCountRef.current = 0;
          setTicker({
            bestBid: price.bestBid,
            bestAsk: price.bestAsk,
            updatedAtMs: Date.now(),
            connected: true,
          });
        })
        .catch(() => {
          if (cancelled) return;
          failCountRef.current += 1;
          if (failCountRef.current >= 2) {
            setTicker((prev) => ({ ...prev, connected: false }));
          }
        });
    };

    // Fetch immediately, then every 3 seconds.
    poll();
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [asset, marginCurrency]);

  return ticker;
}
