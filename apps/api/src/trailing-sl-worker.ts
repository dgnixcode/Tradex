import type { FuturesTrailingSlTable, DB } from '@tradex/db';
import type { Kysely, Selectable } from 'kysely';
import type { MarketRef, OrderBook } from '@tradex/exchange';
import { getLivePrices, isWsFeedConnected } from './futures/ws-prices.js';

export interface TrailingSlStepArgs {
  readonly tenantId: string;
  readonly accountId: string;
  readonly venuePositionId: string;
  readonly stopLossPrice: string;
}

export type UpdateProtectionPort = (
  args: TrailingSlStepArgs
) => Promise<{ readonly ok: boolean; readonly reason?: string | undefined } | void>;

export class TrailingSlEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly db: Kysely<DB>;
  private readonly updateProtectionPort: UpdateProtectionPort;
  private readonly getOrderBook?: ((market: MarketRef, depth?: number) => Promise<OrderBook>) | undefined;
  
  // High-water marks from the websocket feed, by pair
  private readonly livePrices = new Map<string, number>();

  constructor(
    db: Kysely<DB>,
    updateProtectionPort: UpdateProtectionPort,
    getOrderBook?: (market: MarketRef, depth?: number) => Promise<OrderBook>
  ) {
    this.db = db;
    this.updateProtectionPort = updateProtectionPort;
    this.getOrderBook = getOrderBook;
  }

  public start(): void {
    if (this.timer) return;
    // Evaluate every 1000ms using sub-100ms in-memory WebSocket price feed
    this.timer = setInterval(() => void this.evaluate(), 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async evaluate(): Promise<void> {
    try {
      const activeRows = await this.db.selectFrom('futures_trailing_sl')
        .selectAll()
        .where('status', '=', 'active')
        .execute();

      if (activeRows.length === 0) return;

      const wsPrices = getLivePrices();
      const wsConnected = isWsFeedConnected() && wsPrices.size > 0;

      const pairsToFetch = new Set(activeRows.map((r) => r.pair));
      for (const pair of pairsToFetch) {
        // Primary: read from real-time WebSocket cache in memory (0ms network latency)
        const wsPrice = wsPrices.get(pair);
        if (wsPrice) {
          const p = Number(wsPrice.lastPrice || wsPrice.markPrice);
          if (!isNaN(p) && p > 0) {
            this.livePrices.set(pair, p);
            continue;
          }
        }

        // Fallback: REST orderbook fetch only if WebSocket feed is offline
        if (!wsConnected && this.getOrderBook) {
          let quote: 'INR' | 'USDT' = 'USDT';
          let asset = pair;
          if (pair.endsWith('USDT')) { quote = 'USDT'; asset = pair.slice(0, -4); }
          else if (pair.endsWith('INR')) { quote = 'INR'; asset = pair.slice(0, -3); }

          try {
            const book = await this.getOrderBook({ asset, quote }, 1);
            const price = book.bids[0]?.price ?? book.asks[0]?.price;
            if (price !== undefined) {
              this.livePrices.set(pair, Number(price));
            }
          } catch (err) {
            console.error(`Failed to fetch fallback price for ${pair}`, err);
          }
        }
      }

      for (const row of activeRows) {
        await this.evaluateRow(row);
      }
    } catch (err) {
      console.error('TrailingSlEngine loop failed', err);
    }
  }

  private async evaluateRow(row: Selectable<FuturesTrailingSlTable>): Promise<void> {
    const livePriceNum = this.livePrices.get(row.pair);
    if (livePriceNum === undefined) return;
    const livePrice = Number(livePriceNum);

    const highWaterMark = Number(row.high_water_mark);
    const stepBp = Number(row.step_bp);
    const distanceBp = Number(row.distance_bp);
    const currentSl = Number(row.current_sl_price);

    if (livePrice > highWaterMark) {
      const newHighWaterMark = livePrice;
      const targetSlPrice = newHighWaterMark * (1 - (distanceBp / 10000));
      
      const stepThreshold = currentSl * (1 + (stepBp / 10000));
      
      if (targetSlPrice >= stepThreshold) {
        await this.executeTrailingStep(row, newHighWaterMark, targetSlPrice);
      } else {
        await this.db.updateTable('futures_trailing_sl')
          .set({ high_water_mark: String(newHighWaterMark), last_evaluated_at: new Date() })
          .where('id', '=', row.id)
          .execute();
      }
    }
  }

  private async executeTrailingStep(
    row: Selectable<FuturesTrailingSlTable>,
    newHighWaterMark: number,
    newSlPrice: number
  ): Promise<void> {
    await this.db.updateTable('futures_trailing_sl')
      .set({ status: 'updating' })
      .where('id', '=', row.id)
      .execute();

    try {
      const decimals = row.current_sl_price.includes('.') ? row.current_sl_price.split('.')[1]!.length : 2;
      const targetSlStr = newSlPrice.toFixed(Math.min(8, Math.max(2, decimals)));
      
      const res = await this.updateProtectionPort({
        tenantId: row.tenant_id,
        accountId: row.account_id,
        venuePositionId: row.venue_position_id,
        stopLossPrice: targetSlStr,
      });

      if (res && res.ok === false) {
        console.error(`[TrailingSL] Exchange refused step for position ${row.venue_position_id}: ${res.reason ?? 'unknown'}`);
        await this.db.updateTable('futures_trailing_sl')
          .set({ status: 'active', last_evaluated_at: new Date() })
          .where('id', '=', row.id)
          .execute();
        return;
      }

      await this.db.updateTable('futures_trailing_sl')
        .set({ 
          high_water_mark: String(newHighWaterMark),
          current_sl_price: targetSlStr,
          status: 'active',
          last_evaluated_at: new Date()
        })
        .where('id', '=', row.id)
        .execute();
    } catch (err) {
      console.error('Failed to step TSL for ' + row.venue_position_id, err);
      await this.db.updateTable('futures_trailing_sl')
        .set({ status: 'active', last_evaluated_at: new Date() })
        .where('id', '=', row.id)
        .execute();
    }
  }
}
