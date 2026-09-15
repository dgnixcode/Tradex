import type { FuturesTrailingSlTable, DB } from '@tradex/db';
import type { Kysely, Selectable } from 'kysely';

import type { MarketRef, OrderBook } from '@tradex/exchange';

// This is a simplified structural representation of the worker.
// A full implementation would require deep integration with @tradex/exchange for the WS connection.

export class TrailingSlEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly db: Kysely<DB>;
  private readonly updateProtectionPort: (venuePositionId: string, stopLossPrice: string) => Promise<void>;
  private readonly getOrderBook: (market: MarketRef, depth?: number) => Promise<OrderBook>;
  
  // High-water marks from the websocket feed, by pair
  private readonly livePrices = new Map<string, number>();

  constructor(
    db: Kysely<DB>,
    updateProtectionPort: (venuePositionId: string, stopLossPrice: string) => Promise<void>,
    getOrderBook: (market: MarketRef, depth?: number) => Promise<OrderBook>
  ) {
    this.db = db;
    this.updateProtectionPort = updateProtectionPort;
    this.getOrderBook = getOrderBook;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.evaluate(), 3000);
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

      const pairsToFetch = new Set(activeRows.map(r => r.pair));
      for (const pair of pairsToFetch) {
        // Simple regex to split pair into asset/quote for CoinDCX pairs (e.g. BTCUSDT)
        // This is a naive extraction for the stub.
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
          console.error(`Failed to fetch price for ${pair}`, err);
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
    const livePriceStr = this.livePrices.get(row.pair);
    if (livePriceStr === undefined) return;
    const livePrice = Number(livePriceStr);

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

  private async executeTrailingStep(row: Selectable<FuturesTrailingSlTable>, newHighWaterMark: number, newSlPrice: number): Promise<void> {
    await this.db.updateTable('futures_trailing_sl')
      .set({ status: 'updating' })
      .where('id', '=', row.id)
      .execute();

    try {
      const targetSlStr = newSlPrice.toFixed(2);
      await this.updateProtectionPort(row.venue_position_id, targetSlStr);

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
