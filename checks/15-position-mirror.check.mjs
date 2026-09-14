// 15-position-mirror — the writer `futures_position` never had.
//
// The table shipped with a schema, a reader and index checks, and NOTHING ever
// wrote a row, so the Positions page was permanently empty and no test noticed:
// the only writer was 15-schema, probing constraints with a fixed '0.1' row.
//
// The regression that matters most here is the SHORT. `active_pos` was declared
// on the `venue_decimal` domain, whose CHECK forbids a minus sign, while the
// column is documented and consumed as signed — so a short position could not be
// inserted at all and `side: 'short'` was unreachable through the table. Migration
// 017 fixed it, and nothing else covers it.
//
// Needs a database. Skips cleanly without DATABASE_URL.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { forTenant, replaceFuturesPositions, upsertFuturesPositions } from '../packages/db/dist/index.js';
import { buildFuturesPositions } from '../apps/api/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const SCHEMA = 'tradex_pos_mirror_check';

const T1 = '11111111-1111-1111-1111-111111111111';
const ACCOUNT = '22222222-2222-2222-2222-222222222222';
const NOW = 1_760_000_000_000;

/** A venue snapshot as `fetchFuturesPositions` would report it. */
const snapshot = (over = {}) => ({
  venuePositionId: 'pos-1',
  pair: 'B-BTC_USDT',
  marginCurrency: 'USDT',
  activePos: '0.001',
  avgEntryPrice: '8500000',
  markPrice: '8510000',
  liquidationPrice: '7000000',
  leverage: 5,
  lockedMarginMinor: '170000',
  stopLossTrigger: null,
  takeProfitTrigger: null,
  marginType: 'isolated',
  fundingRateBp: null,
  observedAtMs: NOW,
  ...over,
});

