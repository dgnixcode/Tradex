// WebSocket-based real-time futures price feed from CoinDCX.
//
// Connects to CoinDCX's public Socket.IO endpoint and subscribes to
// the `currentPrices@futures@rt` channel for sub-100ms price updates.
// Merges incremental deltas into the shared in-memory price map from rt-prices.ts.
//
// Also exposes an EventEmitter so the SSE relay endpoint can push diffs to browsers.

import { io, type Socket } from 'socket.io-client';
import { EventEmitter } from 'node:events';
import type { FuturesRtPrice } from './rt-prices.js';

const WS_ENDPOINT = 'wss://stream.coindcx.com';
const CHANNEL = 'currentPrices@futures@rt';
const EVENT = 'currentPrices@futures#update';

// The shared in-memory price map.  Initialised empty; the first REST fetch or
// the first WS update will populate it.
const livePrices = new Map<string, FuturesRtPrice>();

// EventEmitter for SSE relay.  Each `update` event carries the incremental diff
// as a Record<string, FuturesRtPrice> so subscribers can push only changed pairs.
export const priceEmitter = new EventEmitter();
priceEmitter.setMaxListeners(100); // support many SSE connections

let socket: Socket | null = null;
let connected = false;

/** Whether the WebSocket feed is currently connected and receiving data. */
export function isWsFeedConnected(): boolean {
  return connected;
}

/** Read the live in-memory price map (populated by WS or REST fallback). */
export function getLivePrices(): Map<string, FuturesRtPrice> {
  return livePrices;
}

/** Seed the live map from a REST fetch (called on startup before WS connects). */
export function seedPrices(prices: Map<string, FuturesRtPrice>): void {
  for (const [k, v] of prices.entries()) {
    livePrices.set(k, v);
  }
}

/** Start the persistent WebSocket connection to CoinDCX. Idempotent. */
export function startWsPriceFeed(): void {
  if (socket !== null) return;

  console.log('[ws-prices] connecting to', WS_ENDPOINT);

  socket = io(WS_ENDPOINT, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionDelayMax: 10000,
    timeout: 10000,
  });

  socket.on('connect', () => {
    connected = true;
    console.log('[ws-prices] connected, joining channel', CHANNEL);
    socket!.emit('join', { channelName: CHANNEL });
  });

  let hasLoggedFirstUpdate = false;

  socket.on(EVENT, (response: unknown) => {
    try {
      let payload = response;
      // CoinDCX often wraps payload in { data: ... }
      if (typeof payload === 'object' && payload !== null && 'data' in payload) {
        payload = (payload as { data: unknown }).data;
      }
      // If payload is a JSON string, parse it
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch {
          return;
        }
      }

      const data = payload as { prices?: Record<string, Record<string, unknown>> };
      if (!data || typeof data.prices !== 'object' || data.prices === null) return;

      const diff: Record<string, FuturesRtPrice> = {};
      let count = 0;

      for (const [pair, val] of Object.entries(data.prices)) {
        if (!val || typeof val !== 'object') continue;
        const mp = val['mp'];
        const ls = val['ls'];
        const pc = val['pc'];
        // Only update if we have a mark price
        if (mp !== undefined && mp !== null) {
          const entry: FuturesRtPrice = {
            markPrice: String(mp),
            lastPrice: ls !== undefined && ls !== null ? String(ls) : String(mp),
            priceChangePercent: typeof pc === 'number' ? pc : (livePrices.get(pair)?.priceChangePercent ?? 0),
          };
          livePrices.set(pair, entry);
          diff[pair] = entry;
          count++;
        }
      }

      if (count > 0) {
        if (!hasLoggedFirstUpdate) {
          console.log('[ws-prices] received live price stream update:', count, 'pairs, total cached pairs:', livePrices.size);
          hasLoggedFirstUpdate = true;
        }
        priceEmitter.emit('update', diff);
      }
    } catch {
      // Malformed data — ignore
    }
  });

  socket.on('disconnect', (reason: string) => {
    connected = false;
    console.log('[ws-prices] disconnected:', reason);
  });

  socket.on('connect_error', (err: Error) => {
    connected = false;
    console.log('[ws-prices] connection error:', err.message);
  });
}

/** Gracefully shut down the WebSocket connection. */
export function stopWsPriceFeed(): void {
  if (socket !== null) {
    socket.emit('leave', { channelName: CHANNEL });
    socket.disconnect();
    socket = null;
    connected = false;
    console.log('[ws-prices] stopped');
  }
}
