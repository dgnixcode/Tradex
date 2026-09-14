// 02-account-lifecycle — deactivate, reactivate and delete a connected account.
//
// These three are the only things a customer can do to an account after creating
// it, and each has a boundary that is easy to get wrong:
//
//   - suspend is the REVERSIBLE brake: it must not touch the credential (revoking
//     crypto-shreds it, and cannot be undone) and must not be reachable from a
//     state other than `active`
//   - the sizing gates refuse any account that is not `active`, so a suspended
//     account is genuinely out of the next trade rather than merely displayed so
//   - delete is impossible once the account has TRADED — the ledger is append-only
//     by trigger and every child FK is RESTRICT, so the refusal has to come before
//     anything is removed, never halfway
//
// Runs against a real database. Skips cleanly without DATABASE_URL.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { LocalKms } from '../packages/crypto/dist/index.js';
import {
  accountHistoryCounts, addMember, createGroup, deleteAccount, forTenant, setAccountStatus,
} from '../packages/db/dist/index.js';
import { FakeVenue, probeCredential } from '../packages/exchange-coindcx/dist/index.js';
import { OnboardingService } from '../apps/api/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const SCHEMA = 'tradex_lifecycle_check';

const T1 = '11111111-1111-1111-1111-111111111111';
const PEPPER = Buffer.from('a1'.repeat(32), 'hex');

const KEY_A = 'lifecycle-key-a-0123456789';
const SECRET_A = 'lifecycle-secret-a-0123456789';
const KEY_B = 'lifecycle-key-b-0123456789';
const SECRET_B = 'lifecycle-secret-b-0123456789';

