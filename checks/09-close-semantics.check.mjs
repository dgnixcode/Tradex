// 09-close-semantics — plan/phase-09 T09.7 + T09.1.
//
// T09.7 (completion-on-fills, moved from Phase 08's open gap): Phase 08 could not
// prove auto-completion because FakeVenue left every order `open` forever. Phase
// 09's fill-capable venue fixes that: settle an order to `filled`, and the
// worker's poll turns the child open → filled, and once NO child is working the
// group trade flips to `completed` in the same commit. A leg left `open` keeps
// the trade `executing`.
//
// T09.1 (cancel): a settled order cannot be cancelled — the FAQ is explicit. The
// per-account precondition is checked LOCALLY before any network call, so
// cancelling a `filled` child must refuse with the cancel port never invoked
// (proved by a spy). And `cancel_all` (the 30/60 s rate-limit trap that would
// cancel orders we did not place) appears in no code — only in prose forbidding it.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { addExecutionJob } from '../packages/db/dist/index.js';
import { ExecutionWorker } from '../apps/api/dist/index.js';
import { fetchOrderByClientId, FakeVenue, submitOrder } from '../packages/exchange-coindcx/dist/index.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'fill-key-abcdef0123456789';
const SECRET = 'fill-secret-abcdef0123456789';
const PEPPER = Buffer.from('ca'.repeat(16), 'hex');

