// 02-onboarding — plan/phase-02 T02.4 and T02.5, the full sequence end to end.
//
// Runs the real OnboardingService against the signature-verifying fake venue and
// a real database, so every branch of the 19 F3 sequence is exercised with the
// actual crypto, storage and validation in place — not mocked.
//
// The branches that matter, each a real failure a customer will hit:
//   - a duplicate key is rejected NAMING the account it clashes with
//   - a wrong secret yields the THREE-CAUSE message (the IP-binding trap is the
//     one that actually bites a server-side platform, 07 F1)
//   - validate leaves the account pending; only confirm activates it
//   - the reconciliation panel's `diverges` is true whenever typed != real
//   - confirm persists both capital figures, the balances and the funding ccys
//
// Skips cleanly without DATABASE_URL.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { LocalKms } from '../packages/crypto/dist/index.js';
import { forTenant, loadCiphertext } from '../packages/db/dist/index.js';
import { FakeVenue, probeCredential } from '../packages/exchange-coindcx/dist/index.js';
import { OnboardingService, THREE_CAUSE_MESSAGE } from '../apps/api/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const SCHEMA = 'tradex_onboard_check';

const T1 = '11111111-1111-1111-1111-111111111111';
const PEPPER = Buffer.from('e5'.repeat(32), 'hex');

const KEY = 'onboard-key-abcdef0123456789';
const SECRET = 'onboard-secret-abcdef0123456789';

