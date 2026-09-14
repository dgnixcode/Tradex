// 15-place-protocol — L1-L4, the futures anti-duplicate protocol.
//
// This is the highest-risk code in the product: futures has no client_order_id and
// no order-status endpoint, so "did my order land?" can only be answered by reading
// orders back and matching. Every branch below is a decision about real money, and
// the dangerous ones are the branches that CONCLUDE something — `not_placed` in
// particular, because it abandons an order that may exist and may fill.
//
// The scenarios are chosen so each one would be wrong in a specific way if the
// protocol were naive:
//
//   * an unreadable list must NOT be read as "no orders" (that concludes not_placed)
//   * a position with no matching order must NOT be read as ours
//   * two identical matches must NOT be resolved by picking one
//   * an order outside the search window must NOT be adopted
//   * the lock must be released, including on the unhappy paths
//
// Needs a database for the (account, pair) lock. Skips cleanly without DATABASE_URL.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { acquireFuturesLock } from '../packages/db/dist/index.js';
import { placeFuturesOrder } from '../apps/api/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');
const SCHEMA = 'tradex_place_protocol_check';

const T1 = '11111111-1111-1111-1111-111111111111';
const ACCOUNT = '22222222-2222-2222-2222-222222222222';
const CHILD_A = '33333333-3333-3333-3333-333333333333';
const CHILD_B = '44444444-4444-4444-4444-444444444444';

const PAIR = 'B-BTC_USDT';
const NOW = 1_760_000_000_000;

const intent = (over = {}) => ({
  accountId: ACCOUNT,
  pair: PAIR,
  marginCurrency: 'USDT',
  side: 'buy',
  orderType: 'market',
  quantity: '0.001',
  price: null,
  sentAtMs: NOW,
  childOrderId: CHILD_A,
  ...over,
});

const listed = (over = {}) => ({
  venueOrderId: 'ford-1',
  pair: PAIR,
  side: 'buy',
  orderType: 'market',
  totalQuantity: '0.001',
  price: null,
  createdAtMs: NOW,
  statusRaw: 'FILLED',
  ...over,
});

/** Ports that succeed, with every response overridable per scenario. */
const ports = (over = {}) => ({
  workerId: 'check',
  nowMs: () => NOW,
  waitMs: 0,
  searchWindowMs: 5_000,
  create: async () => ({ kind: 'accepted', venueOrderId: 'ford-1', statusRaw: 'initial' }),
  listOrders: async () => ({ ok: true, orders: [] }),
  readPositions: async () => ({ ok: true, positions: [] }),
  ...over,
});