export async function run(assert) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  process.env['TRADEX_LOCAL_ROOT_KEY'] ??= 'ab'.repeat(32);

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
    await s.query("INSERT INTO tenant (id, name) VALUES ($1, 'Lifecycle T')", [T1]);
    // `createGroup` and `addMember` lock tenant_limit FOR UPDATE to enforce the
    // group caps, and nothing auto-creates the row — 01-db-live seeds it by hand too.
    await s.query('INSERT INTO tenant_limit (tenant_id) VALUES ($1)', [T1]);
  } finally {
    s.release();
  }

  const pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${SCHEMA},public` });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const tdb = forTenant(db, T1);
  const kms = new LocalKms();
  const venue = new FakeVenue({ credentials: { [KEY_A]: SECRET_A, [KEY_B]: SECRET_B } });
  const base = (await venue.start()).toString();
  const svc = new OnboardingService({
    tdb, kms, pepper: PEPPER,
    probe: (k, sec) => probeCredential(k, sec, { baseUrl: base, deadlineMs: 5_000 }),
  });

  const onboard = async (name, key, secret) => {
    const v = await svc.validate({ accountName: name, apiKey: key, apiSecret: secret });
    if (v.ok !== true) throw new Error(`onboarding ${name} failed: ${JSON.stringify(v.rejection)}`);
    await svc.confirm({ accountId: v.reconciliation.accountId });
    return v.reconciliation.accountId;
  };

  try {
    // ------------------------------------------------ 1. suspend / resume round trip
    const a = await onboard('Primary', KEY_A, SECRET_A);
    assert((await setAccountStatus(tdb, a, 'suspended')) === true, 'an active account could not be deactivated');
    const { rows: susp } = await pool.query(
      'SELECT status, allocated_capital_minor, allocated_currency FROM exchange_account WHERE id = $1', [a]);
    assert(susp[0].status === 'suspended', `the account is ${susp[0].status} after deactivation`);
    // The brake must not disturb anything else: not the sizing basis, and above all
    // not the credential — revoking it would crypto-shred the key irreversibly.
    assert(susp[0].allocated_capital_minor === '24875034', 'deactivating changed the sizing basis');
    assert(susp[0].allocated_currency === 'INR', 'deactivating changed the funding currency');
    const { rows: credSusp } = await pool.query(
      'SELECT status, dek_wrapped IS NOT NULL AS has_dek FROM exchange_credential WHERE account_id = $1', [a]);
    assert(credSusp[0].status === 'active' && credSusp[0].has_dek === true,
      'deactivating must leave the credential active and its DEK intact — revocation is irreversible');

    // Reversible both ways.
    assert((await setAccountStatus(tdb, a, 'active')) === true, 'a deactivated account could not be reactivated');
    const { rows: resumed } = await pool.query('SELECT status FROM exchange_account WHERE id = $1', [a]);
    assert(resumed[0].status === 'active', `the account is ${resumed[0].status} after reactivation`);

    // ---------------------------------- 2. a transition from the wrong state is refused
    // `false` is the signal, not an exception, so the route answers 409 rather than
    // reporting a success that changed nothing. The account is active here.
    assert((await setAccountStatus(tdb, a, 'active')) === false,
      'reactivating an already-active account must report no change');
    assert((await setAccountStatus(tdb, a, 'suspended')) === true,
      'deactivating an active account must report a change');
    assert((await setAccountStatus(tdb, a, 'suspended')) === false,
      'deactivating an already-deactivated account must report no change');
    assert((await setAccountStatus(tdb, a, 'active')) === true,
      'reactivating a deactivated account must report a change');
    assert((await setAccountStatus(tdb, a, 'active')) === false,
      'reactivating an already-active account must report no change');

    // ------------------------------------------------ 3. delete is refused once traded
    // "Has traded" means a `child_order` or `ledger_entry` row exists. They are
    // written here directly: this check is about the constraint, not about driving a
    // whole fan-out, and the columns below are the NOT NULL minimum plus whatever
    // the table's CHECKs require.
    const { rows: userRows } = await pool.query(
      "INSERT INTO app_user (tenant_id, email, password_hash, role) VALUES ($1, 'l@x.test', 'x', 'owner') RETURNING id",
      [T1]);
    const userId = userRows[0].id;
    const groupId = await createGroup(tdb, { name: 'G' });
    await addMember(tdb, { groupId, accountId: a, displayOrder: 0 });

    const b = await onboard('Secondary', KEY_B, SECRET_B);
    const fresh = await accountHistoryCounts(tdb, b);
    assert(fresh.childOrders === 0 && fresh.ledgerEntries === 0,
      'a freshly connected account claims a trading history');

    const { rows: tradeRows } = await pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type,
                                sizing_mode, sizing_value)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'quote_amount', '1000') RETURNING id`,
      [T1, groupId, userId]);
    await pool.query(
      `INSERT INTO child_order (tenant_id, group_trade_id, account_id, state)
       VALUES ($1, $2, $3, 'open')`, [T1, tradeRows[0].id, b]);

    const traded = await accountHistoryCounts(tdb, b);
    assert(traded.childOrders === 1, `the child order was not recorded (${traded.childOrders})`);

    let refused = null;
    try {
      await deleteAccount(tdb, b);
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    assert(refused !== null && /trading history/.test(refused),
      `deleting a traded account must be refused, got: ${refused}`);
    // The refusal must not have removed anything on the way: children go before the
    // parent, so a guard that ran too late would shred the credential and THEN fail.
    const { rows: survived } = await pool.query(
      `SELECT (SELECT count(*)::int FROM exchange_account WHERE id = $1) AS acct,
              (SELECT count(*)::int FROM exchange_credential WHERE account_id = $1) AS cred,
              (SELECT count(*)::int FROM child_order WHERE account_id = $1) AS kids`, [b]);
    assert(survived[0].acct === 1 && survived[0].cred === 1 && survived[0].kids === 1,
      `the refused delete removed things anyway: ${JSON.stringify(survived[0])}`);

    // ------------------------------------------------ 4. delete removes what it should
    // `a` has a group membership and a balance and a credential, none of it history.
    const { rows: before } = await pool.query(
      `SELECT (SELECT count(*)::int FROM account_balance WHERE account_id = $1) AS bal,
              (SELECT count(*)::int FROM exchange_credential WHERE account_id = $1) AS cred,
              (SELECT count(*)::int FROM group_member WHERE account_id = $1) AS mem,
              (SELECT count(*)::int FROM account_market_seen WHERE account_id = $1) AS seen`, [a]);
    assert(before[0].bal > 0 && before[0].cred === 1 && before[0].mem === 1,
      `the fixture is wrong: ${JSON.stringify(before[0])}`);

    const removed = await deleteAccount(tdb, a);
    assert(removed.credentials === 1, `expected 1 credential removed, got ${removed.credentials}`);
    assert(removed.balances === before[0].bal, `expected ${before[0].bal} balances removed, got ${removed.balances}`);
    assert(removed.memberships === 1, `expected 1 membership removed, got ${removed.memberships}`);

    const { rows: gone } = await pool.query(
      `SELECT (SELECT count(*)::int FROM exchange_account WHERE id = $1) AS acct,
              (SELECT count(*)::int FROM account_balance WHERE account_id = $1) AS bal,
              (SELECT count(*)::int FROM exchange_credential WHERE account_id = $1) AS cred,
              (SELECT count(*)::int FROM group_member WHERE account_id = $1) AS mem`, [a]);
    assert(gone[0].acct === 0 && gone[0].bal === 0 && gone[0].cred === 0 && gone[0].mem === 0,
      `the delete left rows behind: ${JSON.stringify(gone[0])}`);

    // Deleting something that is not there is a not-found, not a silent success.
    let notFound = null;
    try { await deleteAccount(tdb, a); } catch (e) { notFound = e instanceof Error ? e.message : String(e); }
    assert(notFound !== null && /not found|trading history/.test(notFound),
      `deleting a missing account must fail, got: ${notFound}`);

    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    console.log('     suspend/resume round trip; wrong-state transitions refused; delete blocked by history, clean otherwise');
  } finally {
    await venue.stop();
    await pool.end();
    await setupPool.end();
  }
}
