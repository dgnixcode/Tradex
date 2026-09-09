// 08-retry-is-fresh — plan/phase-08 T08.7: retry-failed produces a FRESH trade.
//
// The retry button must NEVER re-run the old plan. This check drives the endpoint
// over real HTTP: preview a trade, confirm it against the FakeVenue so it REALLY
// sends, then simulate a venue partial-failure by flipping two legs terminal
// (rejected / not_placed) while a third stays open. Retrying that trade must
// yield a BRAND-NEW group_trade row, re-planned from the CURRENT book and scoped
// ONLY to the two failed accounts — new id, new preview token, and the old trade
// plus its untouched 'open' leg completely unchanged. Confirming the fresh trade
// then really sends just the subset (2 new venue orders, distinct coids).
//
//   - a trade whose legs are all still working/placed ⇒ 409 nothing_to_retry
//   - a mixed trade retries ONLY its terminal-failed accounts; still-working legs
//     (planned / open) are excluded and never double-sent
//   - the fresh trade is a new row: new id, new preview token, re-priced
//   - sizing columns reconstruct from the persisted trade (pct_* → percentBp,
//     quote_amount → sizingValue) — the old plan is never re-run
//   - the old trade and its child rows are byte-for-byte untouched by a retry
//   - confirming the fresh trade really sends exactly the failed subset
//   - a missing trade id is 404
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
const PASSWORD = 'retry-fresh-passphrase-123';
const KEY = 'retry-fresh-key-abcdef0123456789';
const SECRET = 'retry-fresh-secret-abcdef0123456789';
const PEPPER = Buffer.from('c8'.repeat(16), 'hex');

/** The session cookie value from a Set-Cookie header, or null. */
function cookieFrom(res) {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) return null;
  const m = /tradex_session=([^;]*)/.exec(setCookie);
  return m === null ? null : m[1];
}

