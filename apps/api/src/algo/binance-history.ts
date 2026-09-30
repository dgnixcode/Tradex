// Binance historical candle downloader, local compressed storage, and synchronization worker.
// Sourced from Binance Vision public historical archive (4+ years of institutional-grade futures data).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { Kysely } from 'kysely';
import type { DB, TenantDb } from '@tradex/db';
import {
  recordCandleDataset,
  listCandleDatasets,
  updateWatchlistCoinProgress,
  upsertWatchlistCoin,
} from '@tradex/db';
import type { CandleData } from './algo-indicators.js';
import { fetchHistoricalCandles } from './algo-sdk.js';

export const DEFAULT_WATCHLIST_COINS = [
  'BTC',
  'ETH',
  'SOL',
  'DASH',
  'ZEC',
  'DOGE',
  'XRP',
  'AVAX',
  'BNB',
] as const;

export const SUPPORTED_CANDLE_TIMEFRAMES = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '4h',
] as const;

export type SupportedTimeframe = (typeof SUPPORTED_CANDLE_TIMEFRAMES)[number];

const BINANCE_VISION_BASE = 'https://data.binance.vision/data/futures/um';

/**
 * Normalizes any coin or pair representation to standard symbols.
 * Handles 'BTC', 'B-BTC_USDT', 'BTCUSDT', 'BTC_USDT', 'sol', etc.
 */
export function normalizeSymbol(input: string): {
  symbol: string;
  binancePair: string;
  tradexPair: string;
} {
  let cleaned = input.toUpperCase().trim();
  cleaned = cleaned.replace(/^B-/, '');
  cleaned = cleaned.replace(/_USDT$/, '');
  cleaned = cleaned.replace(/USDT$/, '');

  const symbol = cleaned;
  const binancePair = `${symbol}USDT`;
  const tradexPair = `B-${symbol}_USDT`;

  return { symbol, binancePair, tradexPair };
}

/**
 * Resolve the disk directory for compressed historical candles.
 */
export function getCandleDataDir(): string {
  const custom = process.env['CANDLE_DATA_DIR'];
  if (custom && custom.trim() !== '') {
    return path.resolve(custom.trim());
  }
  return path.resolve(process.cwd(), 'data', 'candles');
}

/**
 * Helper to ensure a directory exists synchronously.
 */
