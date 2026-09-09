// 08-confirm-sends — plan/phase-08: confirm over real HTTP REALLY sends.
//
// The Phase-08 seam, end to end. Boot the actual node:http server with the
// FakeVenue-backed execution ports WIRED (submit/resolve/executionPepper), log in
// as the owner, preview a group trade, and CONFIRM it. This is the milestone: the
// confirm response reports a REAL fan-out — the venue holds exactly one order per
// planned child, every child reaches a KNOWN state ('open') with a venue order id,
// and the run is marked dryRun:false.
//
// The pre-milestone behaviour is preserved exactly when the engine ports are
// ABSENT (the rung-0 dry-run confirm, proven by 04-http-auth), and under
// NODE_ENV=production a missing engine REFUSES the confirm with 503 — an operator
// must never mistake a dry run for a send.
//
//   - confirm → 200, dryRun:false, report.placed == planned legs, allPlaced
//   - the venue truly holds one order per child; every child 'open' with a coid
//   - a second confirm is 409 (already_started) and places nothing more
//   - GET /group-trades/:id/report re-reads the same result
//   - a wrong token is 403 and sends nothing
//   - production + no engine ⇒ 503, and the trade stays 'previewed'
//
// Skips cleanly without DATABASE_URL, like every DB-backed check.

import {
  USER, bookProvider, ingestMarkets, seedGroupOfAccounts, setup, teardown,
} from './_plan-harness.mjs';
import { createHttpServer } from '../apps/api/dist/index.js';
import { hashPassword } from '../packages/auth/dist/index.js';
import { LocalKms } from '../packages/crypto/dist/index.js';
import {
  FakeVenue, fetchOrderByClientId, probeCredential, submitOrder,
} from '../packages/exchange-coindcx/dist/index.js';

const COOKIE_SECRET = Buffer.alloc(32, 0x5a);
const PASSWORD = 'confirm-real-send-passphrase-123';
// A FakeVenue credential the engine submit/resolve ports post with.
const KEY = 'confirm-sends-key-abcdef0123456789';
const SECRET = 'confirm-sends-secret-abcdef0123456789';
// Execution pepper for the deterministic client_order_ids.
const PEPPER = Buffer.from('c8'.repeat(16), 'hex');

/** The session cookie value from a Set-Cookie header, or null. */
function cookieFrom(res) {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) return null;
  const m = /tradex_session=([^;]*)/.exec(setCookie);
  return m === null ? null : m[1];
}

/**
 * Boot a server over the throwaway schema. When `engine` is non-null the
 * execution ports are wired and confirm REALLY sends; when null the server is
 * the rung-0 dry-run build (used to prove the production no-engine refusal).
 * `kms` is injected so the production-guard server can model a real deployment,
 * where LocalKms is absent and a real KMS adapter stands in (LocalKms refuses
 * to construct under NODE_ENV=production, exactly as it should).
 */