export async function run(assert) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  process.env['TRADEX_LOCAL_ROOT_KEY'] ??= 'cd'.repeat(32);

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
    await s.query("INSERT INTO tenant (id, name) VALUES ($1, 'Onboard T')", [T1]);
  } finally {
    s.release();
  }

  const pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${SCHEMA},public` });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const kms = new LocalKms();
  const tdb = forTenant(db, T1);

  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  const base = (await venue.start()).toString();
  const probe = (apiKey, apiSecret) => probeCredential(apiKey, apiSecret, { baseUrl: base, deadlineMs: 5_000 });
  const svc = new OnboardingService({ tdb, kms, pepper: PEPPER, probe });

  try {
    // ------------------------------------------------ 1. shape rejections, no I/O
    const short = await svc.validate({
      accountName: 'A', allocatedCapitalMinor: '1000000', allocatedCurrency: 'INR',
      apiKey: 'short', apiSecret: SECRET,
    });
    assert(short.ok === false && short.rejection.kind === 'shape_invalid', 'a too-short key was not rejected on shape');
    const zero = await svc.validate({
      accountName: 'A', allocatedCapitalMinor: '0', allocatedCurrency: 'INR', apiKey: KEY, apiSecret: SECRET,
    });
    assert(zero.ok === false && zero.rejection.kind === 'shape_invalid', 'zero allocated capital was accepted');
    // Nothing was written for a shape rejection.
    const { rows: afterShape } = await pool.query('SELECT count(*)::int n FROM exchange_account');
    assert(afterShape[0].n === 0, 'a shape rejection still created an account row');

    // ------------------------------------------------ 2. the happy path to reconcile
    // The fake venue's INR free balance is 248750.34 = 24875034 paise; the customer
    // typed 2,00,000.00 = 20000000, so the two diverge and the panel must show it.
    const typed = '20000000';
    const ok = await svc.validate({
      accountName: 'Primary', allocatedCapitalMinor: typed, allocatedCurrency: 'INR', apiKey: KEY, apiSecret: SECRET,
    });
    assert(ok.ok === true, `the valid key was rejected: ${ok.ok === false ? JSON.stringify(ok.rejection) : ''}`);
    const rec = ok.ok === true ? ok.reconciliation : null;
    assert(rec.realFreeMinor === '24875034', `reconciliation shows real ${rec.realFreeMinor}, expected 24875034`);
    assert(rec.typedCapitalMinor === typed, 'reconciliation lost the typed figure');
    assert(rec.diverges === true, 'the panel must flag that typed and real differ');
    assert(rec.apiKeyLast4 === '6789', `apiKeyLast4 is ${rec.apiKeyLast4}`);
    assert(JSON.stringify(rec.fundingCurrencies) === '["INR","USDT"]',
      `funding currencies are ${JSON.stringify(rec.fundingCurrencies)}, expected INR+USDT`);

    // The account and credential exist but are BOTH still pending — validate does
    // not activate. Activation is the customer's explicit confirm.
    const beforeConfirm = await loadCiphertext(tdb, rec.credentialId);
    assert(beforeConfirm?.status === 'pending_validation',
      `after validate the credential is ${beforeConfirm?.status}, must be pending_validation`);
    const { rows: acctStatus } = await pool.query('SELECT status FROM exchange_account WHERE id = $1', [rec.accountId]);
    assert(acctStatus[0].status === 'pending_validation', 'the account was activated by validate, before confirm');

    // ------------------------------------------------ 3. duplicate key names the account
    const dup = await svc.validate({
      accountName: 'Second', allocatedCapitalMinor: '5000000', allocatedCurrency: 'INR', apiKey: KEY, apiSecret: SECRET,
    });
    assert(dup.ok === false && dup.rejection.kind === 'duplicate_key', 'the same key was accepted twice');
    assert(dup.ok === false && dup.rejection.conflictingAccountName === 'Primary',
      'the duplicate rejection did not name the conflicting account');

    // ------------------------------------------------ 4. the three-cause auth message
    const badSecret = await svc.validate({
      accountName: 'BadSecret', allocatedCapitalMinor: '1000000', allocatedCurrency: 'INR',
      apiKey: 'different-key-000000', apiSecret: 'wrong-secret-000000',
    });
    assert(badSecret.ok === false && badSecret.rejection.kind === 'auth_failed', 'a wrong secret was not an auth failure');
    assert(badSecret.ok === false && badSecret.rejection.message === THREE_CAUSE_MESSAGE,
      'the auth rejection is not the three-cause message');
    assert(badSecret.ok === false && /Bind IP Address/.test(badSecret.rejection.message),
      'the three-cause message omits the IP-binding cause — the one that actually bites a server platform');
    // The failed attempt still created its account+credential as pending (audit trail).
    const { rows: badAcct } = await pool.query("SELECT status FROM exchange_account WHERE name = 'BadSecret'");
    assert(badAcct[0]?.status === 'pending_validation', 'the failed-auth account was not left pending for retry');

    // ------------------------------------------------ 5. confirm activates and persists
    // Keep the typed figure (adoptRealAsBasis false): both numbers must persist.
    await svc.confirm({
      accountId: rec.accountId, credentialId: rec.credentialId,
      confirmedAgainstMinor: rec.realFreeMinor, adoptRealAsBasis: false,
      fundingCurrencies: rec.fundingCurrencies, balances: rec.balances,
    });
    const activated = await loadCiphertext(tdb, rec.credentialId);
    assert(activated?.status === 'active', `confirm did not activate the credential (${activated?.status})`);

    const { rows: finalAcct } = await pool.query(
      `SELECT status, allocated_capital_minor, allocated_confirmed_against_minor, funding_currencies
         FROM exchange_account WHERE id = $1`, [rec.accountId]);
    const fa = finalAcct[0];
    assert(fa.status === 'active', 'the account is not active after confirm');
    assert(fa.allocated_capital_minor === typed, 'the typed basis was overwritten though adoptRealAsBasis was false');
    assert(fa.allocated_confirmed_against_minor === '24875034', 'the real balance was not recorded at confirmation');
    assert(Array.isArray(fa.funding_currencies) && fa.funding_currencies.join(',') === 'INR,USDT',
      `funding currencies persisted as ${JSON.stringify(fa.funding_currencies)}`);

    // The observed balances landed, and ETH (0/0) was dropped, not stored.
    const { rows: balRows } = await pool.query(
      'SELECT currency, free_minor, scale FROM account_balance WHERE account_id = $1 ORDER BY currency', [rec.accountId]);
    const currencies = balRows.map((r) => r.currency);
    assert(!currencies.includes('ETH'), 'a zero balance (ETH) was stored');
    assert(currencies.includes('INR') && currencies.includes('BTC'), 'a held balance was not persisted');
    const inr = balRows.find((r) => r.currency === 'INR');
    assert(inr.free_minor === '24875034' && inr.scale === 2, 'the persisted INR balance is wrong');

    // ------------------------------------------------ 6. adopt-real basis on a fresh account
    const KEY2 = 'second-key-abcdef0123456789';
    const SECRET2 = 'second-secret-abcdef0123456789';
    venue.reset();
    // reset() cleared the credentials map, so re-register both keys.
    const venue2 = new FakeVenue({ credentials: { [KEY2]: SECRET2 } });
    const base2 = (await venue2.start()).toString();
    const svc2 = new OnboardingService({
      tdb, kms, pepper: PEPPER,
      probe: (k, sec) => probeCredential(k, sec, { baseUrl: base2, deadlineMs: 5_000 }),
    });
    const r2 = await svc2.validate({
      accountName: 'AdoptReal', allocatedCapitalMinor: '100', allocatedCurrency: 'USDT', apiKey: KEY2, apiSecret: SECRET2,
    });
    assert(r2.ok === true, 'the second account failed to validate');
    const rec2 = r2.ok === true ? r2.reconciliation : null;
    // USDT free is 1420.88888888 = 142088888888 at scale 8.
    assert(rec2.realFreeMinor === '142088888888', `USDT real free is ${rec2.realFreeMinor}`);
    await svc2.confirm({
      accountId: rec2.accountId, credentialId: rec2.credentialId,
      confirmedAgainstMinor: rec2.realFreeMinor, adoptRealAsBasis: true,
      fundingCurrencies: rec2.fundingCurrencies, balances: rec2.balances,
    });
    const { rows: adopt } = await pool.query(
      'SELECT allocated_capital_minor FROM exchange_account WHERE id = $1', [rec2.accountId]);
    assert(adopt[0].allocated_capital_minor === '142088888888',
      'adoptRealAsBasis true did not move the sizing basis to the real balance');

    await venue2.stop();
    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    console.log('     full 19 F3 sequence: shape → duplicate → three-cause 401 → reconcile → confirm/activate');
  } finally {
    await venue.stop();
    await pool.end();
    await setupPool.end();
  }
}
