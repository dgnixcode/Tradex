/**
 * useLiveTicker — streams real-time best bid/ask from CoinDCX's public WebSocket.
 *
 * Connects to `wss://stream.coindcx.com` via socket.io-client (CoinDCX mandates
 * Socket.IO — see research/05-coindcx-websockets.md F1).
 *
 * Subscribes to the `{pair}@orderbook@10` channel which emits:
 *   - `depth-snapshot` every 2-3s with a full 10-level book
 *
 * The hook extracts the best bid and best ask from each snapshot and returns them.
 *
 * PUBLIC CHANNEL — no API key, no authentication, no approval required.
 *
 * NOTE: On localhost the browser may block the cross-origin WebSocket (CORS).
 * This works on the production domain where the Origin header is accepted.
 * For local dev, the "↻ Live price" REST button still works as a fallback.
 *
 * Key wire-format facts from research/05:
 *   - Transport MUST be `['websocket']` — long-polling is broken on both hosts.
 *   - Every event arrives as `{ event, data: "<stringified JSON>" }` — double parse.
 *   - Book sides are JSON objects keyed by price string, NOT sorted. Must sort.
 */
import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';

export interface LiveTicker {
  /** Best bid (highest buy order) — what you'd sell at. Decimal string or null. */
  readonly bestBid: string | null;
  /** Best ask (lowest sell order) — what you'd buy at. Decimal string or null. */
  readonly bestAsk: string | null;
  /** Millisecond timestamp of the last received snapshot. */
  readonly updatedAtMs: number | null;
  /** Whether the socket is currently connected. */
  readonly connected: boolean;
}

const SOCKET_URL = 'https://stream.coindcx.com';

/**
 * Build the CoinDCX pair identifier.
 * Spot INR: `I-BTC_INR`, Futures USDT: `B-BTC_USDT`.
 */
function toPair(asset: string, marginCurrency: 'INR' | 'USDT'): string {
  const ecode = marginCurrency === 'INR' ? 'I' : 'B';
  return `${ecode}-${asset}_${marginCurrency}`;
}

/**
 * Extract the highest-priced key from a price→quantity object.
 * CoinDCX sends book sides as `{ "81050.5": "0.03", "81049": "1.2" }`.
 * Key order is NOT guaranteed (V8 hoists integer-like keys — see research/05 C3).
 */
function bestPrice(side: Record<string, string>, direction: 'max' | 'min'): string | null {
  const prices = Object.keys(side);
  if (prices.length === 0) return null;
  let best = prices[0]!;
  for (let i = 1; i < prices.length; i++) {
    const p = prices[i]!;
    const cmp = Number(p) - Number(best);
    if (direction === 'max' ? cmp > 0 : cmp < 0) best = p;
  }
  return best;
}

/**
 * Hook: subscribe to live best-bid/ask for a trading pair.
 *
 * @param asset         e.g. 'BTC', 'ETH'. Empty string = no subscription.
 * @param marginCurrency 'INR' or 'USDT'.
 */
export function useLiveTicker(asset: string, marginCurrency: 'INR' | 'USDT'): LiveTicker {
  const [ticker, setTicker] = useState<LiveTicker>({
    bestBid: null, bestAsk: null, updatedAtMs: null, connected: false,
  });
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    if (asset === '') {
      setTicker({ bestBid: null, bestAsk: null, updatedAtMs: null, connected: false });
      return;
    }

    const pair = toPair(asset, marginCurrency);
    const channel = `${pair}@orderbook@10`;

    const socket = io(SOCKET_URL, {
      transports: ['websocket'],  // long-polling is broken on CoinDCX (VERIFIED)
      upgrade: false,
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10000,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setTicker((prev) => ({ ...prev, connected: true }));
      // Subscribe to the orderbook channel (public, no auth needed).
      socket.emit('join', { channelName: channel });
    });

    socket.on('disconnect', () => {
      setTicker((prev) => ({ ...prev, connected: false }));
    });

    // CoinDCX emits depth-snapshot every 2-3s with a full 10-level book.
    // Envelope: { event: "depth-snapshot", data: "<stringified JSON>" }
    socket.on('depth-snapshot', (envelope: { data?: string } | string) => {
      try {
        const raw = typeof envelope === 'string' ? envelope : (envelope.data ?? envelope);
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;

        // parsed.asks and parsed.bids are { "price": "qty", ... }
        const asks: Record<string, string> = parsed.asks ?? {};
        const bids: Record<string, string> = parsed.bids ?? {};

        const bid = bestPrice(bids, 'max');
        const ask = bestPrice(asks, 'min');
        const ts: number = parsed.ts ?? Date.now();

        setTicker({ bestBid: bid, bestAsk: ask, updatedAtMs: ts, connected: true });
      } catch {
        // Malformed frame — skip silently.
      }
    });

    return () => {
      socket.emit('leave', { channelName: channel });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [asset, marginCurrency]);

  return ticker;
}
