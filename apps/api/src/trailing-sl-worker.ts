import { readPlatformFlags } from '@tradex/db';
import type { FuturesTrailingSlTable, DB } from '@tradex/db';
import type { Kysely, Selectable } from 'kysely';
import type { MarketRef, OrderBook } from '@tradex/exchange';
import { getLivePrices, isWsFeedConnected, livePriceObservedAt } from './futures/ws-prices.js';
import { roePositionBasis, roeTrailingTarget } from './futures/roe-trailing.js';

const precision = 10n ** 18n;
const decimal = (value: string): bigint => {
  if (!/^\d+(\.\d{1,18})?$/.test(value)) throw new Error('Invalid trailing price');
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * precision + BigInt(fraction.padEnd(18, '0'));
};
const plain = (value: bigint): string => {
  const s = value.toString().padStart(19, '0');
  return `${s.slice(0, -18)}.${s.slice(-18)}`.replace(/\.?0+$/, '');
};

/** Favorable extremes and monotonic stops for BOTH longs and shorts, on the venue tick. */
export function trailingTarget(args: { live: string; extreme: string; current: string; short: boolean; distanceBp: string; stepBp: string; tick: string }): { extreme: string; stop: string | null } {
  const live = decimal(args.live), old = decimal(args.extreme), current = decimal(args.current), tick = decimal(args.tick);
  const distance = BigInt(args.distanceBp), step = BigInt(args.stepBp);
  if (live <= 0n || current <= 0n || tick <= 0n || distance < 1n || distance > 10_000n || step < 1n || step > 10_000n) throw new Error('Invalid trailing configuration');
  const extreme = args.short ? (live < old ? live : old) : (live > old ? live : old);
  const numerator = extreme * (10_000n + (args.short ? distance : -distance));
  const divisor = 10_000n * tick;
  const target = (args.short ? (numerator + divisor - 1n) / divisor : numerator / divisor) * tick;
  const moved = args.short ? target < current && target * 10_000n <= current * (10_000n - step)
    : target > current && target * 10_000n >= current * (10_000n + step);
  const valid = target > 0n && (args.short ? target > live : target < live);
  return { extreme: plain(extreme), stop: moved && valid ? plain(target) : null };
}

export interface TrailingSlStepArgs {
  readonly tenantId: string;
  readonly accountId: string;
  readonly venuePositionId: string;
  readonly stopLossPrice: string;
  readonly positionBasisKey?: string;
  readonly expectedSlPrice?: string;
  readonly evaluationClaimAt?: string;
}

export type UpdateProtectionPort = (
  args: TrailingSlStepArgs
) => Promise<{ readonly ok: boolean; readonly reason?: string | undefined } | void>;

export class TrailingSlEngine {
  private timer: ReturnType<typeof setInterval> | null = null;
  private evaluating = false;
  private lastBasisRefresh = 0;
  private basisRefreshing = false;
  private readonly db: Kysely<DB>;
  private readonly updateProtectionPort: UpdateProtectionPort;
  private readonly getOrderBook?: ((market: MarketRef, depth?: number) => Promise<OrderBook>) | undefined;
  
  // High-water marks from the websocket feed, by pair
  private readonly livePrices = new Map<string, string>();

  constructor(
    db: Kysely<DB>,
    updateProtectionPort: UpdateProtectionPort,
    getOrderBook?: (market: MarketRef, depth?: number) => Promise<OrderBook>,
    private readonly getPriceTick?: ((pair: string, margin: 'INR' | 'USDT') => Promise<string>) | undefined,
    private readonly refreshPositions?: ((targets: readonly { tenantId: string; accountId: string }[]) => Promise<void>) | undefined,
  ) {
    this.db = db;
    this.updateProtectionPort = updateProtectionPort;
    this.getOrderBook = getOrderBook;
  }