export async function run(assert) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }

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
    await s.query("INSERT INTO tenant (id, name) VALUES ($1, 'Protocol T')", [T1]);
    // The lock has a composite FK to exchange_account, so the account must exist.
    await s.query(
      `INSERT INTO exchange_account (id, tenant_id, name, allocated_capital_minor, allocated_currency, status)
       VALUES ($1, $2, 'Proto', '1000000', 'INR', 'active')`, [ACCOUNT, T1]);
  } finally {
    s.release();
  }

  const pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${SCHEMA},public` });
  const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

  try {
    // ------------------------------------------------ 1. the happy path
    const ok = await placeFuturesOrder(db, T1, ports(), intent());
    assert(ok.resolution === 'created', `a clean create resolved as ${ok.resolution}`);
    assert(ok.submit.kind === 'accepted' && ok.submit.exchangeOrderId === 'ford-1',
      `the create's order id did not come through: ${JSON.stringify(ok.submit)}`);
    // L1: the lock must be gone the moment we return.
    const freeAfter = await acquireFuturesLock(db, {
      tenantId: T1, accountId: ACCOUNT, pair: PAIR, childOrderId: CHILD_B, workerId: 'check',
    });
    assert(freeAfter === true, 'the lock was not released after a successful create');
    await db.deleteFrom('futures_execution_lock').execute();

    // ------------------------------------------------ 2. a business rejection
    // orderMayExist false means the venue refused it outright — terminal, and it
    // must NOT trigger a read-back (reading would be wasted work at best, and at
    // worst could adopt an unrelated order).
    let listCalls = 0;
    const rejected = await placeFuturesOrder(db, T1, ports({
      create: async () => ({ kind: 'rejected', orderMayExist: false, code: 'insufficient_margin', detail: 'nope' }),
      listOrders: async () => { listCalls += 1; return { ok: true, orders: [] }; },
    }), intent());
    assert(rejected.resolution === 'rejected', `a clean rejection resolved as ${rejected.resolution}`);
    assert(rejected.submit.orderMayExist === false, 'a business rejection was marked as possibly-existing');
    assert(listCalls === 0, 'a business rejection still read the order list back');

    // ------------------------------------------------ 3. ambiguity, exactly one match
    const adopted = await placeFuturesOrder(db, T1, ports({
      create: async () => ({ kind: 'rejected', orderMayExist: true, code: 'timeout', detail: 'no answer' }),
      listOrders: async ({ side }) => (side === 'buy' ? { ok: true, orders: [listed()] } : { ok: true, orders: [] }),
    }), intent());
    assert(adopted.resolution === 'adopted', `a single match resolved as ${adopted.resolution}`);
    assert(adopted.submit.kind === 'accepted' && adopted.submit.exchangeOrderId === 'ford-1',
      'the adopted order id was not carried through');
    assert(adopted.submit.statusRaw === 'FILLED', 'the adopted order did not carry the venue status through');

    // ------------------------------------------------ 4. the fields must all match
    // A near-miss must not be adopted. Each of these differs in exactly one field.
    for (const [label, wrong] of [
      ['quantity', listed({ totalQuantity: '0.002' })],
      ['order_type', listed({ orderType: 'limit' })],
      ['pair', listed({ pair: 'INR-ETH_INR' })],
      ['side', listed({ side: 'sell' })],
    ]) {
      const near = await placeFuturesOrder(db, T1, ports({
        create: async () => ({ kind: 'rejected', orderMayExist: true, code: 'timeout', detail: '' }),
        listOrders: async () => ({ ok: true, orders: [wrong] }),
      }), intent());
      assert(near.resolution === 'not_placed',
        `an order differing only in ${label} was treated as ${near.resolution}`);
    }

    // A price difference matters for a limit order — null vs a number is not a match.
    const priceMismatch = await placeFuturesOrder(db, T1, ports({
      create: async () => ({ kind: 'rejected', orderMayExist: true, code: 'timeout', detail: '' }),
      listOrders: async () => ({ ok: true, orders: [listed({ orderType: 'limit', price: '8000000' })] }),
    }), intent({ orderType: 'limit', price: '8100000' }));
    assert(priceMismatch.resolution === 'not_placed', 'a limit order at a different price was adopted');

    // ------------------------------------------------ 5. zero matches, no position
    const notPlaced = await placeFuturesOrder(db, T1, ports({
      create: async () => ({ kind: 'rejected', orderMayExist: true, code: 'timeout', detail: '' }),
    }), intent());
    assert(notPlaced.resolution === 'not_placed', `an empty read-back resolved as ${notPlaced.resolution}`);
    assert(notPlaced.submit.orderMayExist === false, 'not_placed must not claim the order may exist');
    assert(notPlaced.submit.needsHuman === undefined, 'not_placed must not escalate to a human');

    // ------------------------------------------------ 6. a failed read is NOT "no orders"
    // The single most dangerous inference in this file: a 500 on the list must not
    // be read as "the order is not there". That would abandon a live order.
    for (const [label, listOrders] of [
      ['both sides fail', async () => ({ ok: false, detail: 'venue 500' })],
      ['one side fails', async ({ side }) => (side === 'buy'
        ? { ok: false, detail: 'venue 500' }
        : { ok: true, orders: [] })],
    ]) {
      const unreadable = await placeFuturesOrder(db, T1, ports({
        create: async () => ({ kind: 'rejected', orderMayExist: true, code: 'timeout', detail: '' }),
        listOrders,
      }), intent());
      assert(unreadable.submit.orderMayExist === true,
        `${label}: an unreadable list concluded the order does not exist — it may`);
      assert(unreadable.resolution === 'undecidable', `${label}: resolved as ${unreadable.resolution}`);
    }

    // ------------------------------------------------ 7. a position with no order
    // The order may have filled and still be reported `initial`, which no status
    // filter returns. A position is evidence, but not proof it is OURS.
    const positionOnly = await placeFuturesOrder(db, T1, ports({
      create: async () => ({ kind: 'rejected', orderMayExist: true, code: 'timeout', detail: '' }),
      readPositions: async () => ({ ok: true, positions: [{ pair: PAIR, activePos: '0.001' }] }),
    }), intent());
    assert(positionOnly.submit.orderMayExist === true,
      'an open position with no matching order concluded the order does not exist');
    assert(positionOnly.resolution === 'undecidable', `resolved as ${positionOnly.resolution}`);

    // A closed position (activePos '0') is not evidence of anything.
    const zeroPosition = await placeFuturesOrder(db, T1, ports({
      create: async () => ({ kind: 'rejected', orderMayExist: true, code: 'timeout', detail: '' }),
      readPositions: async () => ({ ok: true, positions: [{ pair: PAIR, activePos: '0' }] }),
    }), intent());
    assert(zeroPosition.resolution === 'not_placed', 'a flat position should not keep the send ambiguous');

    // ------------------------------------------------ 8. two matches need a human
    // The customer placed an identical order by hand. Nothing can separate them,
    // and picking one would attribute their fill to this leg.
    const twoMatches = await placeFuturesOrder(db, T1, ports({
      create: async () => ({ kind: 'rejected', orderMayExist: true, code: 'timeout', detail: '' }),
      listOrders: async () => ({ ok: true, orders: [listed(), listed({ venueOrderId: 'ford-2' })] }),
    }), intent());
    assert(twoMatches.submit.needsHuman === true,
      'two identical matches did not escalate to a human — one was picked');
    assert(twoMatches.resolution === 'undecidable', `two matches resolved as ${twoMatches.resolution}`);

    // ------------------------------------------------ 9. the search window
    // An order from outside the window is not ours. Adopting one would be worse
    // than not finding ours at all.
    const tooOld = await placeFuturesOrder(db, T1, ports({
      create: async () => ({ kind: 'rejected', orderMayExist: true, code: 'timeout', detail: '' }),
      listOrders: async () => ({ ok: true, orders: [listed({ createdAtMs: NOW - 60_000 })] }),
    }), intent());
    assert(tooOld.resolution === 'not_placed', 'an order from a minute ago was adopted as ours');
    const noTimestamp = await placeFuturesOrder(db, T1, ports({
      create: async () => ({ kind: 'rejected', orderMayExist: true, code: 'timeout', detail: '' }),
      listOrders: async () => ({ ok: true, orders: [listed({ createdAtMs: null })] }),
    }), intent());
    assert(noTimestamp.resolution === 'not_placed', 'an order with no timestamp was adopted');

    // ------------------------------------------------ 10. L1: the lock really locks
    const held = await acquireFuturesLock(db, {
      tenantId: T1, accountId: ACCOUNT, pair: PAIR, childOrderId: CHILD_A, workerId: 'someone-else',
    });
    assert(held === true, 'the check could not take the lock it needs to hold');
    let createAttempted = false;
    const busy = await placeFuturesOrder(db, T1, ports({
      create: async () => { createAttempted = true; return { kind: 'accepted', venueOrderId: 'x', statusRaw: 'initial' }; },
    }), intent({ childOrderId: CHILD_B }));
    assert(busy.resolution === 'busy', `a held lock did not refuse the send (got ${busy.resolution})`);
    assert(busy.submit.orderMayExist === false, 'a busy refusal claimed an order may exist');
    assert(createAttempted === false,
      'a send was attempted while the lock was held — L1 is not gating the create');

    // Release the lock we took by hand first, or the next assertion proves nothing:
    // a lock still held by this check would make the re-acquire fail for the wrong
    // reason and read as "the throw path released it".
    await db.deleteFrom('futures_execution_lock').execute();

    let threw = false;
    try {
      await placeFuturesOrder(db, T1, ports({
        create: async () => { throw new Error('transport exploded'); },
      }), intent({ childOrderId: CHILD_B }));
    } catch { threw = true; }
    assert(threw, 'a throwing create was swallowed — the worker must see the failure, not a quiet verdict');

    // Now the lock is the only thing that can be held, so this acquiry is real.
    const freeAfterThrow = await acquireFuturesLock(db, {
      tenantId: T1, accountId: ACCOUNT, pair: PAIR, childOrderId: CHILD_A, workerId: 'check',
    });
    assert(freeAfterThrow === true,
      'the lock was left held after a thrown send — this (account, pair) would be frozen until the reaper ran');

    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    console.log('     L1-L4: create / adopt / not_placed / undecidable / needs_human; lock gated and always released');
  } finally {
    await pool.end();
    await setupPool.end();
  }
}
