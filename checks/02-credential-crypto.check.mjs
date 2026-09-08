// 02-credential-crypto — plan/phase-02 T02.2 and T02.3, against a real database.
//
// The chain this proves end to end: plaintext key and secret -> KMS-wrapped DEK
// -> AES-256-GCM ciphertext -> a database row -> the signer -> an HMAC that
// matches what the raw secret would have produced.
//
// The two assertions worth the whole file:
//
//   §3 A ROW MOVED TO ANOTHER ACCOUNT DOES NOT OPEN. The AAD binds every
//      ciphertext to tenant|account|credential|keyVersion, so someone with full
//      write access to the database cannot relocate a credential and have it
//      decrypt for a different customer. It fails authentication instead.
//
//   §6 THREE CONCURRENT 401s BLOCK THE CREDENTIAL EXACTLY ONCE. A group trade
//      fans out in parallel, so three legs can each receive a 401 in the same
//      instant. Read-then-write leaves all three seeing count 0 and the
//      credential still active — which is the failure the rule exists to stop.
//
// Skips cleanly without DATABASE_URL.

import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { LocalKms, fingerprintOf, keyLast4, openCredential, sealCredential } from '../packages/crypto/dist/index.js';
import {
  activate, findByFingerprint, forTenant, insertCredential,
  loadCiphertext, recordAuthFailure, recordAuthSuccess, revoke,
} from '../packages/db/dist/index.js';
import { Signer } from '../apps/signer/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const SCHEMA = 'tradex_crypto_check';

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';
const A1 = 'aaaaaaaa-0000-0000-0000-000000000001';
const A2 = 'aaaaaaaa-0000-0000-0000-000000000002';
const A3 = 'aaaaaaaa-0000-0000-0000-000000000003';

const API_KEY = '9f2c7b41e8d05a6318cc94af2b7e0d5691af3c82';
const API_SECRET = 'd41d8cd98f00b204e9800998ecf8427e6a1b3c4d5e6f708192a3b4c5d6e7f801';
const KEY_2 = '5d4f3a2c9b1e08d6754a3f2c1e9b8d7c6a5f4e3d2c1b0a9f8e7d6c5b4a3f2c1';
const SECRET_2 = '0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2c1e0d9c8b7a6f5e4d3c2b1a0f';
const KEY_3 = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f80';
const SECRET_3 = '9f8e7d6c5b4a3f2c1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a';
const PEPPER = Buffer.from('c3'.repeat(32), 'hex');

const signed = (secret, payload) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

/** Assert that an async call rejects with a message matching `matcher`. */
async function expectThrow(assert, fn, matcher, what) {
  try {
    await fn();
  } catch (err) {
    const msg = String(err?.message ?? err);
    assert(matcher.test(msg), `${what}: threw, but not for the expected reason — ${msg}`);
    return;
  }
  assert(false, `${what}: did not throw`);
}

/** Seal a fresh key/secret pair and store it as a pending_validation credential. */
async function sealAndInsert(tdb, kms, id, tenantId, accountId, apiKey, apiSecret, keyVersion = 1) {
  const sealed = await sealCredential(
    kms, { tenantId, accountId, credentialId: id, keyVersion }, apiKey, apiSecret,
  );
  await insertCredential(tdb, {
    id, accountId, kmsKeyArn: sealed.kmsKeyId, keyVersion,
    dekWrapped: sealed.dekWrapped,
    apiKeyCt: sealed.apiKey.ct, apiKeyNonce: sealed.apiKey.nonce, apiKeyTag: sealed.apiKey.tag,
    apiSecretCt: sealed.apiSecret.ct, apiSecretNonce: sealed.apiSecret.nonce, apiSecretTag: sealed.apiSecret.tag,
    apiKeyLast4: sealed.apiKeyLast4,
    fingerprint: fingerprintOf(PEPPER, apiKey),
  });
  return sealed;
}

