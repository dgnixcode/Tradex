// 02-accounts — plan/phase-02 T02.8, the parts that are contract and policy, not chrome.
//
// The visual accounts UI needs a frontend stack that this backend workspace does
// not have yet. But T02.8's acceptance criteria are mostly NOT visual, and those
// are enforced here:
//
//   - "both disclosures appear on every add-account view" — a content invariant,
//     asserted on the structured disclosures the UI must render verbatim
//   - "exactly one route accepts a key" — a STRUCTURAL invariant, asserted by
//     scanning apps/api source for how many exported functions ingest a secret
//   - the accounts list read model returns name / currencies / the venue's
//     allocated capital / status, proven against a real database
//
// Skips the DB portion cleanly without DATABASE_URL; the source-scan and
// disclosure assertions run regardless.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { LocalKms } from '../packages/crypto/dist/index.js';
import { forTenant } from '../packages/db/dist/index.js';
import { FakeVenue, probeCredential } from '../packages/exchange-coindcx/dist/index.js';
import {
  ADD_ACCOUNT_DISCLOSURES, KEY_ENTRY_ROUTE, NEVER_ASK_NOTICE, OnboardingService, listAccounts,
} from '../apps/api/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiSrc = join(root, 'apps', 'api', 'src');
const migrationsDir = join(root, 'db', 'migrations');
const SCHEMA = 'tradex_accounts_check';

const T1 = '11111111-1111-1111-1111-111111111111';
const PEPPER = Buffer.from('f7'.repeat(32), 'hex');
const KEY = 'accounts-key-abcdef0123456789';
const SECRET = 'accounts-secret-abcdef0123456789';

