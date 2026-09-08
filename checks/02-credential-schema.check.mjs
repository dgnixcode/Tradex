// 02-credential-schema — plan/phase-02 T02.1, the half that needs a real database.
//
// Every assertion here is of the form "the database REFUSES this". A CHECK that
// is never tested is a comment: it looks like a guarantee in review and turns out
// to be a typo the first time it matters.
//
// The most valuable ones are the composite tenant foreign keys. DATA-MODEL lists
// tenant scoping as enforced by "`tenant_id NOT NULL` + the query layer", and
// calls the cross-tenant leak the unrecoverable failure. A plain `tenant_id`
// column does not stop a credential claiming tenant A while pointing at tenant
// B's account — nothing in the schema would object, and the row would read as
// valid forever. Section 3 proves that row is now unrepresentable.
//
// Skips cleanly without DATABASE_URL.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { TENANT_SCOPED_TABLES } from '../packages/db/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const A1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const A2 = 'aaaaaaaa-0000-0000-0000-000000000002';
/** Tenant 2's account. Used to try to build a cross-tenant credential. */
const A3 = 'aaaaaaaa-0000-0000-0000-000000000003';

const bytes = (n, fill) => Buffer.alloc(n, fill);

/** Run a statement expecting REJECTION, and report which constraint bit. */
async function expectReject(client, assert, sql, params, matcher, what) {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql, params);
    await client.query('ROLLBACK TO SAVEPOINT probe');
    assert(false, `${what}: ACCEPTED but should have been rejected`);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    const msg = String(err.message ?? err);
    assert(matcher.test(msg), `${what}: rejected, but not for the expected reason — ${msg}`);
  }
}

/** Run a statement expecting it to SUCCEED. */
async function expectAccept(client, assert, sql, params, what) {
  await client.query('SAVEPOINT ok');
  try {
    await client.query(sql, params);
    await client.query('RELEASE SAVEPOINT ok');
    assert(true, what);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT ok');
    assert(false, `${what}: rejected but should have been accepted — ${String(err.message ?? err)}`);
  }
}

const INSERT_CRED = `INSERT INTO exchange_credential
  (id, tenant_id, account_id, kms_key_arn, dek_wrapped,
   api_key_ct, api_key_nonce, api_key_tag, api_secret_ct, api_secret_nonce, api_secret_tag,
   api_key_last4, fingerprint, status, validated_at, revoked_at)
  VALUES ($1,$2,$3,'arn:aws:kms:ap-south-1:0:key/test',$4,
          $5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15)`;

