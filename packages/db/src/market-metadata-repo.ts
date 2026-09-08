// Versioned market-metadata storage — plan/phase-03 T03.8, phase-01 T01.4.
//
// One ingest writes one VERSION: a complete snapshot of every market the adapter
// could represent, under a single monotonic number, in one transaction. An order
// then records the version it was legalised against, which is what makes a
// rejection explainable months later — you can reload the exact numbers the
// decision saw instead of arguing about what they probably were.
//
// Two design points that are the whole reason this file is not a plain insert.
//
// The version comes from a SEQUENCE, not `max(version) + 1`. Two concurrent
// ingests reading the same maximum would both claim it and interleave two
// snapshots under one version, and a version that does not identify a single
// snapshot is worse than no version at all.
//
// Nothing is ever updated. The table has an append-only trigger, so a "refresh"
// is a new version and the old one stays readable forever. That matters most for
// `max_market_quantity`, which is depth-derived and moves (09 F6): the cap that
// refused an order last Tuesday is not the cap in force today, and only the
// stored version can tell you which one applied.

import { sql } from 'kysely';
import type { Kysely, Transaction } from 'kysely';
import type { MarketRules, OrderType } from '@tradex/exchange';
import type { DB, SupportedQuote } from './schema.js';

export class MarketMetadataError extends Error {
  override readonly name = 'MarketMetadataError';
}

export interface MarketMetadataSnapshot {
  /** The monotonic version every row in this ingest carries. */
  readonly version: string;
  readonly marketCount: number;
  readonly observedAt: Date;
  readonly source: string;
}

export interface IngestOptions {
  /** Where the snapshot came from, e.g. 'markets_details'. */
  readonly source: string;
  /** When the venue was observed — passed in, never read from a clock here. */
  readonly observedAt: Date;
  /**
   * Rows per INSERT statement. Postgres caps a statement at 65,535 bound
   * parameters and each market binds 20, so ~3,200 markets would be the hard
   * ceiling in one statement. Batching keeps a 999-market ingest comfortably
   * inside it and keeps the failure mode "one batch" rather than "everything".
   */
  readonly batchSize?: number | undefined;
}

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/** Fields the `venue_decimal` domain will reject if they are not plain decimals. */
const DECIMAL_FIELDS = [
  'quantityStep', 'minQuantity', 'maxQuantity', 'minPrice', 'maxPrice',
] as const satisfies readonly (keyof MarketRules)[];

const NULLABLE_DECIMAL_FIELDS = [
  'minMarketQuantity', 'maxMarketQuantity',
] as const satisfies readonly (keyof MarketRules)[];

/**
 * Reject a snapshot the database would reject, but with a message that names the
 * market and the field.
 *
 * This is not belt-and-braces. Phase 01 found 90 numeric fields in the live
 * response arriving in exponent form — `min_quantity: 1e-7`, `min_price: 1e-11`
 * — and `packages/money` refuses exponent notation on purpose. Without this,
 * a single unexpanded value fails the whole 999-row transaction with
 * "value for domain venue_decimal violates check constraint" and no clue which
 * of 999 markets caused it.
 */
function validate(rules: readonly MarketRules[]): void {
  if (rules.length === 0) {
    throw new MarketMetadataError('refusing to ingest an empty market snapshot — a version must describe a venue');
  }
  const bySymbol = new Set<string>();
  const byAssetQuote = new Set<string>();

  for (const r of rules) {
    if (bySymbol.has(r.venueSymbol)) {
      throw new MarketMetadataError(`${r.venueSymbol} appears twice in one snapshot`);
    }
    bySymbol.add(r.venueSymbol);

    const pair = `${r.market.asset}/${r.market.quote}`;
    if (byAssetQuote.has(pair)) {
      throw new MarketMetadataError(
        `two markets in one snapshot both trade ${pair} — market resolution could not choose between them (10 F3)`,
      );
    }
    byAssetQuote.add(pair);

    for (const f of DECIMAL_FIELDS) {
      const v = r[f];
      if (typeof v !== 'string' || !PLAIN_DECIMAL.test(v)) {
        throw new MarketMetadataError(
          `${r.venueSymbol}.${f} is ${String(v)}, which is not a plain decimal `
          + '— exponent notation must be expanded by the adapter before it reaches storage',
        );
      }
    }
    for (const f of NULLABLE_DECIMAL_FIELDS) {
      const v = r[f];
      if (v !== null && (typeof v !== 'string' || !PLAIN_DECIMAL.test(v))) {
        throw new MarketMetadataError(`${r.venueSymbol}.${f} is ${String(v)}, which is not a plain decimal or null`);
      }
    }
    if (!/^\d+$/.test(r.minNotionalMinor)) {
      throw new MarketMetadataError(
        `${r.venueSymbol}.minNotionalMinor is ${r.minNotionalMinor}; it must already be integer minor units`,
      );
    }
    if (r.allowedTypes.length === 0) {
      throw new MarketMetadataError(`${r.venueSymbol} has no representable order type; the adapter should have skipped it`);
    }
  }
}

const rowFor = (r: MarketRules, version: string, opts: IngestOptions): Record<string, unknown> => ({
  version,
  venue_symbol: r.venueSymbol,
  asset: r.market.asset,
  quote: r.market.quote,
  // Derived, because the venue's own string does not cross the adapter (D12).
  status: r.tradable ? 'active' : 'inactive',
  tradable: r.tradable,
  quantity_step: r.quantityStep,
  quantity_precision: r.quantityPrecision,
  price_precision: r.pricePrecision,
  min_quantity: r.minQuantity,
  max_quantity: r.maxQuantity,
  min_market_quantity: r.minMarketQuantity,
  max_market_quantity: r.maxMarketQuantity,
  min_notional_minor: r.minNotionalMinor,
  min_price: r.minPrice,
  max_price: r.maxPrice,
  order_types: [...r.allowedTypes],
  venue_code: r.venueCode,
  observed_at: opts.observedAt,
  source: opts.source,
});

