// 04-gates — plan/phase-04 T04.4.
//
// The twelve live-state gates, tripped one at a time through the REAL planning
// service against a real database. The unit test in packages/sizing proves the
// pure planAccount() trips each gate; this check proves the SERVICE wires the
// database state into those gates correctly — that a paused tenant, a revoked
// credential, a tiny cap or an in-flight order actually reaches the gate that
// refuses it, and that the refusal lands on the persisted child_order row with a
// code and a message.
//
// Each case starts from a world that plans cleanly, breaks exactly one thing, and
// asserts the resulting skip carries the expected code. Because everything funds
// in INR and the book is deep, the baseline plans without slippage or resolution
// trouble, so a break surfaces as its own gate rather than a neighbour's.

import {
  DAY_START_MS, NOW_MS, TENANT, USER, bookProvider, ingestMarkets, seedGroupOfAccounts, setup, teardown,
} from './_plan-harness.mjs';
import { PlanningService, getChildOrders } from '../apps/api/dist/index.js';

// A monotonic token source: every preview persists a unique preview_token, which
// the unique index requires. A counter keeps it deterministic (no clock/random).
let tokenSeq = 0;
const nextToken = () => `tok-gates-${(tokenSeq += 1)}`;

/** Preview a single-account 20% BTC market buy and return that account's row. */
async function planOne(ctx, groupId) {
  const { getOrderBook } = bookProvider();
  const svc = new PlanningService({
    tdb: ctx.tdb, db: ctx.db, getOrderBook, codeVersion: 'gates-check',
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
  const ctx = await setup('gates');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    await ingestMarkets(ctx.db);
    // One account with Rs 1,00,000, enough for a clean 20% buy on a deep book.
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const accountId = accountIds[0];

    // ---------------------------------------------------------------- baseline
    const base = await planOne(ctx, groupId);
    assert(base.state === 'planned', `baseline should plan, got ${base.state} (${base.refusalCode ?? ''})`);

    // Helper: run a mutation, plan, assert the code, then undo the mutation.
    const trip = async (label, mutateSql, undoSql, expectedCode) => {
      await ctx.pool.query(mutateSql.text, mutateSql.values ?? []);
      const row = await planOne(ctx, groupId);
      assert(row.state === 'skipped', `${label}: expected a skip, got ${row.state}`);
      assert(row.refusalCode === expectedCode, `${label}: expected ${expectedCode}, got ${row.refusalCode}`);
      assert(row.refusalDetail !== null && row.refusalDetail.length > 0, `${label}: skip must carry a message`);
      if (undoSql !== null) await ctx.pool.query(undoSql.text, undoSql.values ?? []);
      return row;
    };

    // ---------------------------------------------------------- gate 1: kill switch
    await trip('gate 1 platform kill',
      { text: "UPDATE platform_state SET global_kill_switch = true WHERE id = 'singleton'" },
      { text: "UPDATE platform_state SET global_kill_switch = false WHERE id = 'singleton'" },
      'PLATFORM_KILLED');

    await trip('gate 1 read-only mode',
      { text: "UPDATE platform_state SET mode = 'read_only' WHERE id = 'singleton'" },
      { text: "UPDATE platform_state SET mode = 'normal' WHERE id = 'singleton'" },
      'PLATFORM_READ_ONLY');

    // ---------------------------------------------------------- gate 1: tenant paused
    await trip('gate 1 tenant paused',
      { text: 'UPDATE tenant_limit SET trading_paused = true, paused_at = $1 WHERE tenant_id = $2', values: [new Date(NOW_MS), TENANT] },
      { text: 'UPDATE tenant_limit SET trading_paused = false, paused_at = NULL WHERE tenant_id = $1', values: [TENANT] },
      'TENANT_PAUSED');

    // ---------------------------------------------------------- gate 2: account status
    await trip('gate 2 account suspended',
      { text: "UPDATE exchange_account SET status = 'suspended' WHERE id = $1", values: [accountId] },
      { text: "UPDATE exchange_account SET status = 'active' WHERE id = $1", values: [accountId] },
      'ACCOUNT_NOT_ACTIVE');

    // ---------------------------------------------------------- gate 3: credential status
    // Revocation requires the shred (dek NULL) by CHECK, so set both together.
    await trip('gate 3 credential revoked',
      { text: "UPDATE exchange_credential SET status = 'revoked', dek_wrapped = NULL, revoked_at = $1 WHERE account_id = $2", values: [new Date(NOW_MS), accountId] },
      { text: "UPDATE exchange_credential SET status = 'active', dek_wrapped = $1, revoked_at = NULL WHERE account_id = $2", values: [Buffer.from('00', 'hex'), accountId] },
      'CREDENTIAL_NOT_ACTIVE');

    // ---------------------------------------------------------- gate 10: per-order cap
    await trip('gate 10 per-order cap',
      { text: 'UPDATE tenant_limit SET max_order_notional_minor = 100 WHERE tenant_id = $1', values: [TENANT] },
      { text: 'UPDATE tenant_limit SET max_order_notional_minor = 20000000 WHERE tenant_id = $1', values: [TENANT] },
      'ABOVE_ORDER_CAP');

    // ---------------------------------------------------------- gate 11: daily cap
    // The refusal must carry the remaining headroom (phase 05), not just "over".
    const rowDaily = await trip('gate 11 daily cap',
      { text: 'UPDATE tenant_limit SET max_daily_notional_minor = 100 WHERE tenant_id = $1', values: [TENANT] },
      { text: 'UPDATE tenant_limit SET max_daily_notional_minor = 50000000 WHERE tenant_id = $1', values: [TENANT] },
      'ABOVE_DAILY_CAP');
    assert(/headroom/i.test(rowDaily.refusalDetail ?? ''),
      `gate 11: the daily-cap refusal must quote the remaining headroom, got: ${rowDaily.refusalDetail}`);

    // ------------------------------------------------- phase 05: account-frozen scope
    await trip('account-frozen scope',
      { text: "UPDATE exchange_account SET frozen_at = $1, frozen_reason = 'frozen for a review' WHERE id = $2", values: [new Date(NOW_MS), accountId] },
      { text: 'UPDATE exchange_account SET frozen_at = NULL, frozen_reason = NULL WHERE id = $1', values: [accountId] },
      'ACCOUNT_FROZEN');

    // ------------------------------------------------- phase 05: market-scope switch
    await trip('market cancel_only',
      { text: "INSERT INTO market_state (market, mode, reason) VALUES ('BTCINR', 'cancel_only', 'venue maintenance')" },
      { text: "DELETE FROM market_state WHERE market = 'BTCINR'" },
      'MARKET_CANCEL_ONLY');

    await trip('market read_only',
      { text: "INSERT INTO market_state (market, mode, reason) VALUES ('BTCINR', 'read_only', 'suspicious activity')" },
      { text: "DELETE FROM market_state WHERE market = 'BTCINR'" },
      'MARKET_READ_ONLY');

    // ------------------------------------------------ phase 05: per-account cap override
    // The account's own cap is far below its 20% order, so the refusal must name
    // THIS ACCOUNT'S cap, not the tenant's.
    const rowAccCap = await trip('per-account cap override',
      { text: 'UPDATE exchange_account SET max_order_notional_minor = 100 WHERE id = $1', values: [accountId] },
      { text: 'UPDATE exchange_account SET max_order_notional_minor = NULL WHERE id = $1', values: [accountId] },
      'ABOVE_ORDER_CAP');
    assert(/this account's order cap/i.test(rowAccCap.refusalDetail ?? ''),
      `per-account cap: the refusal must name the account's own cap, got: ${rowAccCap.refusalDetail}`);

    // ---------------------------------------------------------- gate 4: asset not listed
    // No mutation of state undoes cleanly; use a different asset that is not listed.
    {
      const { getOrderBook } = bookProvider();
      const svc = new PlanningService({
        tdb: ctx.tdb, db: ctx.db, getOrderBook, codeVersion: 'gates-check',
        now: () => NOW_MS, dayStartMs: () => DAY_START_MS, newToken: () => 'tok-gate4',
      });
      const result = await svc.preview({
        groupId, createdBy: USER, asset: 'NOTAREALASSET', side: 'buy', orderType: 'market',
        sizingMode: 'pct_allocated', percentBp: 2000,
      });
      const rows = await getChildOrders(ctx.tdb, result.groupTradeId);
      assert(rows[0].state === 'skipped', 'gate 4: an unlisted asset should skip');
      assert(rows[0].refusalCode === 'ASSET_NOT_LISTED', `gate 4: expected ASSET_NOT_LISTED, got ${rows[0].refusalCode}`);
    }

    // ---------------------------------------------------------- gate 12: in-flight order
    // Insert an unresolved order for this account on BTCINR, then plan again.
    {
      // First, a clean plan to confirm the baseline still works after undos.
      const clean = await planOne(ctx, groupId);
      assert(clean.state === 'planned', `after undos the baseline should plan again, got ${clean.refusalCode ?? clean.state}`);

      // Manufacture an in-flight order: a child_order in 'open' on BTCINR. It needs
      // a parent group_trade, so create a minimal one.
      const { rows: gt } = await ctx.pool.query(
        `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value)
         VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'pct_allocated', '2000') RETURNING id`,
        [TENANT, groupId, USER],
      );
      await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, market, state)
         VALUES ($1, $2, $3, 'BTCINR', 'open')`,
        [TENANT, gt[0].id, accountId],
      );

      const row = await planOne(ctx, groupId);
      assert(row.state === 'skipped', 'gate 12: an account with an in-flight order should skip');
      assert(row.refusalCode === 'ORDER_IN_FLIGHT', `gate 12: expected ORDER_IN_FLIGHT, got ${row.refusalCode}`);
    }

    // Every gate code the module can emit is a non-empty string (catalogue sanity).
    const { GATE_CODES } = await import('../packages/sizing/dist/index.js');
    assert(GATE_CODES.length === 15, `expected 15 gate codes, got ${GATE_CODES.length}`);
    for (const code of GATE_CODES) assert(typeof code === 'string' && code.length > 0, `gate code ${code} is malformed`);
    for (const code of ['ACCOUNT_FROZEN', 'MARKET_CANCEL_ONLY', 'MARKET_READ_ONLY']) {
      assert(GATE_CODES.includes(code), `phase-05 gate code ${code} is missing from GATE_CODES`);
    }
  } finally {
    await teardown(ctx);
  }
}
