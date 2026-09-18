// Real-time price streaming hook using Server-Sent Events (SSE).
//
// Opens a persistent EventSource connection to `/api/futures/prices/stream`.
// Merges incoming price diffs into the React Query cache so WatchlistPanel
// and Futures positions page update in near-real-time (sub-500ms).
//
// Falls back gracefully: if SSE connection fails or is not available,
// the existing HTTP polling (refetchInterval: 1000) continues working.

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FuturesPricesResponse, FuturesRtPriceItem } from './api.ts';

export interface LivePricesStatus {
  readonly isStreaming: boolean;
}

/**
 * Subscribe to real-time price diffs via SSE and merge them into the
 * `futures-prices` query cache. Call this once in a top-level component
 * (e.g. the Trade or Futures page) that needs live prices.
 */
export function useLivePrices(): LivePricesStatus {
  const qc = useQueryClient();
  const [isStreaming, setIsStreaming] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;

    const connect = () => {
      if (!active) return;

      // Clean up any existing connection
      if (esRef.current !== null) {
        esRef.current.close();
        esRef.current = null;
      }

      const es = new EventSource('/api/futures/prices/stream');
      esRef.current = es;

      es.onopen = () => {
        if (active) setIsStreaming(true);
      };

      es.onmessage = (event) => {
        if (active) setIsStreaming(true);
        try {
          const data = JSON.parse(event.data) as {
            type: 'snapshot' | 'diff';
            prices: Record<string, FuturesRtPriceItem>;
            observedAtMs: number;
          };

          if (data.type === 'snapshot') {
            // Full snapshot — replace the entire cache
            qc.setQueryData<FuturesPricesResponse>(['futures-prices'], {
              prices: data.prices,
              observedAtMs: data.observedAtMs,
            });
          } else if (data.type === 'diff') {
            // Incremental diff — merge into existing cache
            qc.setQueryData<FuturesPricesResponse>(['futures-prices'], (prev) => {
              if (!prev) {
                return { prices: data.prices, observedAtMs: data.observedAtMs };
              }
              return {
                prices: { ...prev.prices, ...data.prices },
                observedAtMs: data.observedAtMs,
              };
            });
          }
        } catch {
          // Malformed event — ignore
        }
      };

      es.onerror = () => {
        // Connection lost — close and retry after a delay
        if (active) setIsStreaming(false);
        es.close();
        esRef.current = null;
        if (active) {
          retryTimeoutRef.current = setTimeout(connect, 3000);
        }
      };
    };

    connect();

    return () => {
      active = false;
      setIsStreaming(false);
      if (esRef.current !== null) {
        esRef.current.close();
        esRef.current = null;
      }
      if (retryTimeoutRef.current !== null) {
        clearTimeout(retryTimeoutRef.current);
        retryTimeoutRef.current = null;
      }
    };
  }, [qc]);

  return { isStreaming };
}
