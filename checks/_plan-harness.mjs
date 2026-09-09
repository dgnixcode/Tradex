// Shared setup for the phase-04 planning checks — plan/phase-04.
//
// The four DB-backed planning checks (04-planning, 04-gates,
// 04-preview-equals-plan, 04-dry-run-100) all need the same world: a schema with
// every migration applied, a tenant with its limits, a handful of accounts with
// balances and active credentials, an ingested market-metadata version, and a
// group. Building that once here keeps each check about its own property.
//
// Each check gets its OWN schema (the caller passes a suffix) so they can run in
// the same suite without colliding, and every check skips cleanly without
// DATABASE_URL — the whole file no-ops in that case, exactly like the phase-02
// and phase-03 checks.
//
// The planning service reaches the venue only through an injected getOrderBook,
// so these checks pass a book built from the committed order-book fixtures. No
// network, no real venue, and — because nothing in this phase sends — no
// placeOrder path exists to call.

import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { forTenant, createGroup, addMember } from '../packages/db/dist/index.js';
import { mapMarketsDetails, mapOrderBook } from '../packages/exchange-coindcx/dist/index.js';
import { ingestMarketMetadata } from '../packages/db/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const migrationsDir = join(root, 'db', 'migrations');
const fixturesDir = join(here, 'fixtures');

export const TENANT = '22222222-2222-2222-2222-222222222222';
export const USER = '33333333-3333-3333-3333-333333333333';

/** A fixed clock so the checks are deterministic (no Date.now in assertions). */
export const NOW_MS = 1_788_649_200_000;
/** IST midnight before NOW_MS — the day boundary for the daily-cap read. */
export const DAY_START_MS = (() => {
  const IST = (5 * 60 + 30) * 60_000;
  return Math.floor((NOW_MS + IST) / 86_400_000) * 86_400_000 - IST;
})();

/** Load and map the two committed order books, keyed by venue symbol. */
export function loadBooks() {
  const btcinr = mapOrderBook(readFileSync(join(fixturesDir, 'orderbook_btcinr.json'), 'utf8'));
  const btcusdt = mapOrderBook(readFileSync(join(fixturesDir, 'orderbook_btcusdt.json'), 'utf8'));
  const toPort = (m, quote) => ({ market: { asset: 'BTC', quote }, asks: m.asks, bids: m.bids, observedAtMs: Number(m.timestamp) });
  return new Map([
    ['BTCINR', toPort(btcinr, 'INR')],
    ['BTCUSDT', toPort(btcusdt, 'USDT')],
  ]);
}

/**
 * A getOrderBook the planning service can call. Returns the fixture book for the
 * requested market's quote, and COUNTS its calls so a check can assert "one read
 * per market" (T04.10).
 */
export function bookProvider() {
  const books = loadBooks();
  const calls = [];
  const getOrderBook = async (market) => {
    calls.push(market);
    const symbol = `BTC${market.quote}`;
    const book = books.get(symbol);
    if (book === undefined) throw new Error(`no fixture book for ${symbol}`);
    return book;
  };
  return { getOrderBook, calls };
}

/** Open a fresh schema, apply every migration, and return db handles. */
export async function setup(schemaSuffix, opts = {}) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') return null;

  const schema = `tradex_plan_${schemaSuffix}`;
  const setupPool = new pg.Pool({ connectionString: url, max: 2 });
  const s = await setupPool.connect();
  try {
    await s.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await s.query(`CREATE SCHEMA ${schema}`);
    await s.query(`SET search_path TO ${schema}, public`);
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
      await s.query(readFileSync(join(migrationsDir, f), 'utf8')
        .replace(/^\s*BEGIN;\s*$/gim, '').replace(/^\s*COMMIT;\s*$/gim, ''));
    }
    // tenant + its limits. Caps default from migration 001 (per-order 2,00,00,000
    // paise = Rs 2,00,000; daily 5,00,00,000). A check can override per-tenant.
    await s.query("INSERT INTO tenant (id, name, valuation_currency) VALUES ($1, 'Plan T', 'INR')", [TENANT]);
    await s.query('INSERT INTO tenant_limit (tenant_id) VALUES ($1)', [TENANT]);
    if (opts.perOrderCapMinor !== undefined) {
      await s.query('UPDATE tenant_limit SET max_order_notional_minor = $1 WHERE tenant_id = $2', [opts.perOrderCapMinor, TENANT]);
    }
    if (opts.dailyCapMinor !== undefined) {
      await s.query('UPDATE tenant_limit SET max_daily_notional_minor = $1 WHERE tenant_id = $2', [opts.dailyCapMinor, TENANT]);
    }
    await s.query(
      "INSERT INTO app_user (id, tenant_id, email, password_hash, role) VALUES ($1, $2, 'plan@t.example', 'x', 'owner')",
      [USER, TENANT],
    );
  } finally {
    s.release();
  }
  await setupPool.end();

  const pool = new pg.Pool({ connectionString: url, max: 8, options: `-c search_path=${schema},public` });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const tdb = forTenant(db, TENANT);
  return { db, tdb, pool, schema };
}