export async function run(assert) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }

  const setupPool = new pg.Pool({ connectionString: url, max: 2 });
  const s = await setupPool.connect();
  try {
    await s.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await s.query(`CREATE SCHEMA ${SCHEMA}`);
    await s.query(`SET search_path TO ${SCHEMA}, public`);
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
      await s.query(readFileSync(join(migrationsDir, f), 'utf8')
        .replace(/^\s*BEGIN;\s*$/gim, '').replace(/^\s*COMMIT;\s*$/gim, ''));
    }
    await s.query("INSERT INTO tenant (id, name) VALUES ($1, 'Mirror T')", [T1]);
    await s.query(
      `INSERT INTO exchange_account (id, tenant_id, name, allocated_capital_minor, allocated_currency, status)
       VALUES ($1, $2, 'Mirror', '100000000', 'INR', 'active')`, [ACCOUNT, T1]);
  } finally {
    s.release();
  }

  const pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${SCHEMA},public` });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const tdb = forTenant(db, T1);

  try {
    // ------------------------------------------------ 1. a long mirrors
    const wrote = await upsertFuturesPositions(tdb, ACCOUNT, [snapshot()], NOW);
    assert(wrote === 1, `expected one row written, got ${wrote}`);

    let view = await buildFuturesPositions(db, T1, NOW);
    assert(view.views.length === 1, `expected one position view, got ${view.views.length}`);
    assert(view.views[0].side === 'long', `a positive active_pos read as ${view.views[0].side}`);
    assert(view.views[0].quantity === '0.001', `quantity came out as ${view.views[0].quantity}`);
    assert(view.views[0].markPrice === '8510000', 'the mark price did not survive the round trip');
    assert(view.views[0].leverage === '5', `leverage came out as ${view.views[0].leverage}`);
    assert(view.views[0].accountName === 'Mirror', 'the view did not resolve the account name');

    // ------------------------------------------------ 2. THE SHORT
    // This is the migration-017 regression. Before it, this write was rejected by
    // the domain CHECK and the position was simply unrepresentable.
    const short = snapshot({
      venuePositionId: 'pos-2', pair: 'B-ETH_USDT', activePos: '-0.5',
      avgEntryPrice: '250000', markPrice: '245000', liquidationPrice: '300000',
    });
    await upsertFuturesPositions(tdb, ACCOUNT, [short], NOW);

    view = await buildFuturesPositions(db, T1, NOW);
    const eth = view.views.find((v) => v.pair === 'B-ETH_USDT');
    assert(eth !== undefined, 'the short position is not in the view — it was not stored');
    assert(eth.side === 'short', `a negative active_pos read as ${eth.side}`);
    assert(eth.quantity === '0.5', `the sign was not stripped from the quantity (got ${eth.quantity})`);

    // The sign is load-bearing for the maths too: a long marked down is a loss, a
    // short marked down is a profit. If the sign were lost, this would invert.
    assert(eth.unrealisedPnlMinor !== null, 'unrealised PnL should be computed for a fully-populated short');
    assert(BigInt(eth.unrealisedPnlMinor) > 0n,
      'a short marked BELOW its entry should show a profit; the sign is being lost somewhere');

    // ------------------------------------------------ 3. re-reading updates in place
    // The venue is the source of truth and this is a cache of its last answer, so
    // a second read must UPDATE rather than accumulate. Both unique constraints
    // make a careless upsert fail loudly here.
    const moved = snapshot({ markPrice: '8600000', activePos: '0.002' });
    await upsertFuturesPositions(tdb, ACCOUNT, [moved], NOW + 1_000);
    const { rows: countRows } = await pool.query(
      'SELECT count(*)::int n FROM futures_position WHERE account_id = $1 AND pair = $2', [ACCOUNT, 'B-BTC_USDT']);
    assert(countRows[0].n === 1, `a re-read created ${countRows[0].n} rows for one position`);

    view = await buildFuturesPositions(db, T1, NOW + 1_000);
    const btc = view.views.find((v) => v.pair === 'B-BTC_USDT');
    assert(btc.markPrice === '8600000', 'the re-read did not update the mark price');
    assert(btc.quantity === '0.002', 'the re-read did not update the quantity');

    // ------------------------------------------------ 4. a closed position
    // Stored, not deleted: the view filters flat rows out, and the row keeps when
    // we last saw it. Deleting would lose that and gain nothing.
    await upsertFuturesPositions(tdb, ACCOUNT, [snapshot({ venuePositionId: 'pos-3', pair: 'INR-SOL_INR', marginCurrency: 'INR', activePos: '0' })], NOW);
    const { rows: flatRows } = await pool.query(
      "SELECT count(*)::int n FROM futures_position WHERE pair = 'INR-SOL_INR'");
    assert(flatRows[0].n === 1, 'a flat position was not stored');
    view = await buildFuturesPositions(db, T1, NOW);
    assert(view.views.every((v) => v.pair !== 'INR-SOL_INR'), 'a flat position should not render as a view');

    // ------------------------------------------------ 5. the venue's word is what we store
    // A mirror computes nothing. What the venue said is what lands, and what the
    // page shows is that — no local arithmetic in between.
    const { rows: stored } = await pool.query(
      "SELECT venue_position_id, active_pos, margin_type, funding_rate_bp FROM futures_position WHERE pair = 'B-ETH_USDT'");
    assert(stored[0].venue_position_id === 'pos-2', 'the venue position id was not stored verbatim');
    assert(stored[0].active_pos === '-0.5', `the stored active_pos is ${stored[0].active_pos}`);
    assert(stored[0].margin_type === 'isolated', 'the margin type was not stored');

    // A margin currency we do not margin in is a defect, not something to skip
    // silently — it would mean the venue answered a question we did not ask.
    let refused = null;
    try {
      await upsertFuturesPositions(tdb, ACCOUNT, [snapshot({ marginCurrency: 'EUR' })], NOW);
    } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    assert(refused !== null && /not a currency we margin in/.test(refused),
      `an impossible margin currency was accepted: ${refused}`);


    // ------------------------------------------------ 6. a position the venue stopped reporting
    // THE BUG CUSTOMERS SEE. An upsert alone leaves the row behind, so a position
    // that the venue closed — or never had after a restart — keeps rendering as
    // OPEN. A stale position shown as live is the state someone trades on.
    const before = (await buildFuturesPositions(db, T1, NOW)).views.length;
    assert(before === 2, `expected 2 open views before the prune, got ${before}`);
    await replaceFuturesPositions(tdb, ACCOUNT, [snapshot({ markPrice: '8610000' })], NOW + 2_000);
    const after = await buildFuturesPositions(db, T1, NOW + 2_000);
    assert(after.views.length === 1, `a position the venue no longer reports still renders (${after.views.length} views)`);
    assert(after.views[0].pair === 'B-BTC_USDT', `the wrong position survived the prune: ${after.views[0].pair}`);

    // A COMPLETE read that reports nothing removes everything for that account —
    // the venue restarted, or the customer closed out.
    await replaceFuturesPositions(tdb, ACCOUNT, [], NOW + 3_000);
    const cleared = await buildFuturesPositions(db, T1, NOW + 3_000);
    assert(cleared.views.length === 0, 'a venue read reporting no positions left rows behind');

    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    console.log('     mirror: long + SHORT stored, re-read updates in place, flat kept but not rendered');
  } finally {
    await pool.end();
    await setupPool.end();
  }
}