function ensureDirSync(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Extract decompressed CSV content from a ZIP buffer using standard PKZIP Central Directory.
 * Zero external dependencies, pure built-in Node.js buffers and zlib.
 */
export function extractZipCsv(buffer: Buffer): string {
  let eocdOffset = -1;
  // Search backward for End of Central Directory signature: 0x06054b50
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }

  if (eocdOffset === -1) {
    throw new Error('Invalid zip file: End of Central Directory (EOCD) not found');
  }

  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const cdEntries = buffer.readUInt16LE(eocdOffset + 10);

  let cur = cdOffset;
  for (let e = 0; e < cdEntries; e++) {
    if (buffer.readUInt32LE(cur) !== 0x02014b50) break;
    const compMethod = buffer.readUInt16LE(cur + 10);
    const compSize = buffer.readUInt32LE(cur + 20);
    const fnLen = buffer.readUInt16LE(cur + 28);
    const extraLen = buffer.readUInt16LE(cur + 30);
    const commentLen = buffer.readUInt16LE(cur + 32);
    const localHeaderOffset = buffer.readUInt32LE(cur + 42);

    const lhFnLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + lhFnLen + lhExtraLen;

    const compressed = buffer.subarray(dataOffset, dataOffset + compSize);
    let decompressed: Buffer;

    if (compMethod === 0) {
      decompressed = compressed;
    } else if (compMethod === 8) {
      decompressed = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported zip compression method: ${compMethod}`);
    }

    return decompressed.toString('utf8');
  }

  throw new Error('No files found inside zip archive');
}

/**
 * Parse standard Binance Kline CSV text into an array of CandleData.
 * Columns: open_time, open, high, low, close, volume, ...
 */
export function parseBinanceKlineCsv(csvText: string): CandleData[] {
  const lines = csvText.split('\n');
  const candles: CandleData[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;

    const parts = line.split(',');
    if (parts.length < 6) continue;

    const openTime = Number(parts[0]);
    if (isNaN(openTime) || openTime <= 0) {
      // Header line or corrupted row
      continue;
    }

    const open = Number(parts[1]);
    const high = Number(parts[2]);
    const low = Number(parts[3]);
    const close = Number(parts[4]);
    const volume = Number(parts[5]);

    if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume)) {
      continue;
    }

    candles.push({
      time: openTime,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  // Sort ascending by timestamp
  candles.sort((a, b) => a.time - b.time);
  return candles;
}

/**
 * Get file path for a monthly chunk on disk.
 */
export function getMonthlyChunkFilePath(
  binancePair: string,
  timeframe: string,
  year: number,
  month: number,
): { dir: string; gzFile: string; jsonFile: string } {
  const baseDir = getCandleDataDir();
  const dir = path.join(baseDir, binancePair, timeframe);
  const monthStr = String(month).padStart(2, '0');
  const filename = `${binancePair}-${timeframe}-${year}-${monthStr}`;
  const gzFile = path.join(dir, `${filename}.json.gz`);
  const jsonFile = path.join(dir, `${filename}.json`);

  return { dir, gzFile, jsonFile };
}

/**
 * Read candles from a chunk file if it exists on disk.
 */
export function readChunkFromDisk(
  binancePair: string,
  timeframe: string,
  year: number,
  month: number,
): CandleData[] | null {
  const { gzFile, jsonFile } = getMonthlyChunkFilePath(binancePair, timeframe, year, month);

  try {
    if (fs.existsSync(gzFile)) {
      const compressed = fs.readFileSync(gzFile);
      const jsonStr = zlib.gunzipSync(compressed).toString('utf8');
      return JSON.parse(jsonStr) as CandleData[];
    }

    if (fs.existsSync(jsonFile)) {
      const jsonStr = fs.readFileSync(jsonFile, 'utf8');
      return JSON.parse(jsonStr) as CandleData[];
    }
  } catch (err) {
    console.error(`[binance-history] failed reading chunk ${binancePair} ${timeframe} ${year}-${month}:`, err);
  }

  return null;
}

/**
 * Save candles to disk as a compressed .json.gz file.
 */
export function writeChunkToDisk(
  binancePair: string,
  timeframe: string,
  year: number,
  month: number,
  candles: CandleData[],
): string {
  const { dir, gzFile } = getMonthlyChunkFilePath(binancePair, timeframe, year, month);
  ensureDirSync(dir);

  const jsonStr = JSON.stringify(candles);
  const compressed = zlib.gzipSync(Buffer.from(jsonStr, 'utf8'), { level: 6 });
  fs.writeFileSync(gzFile, compressed);

  return gzFile;
}

/**
 * Download, parse, compress, and store a monthly kline chunk from Binance Vision.
 * Returns null if the month is unavailable (e.g. before coin listing).
 */
export async function downloadMonthlyChunk(
  binancePair: string,
  timeframe: string,
  year: number,
  month: number,
): Promise<CandleData[] | null> {
  // Check disk first
  const existing = readChunkFromDisk(binancePair, timeframe, year, month);
  if (existing && existing.length > 0) {
    return existing;
  }

  const monthStr = String(month).padStart(2, '0');
  const url = `${BINANCE_VISION_BASE}/monthly/klines/${binancePair}/${timeframe}/${binancePair}-${timeframe}-${year}-${monthStr}.zip`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20_000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);

    if (res.status === 404) {
      // Month not found or coin not yet traded during this month
      return null;
    }

    if (!res.ok) {
      throw new Error(`Binance Vision HTTP ${res.status} for ${url}`);
    }

    const arrayBuf = await res.arrayBuffer();
    const zipBuf = Buffer.from(arrayBuf);
    const csvText = extractZipCsv(zipBuf);
    const candles = parseBinanceKlineCsv(csvText);

    if (candles.length > 0) {
      writeChunkToDisk(binancePair, timeframe, year, month, candles);
    }

    return candles;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timeout downloading ${binancePair} ${timeframe} ${year}-${monthStr}`);
    }
    throw err;
  }
}