/** A complete, valid credential row. Overrides let one field be made wrong. */
const cred = (over = {}) => {
  const base = {
    id: null,
    tenant: T1,
    account: A1,
    dek: bytes(60, 1),
    keyCt: bytes(32, 2),
    keyNonce: bytes(12, 3),
    keyTag: bytes(16, 4),
    secretCt: bytes(48, 5),
    secretNonce: bytes(12, 6),
    secretTag: bytes(16, 7),
    last4: '9f2c',
    fingerprint: bytes(32, 8),
    status: 'active',
    validatedAt: new Date(),
    revokedAt: null,
    ...over,
  };
  return [
    base.id ?? `cccccccc-0000-0000-0000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
    base.tenant, base.account, base.dek,
    base.keyCt, base.keyNonce, base.keyTag, base.secretCt, base.secretNonce, base.secretTag,
    base.last4, base.fingerprint, base.status, base.validatedAt, base.revokedAt,
  ];
};

export async function run(assert) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS tradex_cred_check CASCADE');
    await client.query('CREATE SCHEMA tradex_cred_check');
    await client.query('SET search_path TO tradex_cred_check, public');

    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(migrationsDir, f), 'utf8')
        .replace(/^\s*BEGIN;\s*$/gim, '').replace(/^\s*COMMIT;\s*$/gim, '');
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    }
    await client.query('BEGIN');

    // --------------------------------------------- 1. the tables and the registry
    const { rows: present } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'tradex_cred_check' AND table_type = 'BASE TABLE'`,
    );
    const names = new Set(present.map((r) => r.table_name));
    for (const t of ['exchange_account', 'exchange_credential', 'account_balance', 'account_market_seen']) {
      assert(names.has(t), `migration 004 did not create ${t}`);
      assert(TENANT_SCOPED_TABLES.includes(t), `${t} carries tenant_id but is not in TENANT_SCOPED_TABLES`);
    }

    // Money columns must be numeric(38,0), never a float.
    const { rows: money } = await client.query(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'tradex_cred_check' AND column_name LIKE '%_minor'`,
    );
    assert(money.length >= 3, `expected several _minor columns, found ${money.length}`);
    for (const c of money) {
      assert(c.data_type === 'numeric' && c.numeric_precision === 38 && c.numeric_scale === 0,
        `${c.table_name}.${c.column_name} is ${c.data_type}(${c.numeric_precision},${c.numeric_scale})`);
    }

    // --------------------------------------------------------- 2. fixtures
    await client.query("INSERT INTO tenant (id, name) VALUES ($1, 'Tenant One'), ($2, 'Tenant Two')", [T1, T2]);
    const insertAccount = `INSERT INTO exchange_account
      (id, tenant_id, name, allocated_capital_minor, allocated_currency) VALUES ($1,$2,$3,$4,$5)`;
    // Passing NULL for id does NOT fall back to the DEFAULT — omit the column.
    const addAccount = `INSERT INTO exchange_account
      (tenant_id, name, allocated_capital_minor, allocated_currency) VALUES ($1,$2,$3,$4)`;
    await client.query(insertAccount, [A1, T1, 'Primary', '10000000', 'INR']);
    await client.query(insertAccount, [A2, T1, 'Secondary', '50000000', 'INR']);
    await client.query(insertAccount, [A3, T2, 'Other tenant', '100000000', 'USDT']);
    assert(true, 'three accounts across two tenants inserted');

    // ------------------------------------- 3. the cross-tenant row is unrepresentable
    // This is the assertion the composite FK exists for. Without it the row
    // below inserts happily: tenant_id says T2, account_id belongs to T1, and
    // every column constraint is satisfied.
    await expectReject(client, assert, INSERT_CRED, cred({ tenant: T2, account: A1 }),
      /exchange_credential_tenant_account_fk|foreign key/i,
      'a credential claiming tenant T2 while pointing at T1\'s account');
    await expectReject(client, assert, INSERT_CRED, cred({ tenant: T1, account: A3 }),
      /exchange_credential_tenant_account_fk|foreign key/i,
      'a credential claiming tenant T1 while pointing at T2\'s account');
    await expectAccept(client, assert, INSERT_CRED, cred({ tenant: T1, account: A1 }),
      'a credential whose tenant matches its account is accepted');

    // The same defence on the other two children.
    await expectReject(client, assert,
      `INSERT INTO account_balance (tenant_id, account_id, currency, free_minor, scale, observed_at)
       VALUES ($1,$2,'INR','100',2,now())`, [T2, A1],
      /account_balance_tenant_account_fk|foreign key/i,
      'a balance row attributed to the wrong tenant');
    await expectReject(client, assert,
      `INSERT INTO account_market_seen (tenant_id, account_id, market, first_fill_at, last_fill_at)
       VALUES ($1,$2,'BTCINR',now(),now())`, [T2, A1],
      /account_market_seen_tenant_account_fk|foreign key/i,
      'a market-seen row attributed to the wrong tenant');

    // -------------------------------------------------- 4. the uniqueness invariants
    // One live credential per account: concurrent adds cannot both win.
    await expectReject(client, assert, INSERT_CRED, cred({ account: A1, fingerprint: bytes(32, 99) }),
      /exchange_credential_account_unique/i, 'a second credential on the same account');
    // One CoinDCX key per tenant, detected by fingerprint without storing the key.
    await expectReject(client, assert, INSERT_CRED, cred({ account: A2, fingerprint: bytes(32, 8) }),
      /exchange_credential_fingerprint_unique/i, 'the same API key added to a second account');
    // The same key IS allowed under a different tenant — the constraint is scoped
    // per tenant on purpose; two customers may not share a key, but we cannot see
    // across tenants to tell, and a global unique would leak that they do.
    await expectAccept(client, assert, INSERT_CRED, cred({ tenant: T2, account: A3, fingerprint: bytes(32, 8) }),
      'the same fingerprint under a different tenant is allowed');
    await expectReject(client, assert, addAccount, [T1, 'Primary', '1', 'INR'],
      /exchange_account_name_unique/i, 'a duplicate account name within one tenant');

    // ------------------------------------------ 5. the credential state machine
    // Active with no DEK would be a credential nothing can decrypt.
    await expectReject(client, assert, INSERT_CRED, cred({ account: A2, fingerprint: bytes(32, 11), dek: null }),
      /exchange_credential_active_has_dek/i, 'an active credential with no wrapped DEK');
    // Revoked while still decryptable: "revoked" would be a label, not a shred.
    await expectReject(client, assert, INSERT_CRED,
      cred({ account: A2, fingerprint: bytes(32, 12), status: 'revoked', dek: bytes(60, 1), revokedAt: new Date() }),
      /exchange_credential_revoked_is_shredded/i, 'a revoked credential that still has its DEK');
    await expectReject(client, assert, INSERT_CRED,
      cred({ account: A2, fingerprint: bytes(32, 13), status: 'revoked', dek: null, revokedAt: null }),
      /exchange_credential_revoked_is_shredded/i, 'a revoked credential with no revoked_at');
    await expectAccept(client, assert, INSERT_CRED,
      cred({ account: A2, fingerprint: bytes(32, 14), status: 'revoked', dek: null, revokedAt: new Date() }),
      'a properly shredded revoked credential is accepted');

    // Crypto-shredding an existing row must be the same guarantee on UPDATE.
    await expectReject(client, assert,
      "UPDATE exchange_credential SET status = 'revoked', revoked_at = now() WHERE account_id = $1", [A1],
      /exchange_credential_revoked_is_shredded/i, 'revoking without nulling dek_wrapped');
    await expectAccept(client, assert,
      `UPDATE exchange_credential SET status = 'revoked', revoked_at = now(), dek_wrapped = NULL
        WHERE account_id = $1`, [A1],
      'revoking and shredding together is accepted');

    // Statuses are constrained, so a typo cannot silently disable a code path.
    await expectReject(client, assert, INSERT_CRED,
      cred({ account: A2, fingerprint: bytes(32, 15), status: 'revoke' }),
      /exchange_credential_status_check|violates check/i, 'a misspelt credential status');
    await expectReject(client, assert,
      "UPDATE exchange_account SET status = 'disconnected' WHERE id = $1", [A2],
      /exchange_account_disconnected_at/i, 'disconnecting an account without a timestamp');
    await expectReject(client, assert,
      'UPDATE exchange_credential SET auth_error_count = -1 WHERE account_id = $1', [A1],
      /auth_error_count/i, 'a negative auth error count');

    // ---------------------------------- 6. the ciphertext columns are shaped right
    // A wrong nonce or tag length means the crypto layer is not doing what it says.
    for (const [field, index, len] of [['api_key_nonce', 5, 12], ['api_key_tag', 6, 16],
      ['api_secret_nonce', 8, 12], ['api_secret_tag', 9, 16]]) {
      const params = cred({ account: A2, fingerprint: bytes(32, 20 + index) });
      params[index] = bytes(len - 1, 1);
      await expectReject(client, assert, INSERT_CRED, params,
        new RegExp(field, 'i'), `a ${len - 1}-byte ${field} (must be ${len})`);
    }
    const shortFp = cred({ account: A2, fingerprint: bytes(16, 30) });
    await expectReject(client, assert, INSERT_CRED, shortFp, /fingerprint/i,
      'a 16-byte fingerprint (HMAC-SHA256 is 32)');
    const badLast4 = cred({ account: A2, fingerprint: bytes(32, 31), last4: 'abcdef' });
    await expectReject(client, assert, INSERT_CRED, badLast4, /api_key_last4/i,
      'api_key_last4 longer than four characters');
    // Reusing one nonce for both ciphertexts under the same key is a break.
    const sameNonce = cred({ account: A2, fingerprint: bytes(32, 32) });
    sameNonce[8] = sameNonce[5];
    await expectReject(client, assert, INSERT_CRED, sameNonce,
      /exchange_credential_nonces_differ/i, 'the same nonce for the key and the secret');

    // ------------------------------------------- 7. the account-side invariants
    await expectReject(client, assert, addAccount, [T1, 'Third', '1', 'BTC'],
      /allocated_currency/i, 'allocated capital in a currency we cannot trade against');
    await expectReject(client, assert, addAccount, [T1, 'Fourth', '-1', 'INR'],
      /allocated_capital_minor/i, 'negative allocated capital');
    await expectReject(client, assert, addAccount, [T1, '   ', '1', 'INR'],
      /name/i, 'a blank account name');
    await expectReject(client, assert,
      `UPDATE exchange_account SET allocated_confirmed_against_minor = '500' WHERE id = $1`, [A2],
      /exchange_account_confirmed_pair/i, 'a confirmation figure with no timestamp');
    await expectAccept(client, assert,
      `UPDATE exchange_account SET allocated_confirmed_against_minor = '500',
         allocated_confirmed_at = now() WHERE id = $1`, [A2],
      'a confirmation figure with its timestamp is accepted');
    // funding_currencies is derived, and it holds quote currencies only — BTC is
    // a holding, and belongs in account_balance.
    await expectReject(client, assert,
      `UPDATE exchange_account SET funding_currencies = ARRAY['INR','BTC'] WHERE id = $1`, [A2],
      /exchange_account_funding_currencies/i, 'BTC listed as a funding currency');
    await expectAccept(client, assert,
      `UPDATE exchange_account SET funding_currencies = ARRAY['INR','USDT'] WHERE id = $1`, [A2],
      'both supported quotes as funding currencies');

    // -------------------------------------------- 8. balances, and holdings vs funding
    await expectAccept(client, assert,
      `INSERT INTO account_balance (tenant_id, account_id, currency, free_minor, locked_minor, scale, observed_at)
       VALUES ($1,$2,'BTC','31204','1',8,now())`, [T1, A1],
      'BTC is a legitimate holding, unlike a funding currency');
    await expectReject(client, assert,
      `INSERT INTO account_balance (tenant_id, account_id, currency, free_minor, scale, observed_at)
       VALUES ($1,$2,'inr','100',2,now())`, [T1, A1],
      /currency/i, 'a lower-case currency code');
    await expectReject(client, assert,
      `INSERT INTO account_balance (tenant_id, account_id, currency, free_minor, scale, observed_at)
       VALUES ($1,$2,'INR','-1',2,now())`, [T1, A1],
      /free_minor/i, 'a negative free balance');
    await expectReject(client, assert,
      `INSERT INTO account_balance (tenant_id, account_id, currency, free_minor, scale, observed_at)
       VALUES ($1,$2,'INR','100',19,now())`, [T1, A1],
      /scale/i, 'a scale beyond 18 digits');
    await expectReject(client, assert,
      `INSERT INTO account_balance (tenant_id, account_id, currency, free_minor, scale, observed_at)
       VALUES ($1,$2,'BTC','1',8,now())`, [T1, A1],
      /account_balance_pkey|duplicate key/i, 'two balance rows for the same account and currency');
    await expectReject(client, assert,
      `INSERT INTO account_market_seen (tenant_id, account_id, market, first_fill_at, last_fill_at)
       VALUES ($1,$2,'BTCINR', now(), now() - interval '1 day')`, [T1, A1],
      /account_market_seen_ordered/i, 'a last fill before the first fill');

    // ----------------------------------------- 9. history cannot be deleted away
    // Retention duty (15) and analytics continuity (14). RESTRICT, not CASCADE:
    // deleting an account with a credential must fail loudly.
    await expectReject(client, assert, 'DELETE FROM exchange_account WHERE id = $1', [A1],
      /foreign key constraint/i, 'deleting an account that still has a credential and balances');
    await expectReject(client, assert, 'DELETE FROM tenant WHERE id = $1', [T1],
      /foreign key constraint/i, 'deleting a tenant that still has accounts');

    const { rows: counts } = await client.query(
      `SELECT (SELECT count(*)::int FROM exchange_account) AS accounts,
              (SELECT count(*)::int FROM exchange_credential) AS credentials`,
    );
    assert(counts[0].accounts === 3, `expected 3 accounts, found ${counts[0].accounts}`);
    assert(counts[0].credentials === 3, `expected 3 credential rows, found ${counts[0].credentials}`);

    await client.query('ROLLBACK');
    await client.query('DROP SCHEMA tradex_cred_check CASCADE');
    console.log('     migration 004 applied to a throwaway schema; every constraint probed');
  } finally {
    client.release();
    await pool.end();
  }
}