async function boot(ctx, { probe, engine, kms }) {
  const { getOrderBook } = bookProvider();
  const server = createHttpServer({
    db: ctx.db,
    getOrderBook,
    cookieSecret: COOKIE_SECRET,
    verifySecondFactor: async () => false,
    kms: kms ?? new LocalKms(),
    pepper: Buffer.from('e6'.repeat(32), 'hex'),
    probe,
    codeVersion: '08-confirm-sends',
    secureCookies: false, // plain HTTP in the check, so the cookie is not dropped
    ...(engine !== null
      ? { submit: engine.submit, resolve: engine.resolve, executionPepper: engine.executionPepper }
      : {}),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function run(assert) {
  const ctx = await setup('confirmsends');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  let engineSrv = null;
  let guardSrv = null;
  let venue = null;
  try {
    await ingestMarkets(ctx.db);
    const { groupId } = await seedGroupOfAccounts(ctx, ['5000000', '10000000', '20000000']);
    await ctx.pool.query('UPDATE app_user SET password_hash = $1 WHERE id = $2', [await hashPassword(PASSWORD), USER]);

    // The engine venue + ports: submit/resolve post to a FakeVenue the check
    // controls — the same shape server.mjs will use against the real venue.
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

    engineSrv = await boot(ctx, { probe, engine: { submit, resolve, executionPepper: PEPPER } });
    const { base } = engineSrv;
    const authHdr = (c) => ({ cookie: `tradex_session=${c}` });

    // ------------------------------------------------ owner logs in
    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'plan@t.example', password: PASSWORD }),
    });
    assert(login.status === 200, `the owner should log in, got ${login.status}`);
    const cookie = cookieFrom(login);
    assert(cookie !== null, 'login must set a session cookie');

    const preview = async () => {
      const r = await fetch(`${base}/api/group-trades/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authHdr(cookie) },
        body: JSON.stringify({ groupId, asset: 'BTC', side: 'buy', orderType: 'market', sizingMode: 'pct_allocated', percentBp: 2000 }),
      });
      assert(r.status === 200, `a preview should be 200, got ${r.status}`);
      return r.json();
    };
    const confirmReq = (id, token) => fetch(`${base}/api/group-trades/${id}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHdr(cookie) },
      body: JSON.stringify({ previewToken: token }),
    });

    // ------------------------------------------------ preview: every member plans
    const p = await preview();
    const planned = p.plannedCount;
    assert(planned >= 2 && planned === p.rows.length,
      `all ${p.rows.length} members should produce a planned leg, got ${planned} planned`);

    // ------------------------------------------------ the milestone: confirm REALLY sends
    const confirm = await confirmReq(p.groupTradeId, p.previewToken);
    assert(confirm.status === 200, `a real confirm should be 200, got ${confirm.status}`);
    const body = await confirm.json();
    assert(body.dryRun === false, 'a real confirm must NOT be marked a dry run');
    assert(body.status === 'executing', `the trade should read 'executing' after the send, got ${body.status}`);
    assert(body.enqueued === planned, `enqueue should cover every planned child, got ${body.enqueued}`);
    assert(body.report.placed === planned,
      `the report should count every planned leg as placed, got ${JSON.stringify(body.report)}`);
    assert(body.report.allPlaced === true, 'every leg placed ⇒ allPlaced');
    assert(body.report.rejected === 0 && body.report.needsReview === 0,
      'a clean FakeVenue fan-out should reject nothing');

    // ------------------------------------------------ the venue holds one order per child
    const { rows: children } = await ctx.pool.query(
      'SELECT account_id AS a, client_order_id AS c, exchange_order_id AS e, state AS s FROM child_order WHERE group_trade_id = $1 ORDER BY leg_seq',
      [p.groupTradeId],
    );
    assert(children.length === planned, 'the DB holds one child row per planned leg');
    const coids = new Set();
    for (const ch of children) {
      assert(ch.s === 'open', `a sent child should be 'open' at the venue, got ${ch.s}`);
      assert(typeof ch.c === 'string' && ch.c !== '', 'every sent child must carry its reserved client_order_id');
      assert(typeof ch.e === 'string' && ch.e !== '', 'every sent child must carry the venue order id');
      coids.add(ch.c);
    }
    assert(coids.size === children.length, 'client_order_ids must be unique across the fan-out');
    const orders = venue.ordersSnapshot();
    assert(orders.length === planned, `the venue must hold exactly the ${planned} fan-out orders, got ${orders.length}`);
    for (const ch of children) {
      const matches = orders.filter((o) => o.client_order_id === ch.c);
      assert(matches.length === 1, 'each child order must exist exactly once at the venue');
    }

    // ------------------------------------------------ a second confirm cannot double-start
    const again = await confirmReq(p.groupTradeId, p.previewToken);
    assert(again.status === 409, `a second confirm must be 409 (already executing), got ${again.status}`);
    assert(venue.ordersSnapshot().length === planned, 'the second confirm must not place a second order');

    // ------------------------------------------------ the report route re-reads the result
    const report = await fetch(`${base}/api/group-trades/${p.groupTradeId}/report`, { headers: authHdr(cookie) });
    assert(report.status === 200, `the report route should read an executed trade, got ${report.status}`);
    const rb = await report.json();
    assert(rb.dryRun === false && rb.report.placed === planned && rb.report.allPlaced === true,
      'the report route must agree with the confirm response');

    // ------------------------------------------------ a wrong token is refused, nothing sent
    const q = await preview();
    const wrong = await confirmReq(q.groupTradeId, 'bogus-token-value');
    assert(wrong.status === 403, `a wrong preview token must be 403, got ${wrong.status}`);
    assert(venue.ordersSnapshot().length === planned, 'a refused confirm must send nothing');

    // ------------------------------------------------ production + no engine ⇒ 503
    // A server whose operator forgot to wire the engine must REFUSE to let a
    // confirm pretend to be a dry run in production — never silently not send.
    process.env['NODE_ENV'] = 'production';
    try {
      // A production deployment has a REAL KMS adapter, never LocalKms — model
      // that with a stub here (the onboarding/TOTP routes never run in this check).
      const realKmsLike = {
        generateDek: async () => { throw new Error('kms not used in the guard phase'); },
        unwrapDek: async () => { throw new Error('kms not used in the guard phase'); },
      };
      guardSrv = await boot(ctx, { probe: async () => null, engine: null, kms: realKmsLike });
      const gpreview = await fetch(`${guardSrv.base}/api/group-trades/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authHdr(cookie) },
        body: JSON.stringify({ groupId, asset: 'BTC', side: 'buy', orderType: 'market', sizingMode: 'pct_allocated', percentBp: 2000 }),
      });
      assert(gpreview.status === 200, `a preview on the guard server should be 200, got ${gpreview.status}`);
      const gp = await gpreview.json();
      const gconf = await fetch(`${guardSrv.base}/api/group-trades/${gp.groupTradeId}/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authHdr(cookie) },
        body: JSON.stringify({ previewToken: gp.previewToken }),
      });
      assert(gconf.status === 503,
        `a production server without an engine must refuse to dry-run a confirm, got ${gconf.status}`);
      const { rows: [row] } = await ctx.pool.query(
        'SELECT status AS s, dry_run AS d, send_suppressed AS sp FROM group_trade WHERE id = $1', [gp.groupTradeId]);
      assert(row.s === 'previewed', 'the refused trade must stay previewed');
      assert(row.d === true && row.sp === false,
        'nothing may be marked completed or send-suppressed by a refused confirm');
    } finally {
      process.env['NODE_ENV'] = '';
    }

    console.log(`     confirm REALLY sends: ${planned} orders at the venue == planned legs; children open; second confirm 409; production-no-engine 503`);
  } finally {
    if (engineSrv !== null) await engineSrv.stop();
    if (guardSrv !== null) await guardSrv.stop();
    if (venue !== null) await venue.stop();
    await teardown(ctx);
  }
}