  public start(): void {
    if (this.timer) return;
    // Evaluate every 1000ms using sub-100ms in-memory WebSocket price feed
    this.timer = setInterval(() => {
      if (this.evaluating) return;
      this.evaluating = true;
      void this.evaluate().finally(() => { this.evaluating = false; });
    }, 1000);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async evaluate(): Promise<void> {
    if (process.env['TRADEX_KILL_SWITCH'] === '1') return;
    try {
      const platform = await readPlatformFlags(this.db);
      if (platform.killSwitch || platform.mode === 'read_only') return;
    } catch {
      return;
    }

    try {
      const activeRows = await this.db.selectFrom('futures_trailing_sl')
        .selectAll()
        .where('status', '=', 'active')
        .execute();

      if (activeRows.length === 0) return;
      const roeRows = activeRows.filter((row) => row.step_basis === 'roe');
      if (roeRows.length > 0 && this.refreshPositions && !this.basisRefreshing && Date.now() - this.lastBasisRefresh >= 15_000) {
        this.lastBasisRefresh = Date.now();
        this.basisRefreshing = true;
        // Collateral reads run independently of the one-second price loop. Each
        // actual stop replacement also rechecks its basis under the action lock.
        void this.refreshPositions(roeRows.map((row) => ({ tenantId: row.tenant_id, accountId: row.account_id })))
          .catch((error: unknown) => console.error('Trailing position refresh failed', error))
          .finally(() => { this.basisRefreshing = false; });
      }

      const wsPrices = getLivePrices();
      const wsConnected = isWsFeedConnected() && wsPrices.size > 0;

      const pairsToFetch = new Set(activeRows.map((r) => r.pair));
      this.livePrices.clear();
      await Promise.all([...pairsToFetch].map(async (pair) => {
        // Primary: read from real-time WebSocket cache in memory (0ms network latency)
        const wsPrice = wsPrices.get(pair);
        if (wsConnected && wsPrice && Date.now() - livePriceObservedAt(pair) <= 5000) {
          const p = wsPrice.markPrice || wsPrice.lastPrice;
          if (/^\d+(\.\d{1,18})?$/.test(p) && /[1-9]/.test(p)) {
            this.livePrices.set(pair, p);
            return;
          }
        }

        // Fallback: REST orderbook fetch only if WebSocket feed is offline
        if (this.getOrderBook) {
          let quote: 'INR' | 'USDT' = 'USDT';
          let asset = pair.replace(/^[A-Z]+-/, '').split('_')[0] ?? pair;
          if (pair.endsWith('INR')) quote = 'INR';
          if (!pair.includes('_')) asset = asset.replace(/(USDT|INR)$/, '');

          try {
            const book = await this.getOrderBook({ asset, quote }, 1);
            const price = book.bids[0]?.price ?? book.asks[0]?.price;
            if (price !== undefined && Date.now() - book.observedAtMs <= 5000) {
              this.livePrices.set(pair, price);
            }
          } catch (err) {
            console.error(`Failed to fetch fallback price for ${pair}`, err);
          }
        }
      }));

      await Promise.all(activeRows.map((row) => this.evaluateRow(row).catch((error: unknown) => console.error('Trailing evaluation failed', error))));
    } catch (err) {
      console.error('TrailingSlEngine loop failed', err);
    }
  }

  private async evaluateRow(row: Selectable<FuturesTrailingSlTable>): Promise<void> {
    const live = this.livePrices.get(row.pair);
    if (live === undefined || !this.getPriceTick) return;
    const position = await this.db.selectFrom('futures_position').select(['active_pos', 'margin_currency', 'pair', 'locked_margin_minor', 'settlement_currency_avg_price', 'avg_entry_price', 'updated_at'])
      .where('tenant_id', '=', row.tenant_id).where('account_id', '=', row.account_id)
      .where('venue_position_id', '=', row.venue_position_id).executeTakeFirst();
    if (!position || /^-?0+(\.0+)?$/.test(position.active_pos)) return;
    const tick = await this.getPriceTick(row.pair, position.margin_currency);
    if (row.step_basis === 'roe') {
      // Never trail using stale collateral/size after an external position change.
      const observedAt = new Date(position.updated_at as unknown as Date).getTime();
      if (!Number.isFinite(observedAt) || Date.now() - observedAt > 60_000) return;
      const basis = roePositionBasis({ activePos: position.active_pos, pair: position.pair,
        marginCurrency: position.margin_currency, lockedMarginMinor: position.locked_margin_minor,
        settlementCurrencyAvgPrice: position.settlement_currency_avg_price, avgEntryPrice: position.avg_entry_price });
      if (row.position_basis_key !== basis.key || !row.step_anchor_price) {
        // A funding, margin, size or entry change is not profit. Rebase without
        // changing the protected stop or carrying an old peak into the new basis.
        await this.db.updateTable('futures_trailing_sl').set({ position_basis_key: basis.key,
          step_anchor_price: live, high_water_mark: live, last_evaluated_at: new Date() })
          .where('id', '=', row.id).where('status', '=', 'active')
          .where('last_evaluated_at', '=', row.last_evaluated_at)
          .where('current_sl_price', '=', row.current_sl_price).where('high_water_mark', '=', row.high_water_mark).execute();
        return;
      }
      const target = roeTrailingTarget({ live, extreme: row.high_water_mark, current: row.current_sl_price,
        anchor: row.step_anchor_price, short: position.active_pos.startsWith('-'), stepBp: row.step_bp, tick, basis });
      if (target.stop !== null) await this.executeTrailingStep(row, target.extreme, target.stop, target.anchor, basis.key);
      else if (target.extreme !== row.high_water_mark) {
        await this.db.updateTable('futures_trailing_sl').set({ high_water_mark: target.extreme, last_evaluated_at: new Date() })
          .where('id', '=', row.id).where('status', '=', 'active').where('current_sl_price', '=', row.current_sl_price)
          .where('last_evaluated_at', '=', row.last_evaluated_at)
          .where('step_anchor_price', '=', row.step_anchor_price).where('position_basis_key', '=', basis.key)
          .where('high_water_mark', '=', row.high_water_mark).execute();
      }
      return;
    }
    const target = trailingTarget({ live, extreme: row.high_water_mark, current: row.current_sl_price,
      short: position.active_pos.startsWith('-'), distanceBp: row.distance_bp, stepBp: row.step_bp, tick });
    if (target.stop !== null) await this.executeTrailingStep(row, target.extreme, target.stop);
    else if (target.extreme !== row.high_water_mark) {
        await this.db.updateTable('futures_trailing_sl')
          .set({ high_water_mark: target.extreme, last_evaluated_at: new Date() })
          .where('id', '=', row.id)
          .where('status', '=', 'active').where('high_water_mark', '=', row.high_water_mark)
          .where('current_sl_price', '=', row.current_sl_price)
          .execute();
    }
  }

  private async executeTrailingStep(
    row: Selectable<FuturesTrailingSlTable>,
    newHighWaterMark: string,
    targetSlStr: string,
    stepAnchor?: string,
    basisKey?: string,
  ): Promise<void> {
    const claimedAt = new Date();
    let claim = this.db.updateTable('futures_trailing_sl')
      .set({ status: 'updating', last_evaluated_at: claimedAt })
      .where('id', '=', row.id)
      .where('last_evaluated_at', '=', row.last_evaluated_at)
      .where('status', '=', 'active').where('high_water_mark', '=', row.high_water_mark)
      .where('current_sl_price', '=', row.current_sl_price);
    if (basisKey && row.step_anchor_price) claim = claim.where('position_basis_key', '=', basisKey).where('step_anchor_price', '=', row.step_anchor_price);
    const claimed = await claim.returning('id').executeTakeFirst();
    if (!claimed) return;

    try {
      const res = await this.updateProtectionPort({
        tenantId: row.tenant_id,
        accountId: row.account_id,
        venuePositionId: row.venue_position_id,
        stopLossPrice: targetSlStr,
        ...(basisKey ? { positionBasisKey: basisKey, expectedSlPrice: row.current_sl_price, evaluationClaimAt: claimedAt.toISOString() } : {}),
      });

      if ((res && res.ok === false) || (basisKey && (!res || res.ok !== true))) {
        const reason = res?.reason ?? 'Stop update was not confirmed';
        console.error(`[TrailingSL] Exchange refused step for position ${row.venue_position_id}: ${reason}`);
        await this.db.updateTable('futures_trailing_sl')
          .set({ status: reason === 'position_basis_changed' ? 'active' : 'failed', last_evaluated_at: new Date() })
          .where('id', '=', row.id)
          .where('status', '=', 'updating').where('last_evaluated_at', '=', claimedAt)
          .execute();
        return;
      }

      await this.db.updateTable('futures_trailing_sl')
        .set({ 
          high_water_mark: String(newHighWaterMark),
          current_sl_price: targetSlStr,
          ...(stepAnchor ? { step_anchor_price: stepAnchor } : {}),
          status: 'active',
          last_evaluated_at: new Date()
        })
        .where('id', '=', row.id)
        .where('status', '=', 'updating').where('last_evaluated_at', '=', claimedAt)
        .execute();
    } catch (err) {
      console.error('Failed to step TSL for ' + row.venue_position_id, err);
      await this.db.updateTable('futures_trailing_sl')
        .set({ status: 'failed', last_evaluated_at: new Date() })
        .where('id', '=', row.id)
        .where('status', '=', 'updating').where('last_evaluated_at', '=', claimedAt)
        .execute();
    }
  }
}
