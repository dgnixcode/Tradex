// 03-fx-snapshot — plan/phase-03 T03.8.
//
// Two tables and one question: can a decision taken today still be explained in
// a year? That needs three things proved, and this file proves each of them
// against a real PostgreSQL rather than by inspection.
//
//  1. The metadata an order was legalised against is RECOVERABLE and UNCHANGED.
//     Not "we stored something" — every field of all 963 markets must survive the
//     round trip byte-identically, because `max_market_quantity` moves (09 F6) and
//     a snapshot that drifted is a snapshot that cannot exonerate a refusal.
//  2. Neither table can be mutated. Insert-only is enforced by a trigger, so it
//     holds against psql and against a repo written in a hurry, not just against
//     the repo below (X10, L9, L10).
//  3. The fx cross-check's alarm cannot disagree with its own numbers, because
//     the database checks the arithmetic rather than trusting the writer.
//
// The loop is closed at the end: metadata is read back OUT of the database, sized
// with the real `size()`, and the resulting order must carry the stored version.
// That is the only assertion that proves the version is load-bearing rather than
// decorative.
//
// Skips cleanly without DATABASE_URL.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import {
  alarmedFxSnapshots, describeMarketMetadataVersion, fxSnapshotById, ingestMarketMetadata,
  insertFxSnapshot, latestFxSnapshot, latestMarketMetadataVersion, loadMarketRules,
  APPEND_ONLY_TABLES, GLOBAL_TABLES,
} from '../packages/db/dist/index.js';
import { mapMarketsDetails } from '../packages/exchange-coindcx/dist/index.js';
import { crossCheck, effectiveMinQty, size, toStr } from '../packages/sizing/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const migrationsDir = join(root, 'db', 'migrations');
const fixture = readFileSync(join(here, 'fixtures', 'markets_details.json'), 'utf8');

const SCHEMA = 'tradex_fx_check';
const OBSERVED = new Date('2026-09-04T10:00:00.000Z');

/** The live 2026-09-04 sample from 10 F4. */
const LIVE = { asset: 'BTC', baseLegPrice: '81602', quoteLegPrice: '8079092', rate: '99.11' };

/** Every field of MarketRules except rulesVersion, which the DB restamps by design. */
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

const firstDifference = (a, b) => {
  for (const f of SHAPE) if (a[f] !== b[f]) return `${f}: ${String(a[f])} -> ${String(b[f])}`;
  if (a.market.asset !== b.market.asset) return `asset: ${a.market.asset} -> ${b.market.asset}`;
  if (a.market.quote !== b.market.quote) return `quote: ${a.market.quote} -> ${b.market.quote}`;
  return `allowedTypes: ${a.allowedTypes.join('/')} -> ${b.allowedTypes.join('/')}`;
};

/** Run a statement expecting the database to REJECT it. */
async function expectReject(client, assert, sql, matcher, what) {
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('ROLLBACK');
    assert(false, `${what}: ACCEPTED but should have been rejected`);
  } catch (err) {
    await client.query('ROLLBACK');
    const msg = String(err.message ?? err);
    assert(matcher.test(msg), `${what}: rejected, but not for the expected reason — ${msg}`);
  }
}

/** Run something expecting the REPO to refuse it before the database is touched. */
async function expectRepoRefusal(assert, fn, matcher, what) {
  try {
    await fn();
    assert(false, `${what}: accepted but should have been refused`);
  } catch (err) {
    const msg = String(err.message ?? err);
    assert(matcher.test(msg), `${what}: refused, but not for the expected reason — ${msg}`);
  }
}

