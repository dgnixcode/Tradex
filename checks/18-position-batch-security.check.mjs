import { randomUUID } from 'node:crypto';
import { setup, teardown, seedGroupOfAccounts, USER } from './_plan-harness.mjs';
import { createHttpServer } from '../apps/api/dist/index.js';
import { hashPassword } from '../packages/auth/dist/index.js';
import { LocalKms } from '../packages/crypto/dist/index.js';

export async function run(assert) {
  const ctx = await setup('batch18');
  if (!ctx) { assert(true, 'database check skipped without DATABASE_URL'); return; }
  let server;
  try {
    const { accountIds } = await seedGroupOfAccounts(ctx, ['10000000', '10000000']);
    await ctx.db.updateTable('app_user').set({ password_hash: await hashPassword('batch-test-password-123') }).where('id', '=', USER).execute();
    for (let i = 0; i < 2; i++) {
      await ctx.tdb.insertInto('futures_position', { account_id: accountIds[i], venue_position_id: `test-position-${i}`, pair: 'B-BTC_USDT',
        margin_currency: 'USDT', active_pos: '0.01' }).execute();
    }
    let calls = 0, inFlight = 0, peak = 0;
    const bothStarted = Promise.withResolvers();
    server = createHttpServer({ db: ctx.db, getOrderBook: async () => { throw new Error('not used'); },
      cookieSecret: Buffer.alloc(32, 7), verifySecondFactor: async () => false, kms: new LocalKms(),
      pepper: Buffer.alloc(32, 8), probe: async () => { throw new Error('not used'); }, codeVersion: 'batch-security-test', secureCookies: false,
      futuresLeverage: { updateLeverage: async (args) => {
        calls++; inFlight++; peak = Math.max(peak, inFlight);
        if (calls === 2) bothStarted.resolve();
        let timer;
        try { await Promise.race([bothStarted.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Batch dispatch was serial')), 5000); })]); }
        finally { clearTimeout(timer); inFlight--; }
        return args.venuePositionId.endsWith('-1') ? { ok: false, code: 'venue_refused', detail: 'test refusal' } : { ok: true, newLeverage: String(args.leverage) };
      } },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    const login = await post('/api/login', { email: 'plan@t.example', password: 'batch-test-password-123' });
    const cookie = /tradex_session=([^;]*)/.exec(login.headers.get('set-cookie'))?.[1];
    assert(login.status === 200 && cookie, 'login must establish the test session');
    const headers = { cookie: `tradex_session=${cookie}` };
    const actions = [0, 1].map((i) => ({ id: `test-position-${i}`, action: 'leverage', body: { leverage: 5 }, requestId: randomUUID() }));
    const batch = await post('/api/futures/positions/batch', { actions }, headers);
    const body = await batch.json();
    assert(batch.status === 200 && body.results[0].status === 200 && body.results[1].status === 400, 'batch must report separate success and refusal results');
    assert(calls === 2 && peak === 2, 'distinct accounts must dispatch concurrently, without serial waits');
    const replay = await post('/api/futures/positions/batch', { actions }, headers);
    assert(replay.status === 200 && calls === 2, 'retrying the same batch keys must not repeat exchange calls');
    const unowned = await post('/api/futures/positions/batch', { actions: [{ ...actions[0], id: 'another-tenant-position', requestId: randomUUID() }] }, headers);
    assert(unowned.status === 404 && calls === 2, 'unowned positions must be rejected before any exchange call');
    const csrf = await post('/api/logout', {}, { ...headers, origin: 'https://attacker.example' });
    assert(csrf.status === 403, 'cross-site logout and trading requests must be rejected');
    const plain = await post('/api/login', { email: 'plan@t.example', password: 'batch-test-password-123' }, { 'content-type': 'text/plain' });
    assert(plain.status === 415, 'JSON endpoints must reject simple cross-origin content types');
    const traversal = await fetch(`${base}/..%2f..%2f..%2fpackage.json`);
    assert(traversal.status === 404, 'encoded path traversal must be blocked');
    const logout = await post('/api/logout', {}, headers);
    assert(logout.status === 200, 'same-origin logout must work');
    const stolen = await fetch(`${base}/api/session`, { headers });
    assert(stolen.status === 401, 'a copied cookie must stop working after logout');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await teardown(ctx);
  }
}
