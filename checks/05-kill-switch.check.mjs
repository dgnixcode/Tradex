// 05-kill-switch — plan/phase-05, definition of done: every switch scope and cap
// proves "no order is sent" — not by checking a flag value but by running the real
// planning pipeline and asserting the affected leg is NOT planned.
//
// Four switch scopes (global platform, tenant pause, account frozen, market mode)
// and three caps (per-order, per-account override, per-tenant daily). Each case
// flips ONE thing from a world that plans cleanly and asserts the single account
// leg comes back skipped with a DISTINCT, non-empty message — so a customer never
// sees two different switches produce the same unexplained refusal.

import {
  DAY_START_MS, NOW_MS, TENANT, USER, bookProvider, ingestMarkets, seedGroupOfAccounts, setup, teardown,
} from './_plan-harness.mjs';
import { PlanningService, getChildOrders } from '../apps/api/dist/index.js';

let tokenSeq = 0;
const nextToken = () => `tok-ks-${(tokenSeq += 1)}`;

/** Preview a 20% BTC market buy for the single account; returns its leg. */
async function planOne(ctx, groupId) {
  const { getOrderBook } = bookProvider();
  const svc = new PlanningService({
    tdb: ctx.tdb, db: ctx.db, getOrderBook, codeVersion: 'killswitch-check',
    now: () => NOW_MS, dayStartMs: () => DAY_START_MS, newToken: nextToken,
  });
  const result = await svc.preview({
    groupId, createdBy: USER, asset: 'BTC', side: 'buy', orderType: 'market',
    sizingMode: 'pct_allocated', percentBp: 2000,
  });
  const rows = await getChildOrders(ctx.tdb, result.groupTradeId);
  return rows[0];
}

export async function run(assert) {
  const ctx = await setup('killswitch');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    await ingestMarkets(ctx.db);
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const accountId = accountIds[0];

    // Baseline: nothing switched, the leg plans.
    const base = await planOne(ctx, groupId);
    assert(base.state === 'planned', `baseline must plan, got ${base.state} (${base.refusalCode ?? ''})`);

    // Each case: flip ONE thing, plan, assert NOT planned with its code + a
    // message; then undo so the next case starts clean.
    const cases = [
      {
        name: 'global platform kill', code: 'PLATFORM_KILLED',
        on: { text: "UPDATE platform_state SET global_kill_switch = true WHERE id = 'singleton'" },
        off: { text: "UPDATE platform_state SET global_kill_switch = false WHERE id = 'singleton'" },
      },
      {
        name: 'platform read_only mode', code: 'PLATFORM_READ_ONLY',
        on: { text: "UPDATE platform_state SET mode = 'read_only' WHERE id = 'singleton'" },
        off: { text: "UPDATE platform_state SET mode = 'normal' WHERE id = 'singleton'" },
      },
      {
        name: 'tenant pause', code: 'TENANT_PAUSED',
        on: { text: 'UPDATE tenant_limit SET trading_paused = true, paused_at = $1 WHERE tenant_id = $2', values: [new Date(NOW_MS), TENANT] },
        off: { text: 'UPDATE tenant_limit SET trading_paused = false, paused_at = NULL WHERE tenant_id = $1', values: [TENANT] },
      },
      {
        name: 'account frozen', code: 'ACCOUNT_FROZEN',
        on: { text: "UPDATE exchange_account SET frozen_at = $1, frozen_reason = 'annual review' WHERE id = $2", values: [new Date(NOW_MS), accountId] },
        off: { text: 'UPDATE exchange_account SET frozen_at = NULL, frozen_reason = NULL WHERE id = $1', values: [accountId] },
      },
      {
        name: 'market read_only', code: 'MARKET_READ_ONLY',
        on: { text: "INSERT INTO market_state (market, mode, reason) VALUES ('BTCINR', 'read_only', 'venue investigation')" },
        off: { text: "DELETE FROM market_state WHERE market = 'BTCINR'" },
      },
      {
        name: 'per-order cap (tenant)', code: 'ABOVE_ORDER_CAP',
        on: { text: 'UPDATE tenant_limit SET max_order_notional_minor = 100 WHERE tenant_id = $1', values: [TENANT] },
        off: { text: 'UPDATE tenant_limit SET max_order_notional_minor = 20000000 WHERE tenant_id = $1', values: [TENANT] },
      },
      {
        name: 'per-account cap override', code: 'ABOVE_ORDER_CAP',
        on: { text: 'UPDATE exchange_account SET max_order_notional_minor = 100 WHERE id = $1', values: [accountId] },
        off: { text: 'UPDATE exchange_account SET max_order_notional_minor = NULL WHERE id = $1', values: [accountId] },
      },
      {
        name: 'per-tenant daily cap', code: 'ABOVE_DAILY_CAP',
        on: { text: 'UPDATE tenant_limit SET max_daily_notional_minor = 100 WHERE tenant_id = $1', values: [TENANT] },
        off: { text: 'UPDATE tenant_limit SET max_daily_notional_minor = 50000000 WHERE tenant_id = $1', values: [TENANT] },
      },
    ];

    const seenMessages = new Set();
    const seenCodes = new Set();
    for (const c of cases) {
      await ctx.pool.query(c.on.text, c.on.values ?? []);
      const row = await planOne(ctx, groupId);
      assert(row.state !== 'planned', `[${c.name}] expected NO planned leg (nothing may be sent), got ${row.state}`);
      assert(row.refusalCode === c.code, `[${c.name}] expected ${c.code}, got ${row.refusalCode}`);
      assert(row.refusalDetail !== null && row.refusalDetail.trim() !== '', `[${c.name}] refusal must carry a message`);
      assert(!seenMessages.has(row.refusalDetail), `[${c.name}] refusal message is not distinct from an earlier case: ${row.refusalDetail}`);
      seenMessages.add(row.refusalDetail);
      seenCodes.add(row.refusalCode);
      await ctx.pool.query(c.off.text, c.off.values ?? []);
    }
    // Every case produced a refusal, and no two cases produced the same message —
    // so a customer can tell which brake stopped them.
    assert(seenMessages.size === cases.length, `expected ${cases.length} distinct refusal messages, got ${seenMessages.size}`);
    assert(seenCodes.has('ACCOUNT_FROZEN') && seenCodes.has('MARKET_READ_ONLY') && seenCodes.has('PLATFORM_KILLED')
      && seenCodes.has('TENANT_PAUSED'), 'the four switch scopes must each have blocked a trade');

    // After every undo, the world plans again — the brakes are the only thing
    // stopping it.
    const after = await planOne(ctx, groupId);
    assert(after.state === 'planned', `after all switches are off the baseline must plan again, got ${after.state}`);
  } finally {
    await teardown(ctx);
  }
}