/** Boot the real http server with the FakeVenue-backed execution ports WIRED. */
async function boot(ctx, { probe, engine }) {
  const { getOrderBook } = bookProvider();
  const server = createHttpServer({
    db: ctx.db,
    getOrderBook,
    cookieSecret: COOKIE_SECRET,
    verifySecondFactor: async () => false,
    kms: new LocalKms(),
    pepper: Buffer.from('e6'.repeat(32), 'hex'),
    probe,
    codeVersion: '08-retry-is-fresh',
    secureCookies: false,
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
  const ctx = await setup('retryfresh');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  let srv = null;
  let venue = null;
  try {
    await ingestMarkets(ctx.db);
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['5000000', '10000000', '20000000']);
    await ctx.pool.query('UPDATE app_user SET password_hash = $1 WHERE id = $2', [await hashPassword(PASSWORD), USER]);
    const [a0, a1, a2] = accountIds;

    // Engine venue + ports, exactly the shape server.mjs will use for real money.
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

    srv = await boot(ctx, { probe, engine: { submit, resolve, executionPepper: PEPPER } });
    const { base } = srv;
    const authHdr = (c) => ({ cookie: `tradex_session=${c}` });

    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'plan@t.example', password: PASSWORD }),
    });
    assert(login.status === 200, `the owner should log in, got ${login.status}`);
    const cookie = cookieFrom(login);
    assert(cookie !== null, 'login must set a session cookie');

    const previewReq = (body) => fetch(`${base}/api/group-trades/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHdr(cookie) },
      body: JSON.stringify(body),
    });
    const preview = async (body) => {
      const r = await previewReq(body);
      assert(r.status === 200, `a preview should be 200, got ${r.status}`);
      return r.json();
    };
    const retryReq = (id) => fetch(`${base}/api/group-trades/${id}/retry-failed`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHdr(cookie) },
      body: JSON.stringify({}),
    });
    const confirmReq = (id, token) => fetch(`${base}/api/group-trades/${id}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...authHdr(cookie) },
      body: JSON.stringify({ previewToken: token }),
    });
    const flipChild = (tradeId, accountId, state) => ctx.pool.query(
      'UPDATE child_order SET state = $1 WHERE group_trade_id = $2 AND account_id = $3',
      [state, tradeId, accountId],
    );
    const tradeRow = async (tradeId) => {
      const { rows } = await ctx.pool.query(
        'SELECT status, dry_run AS d, sizing_mode AS sm, sizing_value AS sv, order_type AS ot, limit_price AS lp, side, asset, created_by AS cb FROM group_trade WHERE id = $1',
        [tradeId]);
      return rows[0];
    };
    const childrenOf = async (tradeId) => {
      const { rows } = await ctx.pool.query(
        'SELECT account_id AS a, state AS s, client_order_id AS c, exchange_order_id AS e FROM child_order WHERE group_trade_id = $1 ORDER BY leg_seq',
        [tradeId]);
      return rows.map((r) => ({ accountId: r.a, state: r.s, clientOrderId: r.c, exchangeOrderId: r.e }));
    };

    // ---- Scenario trades FIRST, before any send leaves an open order. -------
    // Trade A: the real fan-out we will partially fail (pct_allocated 20%).
    const a = await preview({ groupId, asset: 'BTC', side: 'buy', orderType: 'market', sizingMode: 'pct_allocated', percentBp: 2000 });
    assert(a.plannedCount === 3, `trade A should plan all 3 members, got ${a.plannedCount}`);
    // Trade D: quote_amount, used to prove the sizing-value reconstruction branch.
    const d = await preview({ groupId, asset: 'BTC', side: 'buy', orderType: 'market', sizingMode: 'quote_amount', sizingValue: '1000000' });
    assert(d.plannedCount === 3, `trade D should plan all 3 members, got ${d.plannedCount}`);

    // ---- quote_amount reconstruction: flip ONE planned leg to a certain failure. ----
    // 'rejected' is both retryable AND venue-terminal — unlike 'needs_human',
    // which the in-flight gate treats as possibly still live, so a retry of it
    // would re-plan into an in-flight refusal.
    await flipChild(d.groupTradeId, a0, 'rejected');
    const retryD = await retryReq(d.groupTradeId);
    assert(retryD.status === 201, `retrying a trade with one failed leg should be 201, got ${retryD.status}`);
    const e = await retryD.json();
    assert(e.groupTradeId !== d.groupTradeId, 'the retry must be a brand-new group_trade row');
    assert(typeof e.previewToken === 'string' && e.previewToken.length > 0, 'the fresh trade must carry a new preview token');
    const eRow = await tradeRow(e.groupTradeId);
    assert(eRow.sm === 'quote_amount' && eRow.sv === '1000000' && eRow.ot === 'market' && eRow.lp === null,
      `quote_amount + sizingValue must reconstruct, got ${eRow.sm}/${eRow.sv}`);
    assert(e.rows.length === 1 && e.rows[0].accountId === a0,
      `only the failed leg (${a0}) may be retried, got ${JSON.stringify(e.rows.map((r) => r.accountId))}`);
    assert(e.rows[0].state === 'planned', 'the re-priced fresh leg should plan cleanly (nothing in flight yet)');

    // ---- the real fan-out, then simulate a partial venue failure. -----------
    const confirmA = await confirmReq(a.groupTradeId, a.previewToken);
    assert(confirmA.status === 200, `trade A confirm should really send, got ${confirmA.status}`);
    const bodyA = await confirmA.json();
    assert(bodyA.dryRun === false && bodyA.enqueued === 3, `trade A should execute 3 legs, got ${JSON.stringify(bodyA)}`);
    assert(venue.ordersSnapshot().length === 3, 'trade A leaves exactly 3 orders at the venue');
    const aKids = await childrenOf(a.groupTradeId);
    assert(aKids.length === 3 && aKids.every((k) => k.state === 'open'),
      'after the real send every trade-A leg should be open at the venue');

    // A trade whose legs are all still working/placed has nothing to retry.
    const noop = await retryReq(a.groupTradeId);
    assert(noop.status === 409, `all-open trade must refuse to retry (409), got ${noop.status}`);
    assert(venue.ordersSnapshot().length === 3, 'a refused retry must send nothing');

    // Simulate the venue rejecting two legs mid-fan-out: A0 rejected, A1
    // not_placed; A2 stays open (its fill still pending).
    await flipChild(a.groupTradeId, a0, 'rejected');
    await flipChild(a.groupTradeId, a1, 'not_placed');

    // ---- retry-failed: a FRESH trade scoped to the two failed accounts. -----
    const retryA = await retryReq(a.groupTradeId);
    assert(retryA.status === 201, `retrying the partially-failed trade should be 201, got ${retryA.status}`);
    const b = await retryA.json();
    assert(b.groupTradeId !== a.groupTradeId, 'the retry must not reuse the old group_trade id');
    assert(typeof b.previewToken === 'string' && b.previewToken !== a.previewToken,
      'the retry must mint a fresh preview token, not the old one');

    const bRow = await tradeRow(b.groupTradeId);
    assert(bRow.status === 'previewed' && bRow.d === true,
      'the fresh trade must start previewed and dry-run — it has not been confirmed');
    assert(bRow.sm === 'pct_allocated' && bRow.sv === '2000',
      `pct_allocated must reconstruct its basis points, got ${bRow.sm}/${bRow.sv}`);
    assert(bRow.ot === 'market' && bRow.lp === null && bRow.side === 'buy' && bRow.asset === 'BTC' && bRow.cb === USER,
      'the fresh trade must reconstruct the original intent and actor');
    assert(b.rows.length === 2 && b.rows.map((r) => r.accountId).sort().join(',') === [a0, a1].sort().join(','),
      `the retry must scope to ONLY the failed accounts, got ${JSON.stringify(b.rows.map((r) => r.accountId))}`);
    assert(b.rows.every((r) => r.state === 'planned'),
      'the failed accounts must re-plan cleanly against the current book');

    // The old trade is byte-for-byte untouched — including its open leg.
    const aRowAfter = await tradeRow(a.groupTradeId);
    assert(aRowAfter.status === 'executing' && aRowAfter.d === false,
      'the old trade must stay executing and real — a retry never touches it');
    const aKidsAfter = await childrenOf(a.groupTradeId);
    assert(aKidsAfter.length === 3, `the old trade must keep all 3 child rows, got ${aKidsAfter.length}`);
    const kid = (acct) => aKidsAfter.find((k) => k.accountId === acct);
    assert(kid(a0) !== undefined && kid(a0).state === 'rejected', `trade A's ${a0} leg must stay rejected, got ${kid(a0)?.s}`);
    assert(kid(a1) !== undefined && kid(a1).state === 'not_placed', `trade A's ${a1} leg must stay not_placed, got ${kid(a1)?.s}`);
    assert(kid(a2) !== undefined && kid(a2).state === 'open', `trade A's still-working ${a2} leg must stay open, got ${kid(a2)?.s}`);
    const oldCoids = new Set(aKidsAfter.map((k) => k.clientOrderId));
    assert(oldCoids.size === 3 && oldCoids.has(kid(a0).clientOrderId) && oldCoids.has(kid(a2).clientOrderId),
      'the old trade\'s children must keep their reserved venue ids');
    assert(venue.ordersSnapshot().length === 3, 'planning the retry must itself send nothing');

    // ---- confirming the FRESH trade really sends exactly the subset. --------
    const confirmB = await confirmReq(b.groupTradeId, b.previewToken);
    assert(confirmB.status === 200, `confirming the retried trade should really send, got ${confirmB.status}`);
    const bodyB = await confirmB.json();
    assert(bodyB.dryRun === false && bodyB.report.placed === 2,
      `the retried trade should place exactly the 2 failed legs, got ${JSON.stringify(bodyB.report)}`);
    assert(venue.ordersSnapshot().length === 5, 'the venue must now hold 3 (old) + 2 (retried) orders');
    const bKids = await childrenOf(b.groupTradeId);
    assert(bKids.length === 2 && bKids.every((k) => k.state === 'open'), 'both retried legs should be open at the venue');
    assert(bKids.every((k) => !oldCoids.has(k.clientOrderId)), 'the retried send must reserve brand-new client_order_ids');

    // The endpoint returns 404 for an id that is not this tenant's trade.
    const ghost = await retryReq('00000000-0000-4000-8000-000000000000');
    assert(ghost.status === 404, `an unknown trade must be 404, got ${ghost.status}`);

    // And it must still refuse a fully-planned (never-failed) trade.
    const { rows: [count] } = await ctx.pool.query('SELECT count(*)::int AS n FROM group_trade');
    assert(count.n === 4, `exactly A, B, D, E should exist, got ${count.n} group trades`);

    console.log(`     retry is fresh: subset retried to a NEW trade (${b.groupTradeId.slice(0, 8)}…), old trade untouched, confirm places the 2 failed legs, planned-trades 409`);
  } finally {
    if (srv !== null) await srv.stop();
    if (venue !== null) await venue.stop();
    await teardown(ctx);
  }
}