/**
 * Write one complete, versioned snapshot. Returns the version allocated to it.
 *
 * All-or-nothing: the whole snapshot lands in one transaction, because a
 * half-written version would legalise some markets against new numbers and
 * others against nothing at all.
 */
export async function ingestMarketMetadata(
  db: Kysely<DB>,
  rules: readonly MarketRules[],
  opts: IngestOptions,
): Promise<MarketMetadataSnapshot> {
  validate(rules);
  const batchSize = opts.batchSize ?? 250;
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new MarketMetadataError(`batchSize must be a positive integer, got ${batchSize}`);
  }

  return db.transaction().execute(async (trx) => {
    const version = await nextVersion(trx);
    for (let i = 0; i < rules.length; i += batchSize) {
      const batch = rules.slice(i, i + batchSize).map((r) => rowFor(r, version, opts));
      await trx.insertInto('market_metadata').values(batch as never).execute();
    }
    return { version, marketCount: rules.length, observedAt: opts.observedAt, source: opts.source };
  });
}

/** Claim the next snapshot version. Monotonic, and race-free by construction. */
async function nextVersion(trx: Transaction<DB>): Promise<string> {
  const result = await sql<{ version: string }>`
    SELECT nextval('market_metadata_version_seq')::text AS version
  `.execute(trx);
  const row = result.rows[0];
  if (row === undefined) throw new MarketMetadataError('the version sequence returned no value');
  return row.version;
}

/** One tradable asset and the quote currencies it can be funded/traded in. */
export interface TradableAsset {
  readonly asset: string;
  readonly quotes: readonly string[];
}

/**
 * The tradable assets in the latest snapshot, each with the quote markets that
 * exist for it — the typeahead source for the trade ticket (T04.7). Only
 * `tradable` markets are listed, because an asset whose only markets are halted
 * cannot be traded right now and offering it would produce a guaranteed skip.
 */
export async function listTradableAssets(db: Kysely<DB>): Promise<readonly TradableAsset[]> {
  const version = await latestMarketMetadataVersion(db);
  if (version === null) return [];
  const rows = await db.selectFrom('market_metadata')
    .select(['asset', 'quote'])
    .where('version', '=', version)
    .where('tradable', '=', true)
    .orderBy('asset')
    .orderBy('quote')
    .execute();
  const byAsset = new Map<string, string[]>();
  for (const row of rows as ReadonlyArray<{ asset: string; quote: string }>) {
    const list = byAsset.get(row.asset) ?? [];
    list.push(row.quote);
    byAsset.set(row.asset, list);
  }
  return [...byAsset.entries()].map(([asset, quotes]) => ({ asset, quotes }));
}

/** The newest version present, or null when nothing has been ingested. */
export async function latestMarketMetadataVersion(db: Kysely<DB>): Promise<string | null> {
  const row = await db
    .selectFrom('market_metadata')
    .select(({ fn }) => fn.max('version').as('version'))
    .executeTakeFirst();
  const version = row?.version;
  return version === undefined || version === null ? null : String(version);
}

/**
 * Reload a snapshot as `MarketRules`, ready to hand straight to `size()`.
 *
 * `rulesVersion` on every returned market is the DB version, not whatever the
 * adapter called it at fetch time. That is the point: the number an order
 * records must be the number that identifies the stored snapshot, so a replay
 * can find it again.
 */
export async function loadMarketRules(
  db: Kysely<DB>,
  version: string,
): Promise<readonly MarketRules[]> {
  if (!/^\d+$/.test(version)) throw new MarketMetadataError(`not a version: ${version}`);
  const rows = await db
    .selectFrom('market_metadata')
    .selectAll()
    .where('version', '=', version)
    .orderBy('venue_symbol')
    .execute();

  return rows.map((row) => ({
    market: { asset: row.asset, quote: row.quote as SupportedQuote },
    venueSymbol: row.venue_symbol,
    tradable: row.tradable,
    quantityStep: row.quantity_step,
    quantityPrecision: row.quantity_precision,
    pricePrecision: row.price_precision,
    minQuantity: row.min_quantity,
    maxQuantity: row.max_quantity,
    minMarketQuantity: row.min_market_quantity,
    maxMarketQuantity: row.max_market_quantity,
    minNotionalMinor: row.min_notional_minor,
    minPrice: row.min_price,
    maxPrice: row.max_price,
    allowedTypes: row.order_types as readonly OrderType[],
    venueCode: row.venue_code,
    rulesVersion: String(row.version),
  }));
}

/** Header facts about a stored version, for a status page or a replay. */
export async function describeMarketMetadataVersion(
  db: Kysely<DB>,
  version: string,
): Promise<MarketMetadataSnapshot | null> {
  if (!/^\d+$/.test(version)) throw new MarketMetadataError(`not a version: ${version}`);
  const row = await db
    .selectFrom('market_metadata')
    .select(({ fn }) => [
      fn.countAll<string>().as('market_count'),
      fn.min('observed_at').as('observed_at'),
      fn.min('source').as('source'),
    ])
    .where('version', '=', version)
    .executeTakeFirst();
  if (row === undefined || row.observed_at === null) return null;
  return {
    version,
    marketCount: Number(row.market_count),
    observedAt: new Date(row.observed_at as unknown as string),
    source: String(row.source),
  };
}
