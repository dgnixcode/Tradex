// Versioned market-metadata ingest — plan/phase-03 T03.8, phase-01 T01.4.
//
// Loads a `markets_details` capture, maps it through the adapter, and writes one
// complete versioned snapshot into `market_metadata`. This is the phase-03
// precondition ("market_metadata populated and versioned") and the thing that
// lets an order record the version it was legalised against.
//
// Usage:
//   node --env-file-if-exists=.env scripts/ingest-market-metadata.mjs
//   node --env-file-if-exists=.env scripts/ingest-market-metadata.mjs --file path/to/capture.json
//   node --env-file-if-exists=.env scripts/ingest-market-metadata.mjs --force
//   node --env-file-if-exists=.env scripts/ingest-market-metadata.mjs --status
//
// By default an ingest that would produce a snapshot IDENTICAL to the newest
// stored one is skipped. The table is append-only, so without that guard every
// run would burn a version and the version number would stop meaning "the
// metadata changed" — which is the only thing it is useful for. `--force` writes
// a new version regardless.
//
// `observed_at` is when the VENUE was observed, not when this script ran. For the
// captured fixture that is its documented capture date, so re-running the script
// tomorrow does not claim to have seen the venue tomorrow.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import {
  describeMarketMetadataVersion, ingestMarketMetadata, latestMarketMetadataVersion, loadMarketRules,
} from '../packages/db/dist/index.js';
import { mapMarketsDetails } from '../packages/exchange-coindcx/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = join(root, 'checks', 'fixtures', 'markets_details.json');
/** The documented capture date of the committed fixture (09 F6, 01 T01.4). */
const DEFAULT_OBSERVED_AT = '2026-09-04T00:00:00.000Z';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 || args[i + 1] === undefined ? fallback : args[i + 1];
};

const file = resolve(value('file', DEFAULT_FILE));
const observedAt = new Date(value('observed-at', DEFAULT_OBSERVED_AT));
const source = value('source', 'markets_details');

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set. PostgreSQL is required to ingest market metadata.');
  process.exit(2);
}
if (Number.isNaN(observedAt.getTime())) {
  console.error(`--observed-at is not a date: ${value('observed-at', DEFAULT_OBSERVED_AT)}`);
  process.exit(2);
}

/** Field-by-field equality, ignoring rulesVersion, which the DB restamps. */
const SHAPE = [
  'venueSymbol', 'tradable', 'quantityStep', 'quantityPrecision', 'pricePrecision',
  'minQuantity', 'maxQuantity', 'minMarketQuantity', 'maxMarketQuantity',
  'minNotionalMinor', 'minPrice', 'maxPrice', 'venueCode',
];

const sameMarket = (a, b) => {
  if (a.market.asset !== b.market.asset || a.market.quote !== b.market.quote) return false;
  for (const f of SHAPE) if (a[f] !== b[f]) return false;
  if (a.allowedTypes.length !== b.allowedTypes.length) return false;
  return a.allowedTypes.every((t, i) => t === b.allowedTypes[i]);
};

const sameSnapshot = (a, b) => {
  if (a.length !== b.length) return false;
  const bySymbol = new Map(b.map((r) => [r.venueSymbol, r]));
  return a.every((r) => {
    const other = bySymbol.get(r.venueSymbol);
    return other !== undefined && sameMarket(r, other);
  });
};

const pool = new pg.Pool({ connectionString: url, max: 2 });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

try {
  const latest = await latestMarketMetadataVersion(db);

  if (flag('status')) {
    if (latest === null) {
      console.log('market_metadata is empty — no version has been ingested');
    } else {
      const header = await describeMarketMetadataVersion(db, latest);
      console.log(`latest version ${latest}: ${header.marketCount} markets,`
        + ` observed ${header.observedAt.toISOString()}, source ${header.source}`);
    }
    process.exit(0);
  }

  const { rules, skipped } = mapMarketsDetails(readFileSync(file, 'utf8'), 'pending');
  console.log(`read ${file}`);
  console.log(`mapped ${rules.length} markets; ${skipped.length} skipped with a reason`);

  if (latest !== null && !flag('force')) {
    const stored = await loadMarketRules(db, latest);
    if (sameSnapshot(rules, stored)) {
      console.log(`version ${latest} already holds an identical snapshot — nothing to do (use --force to write anyway)`);
      process.exit(0);
    }
    console.log(`version ${latest} differs from this capture; writing a new version`);
  }

  const snapshot = await ingestMarketMetadata(db, rules, { source, observedAt });
  console.log(`ingested version ${snapshot.version}: ${snapshot.marketCount} markets,`
    + ` observed ${snapshot.observedAt.toISOString()}, source ${snapshot.source}`);

  // Prove the write is readable before claiming success: an ingest whose rows
  // cannot be reloaded is not an ingest, and this is cheap.
  const back = await loadMarketRules(db, snapshot.version);
  if (!sameSnapshot(rules, back)) {
    console.error('the ingested snapshot did not reload identically — refusing to report success');
    process.exit(1);
  }
  console.log(`verified: all ${back.length} markets reload byte-identically under version ${snapshot.version}`);
} finally {
  await db.destroy();
}
