// 15-anti-dup-futures — plan/phase-15 T15.4.
//
// Research/03 Verdict: futures has NO client_order_id, so the spot anti-double-
// send spine (deterministic coid → duplicate-key rejection) does not carry over.
// The substitute is the (account, pair) row lock in `futures_execution_lock`:
// INSERT ON CONFLICT DO NOTHING makes the race atomic — exactly one caller wins.
// This proves that property, plus the reaper's stale-lock release with the
// 30-second default cushion (well outside the venue's 10s signing window, so a
// legitimate in-flight send is never reaped).

import { NOW_MS, TENANT, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { acquireFuturesLock, reapStaleFuturesLocks, releaseFuturesLock } from '../packages/db/dist/index.js';

export async function run(assert) {
  const ctx = await setup('futdup');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    const { accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const a0 = accountIds[0];
    const child = await ctx.pool.query(
      `INSERT INTO exchange_account (id, tenant_id, name, allocated_capital_minor, allocated_currency, status)
       VALUES (gen_random_uuid(), $1, 'not used', '0', 'USDT', 'active') RETURNING id`,
      [TENANT],
    );
    void child; // reserved for future multi-account expansion

    // 1. First acquire wins.
    const first = await acquireFuturesLock(ctx.db, {
      tenantId: TENANT, accountId: a0, pair: 'B-BTC_USDT',
      childOrderId: '11111111-1111-4111-8111-111111111111',
      workerId: 'w1', now: new Date(NOW_MS),
    });
    assert(first === true, 'first acquire must win the (account, pair) lock');

    // 2. Second acquire on the SAME (account, pair) loses — the anti-duplicate.
    const second = await acquireFuturesLock(ctx.db, {
      tenantId: TENANT, accountId: a0, pair: 'B-BTC_USDT',
      childOrderId: '22222222-2222-4222-8222-222222222222',
      workerId: 'w2', now: new Date(NOW_MS + 100),
    });
    assert(second === false, 'a second acquire on the same (account, pair) MUST lose — the anti-duplicate substitute');

    // 3. A DIFFERENT pair on the same account acquires cleanly.
    const otherPair = await acquireFuturesLock(ctx.db, {
      tenantId: TENANT, accountId: a0, pair: 'B-ETH_USDT',
      childOrderId: '33333333-3333-4333-8333-333333333333',
      workerId: 'w1', now: new Date(NOW_MS + 200),
    });
    assert(otherPair === true, 'a different pair on the same account is a separate lock');

    // 4. Reaper with a 30 s window LEAVES fresh locks alone — a legitimate
    //    in-flight send is safe because the venue's own window is only 10 s.
    const notReaped = await reapStaleFuturesLocks(ctx.db, {
      staleMs: 30_000, now: new Date(NOW_MS + 5_000),
    });
    assert(notReaped.length === 0, `a 5s-old lock inside the 30s window must not be reaped, got ${notReaped.length}`);

    // 5. After the window, the reaper releases the stale ones.
    const reaped = await reapStaleFuturesLocks(ctx.db, {
      staleMs: 30_000, now: new Date(NOW_MS + 60_000),
    });
    assert(reaped.length === 2, `both stale locks must reap after 60s, got ${reaped.length}`);
    assert(reaped.some((r) => r.pair === 'B-BTC_USDT'), 'BTC lock reaped');
    assert(reaped.some((r) => r.pair === 'B-ETH_USDT'), 'ETH lock reaped');

    // 6. After the reap, the (account, BTC) lock can be re-acquired.
    const again = await acquireFuturesLock(ctx.db, {
      tenantId: TENANT, accountId: a0, pair: 'B-BTC_USDT',
      childOrderId: '44444444-4444-4444-8444-444444444444',
      workerId: 'w3', now: new Date(NOW_MS + 61_000),
    });
    assert(again === true, 'after reap, the (account, BTC) lock can be acquired again');

    // 7. Explicit release drops the row so a follow-up leg can proceed.
    await releaseFuturesLock(ctx.db, {
      accountId: a0, pair: 'B-BTC_USDT',
      childOrderId: '44444444-4444-4444-8444-444444444444',
    });
    const afterRelease = await acquireFuturesLock(ctx.db, {
      tenantId: TENANT, accountId: a0, pair: 'B-BTC_USDT',
      childOrderId: '55555555-5555-4555-8555-555555555555',
      workerId: 'w4', now: new Date(NOW_MS + 62_000),
    });
    assert(afterRelease === true, 'after release, a fresh acquire wins');
  } finally {
    await teardown(ctx);
  }
}
