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
//   - the funding currency and the capital are the VENUE's: derived from what the
//     account holds, recorded at validate, and never accepted from a client
//   - an account holding neither INR nor USDT is refused with something to act on
//   - confirm persists the basis, the balances and the funding currencies
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
    const short = await svc.validate({ accountName: 'A', apiKey: 'short', apiSecret: SECRET });
    assert(short.ok === false && short.rejection.kind === 'shape_invalid', 'a too-short key was not rejected on shape');
    const unnamed = await svc.validate({ accountName: '   ', apiKey: KEY, apiSecret: SECRET });
    assert(unnamed.ok === false && unnamed.rejection.kind === 'shape_invalid', 'a blank account name was accepted');
    // Nothing was written for a shape rejection.
    const { rows: afterShape } = await pool.query('SELECT count(*)::int n FROM exchange_account');
    assert(afterShape[0].n === 0, 'a shape rejection still created an account row');

    // ------------------------------------------------ 2. the happy path to reconcile
    // The fake venue holds both INR (248750.34 = 24875034 paise) and USDT. INR
    // wins the derivation, and the capital is the venue's free balance — there is
    // no typed figure to compare it against any more.
    const ok = await svc.validate({ accountName: 'Primary', apiKey: KEY, apiSecret: SECRET });
    assert(ok.ok === true, `the valid key was rejected: ${ok.ok === false ? JSON.stringify(ok.rejection) : ''}`);
    const rec = ok.ok === true ? ok.reconciliation : null;
    assert(rec.realFreeMinor === '24875034', `reconciliation shows real ${rec.realFreeMinor}, expected 24875034`);
    assert(rec.allocatedCurrency === 'INR', `derived currency is ${rec.allocatedCurrency}, expected INR when both are held`);
    assert(rec.apiKeyLast4 === '6789', `apiKeyLast4 is ${rec.apiKeyLast4}`);
    assert(JSON.stringify(rec.fundingCurrencies) === '["INR","USDT"]',
      `funding currencies are ${JSON.stringify(rec.fundingCurrencies)}, expected INR+USDT`);

    // The account and credential exist but are BOTH still pending — validate does
    // not activate. Activation is the customer's explicit confirm.
    const beforeConfirm = await loadCiphertext(tdb, rec.credentialId);
    assert(beforeConfirm?.status === 'pending_validation',
      `after validate the credential is ${beforeConfirm?.status}, must be pending_validation`);
    const { rows: acctStatus } = await pool.query(
      'SELECT status, allocated_capital_minor, allocated_currency, allocated_confirmed_against_minor FROM exchange_account WHERE id = $1',
      [rec.accountId]);
    assert(acctStatus[0].status === 'pending_validation', 'the account was activated by validate, before confirm');
    // The basis is already recorded — it is the venue's read, and it is written the
    // moment it is known so that no later client request can restate it.
    assert(acctStatus[0].allocated_capital_minor === '24875034',
      `the venue basis was not recorded at validate (${acctStatus[0].allocated_capital_minor})`);
    assert(acctStatus[0].allocated_currency === 'INR', 'the derived currency was not recorded at validate');
    assert(acctStatus[0].allocated_confirmed_against_minor === null,
      'the confirmed-against stamp must wait for confirm — nothing is reconciled yet');
    // The balances and funding currencies land at validate too, not at confirm:
    // they are the venue's read, recorded the moment it happens, which is what lets
    // a connect abandoned at the review step be finished later from the account's
    // own page with nothing re-entered.
    const { rows: preBal } = await pool.query(
      'SELECT count(*)::int n FROM account_balance WHERE account_id = $1', [rec.accountId]);
    assert(preBal[0].n > 0, 'the observed balances were not recorded at validate');
    const { rows: preFund } = await pool.query(
      'SELECT funding_currencies FROM exchange_account WHERE id = $1', [rec.accountId]);
    assert(preFund[0].funding_currencies.join(',') === 'INR,USDT',
      'the funding currencies were not recorded at validate');

    // ------------------------------------------------ 3. duplicate key names the account
    const dup = await svc.validate({ accountName: 'Second', apiKey: KEY, apiSecret: SECRET });
    assert(dup.ok === false && dup.rejection.kind === 'duplicate_key', 'the same key was accepted twice');
    assert(dup.ok === false && dup.rejection.conflictingAccountName === 'Primary',
      'the duplicate rejection did not name the conflicting account');

    // ------------------------------------------------ 4. the three-cause auth message
    const badSecret = await svc.validate({
      accountName: 'BadSecret', apiKey: 'different-key-000000', apiSecret: 'wrong-secret-000000',
    });
    assert(badSecret.ok === false && badSecret.rejection.kind === 'auth_failed', 'a wrong secret was not an auth failure');
    assert(badSecret.ok === false && badSecret.rejection.message === THREE_CAUSE_MESSAGE,
      'the auth rejection is not the three-cause message');
    assert(badSecret.ok === false && /Bind IP Address/.test(badSecret.rejection.message),
      'the three-cause message omits the IP-binding cause — the one that actually bites a server platform');
    // NOTHING is written for a rejected attempt. This is the whole point of probing
    // before inserting: a failed connect cannot strand an account the customer has
    // no way to finish or remove. The audit log records the attempt instead.
    const { rows: afterFail } = await pool.query('SELECT count(*)::int n FROM exchange_account');
    assert(afterFail[0].n === 1, `a rejected attempt created rows (${afterFail[0].n} accounts, expected just Primary)`);
    const { rows: credAfterFail } = await pool.query('SELECT count(*)::int n FROM exchange_credential');
    assert(credAfterFail[0].n === 1, `a rejected attempt sealed a credential (${credAfterFail[0].n}, expected 1)`);

    // ------------------------------------------------ 5. confirm activates and persists
    // The whole payload is the account id: the basis, the funding currencies and the
    // balances are already stored from the venue read.
    await svc.confirm({ accountId: rec.accountId });
    const activated = await loadCiphertext(tdb, rec.credentialId);
    assert(activated?.status === 'active', `confirm did not activate the credential (${activated?.status})`);

    const { rows: finalAcct } = await pool.query(
      `SELECT status, allocated_capital_minor, allocated_currency, allocated_confirmed_against_minor, funding_currencies
         FROM exchange_account WHERE id = $1`, [rec.accountId]);
    const fa = finalAcct[0];
    assert(fa.status === 'active', 'the account is not active after confirm');
    assert(fa.allocated_capital_minor === '24875034', 'the sizing basis is not the venue free balance');
    assert(fa.allocated_currency === 'INR', 'the sizing currency is not the derived one');
    assert(fa.allocated_confirmed_against_minor === '24875034',
      'the confirmed-against stamp must be the basis this activation was reconciled against');
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

    // ------------------------------------------------ 6. a USDT-only account derives USDT
    // Same sequence, but the account holds no INR at all: the derivation must fall
    // through to USDT rather than keep the INR default and size against nothing.
    const KEY2 = 'second-key-abcdef0123456789';
    const SECRET2 = 'second-secret-abcdef0123456789';
    venue.reset();
    // reset() cleared the credentials map, so re-register both keys.
    const venue2 = new FakeVenue({ credentials: { [KEY2]: SECRET2 } });
    venue2.setBalance('INR', 0, 0);
    const base2 = (await venue2.start()).toString();
    const svc2 = new OnboardingService({
      tdb, kms, pepper: PEPPER,
      probe: (k, sec) => probeCredential(k, sec, { baseUrl: base2, deadlineMs: 5_000 }),
    });
    const r2 = await svc2.validate({ accountName: 'UsdtOnly', apiKey: KEY2, apiSecret: SECRET2 });
    assert(r2.ok === true, 'the second account failed to validate');
    const rec2 = r2.ok === true ? r2.reconciliation : null;
    assert(rec2.allocatedCurrency === 'USDT', `currency is ${rec2.allocatedCurrency}, expected USDT with no INR held`);
    assert(JSON.stringify(rec2.fundingCurrencies) === '["USDT"]',
      `funding currencies are ${JSON.stringify(rec2.fundingCurrencies)}, expected USDT only`);
    // USDT free is 1420.88888888 = 142088888888 at scale 8.
    assert(rec2.realFreeMinor === '142088888888', `USDT real free is ${rec2.realFreeMinor}`);
    await svc2.confirm({ accountId: rec2.accountId });
    const { rows: usdt } = await pool.query(
      'SELECT allocated_capital_minor, allocated_currency FROM exchange_account WHERE id = $1', [rec2.accountId]);
    assert(usdt[0].allocated_capital_minor === '142088888888',
      'the USDT basis is not the venue free balance');
    assert(usdt[0].allocated_currency === 'USDT', 'the basis currency did not follow the derivation');

    // ------------------------------------------------ 7. an account with nothing to fund
    // Holding neither quote leaves nothing to size a percentage-of-capital order
    // against. Refusing beats activating an account whose basis is zero.
    const KEY3 = 'third-key-abcdef0123456789';
    const SECRET3 = 'third-secret-abcdef0123456789';
    const venue3 = new FakeVenue({ credentials: { [KEY3]: SECRET3 } });
    venue3.setBalance('INR', 0, 0);
    venue3.setBalance('USDT', 0, 0);
    const base3 = (await venue3.start()).toString();
    const svc3 = new OnboardingService({
      tdb, kms, pepper: PEPPER,
      probe: (k, sec) => probeCredential(k, sec, { baseUrl: base3, deadlineMs: 5_000 }),
    });
    const r3 = await svc3.validate({ accountName: 'Empty', apiKey: KEY3, apiSecret: SECRET3 });
    assert(r3.ok === false && r3.rejection.kind === 'no_funding_currency',
      `an account holding no INR and no USDT was not refused (${JSON.stringify(r3.rejection)})`);
    assert(r3.ok === false && /Fund the account/.test(r3.rejection.message),
      'the no-funding-currency rejection must say what to do about it');
    const { rows: emptyAcct } = await pool.query(
      "SELECT count(*)::int n FROM exchange_account WHERE name = 'Empty'");
    assert(emptyAcct[0].n === 0,
      'a refused account must leave no row at all — the refusal happens before anything is written');

    // ------------------------------------------------ 7b. a name clash, not a 500
    // `exchange_account_name_unique UNIQUE (tenant_id, name)`. Two different keys
    // may share a display name, and without this the second insert would surface as
    // a raw 500 on a perfectly ordinary mistake.
    const KEY5 = 'fifth-key-abcdef0123456789';
    const SECRET5 = 'fifth-secret-abcdef0123456789';
    const venue5 = new FakeVenue({ credentials: { [KEY5]: SECRET5 } });
    const base5 = (await venue5.start()).toString();
    const svc5 = new OnboardingService({
      tdb, kms, pepper: PEPPER,
      probe: (k, sec) => probeCredential(k, sec, { baseUrl: base5, deadlineMs: 5_000 }),
    });
    const clash = await svc5.validate({ accountName: 'Primary', apiKey: KEY5, apiSecret: SECRET5 });
    assert(clash.ok === false && clash.rejection.kind === 'duplicate_name',
      `a duplicate account name was not reported (${JSON.stringify(clash.rejection)})`);
    assert(clash.ok === false && /already exists/.test(clash.rejection.message),
      'the duplicate-name rejection must name the problem');
    const { rows: afterClash } = await pool.query('SELECT count(*)::int n FROM exchange_account');
    assert(afterClash[0].n === 2,
      `a name clash left rows behind (${afterClash[0].n} accounts, expected 2 — the rollback did not happen)`);
    await venue5.stop();

    // ------------------------------------------------ 8. wallet dust + the two scales
    // The live shape that hard-failed onboarding: a real account returned INR
    // `0.00508437692499` — 14 decimals, because the venue tracks its internal
    // ledger finer than the rupee's tradable step. Two things must hold at once:
    // the balance must be storable exactly, and the sub-paise dust must NOT be
    // mistaken for spendable INR and win the derivation over a real USDT balance.
    const KEY4 = 'fourth-key-abcdef0123456789';
    const SECRET4 = 'fourth-secret-abcdef0123456789';
    const venue4 = new FakeVenue({ credentials: { [KEY4]: SECRET4 } });
    venue4.setBalance('INR', 0.00508437692499, 0);
    venue4.setBalance('USDT', 100, 0);
    const base4 = (await venue4.start()).toString();
    const svc4 = new OnboardingService({
      tdb, kms, pepper: PEPPER,
      probe: (k, sec) => probeCredential(k, sec, { baseUrl: base4, deadlineMs: 5_000 }),
    });
    const r4 = await svc4.validate({ accountName: 'DustInr', apiKey: KEY4, apiSecret: SECRET4 });
    assert(r4.ok === true, `the dust-INR account was refused: ${r4.ok === false ? r4.rejection.message : ''}`);
    const rec4 = r4.ok === true ? r4.reconciliation : null;
    assert(rec4.allocatedCurrency === 'USDT',
      `sub-paise INR dust won the derivation (got ${rec4?.allocatedCurrency}) — the account can only fund with USDT`);
    assert(JSON.stringify(rec4.fundingCurrencies) === '["USDT"]',
      `funding currencies are ${JSON.stringify(rec4.fundingCurrencies)}, expected USDT alone`);
    // And the basis is at the QUOTE's tradable scale, not the wallet's: 100 USDT is
    // 10000000000 at scale 8. A wallet-scale reading would be 10^10 out.
    assert(rec4.realFreeMinor === '10000000000', `the USDT basis is ${rec4.realFreeMinor}, expected 10000000000`);
    // Confirm writes the observed balances; the INR row must land EXACTLY, at the
    // wallet scale, even though it contributes nothing to the basis.
    await svc4.confirm({ accountId: rec4.accountId });
    const { rows: dust } = await pool.query(
      "SELECT free_minor, scale FROM account_balance WHERE account_id = $1 AND currency = 'INR'", [rec4.accountId]);
    assert(dust[0]?.free_minor === '5084376924990000' && dust[0]?.scale === 18,
      `the dust INR row was not stored exactly: ${JSON.stringify(dust[0])}`);

    await venue4.stop();
    await venue3.stop();
    await venue2.stop();
    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    console.log('     full 19 F3 sequence: shape → duplicate → three-cause 401 → venue-derived basis → confirm/activate');
  } finally {
    await venue.stop();
    await pool.end();
    await setupPool.end();
  }
}
