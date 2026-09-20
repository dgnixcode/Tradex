// Emergency Kill Switch CLI tool.
//
// Usage:
//   node scripts/kill-switch.mjs status
//   node scripts/kill-switch.mjs on "Maintenance or emergency halt reason"
//   node scripts/kill-switch.mjs off
//
// Needs DATABASE_URL.

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { readPlatformKillSwitchDetails, setPlatformKillSwitch } from '../packages/db/dist/index.js';

try {
  process.loadEnvFile?.('.env');
} catch {}

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set — see .env.example');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 2 });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

const cmd = process.argv[2]?.toLowerCase() ?? 'status';
const reasonArg = process.argv.slice(3).join(' ').trim();

try {
  if (cmd === 'on' || cmd === 'enable') {
    const reason = reasonArg !== '' ? reasonArg : 'CLI operator manual activation';
    const res = await setPlatformKillSwitch(db, true, reason, 'cli-operator');
    console.log('\nEMERGENCY KILL SWITCH ENGAGED');
    console.log('----------------------------------------------------');
    console.log(`Status:      HALTED (killSwitch = ${res.killSwitch})`);
    console.log(`Mode:        ${res.mode}`);
    console.log(`Reason:      ${res.modeReason ?? 'none'}`);
    console.log(`Changed At:  ${res.changedAt ? res.changedAt.toISOString() : 'now'}`);
    console.log(`Changed By:  ${res.changedBy ?? 'unknown'}`);
    console.log('----------------------------------------------------');
    console.log('All order placement, position exits, adjustments, and TP/SL mutations are now BLOCKED.\n');
  } else if (cmd === 'off' || cmd === 'disable') {
    const res = await setPlatformKillSwitch(db, false, undefined, 'cli-operator');
    console.log('\nEMERGENCY KILL SWITCH DISENGAGED');
    console.log('----------------------------------------------------');
    console.log(`Status:      NORMAL (killSwitch = ${res.killSwitch})`);
    console.log(`Mode:        ${res.mode}`);
    console.log(`Changed At:  ${res.changedAt ? res.changedAt.toISOString() : 'now'}`);
    console.log(`Changed By:  ${res.changedBy ?? 'unknown'}`);
    console.log('----------------------------------------------------');
    console.log('Trading and position modifications are now ACTIVE.\n');
  } else {
    // status
    const details = await readPlatformKillSwitchDetails(db);
    const envKill = process.env['TRADEX_KILL_SWITCH'] === '1';
    const isKilled = details.killSwitch || envKill || details.mode === 'read_only';

    console.log('\nEMERGENCY KILL SWITCH STATUS');
    console.log('----------------------------------------------------');
    console.log(`Effective:   ${isKilled ? 'HALTED (Read-Only Mode)' : 'NORMAL (Trading Enabled)'}`);
    console.log(`DB Switch:   ${details.killSwitch ? 'ACTIVE' : 'INACTIVE'}`);
    console.log(`DB Mode:     ${details.mode}`);
    console.log(`Reason:      ${details.modeReason ?? 'none'}`);
    console.log(`Changed At:  ${details.changedAt ? details.changedAt.toISOString() : 'never'}`);
    console.log(`Changed By:  ${details.changedBy ?? 'none'}`);
    console.log(`ENV Override:${envKill ? ' TRADEX_KILL_SWITCH=1 (FORCED HALT)' : ' None'}`);
    console.log('----------------------------------------------------\n');
  }
} finally {
  await db.destroy();
}