export async function run(assert) {
  // ---- T09.1: cancel_all must appear in no CODE (only in prose forbidding it) ----
  // The route is group-scoped by design and comments document "never cancel_all";
  // a naive grep would flag its own prohibition. So test only the code portion of
  // each line (before the first //) and skip this file itself.
  const walk = (dir, out) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (['node_modules', 'dist', '.git', 'plan', 'research', '.tmpwork'].includes(e.name)) continue;
        walk(full, out);
      } else if (/(\.ts|\.mjs|\.tsx|\.sql)$/.test(e.name)) out.push(full);
    }
    return out;
  };
  const self = fileURLToPath(import.meta.url);
  const hits = [];
  for (const file of walk(root, [])) {
    if (file === self) continue;
    try {
      const src = readFileSync(file, 'utf8');
      for (const line of src.split('\n')) {
        // The code before the first // — the venue mass-cancel cannot live in a
        // comment, so prose that names cancel_all to forbid it is not a violation.
        if (/cancel_all|orders\/cancel_all/i.test(line.split('//')[0])) {
          hits.push(file.slice(root.length + 1));
          break;
        }
      }
    } catch { /* skip unreadable */ }
  }
  assert(hits.length === 0, `cancel_all reached code in: ${hits.join(', ')} — the FAQ-capped sweep that could cancel orders we did not place`);

  // ---- T09.7 + T09.1(cancel): completion on fills ----
  const ctx = await setup('closesem');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000', '10000000']);
    const a0 = accountIds[0];
    const a1 = accountIds[1];

    const submit = async (coid, order) => {
      const out = await submitOrder(KEY, SECRET, { client_order_id: coid, side: order.side, market_order: { market: order.market, side: order.side, order_type: order.orderType, total_quantity: order.quantity, price: 0 } }, { baseUrl: base });
      if (out.kind === 'accepted') return { kind: 'accepted', exchangeOrderId: out.order.id, statusRaw: out.order.statusRaw };
      return { kind: 'rejected', orderMayExist: out.failure.orderMayExist, code: out.failure.code, detail: out.failure.detail };
    };
    const resolve = async (coid) => {
      const r = await fetchOrderByClientId(KEY, SECRET, coid, { baseUrl: base });
      if (!r.ok) return { ok: false };
      return { ok: true, order: r.order === null ? null : { id: r.order.id, statusRaw: r.order.statusRaw } };
    };
    // A spy cancel port: a correct worker must refuse a settled order WITHOUT
    // ever reaching the venue. Any invocation fails the check loudly.
    let cancelCalls = 0;
    const cancel = async () => { cancelCalls += 1; return { kind: 'cancelled' }; };
    const worker = new ExecutionWorker({ db: ctx.db, pepper: PEPPER, submit, resolve, cancel });

    const gt = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'executing', 'tok-fill', $4) RETURNING id`,
      [TENANT, groupId, USER, new Date(NOW_MS + 60_000)],
    );
    const tradeId = gt.rows[0].id;
    const childIds = [];
    for (let i = 0; i < 2; i += 1) {
      const child = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
         VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', 'planned', '0.0001') RETURNING id`,
        [TENANT, tradeId, i === 0 ? a0 : a1, i + 1],
      );
      childIds.push(child.rows[0].id);
      await addExecutionJob(ctx.db, child.rows[0].id, TENANT, 'place', new Date(NOW_MS - 1000));
    }

    await worker.runPlaceOnce();
    const open = await ctx.pool.query("SELECT count(*)::int n FROM child_order WHERE group_trade_id = $1 AND state = 'open'", [tradeId]);
    assert(open.rows[0].n === 2, 'both legs must be placed and open after the drain');

    // ---- settle BOTH to filled → poll → the trade auto-completes ----
    // The coid is only reserved during place (write-before-send), so read it back now.
    const r0 = await ctx.pool.query('SELECT client_order_id c FROM child_order WHERE id = $1', [childIds[0]]).then((r) => r.rows[0].c);
    const r1 = await ctx.pool.query('SELECT client_order_id c FROM child_order WHERE id = $1', [childIds[1]]).then((r) => r.rows[0].c);
    venue.settleOrder(r0, 'filled');
    venue.settleOrder(r1, 'filled');
    const changed = await worker.pollTrade(ctx.tdb, tradeId);
    assert(changed.changed === 2, `polling must settle both legs, got ${changed.changed}`);
    const states = await ctx.pool.query('SELECT state FROM child_order WHERE group_trade_id = $1 ORDER BY leg_seq', [tradeId]);
    assert(states.rows.every((r) => r.state === 'filled'), `both children must be filled, got ${states.rows.map((r) => r.state).join(', ')}`);
    const status = await ctx.pool.query('SELECT status s FROM group_trade WHERE id = $1', [tradeId]).then((r) => r.rows[0].s);
    assert(status === 'completed', `once no child is working the trade must auto-complete, got ${status}`);

    // ---- a leg left OPEN keeps a trade executing ----
    const gt2 = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'executing', 'tok-fill2', $4) RETURNING id`,
      [TENANT, groupId, USER, new Date(NOW_MS + 60_000)],
    );
    const trade2 = gt2.rows[0].id;
    const childA = await ctx.pool.query(
      `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
       VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', 'planned', '0.0001') RETURNING id`,
      [TENANT, trade2, a0, 1],
    );
    const childB = await ctx.pool.query(
      `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
       VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', 'planned', '0.0001') RETURNING id`,
      [TENANT, trade2, a1, 2],
    );
    for (const c of [childA.rows[0].id, childB.rows[0].id]) {
      await addExecutionJob(ctx.db, c, TENANT, 'place', new Date(NOW_MS - 1000));
    }
    await worker.runPlaceOnce();
    const coidA = await ctx.pool.query('SELECT client_order_id c FROM child_order WHERE id = $1', [childA.rows[0].id]).then((r) => r.rows[0].c);
    venue.settleOrder(coidA, 'filled'); // only ONE fills
    await worker.pollTrade(ctx.tdb, trade2);
    const sA = await ctx.pool.query('SELECT state s FROM child_order WHERE id = $1', [childA.rows[0].id]).then((r) => r.rows[0].s);
    const sB = await ctx.pool.query('SELECT state s FROM child_order WHERE id = $1', [childB.rows[0].id]).then((r) => r.rows[0].s);
    assert(sA === 'filled' && sB === 'open', `one filled + one open expected, got ${sA}/${sB}`);
    const status2 = await ctx.pool.query('SELECT status s FROM group_trade WHERE id = $1', [trade2]).then((r) => r.rows[0].s);
    assert(status2 === 'executing', `an open leg must keep the trade executing, got ${status2}`);

    // ---- T09.1: cancelling a SETTLED order is refused locally, no network call ----
    // tradeId's two children are now 'filled'. A cancel fan-out over one of them
    // must refuse BEFORE any venue call — the spy cancel port must never fire.
    const cancelRes = await worker.cancelChildren(ctx.tdb, [
      { id: childIds[0], groupTradeId: tradeId, accountId: a0, market: 'BTCINR' },
    ]);
    assert(cancelRes.length === 1 && cancelRes[0].outcome === 'refused', `a filled child must refuse cancel, got ${cancelRes[0]?.outcome}`);
    assert(cancelRes[0].toState === 'filled', `the refused child must still be filled, got ${cancelRes[0]?.toState}`);
    assert(cancelCalls === 0, `no venue cancel may be attempted for a settled order, got ${cancelCalls} calls`);
  } finally {
    await venue.stop();
    await teardown(ctx);
  }
}