export async function run(assert) {
  // ---------------------------------------------- 1. the disclosures (no DB needed)
  assert(ADD_ACCOUNT_DISCLOSURES.length === 2, 'the add-account view must carry exactly the two required disclosures');
  const ids = ADD_ACCOUNT_DISCLOSURES.map((d) => d.id).sort();
  assert(ids.join(',') === 'no-ip-binding,no-restricted-keys', `disclosures are ${ids.join(',')}`);
  for (const d of ADD_ACCOUNT_DISCLOSURES) {
    assert(d.title.length > 0 && d.body.length > 40, `disclosure ${d.id} has no real body`);
    assert(d.mustAcknowledge === true, `disclosure ${d.id} is not marked must-acknowledge`);
  }
  // The two facts that cost money must actually be stated, not just titled.
  const ipDisc = ADD_ACCOUNT_DISCLOSURES.find((d) => d.id === 'no-ip-binding');
  assert(/Bind IP Address/i.test(ipDisc.body) && /server/i.test(ipDisc.body),
    'the IP-binding disclosure does not explain why an IP-bound key fails on our servers');
  const restrictedDisc = ADD_ACCOUNT_DISCLOSURES.find((d) => d.id === 'no-restricted-keys');
  assert(/read-only|read only|trade-only/i.test(restrictedDisc.body),
    'the no-restricted-keys disclosure does not say keys cannot be read-only');
  assert(/withdraw/i.test(restrictedDisc.body), 'the no-restricted-keys disclosure omits the withdrawal boundary');
  // The never-ask notice names both the password and the 2FA seed.
  assert(/password/i.test(NEVER_ASK_NOTICE) && /2fa|authenticator/i.test(NEVER_ASK_NOTICE),
    'the never-ask notice does not cover both the password and the 2FA seed');

  // ------------------------------------ 2. exactly one route accepts a key (structural)
  // Scan apps/api source: a function that takes BOTH apiKey and apiSecret is a
  // key-ingestion point. There must be exactly one — the onboarding validate. A
  // second one is a second attack surface and a second thing to phish.
  const tsFiles = readdirSync(apiSrc).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const ingestors = [];
  for (const f of tsFiles) {
    const src = readFileSync(join(apiSrc, f), 'utf8');
    // A parameter list (or interface) that names both apiKey and apiSecret.
    for (const m of src.matchAll(/(?:function\s+\w+|interface\s+\w+|\w+\s*[:(])[^;{]*\bapiKey\b[^;{]*\bapiSecret\b/g)) {
      ingestors.push({ file: f, at: m.index });
    }
  }
  assert(ingestors.length >= 1, 'no key-ingestion point found in apps/api — the onboarding input should take a key');
  const ingestFiles = [...new Set(ingestors.map((i) => i.file))];
  assert(ingestFiles.length === 1 && ingestFiles[0] === 'onboarding-service.ts',
    `more than one file ingests a key: ${ingestFiles.join(', ')} — there must be exactly one canonical entry`);
  assert(KEY_ENTRY_ROUTE === '/accounts/connect', 'the canonical key-entry route constant drifted');

  // ------------------------------------------------ 3. the accounts list (needs a DB)
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.log('     (disclosures + single-entry checked; accounts list skipped: no DATABASE_URL)');
    return;
  }
  process.env['TRADEX_LOCAL_ROOT_KEY'] ??= 'ef'.repeat(32);

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
    await s.query("INSERT INTO tenant (id, name) VALUES ($1, 'Accounts T')", [T1]);
  } finally {
    s.release();
  }

  const pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${SCHEMA},public` });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
  const tdb = forTenant(db, T1);
  const kms = new LocalKms();
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  const base = (await venue.start()).toString();
  const svc = new OnboardingService({
    tdb, kms, pepper: PEPPER,
    probe: (k, sec) => probeCredential(k, sec, { baseUrl: base, deadlineMs: 5_000 }),
  });

  try {
    // An empty tenant lists nothing.
    assert((await listAccounts(tdb)).length === 0, 'a fresh tenant already had accounts');

    // Onboard one account. Nothing about its money is typed: the FakeVenue holds
    // INR, so the derived basis is the venue's INR free balance.
    const v = await svc.validate({ accountName: 'Primary', apiKey: KEY, apiSecret: SECRET });
    assert(v.ok === true, 'onboarding failed to validate');
    const rec = v.ok === true ? v.reconciliation : null;

    // Before confirm: the account lists as pending, with the venue's basis AND its
    // funding currencies already recorded — both were read during validate, which
    // is what makes a half-finished connect resumable. Only the confirmed-against
    // stamp waits for the activation.
    const pending = await listAccounts(tdb);
    assert(pending.length === 1 && pending[0].status === 'pending_validation', 'the pending account did not list');
    assert(pending[0].allocatedCapitalMinor === '24875034', 'the pending account is missing the venue basis');
    assert(pending[0].allocatedCurrency === 'INR', 'the pending account is missing the venue currency');
    assert(pending[0].confirmedAgainstMinor === null, 'a pending account already has a confirmed figure');
    assert(pending[0].fundingCurrencies.join(',') === 'INR,USDT',
      'the funding currencies read at validate are missing');

    // The whole payload is the account id — nothing about the account's money is
    // echoed back by the client.
    await svc.confirm({ accountId: rec.accountId });

    // After confirm: active, the basis stamped as reconciled.
    const listed = await listAccounts(tdb);
    assert(listed.length === 1, `expected one account, got ${listed.length}`);
    const a = listed[0];
    assert(a.name === 'Primary' && a.status === 'active', `account is ${a.name}/${a.status}`);
    assert(a.allocatedCapitalMinor === '24875034', 'the basis is not the venue free balance');
    assert(a.confirmedAgainstMinor === '24875034', 'the confirmed-against figure is wrong in the list');
    assert(a.allocatedCurrency === 'INR', 'the allocated currency is wrong');
    assert(a.fundingCurrencies.join(',') === 'INR,USDT', `funding currencies are ${a.fundingCurrencies.join(',')}`);

    // A REJECTED connect leaves nothing to list. Probing before inserting is what
    // removed the stranded `pending_validation` rows that had no way to be finished
    // or removed — the state a basis-less account used to occupy is now unreachable.
    const failed = await svc.validate({ accountName: 'BadKey', apiKey: 'unknown-key-00000000', apiSecret: 'unknown-secret-0000' });
    assert(failed.ok === false, 'an unknown key was accepted');
    const afterFail = await listAccounts(tdb);
    assert(afterFail.length === 1, `a rejected connect left ${afterFail.length - 1} account row(s) behind`);
    assert(afterFail.every((x) => x.allocatedCapitalMinor !== null),
      'every listed account must carry a venue basis — a basis-less account is no longer reachable');

    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    console.log('     2 disclosures + never-ask, single key-entry point, accounts list off the venue read');
  } finally {
    await venue.stop();
    await pool.end();
    await setupPool.end();
  }
}