/**
 * Generate list of year and month pairs for past N years.
 */
export function generateMonthList(lookbackYears = 4): Array<{ year: number; month: number }> {
  const result: Array<{ year: number; month: number }> = [];
  const now = new Date();
  let currentYear = now.getUTCFullYear();
  let currentMonth = now.getUTCMonth() + 1; // 1-12

  // Binance monthly archives are complete up to previous month
  let y = currentYear;
  let m = currentMonth - 1;
  if (m < 1) {
    m = 12;
    y -= 1;
  }

  const totalMonths = lookbackYears * 12;
  for (let i = 0; i < totalMonths; i++) {
    result.push({ year: y, month: m });
    m -= 1;
    if (m < 1) {
      m = 12;
      y -= 1;
    }
  }

  return result;
}

/**
 * Background synchronization worker managing watchlist candle downloads.
 */
export class BinanceHistorySyncManager {
  private isProcessing = false;
  private queue: string[] = [];
  private currentCoin: string | null = null;
  private currentTimeframe: string | null = null;
  private currentYear: number | null = null;
  private currentMonth: number | null = null;
  private lastError: string | null = null;
  private lastCompletedCoin: string | null = null;

  constructor(private readonly db: Kysely<DB>) {}

  /**
   * Return current live synchronization telemetry.
   */
  getStatus() {
    return {
      isProcessing: this.isProcessing,
      queueLength: this.queue.length,
      currentCoin: this.currentCoin,
      currentTimeframe: this.currentTimeframe,
      currentYear: this.currentYear,
      currentMonth: this.currentMonth,
      lastError: this.lastError,
      lastCompletedCoin: this.lastCompletedCoin,
      storageDirectory: getCandleDataDir(),
    };
  }

  /**
   * Enqueue coins for background synchronization.
   */
  async enqueueCoins(
    symbols: string[],
    tdb?: TenantDb,
    lookbackYears = 4,
  ): Promise<{ enqueued: string[]; totalQueue: number }> {
    const enqueued: string[] = [];

    for (const raw of symbols) {
      const { symbol, binancePair } = normalizeSymbol(raw);
      if (!symbol) continue;

      if (tdb) {
        await upsertWatchlistCoin(tdb, {
          symbol,
          pair: binancePair,
          isActive: true,
        }).catch((err) => {
          console.error(`[binance-history] failed registering ${symbol} in watchlist_coin:`, err);
        });
      }

      if (!this.queue.includes(symbol) && this.currentCoin !== symbol) {
        this.queue.push(symbol);
        enqueued.push(symbol);
      }
    }

    if (!this.isProcessing && this.queue.length > 0) {
      this.startProcessingLoop(tdb, lookbackYears).catch((err) => {
        console.error('[binance-history] background processing loop error:', err);
      });
    }

    return { enqueued, totalQueue: this.queue.length };
  }

  /**
   * Background download loop executing one coin at a time.
   */
  private async startProcessingLoop(tdb?: TenantDb, lookbackYears = 4): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        const symbol = this.queue.shift()!;
        this.currentCoin = symbol;
        const { binancePair } = normalizeSymbol(symbol);
        const months = generateMonthList(lookbackYears);

        if (tdb) {
          await updateWatchlistCoinProgress(tdb, symbol, {
            syncStatus: 'syncing',
            lastSyncError: null,
          }).catch(() => {});
        }

        const syncedTimeframes: Record<string, { count: number; syncedAt: string }> = {};
        let totalCandles = 0;
        let earliestDate: Date | null = null;
        let latestDate: Date | null = null;

