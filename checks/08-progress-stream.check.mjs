// 08-progress-stream — plan/phase-08 T08.6: SSE progress is a live projection.
//
// The live-progress route (GET /group-trades/:id/stream) streams each child's
// state change as it happens and closes with a durable report. This check opens
// a REAL SSE connection over HTTP, confirms a group trade against the FakeVenue,
// and asserts the frames the browser would render:
//
//   - the stream seeds every account's current state, then a `header`
//   - each child settles to 'open' → exactly one live `state` event per account
//   - once every account has settled the stream sends a `report` then `done` and
//     closes the connection
//
// T08.6's other half is the acceptance "closing the page does not affect
// execution". We hold the fan-out mid-send (a gated submit port leaves the first
// child 'sending'), drop the SSE watcher, release the send, and assert every
// child STILL reaches 'open' at the venue. The worker persists state first and
// only then publishes — the bus is liveness, never the source of truth.
//
// Skips cleanly without DATABASE_URL, like every DB-backed check.

import { USER, bookProvider, ingestMarkets, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { TextDecoder } from 'node:util';
import { createHttpServer } from '../apps/api/dist/index.js';
import { hashPassword } from '../packages/auth/dist/index.js';
import { LocalKms } from '../packages/crypto/dist/index.js';
import {
  FakeVenue, fetchOrderByClientId, probeCredential, submitOrder,
} from '../packages/exchange-coindcx/dist/index.js';

const COOKIE_SECRET = Buffer.alloc(32, 0x5a);
const PASSWORD = 'progress-stream-passphrase-123';
const KEY = 'progress-stream-key-abcdef0123456789';
const SECRET = 'progress-stream-secret-abcdef0123456789';
const PEPPER = Buffer.from('c8'.repeat(16), 'hex');

/** The session cookie value from a Set-Cookie header, or null. */
function cookieFrom(res) {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) return null;
  const m = /tradex_session=([^;]*)/.exec(setCookie);
  return m === null ? null : m[1];
}

/**
 * Consume an SSE response body. Resolves `headerSeen` the moment the `header`
 * frame arrives (the subscription + seed are done by then) and resolves `done`
 * once the `event: done` frame arrives. `close` aborts the read — the simulated
 * "closing the page".
 */
function sseWatcher(res) {
  const frames = [];
  let headerResolve;
  let doneResolve;
  let closedResolve;
  const headerSeen = new Promise((r) => { headerResolve = r; });
  const done = new Promise((r) => { doneResolve = r; });
  const closed = new Promise((r) => { closedResolve = r; });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      readLoop:
      for (;;) {
        const { value, done: eof } = await reader.read();
        if (eof) break;
        buf += dec.decode(value, { stream: true });
        for (;;) {
          const idx = buf.indexOf('\n\n');
          if (idx < 0) break;
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (\S+)$/m.exec(block);
          const dt = /^data: (.+)$/m.exec(block);
          if (ev !== null && dt !== null) {
            const frame = { event: ev[1], data: JSON.parse(dt[1]) };
            frames.push(frame);
            if (frame.event === 'header') headerResolve();
            if (frame.event === 'done') {
              doneResolve();
              break readLoop;
            }
          }
        }
      }
    } catch {
      // a cancelled read is the caller closing the page — expected
    } finally {
      closedResolve();
    }
  })();
  return {
    frames, headerSeen, done, closed,
    close: () => { try { void reader.cancel(); } catch { /* already closed */ } },
  };
}

/** Boot the real http server with the FakeVenue-backed execution ports WIRED. */
async function boot(ctx, { probe, submit, resolve }) {
  const { getOrderBook } = bookProvider();
  const server = createHttpServer({
    db: ctx.db,
    getOrderBook,
    cookieSecret: COOKIE_SECRET,
    verifySecondFactor: async () => false,
    kms: new LocalKms(),
    pepper: Buffer.from('e6'.repeat(32), 'hex'),
    probe,
    codeVersion: '08-progress-stream',
    secureCookies: false,
    submit, resolve, executionPepper: PEPPER,
  });
  await new Promise((resolve2) => server.listen(0, '127.0.0.1', resolve2));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve2) => server.close(resolve2)),
  };
}