/** Ingest the committed markets fixture as one version. Returns the version. */
export async function ingestMarkets(db) {
  const { rules } = mapMarketsDetails(readFileSync(join(fixturesDir, 'markets_details.json'), 'utf8'), 'plan-v1');
  const snap = await ingestMarketMetadata(db, rules, { source: 'markets_details.json', observedAt: new Date(NOW_MS) });
  return snap.version;
}

/**
 * Create N active accounts, each with an INR balance, and put them in one group.
 * `capitals` gives each account's allocated capital in paise, which is also its
 * free INR balance, so the percentage sizing has a real basis. `namePrefix` lets
 * a check seed several groups in one schema without tripping the per-tenant
 * account-name uniqueness. Returns the group id and the account ids in creation
 * order.
 */
export async function seedGroupOfAccounts(ctx, capitals, namePrefix = 'Acct') {
  const { tdb, pool } = ctx;
  const accountIds = [];
  for (let i = 0; i < capitals.length; i += 1) {
    const cap = capitals[i];
    const { rows } = await pool.query(
      `INSERT INTO exchange_account (tenant_id, name, allocated_capital_minor, allocated_currency, status)
       VALUES ($1, $2, $3, 'INR', 'active') RETURNING id`,
      [TENANT, `${namePrefix} ${i + 1}`, cap],
    );
    const accountId = rows[0].id;
    accountIds.push(accountId);
    // A live INR balance equal to the allocated capital.
    await pool.query(
      `INSERT INTO account_balance (tenant_id, account_id, currency, free_minor, locked_minor, scale, observed_at)
       VALUES ($1, $2, 'INR', $3, '0', 2, $4)`,
      [TENANT, accountId, cap, new Date(NOW_MS)],
    );
    // An active credential so gate 3 passes. Ciphertext bytes are placeholders —
    // nothing decrypts them in a planning check (no send). The fingerprint is
    // derived from the (prefix, index) pair so a check that seeds several groups
    // in one schema never trips exchange_credential_fingerprint_unique.
    const fingerprint = createHash('sha256').update(`${namePrefix}:${i}`).digest().subarray(0, 32);
    await pool.query(
      `INSERT INTO exchange_credential
         (tenant_id, account_id, kms_key_arn, dek_wrapped, api_key_ct, api_key_nonce, api_key_tag,
          api_secret_ct, api_secret_nonce, api_secret_tag, api_key_last4, fingerprint, status, validated_at)
       VALUES ($1, $2, 'arn:local', $3, $3, $4, $5, $3, $6, $5, '0000', $7, 'active', $8)`,
      [
        TENANT, accountId,
        Buffer.from('00', 'hex'), Buffer.alloc(12, 1), Buffer.alloc(16, 2),
        Buffer.alloc(12, 3), fingerprint,
        new Date(NOW_MS),
      ],
    );
  }
  const groupName = namePrefix === 'Acct' ? 'Plan Group' : `${namePrefix} Group`;
  const groupId = await createGroup(tdb, { name: groupName, createdBy: USER });
  for (const accountId of accountIds) await addMember(tdb, { groupId, accountId });
  return { groupId, accountIds };
}

/** Tear down: drop the schema and close the pool. */
export async function teardown(ctx) {
  if (ctx === null) return;
  await ctx.pool.query(`DROP SCHEMA IF EXISTS ${ctx.schema} CASCADE`);
  await ctx.db.destroy();
}
