// Deploy guard — plan/phase-13 T13.7 (research/20 F5).
//
// Refuse a deploy while any group trade is still `executing`: landing new code
// mid-fan-out is the R19 risk. Run this as the first step of a deploy pipeline;
// exit 1 blocks the deploy, exit 0 is safe. Read-only — it never mutates.
//
// Usage:  node scripts/deploy-guard.mjs   (needs DATABASE_URL)

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { readDeployBlockers } from '../packages/db/dist/index.js';

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set — see .env.example');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

try {
  const blockers = await readDeployBlockers(db);
  if (blockers.executingTrades > 0) {
    console.error(`DEPLOY BLOCKED — ${blockers.executingTrades} group trade(s) still executing` +
      (blockers.oldestExecutingSince === null
        ? ''
        : ` (oldest since ${blockers.oldestExecutingSince.toISOString()})`) +
      '\n    wait for the fan-out to complete, or resolve the working legs first.');
    process.exit(1);
  }
  console.log('PASS deploy-guard — no group trade is mid-execution');
  process.exit(0);
} finally {
  await db.destroy();
}
