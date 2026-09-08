// Demo seed — a login you can actually use in the browser.
//
// Inserts a demo tenant, a trader user with a REAL password hash, two active
// accounts (each with an INR balance and an active credential), a group holding
// both, and — if the database has no market snapshot yet — ingests the committed
// markets fixture so the asset typeahead and market resolution have data.
//
// Idempotent: fixed ids + ON CONFLICT DO NOTHING, so re-running is a no-op rather
// than a unique-constraint crash. Market metadata is append-only (a trigger
// blocks re-writes), so it is ingested only when none exists.
//
// The credential ciphertext bytes are PLACEHOLDERS. Nothing decrypts them in the
// dry-run flow (no order is sent), and the byte lengths satisfy the schema's
// CHECK constraints. This seeds a usable demo, not a live-trading account.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { hashPassword } from '../packages/auth/dist/index.js';
import { ingestMarketMetadata, latestMarketMetadataVersion } from '../packages/db/dist/index.js';
import { mapMarketsDetails } from '../packages/exchange-coindcx/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'checks', 'fixtures');

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set — see .env.example');
  process.exit(1);
}

// Fixed ids so a re-run collides with itself (and does nothing) rather than
// creating a second demo tenant.
const TENANT = 'de11a000-0000-4000-8000-000000000001';
const USER = 'de11a000-0000-4000-8000-000000000002';
const ACCOUNTS = [
  { id: 'de11a000-0000-4000-8000-0000000000a1', name: 'Demo account A', capital: '10000000' }, // Rs 1,00,000
  { id: 'de11a000-0000-4000-8000-0000000000a2', name: 'Demo account B', capital: '50000000' }, // Rs 5,00,000
];
const GROUP = 'de11a000-0000-4000-8000-0000000000b1';

const EMAIL = 'demo@tradex.local';
const PASSWORD = 'tradex-demo-123';

const pool = new pg.Pool({ connectionString: url, max: 4 });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

/** 32 distinct bytes for a per-account credential fingerprint (unique per tenant). */
const fingerprint = (n) => Buffer.from(`${n}`.padStart(64, '0'), 'hex').subarray(0, 32);

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // tenant + its limits (defaults are fine for a demo).
    await client.query(
      `INSERT INTO tenant (id, name, valuation_currency) VALUES ($1, 'Demo Desk', 'INR')
       ON CONFLICT DO NOTHING`,
      [TENANT],
    );
    await client.query('INSERT INTO tenant_limit (tenant_id) VALUES ($1) ON CONFLICT DO NOTHING', [TENANT]);

    // trader user with a real scrypt hash.
    const hash = await hashPassword(PASSWORD);
    await client.query(
      `INSERT INTO app_user (id, tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'trader') ON CONFLICT DO NOTHING`,
      [USER, TENANT, EMAIL, hash],
    );

    // accounts + balances + active credentials.
    for (let i = 0; i < ACCOUNTS.length; i += 1) {
      const a = ACCOUNTS[i];
      await client.query(
        `INSERT INTO exchange_account (id, tenant_id, name, allocated_capital_minor, allocated_currency, status)
         VALUES ($1, $2, $3, $4, 'INR', 'active') ON CONFLICT DO NOTHING`,
        [a.id, TENANT, a.name, a.capital],
      );
      await client.query(
        `INSERT INTO account_balance (tenant_id, account_id, currency, free_minor, locked_minor, scale, observed_at)
         VALUES ($1, $2, 'INR', $3, '0', 2, now()) ON CONFLICT DO NOTHING`,
        [TENANT, a.id, a.capital],
      );
      await client.query(
        `INSERT INTO exchange_credential
           (tenant_id, account_id, kms_key_arn, dek_wrapped, api_key_ct, api_key_nonce, api_key_tag,
            api_secret_ct, api_secret_nonce, api_secret_tag, api_key_last4, fingerprint, status, validated_at)
         VALUES ($1, $2, 'arn:local:demo', $3, $3, $4, $5, $3, $6, $5, '0000', $7, 'active', now())
         ON CONFLICT DO NOTHING`,
        [
          TENANT, a.id,
          Buffer.from('00', 'hex'), Buffer.alloc(12, 1), Buffer.alloc(16, 2),
          Buffer.alloc(12, 3), fingerprint(i + 1),
        ],
      );
    }

    // a group holding both accounts.
    await client.query(
      `INSERT INTO account_group (id, tenant_id, name, created_by)
       VALUES ($1, $2, 'All demo accounts', $3) ON CONFLICT DO NOTHING`,
      [GROUP, TENANT, USER],
    );
    for (const a of ACCOUNTS) {
      await client.query(
        `INSERT INTO group_member (tenant_id, group_id, account_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [TENANT, GROUP, a.id],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Market metadata is append-only: ingest a snapshot only if none exists.
  const version = await latestMarketMetadataVersion(db);
  if (version === null) {
    const { rules } = mapMarketsDetails(readFileSync(join(fixturesDir, 'markets_details.json'), 'utf8'), 'demo-v1');
    const snap = await ingestMarketMetadata(db, rules, { source: 'seed-demo', observedAt: new Date() });
    console.log(`ingested market metadata version ${snap.version} (${snap.marketCount} markets)`);
  } else {
    console.log(`market metadata already present (version ${version}); not re-ingesting`);
  }

  console.log('\nDemo data ready. Log in at http://localhost:5273/login with:');
  console.log(`  email:    ${EMAIL}`);
  console.log(`  password: ${PASSWORD}`);
  console.log('\nThe "All demo accounts" group has two funded accounts; try a BTC buy at 20% of allocated.');
}

main()
  .then(() => db.destroy())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