export async function run(assert) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  // LocalKms needs a stable root key or every ciphertext dies with the process.
  process.env['TRADEX_LOCAL_ROOT_KEY'] ??= 'ab'.repeat(32);

  const pool = new pg.Pool({ connectionString: url, max: 4 });
  const setup = await pool.connect();
  try {
    await setup.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await setup.query(`CREATE SCHEMA ${SCHEMA}`);
    await setup.query(`SET search_path TO ${SCHEMA}, public`);
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith('.sql')).sort()) {
      const sql = readFileSync(join(migrationsDir, f), 'utf8')
        .replace(/^\s*BEGIN;\s*$/gim, '').replace(/^\s*COMMIT;\s*$/gim, '');
      await setup.query(sql);
    }
    await setup.query("INSERT INTO tenant (id, name) VALUES ($1,'T1'), ($2,'T2')", [T1, T2]);
    await setup.query(
      `INSERT INTO exchange_account (id, tenant_id, name, allocated_capital_minor, allocated_currency)
       VALUES ($1,$2,'Primary','10000000','INR'), ($3,$2,'Secondary','5000000','INR'), ($4,$2,'Third','8000000','USDT')`,
      [A1, T1, A2, A3],
    );
  } finally {
    setup.release();
  }

  // Every pooled connection must land in the check schema, not public.
  const searchPathPool = new pg.Pool({
    connectionString: url,
    max: 6,
    options: `-c search_path=${SCHEMA},public`,
  });
  const db = new Kysely({ dialect: new PostgresDialect({ pool: searchPathPool }) });
  const kms = new LocalKms();
  const tdb1 = forTenant(db, T1);
  const tdb2 = forTenant(db, T2);

  try {
    // ------------------------------------------------ 1. seal, store, activate
    const credentialId = '33333333-0000-0000-0000-000000000001';
    const sealed = await sealCredential(
      kms,
      { tenantId: T1, accountId: A1, credentialId, keyVersion: 1 },
      API_KEY,
      API_SECRET,
    );
    assert(sealed.dekWrapped.byteLength > 28, 'the wrapped DEK looks too short to be a real blob');
    assert(sealed.apiKeyLast4 === keyLast4(API_KEY), 'apiKeyLast4 does not match the key suffix');
    assert(sealed.apiKey.nonce.byteLength === 12 && sealed.apiKey.tag.byteLength === 16,
      'GCM nonce or tag is the wrong length');
    assert(Buffer.compare(Buffer.from(sealed.apiKey.nonce), Buffer.from(sealed.apiSecret.nonce)) !== 0,
      'the key and the secret were sealed under the same nonce');

    const storedId = await insertCredential(tdb1, {
      id: credentialId,
      accountId: A1,
      kmsKeyArn: sealed.kmsKeyId,
      keyVersion: sealed.keyVersion,
      dekWrapped: sealed.dekWrapped,
      apiKeyCt: sealed.apiKey.ct,
      apiKeyNonce: sealed.apiKey.nonce,
      apiKeyTag: sealed.apiKey.tag,
      apiSecretCt: sealed.apiSecret.ct,
      apiSecretNonce: sealed.apiSecret.nonce,
      apiSecretTag: sealed.apiSecret.tag,
      apiKeyLast4: sealed.apiKeyLast4,
      fingerprint: fingerprintOf(PEPPER, API_KEY),
    });
    assert(storedId === credentialId, 'the stored id is not the id the AAD was bound to');

    const stored = await loadCiphertext(tdb1, credentialId);
    assert(stored !== null, 'the credential could not be read back');
    assert(stored.status === 'pending_validation',
      `a new credential is ${stored.status}, expected pending_validation — it must be proved by a live call first`);

    // ------------------------------- 2. the row is worthless without the KMS key
    const { rows: raw } = await searchPathPool.query(
      'SELECT * FROM exchange_credential WHERE id = $1', [credentialId],
    );
    const blob = Buffer.concat(Object.values(raw[0])
      .filter((v) => v !== null)
      .map((v) => (Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8'))));
    assert(!blob.includes(Buffer.from(API_KEY, 'utf8')), 'the API KEY appears verbatim in the stored row');
    assert(!blob.includes(Buffer.from(API_SECRET, 'utf8')), 'the API SECRET appears verbatim in the stored row');
    assert(!blob.includes(Buffer.from(API_SECRET.slice(0, 16), 'utf8')),
      'a 16-character prefix of the secret appears in the stored row');
    assert(raw[0].api_key_last4 === '3c82', 'api_key_last4 is not the four displayable characters');
    assert(!API_KEY.startsWith(raw[0].api_key_last4), 'the display value is a PREFIX of the key, which leaks');

    // -------------------------------------- 3. the signer, and what it refuses
    const signer = new Signer({ tdb: tdb1, kms });
    const payload = '{"market":"BTCINR","side":"buy","timestamp":1788442200000}';
    const request = {
      credentialId, payload, algorithm: 'hmac-sha256-hex',
      reason: 'place order for group trade', actorProcess: 'worker',
    };

    // pending_validation must refuse: signing an unproved key produces a venue
    // error that reads like an outage.
    await expectThrow(assert, () => signer.sign(request),
      /pending_validation/, 'signing with an unvalidated credential');

    assert(await activate(tdb1, credentialId), 'the credential could not be activated');
    const result = await signer.sign(request);
    assert(result.signature === signed(API_SECRET, payload),
      'the signature does not match what the raw secret produces — the round trip is broken');
    assert(result.apiKey === API_KEY, 'the signer returned the wrong API key');
    assert(result.keyVersion === 1, 'the signer lost the key version');
    assert(!Object.values(result).some((v) => String(v) === API_SECRET),
      'the SECRET came back out of the signer');
    assert(Object.keys(result).sort().join(',') === 'apiKey,keyVersion,signature',
      `the signer returned unexpected fields: ${Object.keys(result).join(',')}`);

    // Byte-exactness: one changed character must change the signature.
    const other = await signer.sign({ ...request, payload: `${payload.slice(0, -1)} ` });
    assert(other.signature !== result.signature, 'two different payloads produced the same signature');

    await expectThrow(assert, () => signer.sign({ ...request, payload: '' }),
      /empty payload/, 'signing an empty payload');
    await expectThrow(assert, () => signer.sign({ ...request, reason: '  ' }),
      /stated reason/, 'a decrypt with no stated reason');
    await expectThrow(assert, () => signer.sign({ ...request, algorithm: 'md5' }),
      /unsupported algorithm/, 'an unsupported algorithm');

    // ------------------------------- 4. the AAD binds ciphertext to its identity
    // Direct proof: open the same ciphertext under a different account, tenant or
    // key version. It must FAIL AUTHENTICATION, not decrypt for the wrong customer —
    // even for someone with full write access to the database.
    await expectThrow(assert, () => openCredential(kms, {
      tenantId: T1, accountId: A2, credentialId, keyVersion: 1,
    }, { dekWrapped: sealed.dekWrapped, apiKey: sealed.apiKey, apiSecret: sealed.apiSecret }),
      /authentication failed/, 'opening the ciphertext under a different ACCOUNT');
    await expectThrow(assert, () => openCredential(kms, {
      tenantId: T2, accountId: A1, credentialId, keyVersion: 1,
    }, { dekWrapped: sealed.dekWrapped, apiKey: sealed.apiKey, apiSecret: sealed.apiSecret }),
      /authentication failed/, 'opening the ciphertext under a different TENANT');
    await expectThrow(assert, () => openCredential(kms, {
      tenantId: T1, accountId: A1, credentialId, keyVersion: 2,
    }, { dekWrapped: sealed.dekWrapped, apiKey: sealed.apiKey, apiSecret: sealed.apiSecret }),
      /authentication failed/, 'opening the ciphertext under a different KEY VERSION');

    // The realistic attack: rewrite the stored row so it points at another
    // account. The composite tenant FK lets the UPDATE through; the AAD is what
    // stops the decrypt. This is the relocation 07 F3 names explicitly.
    await searchPathPool.query('UPDATE exchange_credential SET account_id = $1 WHERE id = $2', [A2, credentialId]);
    await expectThrow(assert, () => signer.sign(request),
      /authentication failed/, 'signing a credential whose row was moved to another account');
    await searchPathPool.query('UPDATE exchange_credential SET account_id = $1 WHERE id = $2', [A1, credentialId]);
    const afterMove = await signer.sign(request);
    assert(afterMove.signature === signed(API_SECRET, payload),
      'signing did not recover after the row was moved back');

    // ----------------------------- 5. the duplicate-key check, by fingerprint
    const conflict = await findByFingerprint(tdb1, fingerprintOf(PEPPER, API_KEY));
    assert(conflict !== null, 'the duplicate key was not found by fingerprint');
    assert(conflict.accountId === A1 && conflict.accountName === 'Primary',
      `the conflict points at ${conflict.accountName}, expected Primary (account A1)`);
    assert(conflict.status === 'active', `the conflict reports status ${conflict.status}`);
    // Tenant scoping holds here too: the same key is not visible from T2.
    const otherTenant = await findByFingerprint(tdb2, fingerprintOf(PEPPER, API_KEY));
    assert(otherTenant === null, 'a fingerprint lookup crossed the tenant boundary');

    // --------------------------------- 6. three concurrent 401s block exactly once
    const c2Id = '44444444-0000-0000-0000-000000000002';
    await sealAndInsert(tdb1, kms, c2Id, T1, A2, KEY_2, SECRET_2);
    assert(await activate(tdb1, c2Id), 'credential C2 could not be activated');

    // A group trade fans out in parallel, so three legs can each hit a 401 in the
    // same instant. Read-then-write in the application would let all three see
    // count 0; the single-statement increment must land each one. Under READ
    // COMMITTED the three UPDATEs serialise on the row lock, so the counts come
    // back 1, 2, 3 — and the CASE that flips to failed_auth fires on exactly ONE
    // of them, the statement that carries the count to the threshold. The others
    // return still-active; that is correct, not a miss.
    const failures = await Promise.all([1, 2, 3].map(() => recordAuthFailure(tdb1, c2Id)));
    assert(failures.length === 3, 'one of the three concurrent 401s was not recorded');
    assert(failures.map((f) => f.authErrorCount).sort((a, b) => a - b).join(',') === '1,2,3',
      `the concurrent increments did not land atomically — got ${failures.map((f) => f.authErrorCount).join(',')}`);
    const transitioned = failures.filter((f) => f.status === 'failed_auth' && f.blocked);
    assert(transitioned.length === 1,
      `expected exactly one concurrent call to observe the failed_auth transition, saw ${transitioned.length}`);
    assert(transitioned[0].authErrorCount === 3,
      `the transition fired at count ${transitioned[0].authErrorCount}, not the threshold of 3`);
    // Whatever each caller saw, the persisted row must be blocked once all land.
    const c2After = await loadCiphertext(tdb1, c2Id);
    assert(c2After?.status === 'failed_auth',
      `after three 401s the credential is ${c2After?.status}, not failed_auth`);

    const c2Request = { credentialId: c2Id, payload, algorithm: 'hmac-sha256-hex',
      reason: 'order', actorProcess: 'worker' };
    await expectThrow(assert, () => signer.sign(c2Request),
      /failed_auth/, 'signing with a blocked credential');
    assert(await activate(tdb1, c2Id) === false, 'a blocked credential was resurrected by activate');

    // ------------------------ 7. consecutive, not cumulative; and the revoke shred
    const c3Id = '44444444-0000-0000-0000-000000000003';
    await sealAndInsert(tdb1, kms, c3Id, T1, A3, KEY_3, SECRET_3);
    assert(await activate(tdb1, c3Id), 'credential C3 could not be activated');

    await recordAuthFailure(tdb1, c3Id);
    await recordAuthFailure(tdb1, c3Id);
    await recordAuthSuccess(tdb1, c3Id); // a working call clears the streak
    const scatter1 = await recordAuthFailure(tdb1, c3Id);
    const scatter2 = await recordAuthFailure(tdb1, c3Id);
    assert(scatter1.status === 'active' && scatter2.status === 'active'
      && scatter2.authErrorCount === 2,
      `scattered failures were counted cumulatively and blocked early — got ${scatter2.status} at ${scatter2.authErrorCount}`);
    const blocked = await recordAuthFailure(tdb1, c3Id);
    assert(blocked.status === 'failed_auth' && blocked.blocked,
      'a real streak of three did not block the credential');
    await recordAuthSuccess(tdb1, c3Id);
    const afterBlock = await loadCiphertext(tdb1, c3Id);
    assert(afterBlock?.status === 'failed_auth',
      'a successful call unblocked a failed_auth credential — the counter cleared but the block stands');

    // Crypto-shred: revoke nulls the DEK, and the row survives for audit.
    assert(await revoke(tdb1, credentialId), 'revoke did not shred the active credential');
    const shredded = await loadCiphertext(tdb1, credentialId);
    assert(shredded !== null, 'the credential row vanished on revoke — it must survive for audit');
    assert(shredded.dekWrapped === null, 'dek_wrapped was not nulled by revoke');
    assert(shredded.status === 'revoked', `revoked row is ${shredded.status}`);
    await expectThrow(assert, () => signer.sign(request),
      /revoked|crypto-shredded/, 'signing with a shredded credential');
    assert(await revoke(tdb1, credentialId) === false,
      'a second revoke reported success on an already-revoked row');

    // -------------------------------------- 8. every decrypt is on the audit log
    const { rows: auditRows } = await searchPathPool.query(
      `SELECT actor_process, subject_id, after FROM audit_event
        WHERE subject_type = 'exchange_credential' AND subject_id = $1 AND action = 'credential.decrypt'`,
      [credentialId],
    );
    // C1 decrypts that succeeded: the main sign, the changed-payload sign, and the
    // post-relocation sign. Every refusal above threw BEFORE any decrypt, and the
    // relocation attempt threw before its audit row could be written.
    assert(auditRows.length === 3, `expected 3 decrypt audit rows for C1, found ${auditRows.length}`);
    for (const row of auditRows) {
      assert(row.actor_process === 'worker', `decrypt audit row has actor_process ${row.actor_process}`);
      const after = typeof row.after === 'string' ? JSON.parse(row.after) : row.after;
      assert(after.reason === 'place order for group trade', 'the audit row lost the stated reason');
      assert(typeof after.account_id === 'string' && after.account_id === A1,
        'the audit row lost which account was decrypted');
      assert(JSON.stringify(after).includes('payload_sha256'), 'the audit row has no correlation digest');
      assert(!JSON.stringify(after).includes('BTCINR'), 'the signed payload itself was recorded in the audit row');
    }
    const { rows: afterRevoke } = await searchPathPool.query(
      `SELECT count(*)::int AS n FROM audit_event WHERE subject_type = 'exchange_credential'
         AND subject_id = $1 AND action = 'credential.decrypt'`, [credentialId],
    );
    // The shredded credential must not have signed anything after the shred.
    assert(afterRevoke[0].n === auditRows.length,
      'a decrypt audit row appeared after the credential was shredded');

    await searchPathPool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    console.log('     seal -> store -> sign round trip; AAD relocation refused; 3 concurrent 401s block exactly once');
  } finally {
    await searchPathPool.end();
    await pool.end();
  }
}
