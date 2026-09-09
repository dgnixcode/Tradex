// 08-partial-failure — plan/phase-08 T08.8 (integration): a fan-out where SOME
// legs are rejected still completes successfully, and the report groups the
// identical rejections into ONE cause with a count — not an error state, and not
// one row per failure.
//
// Mechanism for a deterministic partial failure: one account's deterministic
// client_order_id is PRE-PLACED at the venue before confirm, so the engine's send
// for that leg is a duplicate-coid business rejection (never retried) while the
// other two legs place normally.

import { USER, bookProvider, ingestMarkets, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { createHttpServer } from '../apps/api/dist/index.js';
import { hashPassword } from '../packages/auth/dist/index.js';
import { LocalKms } from '../packages/crypto/dist/index.js';
import { clientOrderIdOf } from '../packages/crypto/dist/index.js';
import {
  FakeVenue, fetchOrderByClientId, probeCredential, submitOrder,
} from '../packages/exchange-coindcx/dist/index.js';

const COOKIE_SECRET = Buffer.alloc(32, 0x5a);
const PASSWORD = 'partial-failure-pass-12345678';
const KEY = 'partial-key-abcdef0123456789';
const SECRET = 'partial-secret-abcdef0123456789';
const PEPPER = Buffer.from('c9'.repeat(16), 'hex');

function cookieFrom(res) {
  const m = /tradex_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
  return m === null ? null : m[1];
}

export async function run(assert) {
  const ctx = await setup('partial');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  let srv = null;
  let venue = null;
  try {
    await ingestMarkets(ctx.db);
    const { groupId } = await seedGroupOfAccounts(ctx, ['5000000', '10000000', '20000000']);
    await ctx.pool.query('UPDATE app_user SET password_hash = $1 WHERE id = $2', [await hashPassword(PASSWORD), USER]);

    venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
    const venueBase = (await venue.start()).toString();
    const submit = async (coid, order) => {
      const out = await submitOrder(KEY, SECRET, {
        client_order_id: coid, side: order.side,
        market_order: { market: order.market, side: order.side, order_type: order.orderType, total_quantity: order.quantity, price: 0 },
      }, { baseUrl: venueBase });
      if (out.kind === 'accepted') return { kind: 'accepted', exchangeOrderId: out.order.id, statusRaw: out.order.statusRaw };
      return { kind: 'rejected', orderMayExist: out.failure.orderMayExist, code: out.failure.code, detail: out.failure.detail };
    };
    const resolve = async (coid) => {
      const r = await fetchOrderByClientId(KEY, SECRET, coid, { baseUrl: venueBase });
      if (!r.ok) return { ok: false };
      return { ok: true, order: r.order === null ? null : { id: r.order.id, statusRaw: r.order.statusRaw } };
    };
    const probe = (apiKey, apiSecret) => probeCredential(apiKey, apiSecret, { baseUrl: venueBase, deadlineMs: 5_000 });

    const { getOrderBook } = bookProvider();
    const server = createHttpServer({
      db: ctx.db, getOrderBook, cookieSecret: COOKIE_SECRET, verifySecondFactor: async () => false,
      kms: new LocalKms(), pepper: Buffer.from('e6'.repeat(32), 'hex'), probe,
      codeVersion: '08-partial', secureCookies: false,
      submit, resolve, executionPepper: PEPPER,
    });
    await new Promise((res) => server.listen(0, '127.0.0.1', res));
    const base = `http://127.0.0.1:${server.address().port}`;
    srv = { stop: () => new Promise((r) => server.close(r)) };
    const auth = (c) => ({ cookie: `tradex_session=${c}` });

    const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'plan@t.example', password: PASSWORD }) });
    assert(login.status === 200, 'owner should log in');
    const cookie = cookieFrom(login);
    assert(cookie !== null, 'login must set a cookie');

    const preview = await fetch(`${base}/api/group-trades/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ groupId, asset: 'BTC', side: 'buy', orderType: 'market', sizingMode: 'pct_allocated', percentBp: 2000 }),
    });
    assert(preview.status === 200, 'preview should succeed');
    const p = await preview.json();
    assert(p.plannedCount === p.rows.length && p.rows.length >= 3, `expect 3 planned legs, got ${p.plannedCount}/${p.rows.length}`);

    // Pre-place the deterministic coid of ONE account so the engine's send for it
    // is a duplicate-coid business rejection — the deterministic partial failure.
    const failAccountId = p.rows[0].accountId;
    const failCoid = clientOrderIdOf(PEPPER, p.groupTradeId, failAccountId, 0);
    await submitOrder(KEY, SECRET, { client_order_id: failCoid, side: 'buy', market_order: { market: 'BTCINR', side: 'buy' } }, { baseUrl: venueBase });

    const confirm = await fetch(`${base}/api/group-trades/${p.groupTradeId}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ previewToken: p.previewToken }),
    });
    assert(confirm.status === 200, `a partial-failure confirm must still be a SUCCESS (200), got ${confirm.status}`);
    const body = await confirm.json();
    assert(body.dryRun === false, 'a real confirm must not be dry-run');
    assert(body.report.placed === 2, `two legs must place, got ${body.report.placed}`);
    assert(body.report.rejected === 1, `one leg must be rejected, got ${body.report.rejected}`);
    assert(body.report.allPlaced === false, 'a partial failure is not all-placed');
    assert(body.report.needsReview === 0, 'a duplicate-coid rejection is not needs-human');

    // The one rejection is GROUPED as one cause with a count, not scattered.
    assert(body.report.groupedCauses.length === 1, `identical rejections must collapse to one grouped cause, got ${body.report.groupedCauses.length}`);
    assert(body.report.groupedCauses[0].count === 1 && body.report.groupedCauses[0].accounts.length === 1,
      'the grouped cause must count the single rejected account');
    assert(/duplicate/i.test(body.report.groupedCauses[0].code), `the cause should be the duplicate-coid rejection, got ${body.report.groupedCauses[0].code}`);

    // The venue holds exactly 3 orders: 2 freshly placed + the 1 pre-placed.
    assert(venue.ordersSnapshot().length === 3, `the venue must hold 3 orders total, got ${venue.ordersSnapshot().length}`);

    // The DB reflects it: 2 open, 1 rejected with the refusal reason.
    const rows = await ctx.pool.query(
      'SELECT state, refusal_code FROM child_order WHERE group_trade_id = $1 ORDER BY account_id', [p.groupTradeId],
    );
    const open = rows.rows.filter((r) => r.state === 'open').length;
    const rejected = rows.rows.filter((r) => r.state === 'rejected' && r.refusal_code === 'duplicate_client_order_id').length;
    assert(open === 2 && rejected === 1, `DB must show 2 open + 1 duplicate-rejected, got open=${open} rejected=${rejected}`);
  } finally {
    if (srv !== null) await srv.stop();
    if (venue !== null) await venue.stop();
    await teardown(ctx);
  }
}