        // Process from higher timeframe to lower: 4h, 1h, 30m, 15m, 5m, 3m, 1m
        for (const tf of SUPPORTED_CANDLE_TIMEFRAMES) {
          this.currentTimeframe = tf;
          let tfCandleCount = 0;

          for (const { year, month } of months) {
            this.currentYear = year;
            this.currentMonth = month;

            try {
              // Check if dataset record exists in db first
              const datasetId = `${binancePair}_${tf}_${year}_${String(month).padStart(2, '0')}`;
              const { gzFile } = getMonthlyChunkFilePath(binancePair, tf, year, month);

              let candles: CandleData[] | null = null;
              if (fs.existsSync(gzFile)) {
                candles = readChunkFromDisk(binancePair, tf, year, month);
              } else {
                candles = await downloadMonthlyChunk(binancePair, tf, year, month);
              }

              if (candles && candles.length > 0) {
                tfCandleCount += candles.length;
                totalCandles += candles.length;

                const firstTime = candles[0]!.time;
                const lastTime = candles[candles.length - 1]!.time;

                const firstDt = new Date(firstTime);
                const lastDt = new Date(lastTime);

                if (!earliestDate || firstDt < earliestDate) earliestDate = firstDt;
                if (!latestDate || lastDt > latestDate) latestDate = lastDt;

                await recordCandleDataset(this.db, {
                  id: datasetId,
                  pair: binancePair,
                  symbol,
                  timeframe: tf,
                  year,
                  month,
                  barCount: candles.length,
                  startTime: firstTime,
                  endTime: lastTime,
                  filePath: gzFile,
                  source: 'binance',
                }).catch(() => {});
              }
            } catch (chunkErr) {
              console.warn(
                `[binance-history] failed chunk ${binancePair} ${tf} ${year}-${month}:`,
                chunkErr instanceof Error ? chunkErr.message : String(chunkErr),
              );
            }

            // Yield briefly to event loop between chunks
            await new Promise((resolve) => setTimeout(resolve, 20));
          }

          syncedTimeframes[tf] = {
            count: tfCandleCount,
            syncedAt: new Date().toISOString(),
          };

          if (tdb) {
            await updateWatchlistCoinProgress(tdb, symbol, {
              syncedTimeframes,
              totalCandlesCount: totalCandles,
              earliestCandleAt: earliestDate,
              latestCandleAt: latestDate,
            }).catch(() => {});
          }
        }

        if (tdb) {
          await updateWatchlistCoinProgress(tdb, symbol, {
            syncStatus: 'synced',
            syncedTimeframes,
            totalCandlesCount: totalCandles,
            earliestCandleAt: earliestDate,
            latestCandleAt: latestDate,
          }).catch(() => {});
        }

        this.lastCompletedCoin = symbol;
      }
    } catch (loopErr) {
      this.lastError = loopErr instanceof Error ? loopErr.message : String(loopErr);
      console.error('[binance-history] processing loop error:', loopErr);
    } finally {
      this.isProcessing = false;
      this.currentCoin = null;
      this.currentTimeframe = null;
      this.currentYear = null;
      this.currentMonth = null;
    }
  }
}

/**
 * Load contiguous historical candles for backtesting or algorithmic strategy analysis.
 * Stitches together Binance historical monthly chunks and recent live candles.
 */
