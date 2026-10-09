// Deploy guard — plan/phase-13 T13.7 (research/20 F5).
//
// Refuse activation with missing/edited migrations or an `executing` group trade.
// Landing new code mid-fan-out is the R19 risk. Run after migration preparation
// and before activating the API; exit 1 blocks activation. Read-only.
//
// Usage:  node scripts/deploy-guard.mjs   (needs DATABASE_URL)

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { readDeployBlockers, readMigrationStatus } from '../packages/db/dist/index.js';

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set — see .env.example');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

try {
  const migrations = await readMigrationStatus(pool, process.env['TRADEX_MIGRATIONS_DIR'] ?? 'db/migrations');
  const pending = migrations.filter((s) => !s.applied);
  if (pending.length > 0) {
    console.error(`DEPLOY BLOCKED — database update required: ${pending.map((s) => s.version).join(', ')}. Apply the pending migrations before activating this API version.`);
    process.exitCode = 1;
  } else {
    const blockers = await readDeployBlockers(db);
    if (blockers.executingTrades > 0) {
      console.error(`DEPLOY BLOCKED — ${blockers.executingTrades} group trade(s) still executing` +
        (blockers.oldestExecutingSince === null
          ? ''
          : ` (oldest since ${blockers.oldestExecutingSince.toISOString()})`) +
        '\n    wait for the fan-out to complete, or resolve the working legs first.');
      process.exitCode = 1;
    } else {
      console.log('PASS deploy-guard — database is current and no group trade is mid-execution');
    }
  }
} finally {
  await db.destroy();
}