export async function run(assert) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }

  // ------------------------------------------------------ 0. the registries agree
  // A table nothing lists as global and nothing lists as tenant-scoped is a table
  // the scoping layer has no opinion about, which is how a leak starts.
  for (const t of ['market_metadata', 'fx_snapshot']) {
    assert(GLOBAL_TABLES.includes(t), `${t} is market data shared by every tenant but is not in GLOBAL_TABLES`);
    assert(APPEND_ONLY_TABLES.includes(t), `${t} is insert-only but is not in APPEND_ONLY_TABLES`);
  }

  const setupPool = new pg.Pool({ connectionString: url, max: 2 });
  const setup = await setupPool.connect();
  try {
    await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await setup.query(`CREATE SCHEMA ${SCHEMA}`);
    await setup.query(`SET search_path TO ${SCHEMA}, public`);
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
      await setup.query(readFileSync(join(migrationsDir, f), 'utf8')
        .replace(/^\s*BEGIN;\s*$/gim, '').replace(/^\s*COMMIT;\s*$/gim, ''));
    }
    assert(true, 'migrations 001-005 applied to a throwaway schema');
  } finally {
    setup.release();
    await setupPool.end();
  }

  const pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${SCHEMA},public` });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const raw = await pool.connect();

  try {
    // ----------------------------------------------- 1. migration 005 exists at all
    const { rows: tables } = await raw.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [SCHEMA],
    );
    const names = new Set(tables.map((r) => r.table_name));
    assert(names.has('market_metadata'), 'migration 005 did not create market_metadata');
    assert(names.has('fx_snapshot'), 'migration 005 did not create fx_snapshot');

    // Neither table is tenant-scoped: market data is identical for every customer,
    // and duplicating 963 rows per tenant would make one tenant's legalisation
    // differ from another's for no reason.
    const { rows: tenantCols } = await raw.query(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = $1 AND column_name = 'tenant_id'
          AND table_name IN ('market_metadata','fx_snapshot')`, [SCHEMA],
    );
    assert(tenantCols.length === 0, 'a market-data table carries tenant_id; it is listed as global');

    // The venue_decimal domain is what makes an unexpanded exponent unstorable.
    const { rows: domains } = await raw.query(
      `SELECT domain_name FROM information_schema.domains WHERE domain_schema = $1`, [SCHEMA],
    );
    assert(domains.some((d) => d.domain_name === 'venue_decimal'),
      'the venue_decimal domain is missing — nothing then stops 1e-7 being stored verbatim');

    // ------------------------------------------------ 2. ingest the real fixture
    const { rules, skipped } = mapMarketsDetails(fixture, 'fixture-v1');
    assert(rules.length > 900, `expected 900+ mappable markets in the fixture, got ${rules.length}`);
    assert(skipped.length > 0, 'the fixture should contain markets the adapter skips with a reason');

    assert(await latestMarketMetadataVersion(db) === null, 'an empty table should report no version');

    const snap1 = await ingestMarketMetadata(db, rules, { source: 'markets_details', observedAt: OBSERVED });
    assert(snap1.version === '1', `the first ingest should be version 1, got ${snap1.version}`);
    assert(snap1.marketCount === rules.length, `ingested ${snap1.marketCount}, expected ${rules.length}`);
    assert(await latestMarketMetadataVersion(db) === '1', 'the latest version should now be 1');

    const { rows: counted } = await raw.query('SELECT count(*)::int AS n, count(DISTINCT version)::int AS v FROM market_metadata');
    assert(counted[0].n === rules.length, `market_metadata holds ${counted[0].n} rows, expected ${rules.length}`);
    assert(counted[0].v === 1, 'the whole snapshot must sit under exactly one version');

    const described = await describeMarketMetadataVersion(db, '1');
    assert(described !== null && described.marketCount === rules.length, 'the version header does not describe the snapshot');
    assert(described.observedAt.getTime() === OBSERVED.getTime(), 'observed_at did not round-trip');

    // ------------------------------- 3. every market survives the round trip exactly
    // This is the assertion the table exists for. A field that drifts in storage
    // means a refusal cannot be explained from the record.
    const reloaded = await loadMarketRules(db, '1');
    assert(reloaded.length === rules.length, `reloaded ${reloaded.length} markets, stored ${rules.length}`);
    const bySymbol = new Map(reloaded.map((r) => [r.venueSymbol, r]));
    let identical = 0;
    for (const original of rules) {
      const back = bySymbol.get(original.venueSymbol);
      if (back === undefined) {
        assert(false, `${original.venueSymbol} did not come back out of the database`);
        continue;
      }
      assert(sameMarket(original, back), `${original.venueSymbol} changed in storage — ${firstDifference(original, back)}`);
      identical += 1;
    }
    assert(identical === rules.length, `${identical} of ${rules.length} markets round-tripped`);
    // rulesVersion is the ONE field that changes, and it changes on purpose.
    assert(reloaded.every((r) => r.rulesVersion === '1'),
      'reloaded markets must carry the DB version, since that is the number an order records');

    // The float-artefact markets are the ones most likely to be corrupted by a
    // numeric column, so name them explicitly.
    const exotic = rules.filter((r) => /^\d+\.\d{11,}$/.test(r.minPrice)).slice(0, 5);
    assert(exotic.length > 0, 'expected the fixture to contain float-artefact price bands (BSVINR-shaped)');
    for (const r of exotic) {
      assert(bySymbol.get(r.venueSymbol).minPrice === r.minPrice,
        `${r.venueSymbol}.minPrice ${r.minPrice} was re-rendered in storage`);
    }

    // And the two markets 18 F2 names as mattering most.
    for (const [symbol, step, precision] of [['DOGEINR', '1', 0], ['BTCINR', '0.00001', 5]]) {
      const back = bySymbol.get(symbol);
      assert(back !== undefined, `${symbol} is missing after the round trip`);
      assert(back.quantityStep === step, `${symbol} step is ${back.quantityStep}, expected ${step}`);
      assert(back.quantityPrecision === precision, `${symbol} precision is ${back.quantityPrecision}, expected ${precision}`);
    }
    // DOGEINR's whole point: the effective minimum must still be 1 whole DOGE
    // when computed from metadata that has been through the database.
    assert(toStr(effectiveMinQty(bySymbol.get('DOGEINR'), 'market')) === '1',
      'DOGEINR effective minimum is not 1 DOGE after a database round trip');
    assert(bySymbol.get('BTCINR').maxMarketQuantity === '0.0158',
      'BTCINR max_quantity_market did not survive storage — the cap that refuses large accounts');

    // ------------------------------------------------ 4. versions are monotonic
    const snap2 = await ingestMarketMetadata(db, rules.slice(0, 10), { source: 'markets_details', observedAt: new Date() });
    assert(BigInt(snap2.version) > BigInt(snap1.version), `version ${snap2.version} did not advance past ${snap1.version}`);
    assert(await latestMarketMetadataVersion(db) === snap2.version, 'the latest version did not move');
    // Crucially, version 1 is untouched by the newer snapshot.
    const stillThere = await loadMarketRules(db, '1');
    assert(stillThere.length === rules.length, `version 1 now has ${stillThere.length} markets; a new version overwrote it`);

    // ------------------------------------------ 5. the ingest refuses bad snapshots
    await expectRepoRefusal(assert, () => ingestMarketMetadata(db, [], { source: 's', observedAt: OBSERVED }),
      /empty market snapshot/i, 'an empty snapshot');
    const exponent = { ...rules[0], minPrice: '1e-7' };
    await expectRepoRefusal(assert, () => ingestMarketMetadata(db, [exponent], { source: 's', observedAt: OBSERVED }),
      /not a plain decimal/i, 'a market whose price arrived in exponent form');
    await expectRepoRefusal(assert, () => ingestMarketMetadata(db, [rules[0], rules[0]], { source: 's', observedAt: OBSERVED }),
      /appears twice/i, 'the same market twice in one snapshot');
    const clash = { ...rules[0], venueSymbol: `${rules[0].venueSymbol}_ALT` };
    await expectRepoRefusal(assert, () => ingestMarketMetadata(db, [rules[0], clash], { source: 's', observedAt: OBSERVED }),
      /both trade/i, 'two symbols claiming the same asset/quote pair');

    // The domain is the backstop when something bypasses the repo entirely.
    await expectReject(raw, assert,
      `INSERT INTO market_metadata (version, venue_symbol, asset, quote, status, tradable,
        quantity_step, quantity_precision, price_precision, min_quantity, max_quantity,
        min_notional_minor, min_price, max_price, order_types, venue_code, observed_at, source)
       VALUES (999,'XINR','X','INR','active',true,'1e-5',5,1,'0.001','2','10000','1','2',
               ARRAY['limit']::text[],'I',now(),'raw')`,
      /venue_decimal/i, 'exponent notation inserted directly, bypassing the repo');
    await expectReject(raw, assert,
      `INSERT INTO market_metadata (version, venue_symbol, asset, quote, status, tradable,
        quantity_step, quantity_precision, price_precision, min_quantity, max_quantity,
        min_notional_minor, min_price, max_price, order_types, venue_code, observed_at, source)
       VALUES (999,'YINR','Y','INR','inactive',true,'1',0,1,'0.001','2','10000','1','2',
               ARRAY['limit']::text[],'I',now(),'raw')`,
      /tradable_matches_status/i, 'a tradable market whose status says otherwise');

    // ------------------------------------------- 6. neither table can be mutated
    for (const t of ['market_metadata', 'fx_snapshot']) {
      await expectReject(raw, assert, `UPDATE ${t} SET source = 'tampered'`,
        /insert_only_table|append-only/i, `UPDATE on ${t}`);
      await expectReject(raw, assert, `DELETE FROM ${t}`,
        /insert_only_table|append-only/i, `DELETE on ${t}`);
      // TRUNCATE may be refused by EITHER barrier. As of phase 04,
      // group_trade.fx_snapshot_id is the first foreign key pointing at
      // fx_snapshot, and Postgres refuses to TRUNCATE a table referenced by an FK
      // BEFORE it fires the append-only trigger. Both prove the table cannot be
      // truncated; the property is strengthened, not weakened, so the matcher
      // accepts the FK rejection as well.
      await expectReject(raw, assert, `TRUNCATE ${t}`,
        /insert_only_table|append-only|foreign key constraint/i, `TRUNCATE on ${t}`);
      // A DELETE matching nothing must still raise: "you cannot delete here" is a
      // clearer contract than "you happened to delete nothing".
      await expectReject(raw, assert, `DELETE FROM ${t} WHERE source = 'no-such-source'`,
        /insert_only_table|append-only/i, `a zero-row DELETE on ${t}`);
    }

    // -------------------------------------------------- 7. the fx cross-check
    const check = crossCheck(LIVE);
    assert(check.driftBp === '11', `the live sample should drift 11bp, got ${check.driftBp}`);
    assert(check.alarmed === false, '11bp must not alarm against a 100bp threshold');

    const id1 = await insertFxSnapshot(db, {
      base: 'USDT', quote: 'INR', rate: LIVE.rate, source: 'coindcx_ticker_last',
      observedAt: OBSERVED, crossCheck: check,
    });
    assert(/^\d+$/.test(id1), `an fx snapshot id should be a numeric string, got ${id1}`);

    const back = await fxSnapshotById(db, id1);
    assert(back !== null, 'the fx snapshot did not come back');
    assert(back.rate === '99.11', `the rate did not round-trip: ${back.rate}`);
    assert(back.source === 'coindcx_ticker_last', 'the sampled side did not round-trip');
    assert(back.observedAt.getTime() === OBSERVED.getTime(), 'observed_at did not round-trip');
    assert(back.crossCheck.driftBp === '11', `drift did not round-trip: ${back.crossCheck.driftBp}`);
    assert(back.crossCheck.thresholdBp === '100', 'the threshold did not round-trip');
    assert(back.crossCheck.alarmed === false, 'the alarm flag did not round-trip');
    assert(back.crossCheck.baseLegPrice === '81602' && back.crossCheck.quoteLegPrice === '8079092',
      'both legs must be stored so the drift is recomputable');

    // A snapshot with no cross-check is legitimate — not every sample runs one.
    const id2 = await insertFxSnapshot(db, {
      base: 'USDT', quote: 'INR', rate: '99.09', source: 'coindcx_ticker_bid',
      observedAt: new Date(OBSERVED.getTime() + 1000),
    });
    const bare = await fxSnapshotById(db, id2);
    assert(bare.crossCheck === undefined, 'a snapshot without a cross-check should report none');

    const latest = await latestFxSnapshot(db, 'USDT', 'INR');
    assert(latest.id === id2, `the latest USDT/INR snapshot should be ${id2}, got ${latest.id}`);
    assert(await latestFxSnapshot(db, 'USDT', 'EUR') === null, 'an unsampled pair should report no snapshot');

    // ------------------------------------------------- 8. the alarm actually fires
    const dislocated = crossCheck({ ...LIVE, quoteLegPrice: '8000000' });
    assert(dislocated.driftBp === '110', `expected 110bp, got ${dislocated.driftBp}`);
    assert(dislocated.alarmed === true, '110bp must alarm against a 100bp threshold');
    const id3 = await insertFxSnapshot(db, {
      base: 'USDT', quote: 'INR', rate: LIVE.rate, source: 'coindcx_ticker_last',
      observedAt: new Date(OBSERVED.getTime() + 2000), crossCheck: dislocated,
    });
    const alarms = await alarmedFxSnapshots(db);
    assert(alarms.length === 1, `expected exactly one alarmed snapshot, got ${alarms.length}`);
    assert(alarms[0].id === id3, 'the alarmed feed returned the wrong snapshot');
    assert(alarms[0].crossCheck.alarmed === true, 'an alarmed snapshot must say so');

    // ---------------------------- 9. the alarm cannot disagree with its own numbers
    // First the repo refuses it...
    await expectRepoRefusal(assert, () => insertFxSnapshot(db, {
      base: 'USDT', quote: 'INR', rate: '99.11', source: 'coindcx_ticker_last', observedAt: OBSERVED,
      crossCheck: { ...check, alarmed: true },
    }), /says otherwise/i, 'an alarm flag contradicting an 11bp drift');
    // ...and then the database refuses it too, which is the guarantee that holds
    // when the next writer is not this repo.
    await expectReject(raw, assert,
      `INSERT INTO fx_snapshot (base, quote, rate, source, observed_at,
         cross_base_rate, cross_quote_rate, cross_drift_bp, cross_threshold_bp, cross_alarmed)
       VALUES ('USDT','INR','99.11','coindcx_ticker_last', now(), '81602','8079092','11','100', true)`,
      /alarm_matches_drift/i, 'a contradictory alarm inserted directly');
    await expectReject(raw, assert,
      `INSERT INTO fx_snapshot (base, quote, rate, source, observed_at, cross_drift_bp)
       VALUES ('USDT','INR','99.11','coindcx_ticker_last', now(), '11')`,
      /cross_check_complete/i, 'a drift with no threshold to judge it against');
    await expectReject(raw, assert,
      `INSERT INTO fx_snapshot (base, quote, rate, source, observed_at)
       VALUES ('USDT','INR','99.11','some_blog', now())`,
      /fx_snapshot_source_check/i, 'a rate from an unknown source');
    await expectReject(raw, assert,
      `INSERT INTO fx_snapshot (base, quote, rate, source, observed_at)
       VALUES ('INR','INR','1','coindcx_ticker_last', now())`,
      /base_not_quote/i, 'a snapshot of a currency against itself');
    await expectRepoRefusal(assert, () => insertFxSnapshot(db, {
      base: 'USDT', quote: 'INR', rate: '9.911e1', source: 'coindcx_ticker_last', observedAt: OBSERVED,
    }), /plain positive decimal/i, 'a rate in exponent form');

    // ------------------------- 10. the loop closes: stored metadata sizes an order
    // Everything above is bookkeeping unless the stored version is the version an
    // order actually carries. Size the 09 F7 row-1 example from metadata read back
    // out of the database and assert both the quantity AND the version.
    const btcinr = bySymbol.get('BTCINR');
    const sized = size({
      intent: { asset: 'BTC', side: 'buy', mode: 'pct_allocated', orderType: 'market', percent: { basisPoints: 2000 } },
      rules: btcinr, price: '8077476.1', priceSource: 'ask', allocatedCapitalMinor: '10000000',
    });
    assert(sized.ok === true, `sizing from stored metadata should fill: ${JSON.stringify(sized)}`);
    assert(sized.finalQuantity === '0.00246', `stored metadata produced ${sized.finalQuantity}, expected 0.00246`);
    assert(sized.notionalMinor === '1987059', `stored metadata produced notional ${sized.notionalMinor}`);
    assert(sized.marketMetaVersion === '1',
      `the order must record the stored snapshot version, got ${sized.marketMetaVersion}`);

    // And the refusal that matters most still refuses, from stored metadata.
    const refused = size({
      intent: { asset: 'BTC', side: 'buy', mode: 'pct_allocated', orderType: 'market', percent: { basisPoints: 2000 } },
      rules: btcinr, price: '8077476.1', priceSource: 'ask', allocatedCapitalMinor: '100000000',
    });
    assert(refused.ok === undefined && refused.code === 'ABOVE_MAX_QTY_MARKET',
      `a Rs 10 lakh account must still be refused from stored metadata, got ${JSON.stringify(refused)}`);
    assert(refused.limit === '0.0158', `the cap in the message must be the stored one, got ${refused.limit}`);

    console.log(`     migration 005 applied; ${rules.length} markets round-tripped byte-identically under version 1;`
      + ' both tables proved append-only; 11bp drift stored, 110bp alarmed');
  } finally {
    raw.release();
    await db.destroy();
    const cleanupPool = new pg.Pool({ connectionString: url, max: 1 });
    const cleanup = await cleanupPool.connect();
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    } finally {
      cleanup.release();
      await cleanupPool.end();
    }
  }
}