export async function run(assert) {
  const ctx = await setup('progressstream');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  let srv = null;
  let venue = null;
  try {
    await ingestMarkets(ctx.db);
    // Two independent groups, so the second trade's fan-out is not blocked by the
    // first trade's still-open orders (one live order per account+market).
    const g1 = await seedGroupOfAccounts(ctx, ['5000000', '10000000', '20000000']);
    const g2 = await seedGroupOfAccounts(ctx, ['5000000', '10000000', '20000000'], 'G2');
    await ctx.pool.query('UPDATE app_user SET password_hash = $1 WHERE id = $2', [await hashPassword(PASSWORD), USER]);

    venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
    const venueBase = (await venue.start()).toString();
    const doSubmit = async (coid, order) => {
      const out = await submitOrder(KEY, SECRET, {
        client_order_id: coid, side: order.side,
        market_order: { market: order.market, side: order.side, order_type: order.orderType, total_quantity: order.quantity, price: 0 },
      }, { baseUrl: venueBase });
      if (out.kind === 'accepted') return { kind: 'accepted', exchangeOrderId: out.order.id, statusRaw: out.order.statusRaw };
      return { kind: 'rejected', orderMayExist: out.failure.orderMayExist, code: out.failure.code, detail: out.failure.detail };
    };
    // A one-shot gate: when armed, the FIRST submit call blocks until released —
    // leaving that child 'sending' mid-fan-out while the rest of the send waits.
    let armed = false;
    let release;
    const gate = new Promise((r) => { release = r; });
    const submit = async (coid, order) => {
      if (armed) { armed = false; await gate; }
      return doSubmit(coid, order);
    };
    const resolve = async (coid) => {
      const r = await fetchOrderByClientId(KEY, SECRET, coid, { baseUrl: venueBase });
      if (!r.ok) return { ok: false };
      return { ok: true, order: r.order === null ? null : { id: r.order.id, statusRaw: r.order.statusRaw } };
    };
    const probe = (apiKey, apiSecret) => probeCredential(apiKey, apiSecret, { baseUrl: venueBase, deadlineMs: 5_000 });

    srv = await boot(ctx, { probe, submit, resolve });
    const { base } = srv;
    const authHdr = (c) => ({ cookie: `tradex_session=${c}` });

    const login = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'plan@t.example', password: PASSWORD }),
    });
    assert(login.status === 200, `the owner should log in, got ${login.status}`);
    const cookie = cookieFrom(login);
    assert(cookie !== null, 'login must set a session cookie');

    const preview = async (groupId) => {
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
    const statesOf = async (tradeId) => {
      const { rows } = await ctx.pool.query(
        'SELECT account_id AS a, state AS s FROM child_order WHERE group_trade_id = $1',
        [tradeId]);
      return rows.map((r) => ({ accountId: r.a, state: r.s }));
    };

    // =========================================================================
    // Trade P — a watcher present for the WHOLE fan-out sees every settle.
    // =========================================================================
    const p = await preview(g1.groupId);
    assert(p.plannedCount === 3, `trade P should plan all 3, got ${p.plannedCount}`);

    const watch = await fetch(`${base}/api/group-trades/${p.groupTradeId}/stream`, { headers: authHdr(cookie) });
    assert(watch.status === 200, `the stream should open 200, got ${watch.status}`);
    const watcher = sseWatcher(watch);

    // Wait until the stream has subscribed and seeded (the `header` frame is
    // written only after that), THEN confirm — so no settle can race the
    // subscription.
    await watcher.headerSeen;
    const header = watcher.frames.find((f) => f.event === 'header');
    assert(header !== undefined && header.data.groupTradeId === p.groupTradeId && header.data.status === 'previewed',
      `the stream should open with the previewed trade in its header, got ${JSON.stringify(header)}`);
    const seedStates = watcher.frames.filter((f) => f.event === 'state' && f.data.at === 0);
    assert(seedStates.length === 3 && seedStates.every((f) => f.data.state === 'planned'),
      `the stream should seed all 3 planned legs, got ${seedStates.length}`);

    const confirmP = confirmReq(p.groupTradeId, p.previewToken);
    await watcher.done;
    assert(watcher.closed, 'the stream must close itself after the final report');

    const bodyP = await (await confirmP).json();
    assert(bodyP.dryRun === false && bodyP.report.placed === 3, 'trade P should really place all 3 legs');

    const live = watcher.frames.filter((f) => f.event === 'state' && f.data.at > 0);
    assert(live.length === 3, `each settle must stream one live state event, got ${live.length}`);
    const byAcct = new Map(live.map((f) => [f.data.accountId, f.data.state]));
    assert(byAcct.size === 3 && [...byAcct.values()].every((s) => s === 'open'),
      `every account should be reported 'open' live, got ${JSON.stringify([...byAcct])}`);
    const report = watcher.frames.find((f) => f.event === 'report');
    assert(report !== undefined && report.data.dryRun === false && report.data.status === 'executing',
      'the stream should finish with the real report, not a dry run');
    assert(watcher.frames.some((f) => f.event === 'done'), 'the stream must send a done frame');
    assert(live.every((f) => typeof f.data.exchangeOrderId === 'string'),
      'a live state event should carry the venue order id');

    // =========================================================================
    // Trade Q — closing the page mid-fan-out must NOT stop the execution.
    // =========================================================================
    const q = await preview(g2.groupId);
    assert(q.plannedCount === 3, `trade Q should plan all 3, got ${q.plannedCount}`);

    const watchQ = await fetch(`${base}/api/group-trades/${q.groupTradeId}/stream`, { headers: authHdr(cookie) });
    const watcherQ = sseWatcher(watchQ);
    await watcherQ.headerSeen;

    // Hold the FIRST child mid-send, then drop the watcher.
    armed = true;
    const confirmQ = confirmReq(q.groupTradeId, q.previewToken);

    // Wait until the gated submit has been entered (that child reads 'sending').
    let sawSending = false;
    const startWait = Date.now();
    while (Date.now() - startWait < 5_000) {
      const st = await statesOf(q.groupTradeId);
      if (st.some((r) => r.state === 'sending')) { sawSending = true; break; }
      await new Promise((r) => setTimeout(r, 25));
    }
    assert(sawSending, 'the gated submit should leave one child sending mid-fan-out');

    // The page closes while the first order is still mid-flight.
    watcherQ.close();
    await watcherQ.closed;

    // Release the send; the worker does not know a watcher ever existed.
    release();
    const bodyQ = await (await confirmQ).json();
    assert(bodyQ.dryRun === false && bodyQ.report.placed === 3,
      `the fan-out must still place all 3 legs after the watcher left, got ${JSON.stringify(bodyQ.report)}`);
    const qStates = await statesOf(q.groupTradeId);
    assert(qStates.length === 3 && qStates.every((r) => r.state === 'open'),
      'every child must still reach the venue even with no one watching');
    assert(venue.ordersSnapshot().length === 6, 'the venue should hold 3 (P) + 3 (Q) orders');

    console.log('     progress stream: one live state event per child, report+done close; dropping the watcher mid-fan-out does not stop execution');
  } finally {
    if (srv !== null) await srv.stop();
    if (venue !== null) await venue.stop();
    await teardown(ctx);
  }
}