export async function loadHistoricalCandles(
  db: Kysely<DB>,
  pair: string,
  timeframe = '5m',
  options: {
    limit?: number | undefined;
    startTime?: number | undefined;
    endTime?: number | undefined;
    lookbackMonths?: number | undefined;
    dataSource?: 'binance' | 'coindcx' | 'auto' | undefined;
  } = {},
): Promise<CandleData[]> {
  const { symbol, binancePair } = normalizeSymbol(pair);
  const limit = options.limit ?? 500;
  const dataSource = options.dataSource ?? 'auto';

  // If CoinDCX is explicitly selected or limit is very small (< 100), fetch live directly
  if (dataSource === 'coindcx') {
    return await fetchHistoricalCandles(pair, timeframe, limit);
  }

  // 1. Check datasets in database
  const datasets = await listCandleDatasets(db, binancePair, timeframe);

  if (datasets.length === 0) {
    // No pre-downloaded dataset in DB, attempt reading from disk directly if exists
    const months = generateMonthList(Math.min(4, Math.ceil((options.lookbackMonths ?? 12) / 12)))
      .slice(0, options.lookbackMonths ?? 12);
    const diskCandles: CandleData[] = [];

    for (const { year, month } of months) {
      let chunk = readChunkFromDisk(binancePair, timeframe, year, month);
      if (!chunk && (options.lookbackMonths ?? 0) <= 6) {
        // Fast on-demand fetch for small lookbacks if not yet synced
        try {
          chunk = await downloadMonthlyChunk(binancePair, timeframe, year, month);
        } catch {}
      }
      if (chunk && chunk.length > 0) {
        diskCandles.push(...chunk);
      }
    }

    if (diskCandles.length >= 25) {
      diskCandles.sort((a, b) => a.time - b.time);
      const MAX_CANDLES = 100_000;
      const effectiveLimit = options.limit ? Math.min(options.limit, MAX_CANDLES) : MAX_CANDLES;
      if (diskCandles.length > effectiveLimit) {
        return diskCandles.slice(diskCandles.length - effectiveLimit);
      }
      return diskCandles;
    }

    // Fallback to CoinDCX live candles
    return await fetchHistoricalCandles(pair, timeframe, limit);
  }

  // 2. Filter datasets by lookback months if specified
  let relevantDatasets = datasets;
  if (options.lookbackMonths && options.lookbackMonths > 0) {
    const targetMonths = new Set(
      generateMonthList(Math.min(4, Math.ceil(options.lookbackMonths / 12)))
        .slice(0, options.lookbackMonths)
        .map((m) => `${m.year}_${m.month}`)
    );
    relevantDatasets = datasets.filter((ds) => targetMonths.has(`${ds.year}_${ds.month}`));
  }

  // 3. Load candles from recorded datasets
  const allCandles: CandleData[] = [];
  for (const ds of relevantDatasets) {
    if (options.startTime && ds.endTime < options.startTime) continue;
    if (options.endTime && ds.startTime > options.endTime) continue;

    const chunk = readChunkFromDisk(binancePair, timeframe, ds.year, ds.month);
    if (chunk && chunk.length > 0) {
      allCandles.push(...chunk);
    }
  }

  // 4. Check if we should append recent live candles (e.g. current month)
  const now = Date.now();
  const latestRecordedTime = allCandles.length > 0 ? allCandles[allCandles.length - 1]!.time : 0;

  if (now - latestRecordedTime > 3_600_000) {
    try {
      const liveCandles = await fetchHistoricalCandles(pair, timeframe, 300);
      const filteredLive = liveCandles.filter((c) => c.time > latestRecordedTime);
      allCandles.push(...filteredLive);
    } catch {
      // If live fetch fails, proceed with available historical candles
    }
  }

  // Sort and deduplicate sequentially by timestamp (avoids allocating millions of Set entries)
  allCandles.sort((a, b) => a.time - b.time);

  const deduped: CandleData[] = [];
  for (let i = 0; i < allCandles.length; i++) {
    const c = allCandles[i]!;
    if (deduped.length === 0 || c.time > deduped[deduped.length - 1]!.time) {
      deduped.push(c);
    }
  }

  // Safety guardrail: cap at 100,000 candles to guarantee low memory usage (~10MB RAM)
  const MAX_CANDLES = 100_000;
  const effectiveLimit = options.limit ? Math.min(options.limit, MAX_CANDLES) : MAX_CANDLES;

  if (deduped.length > effectiveLimit) {
    return deduped.slice(deduped.length - effectiveLimit);
  }

  return deduped;
}
