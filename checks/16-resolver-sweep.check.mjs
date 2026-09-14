// 16-resolver-sweep — the timer that keeps the resolve ladder alive.
//
// Settling a leg `ambiguous` enqueues a resolve job, and the ladder re-enqueues
// with growing gaps up to 20 s. But the ONLY caller of `runResolveOnce` used to be
// a confirm's inline drain — so the moment the confirm response was written, the
// ladder stopped, and a leg whose outcome the venue had not yet settled sat
// `ambiguous` FOREVER with real money at the venue and nothing looking at it.
//
// This check drives the real server on a short sweep interval and proves a leg
// resolves with NO further request of any kind. A timer that never fires looks
// exactly like a timer with nothing to do, so the assertion is on the state
// change, not on the timer existing.
//
// Needs a database. Skips cleanly without DATABASE_URL.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { LocalKms } from '../packages/crypto/dist/index.js';
import { createHttpServer } from '../apps/api/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const SCHEMA = 'tradex_resolver_check';

const T1 = '11111111-1111-1111-1111-111111111111';
const ACCOUNT = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const GROUP = '44444444-4444-4444-4444-444444444444';
const TRADE = '55555555-5555-5555-5555-555555555555';
const CHILD = '66666666-6666-6666-6666-666666666666';

const PEPPER = Buffer.from('cd'.repeat(16), 'hex');

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

export async function run(assert) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  process.env['TRADEX_LOCAL_ROOT_KEY'] ??= 'ce'.repeat(32);

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
    await s.query("INSERT INTO tenant (id, name) VALUES ($1, 'Resolver T')", [T1]);
    await s.query("INSERT INTO app_user (id, tenant_id, email, password_hash, role) VALUES ($1,$2,'r@x.test','x','owner')", [USER, T1]);
    await s.query(
      `INSERT INTO exchange_account (id, tenant_id, name, allocated_capital_minor, allocated_currency, status)
       VALUES ($1, $2, 'Resolver', '100000000', 'INR', 'active')`, [ACCOUNT, T1]);
    await s.query("INSERT INTO account_group (id, tenant_id, name) VALUES ($1, $2, 'G')", [GROUP, T1]);
    await s.query(
      `INSERT INTO group_trade (id, tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at, is_futures, leverage, margin_currency, position_margin_type)
       VALUES ($1,$2,$3,$4,'BTC','buy','market','quote_amount','1000','executing','resolver-check-token', now() + interval '1 hour', true,'5','INR','isolated')`,
      [TRADE, T1, GROUP, USER]);
    // A leg stranded mid-flight: the venue's answer never arrived.
    await s.query(
      `INSERT INTO child_order (id, tenant_id, group_trade_id, account_id, market, state, final_quantity, leg_seq, client_order_id)
       VALUES ($1,$2,$3,$4,'BTCINR','ambiguous','0.001',0,'resolver-check-coid')`, [CHILD, T1, TRADE, ACCOUNT]);
    // ...and the resolve job the ladder would have queued for it.
    await s.query(
      "INSERT INTO execution_job (child_order_id, tenant_id, kind, run_after) VALUES ($1,$2,'resolve', now() - interval '1 second')",
      [CHILD, T1]);
  } finally {
    s.release();
  }

  const pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${SCHEMA},public` });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

  // The resolve port answers the way the venue finally did: the order filled.
  const resolveCalls = [];
  const server = createHttpServer({
    db,
    getOrderBook: async () => ({ market: { asset: 'BTC', quote: 'INR' }, asks: [], bids: [], observedAtMs: Date.now() }),
    cookieSecret: Buffer.from('ef'.repeat(32), 'hex'),
    verifySecondFactor: async () => false,
    kms: new LocalKms(),
    pepper: PEPPER,
    probe: async () => ({ ok: false, neverSent: true, failure: undefined }),
    codeVersion: 'resolver-check',
    secureCookies: false,
    submit: async () => ({ kind: 'rejected', orderMayExist: false, code: 'unused', detail: 'not used here' }),
    resolve: async (coid) => {
      resolveCalls.push(coid);
      return { ok: true, order: { id: 'ford-9', statusRaw: 'filled' } };
    },
    executionPepper: PEPPER,
    // The shortest interval that still proves it is a TIMER and not the request
    // path: nothing here asks for anything, so only the sweep can move it.
    resolverIntervalMs: 150,
  });
  await new Promise((r) => { server.listen(0, '127.0.0.1', r); });

  try {
    const stateOf = async () => {
      const { rows } = await pool.query('SELECT state FROM child_order WHERE id = $1', [CHILD]);
      return rows[0]?.state;
    };
    assert(await stateOf() === 'ambiguous', 'the fixture did not start ambiguous');

    // NO request is made in this window. If the leg resolves, only the sweep did it.
    let resolved = null;
    for (let i = 0; i < 40; i += 1) {
      await sleep(100);
      if (await stateOf() !== 'ambiguous') { resolved = await stateOf(); break; }
    }

    assert(resolved !== null,
      'the leg is STILL ambiguous — the resolve ladder has no caller once a confirm returns, '
      + 'so an unresolved send parks forever with real money at the venue');
    assert(resolved === 'filled', `the sweep resolved the leg to "${resolved}", expected filled`);
    assert(resolveCalls.includes('resolver-check-coid'),
      `the sweep settled without asking the venue (calls: ${JSON.stringify(resolveCalls)})`);

    // The job it drained must be gone or re-scheduled, never left claimable in a
    // loop that would spin the sweep forever on the same leg.
    const { rows: jobs } = await pool.query(
      "SELECT count(*)::int n FROM execution_job WHERE child_order_id = $1 AND locked_by IS NULL AND run_after <= now()", [CHILD]);
    assert(jobs[0].n === 0, `the sweep left ${jobs[0].n} immediately-claimable job(s) behind`);

    console.log('     resolver sweep: a stranded ambiguous leg resolved on a timer, with no request made');
  } finally {
    await new Promise((r) => { server.close(r); });
    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await pool.end();
    await setupPool.end();
  }
}
