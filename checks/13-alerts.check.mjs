// 13-alerts — plan/phase-13 T13.1/T13.2.
//
// Every alert A1–A18 fires when its own readout crosses the research/20 F2
// threshold (synthetic per-alert trigger), the ten money-at-risk alerts page at
// night, an absent readout never fires (no monitoring ≠ no alarm), and the
// DB-backed readouts (A11 job age, A16 kill switch, A18 ledger invariant) are
// proven end-to-end from our own tables.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { ALERT_DEFS, PAGE_AT_NIGHT, evaluateAlerts } from '../packages/ops/dist/index.js';
import { addExecutionJob, recordFill, rebuildHoldings, readOpsReadouts } from '../packages/db/dist/index.js';

// One crossing readout per alert, everything else absent.
const CROSS = {
  A1: { orderFailPct: 21 },
  A2: { needsHuman: 1 },
  A3: { reconcilerSilentCycles: 3 },
  A4: { divergenceAboveTolerance: true },
  A5: { externalFillsNoCoid: 1 },
  A6: { decryptRateRatio: 3.1 },
  A7: { credential401s: 3 },
  A8: { signatureErrors: 1 },
  A9: { rateLimit429Pct: 1.1 },
  A10: { clockOffsetMs: 1001 },
  A11: { oldestPlaceJobMs: 10_001 },
  A12: { depthStalledSec: 61 },
  A13: { fivexxPerMin: 11 },
  A14: { marketInactive: true },
  A15: { groupNotionalRatio: 3.1 },
  A16: { killSwitchOn: true },
  A17: { workerLocksReaped: 1 },
  A18: { ledgerInvariantBroken: true },
  A19: { maxFundingRateBp: 101 },
  A20: { minLiquidationBufferBp: 150, liquidationBufferUnderForSec: 61 },
  A21: { staleSlAfterExitFor: 31 },
};

export async function run(assert) {
  // ---- synthetic per-alert trigger ----
  assert(ALERT_DEFS.length === 21, `the catalogue must list all 21 alerts, got ${ALERT_DEFS.length}`);
  assert(PAGE_AT_NIGHT.size === 12, `exactly twelve alerts page at night (A20/A21 added for futures), got ${PAGE_AT_NIGHT.size}`);

  for (const def of ALERT_DEFS) {
    const fired = evaluateAlerts(CROSS[def.id]);
    assert(fired.some((a) => a.id === def.id), `${def.id} must fire when its readout crosses the threshold`);
    const mine = fired.find((a) => a.id === def.id);
    assert(mine !== undefined && mine.page === PAGE_AT_NIGHT.has(def.id),
      `${def.id} routing must match the money-at-risk page set`);
  }

  // An alert whose readout sits BELOW the threshold does not fire.
  assert(evaluateAlerts({ oldestPlaceJobMs: 5_000 }).length === 0, 'below-threshold readouts must not fire');
  assert(evaluateAlerts({}).length === 0, 'absent readouts (no monitoring) must never fire');
  // A single crossing fires exactly that one alert.
  const only = evaluateAlerts(CROSS['A18']);
  assert(only.length === 1 && only[0].id === 'A18', 'one crossing readout must fire exactly its alert');

  // ---- DB-backed readouts, end-to-end ----
  const ctx = await setup('opsalerts');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const a0 = accountIds[0];

    // Clean world: no job, no pause, ledger verifies → no A11/A16/A18.
    const clean = await readOpsReadouts(ctx.db, TENANT, [a0], NOW_MS);
    assert(clean.oldestPlaceJobMs === null, 'no unclaimed place job in a clean world');
    assert(clean.killSwitchOn === false, 'no kill switch in a clean world');
    assert(clean.ledgerInvariantBroken === false, 'a clean ledger verifies');
    assert(evaluateAlerts(clean).length === 0, 'a clean world fires nothing');

    // A11 — an unclaimed 'place' job due 20 s ago is older than the 10 s window.
    const gt = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'executing', 'tok-alert', $4) RETURNING id`,
      [TENANT, groupId, USER, new Date(NOW_MS + 60_000)],
    );
    const child = await ctx.pool.query(
      `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
       VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', 'planned', '0.0001') RETURNING id`,
      [TENANT, gt.rows[0].id, a0, 1],
    );
    await addExecutionJob(ctx.db, child.rows[0].id, TENANT, 'place', new Date(NOW_MS - 20_000));
    const withStaleJob = await readOpsReadouts(ctx.db, TENANT, [a0], NOW_MS);
    assert(withStaleJob.oldestPlaceJobMs !== null && withStaleJob.oldestPlaceJobMs > 10_000,
      `A11 readout must see the 20s-old job, got ${withStaleJob.oldestPlaceJobMs}`);
    assert(evaluateAlerts(withStaleJob).some((a) => a.id === 'A11'), 'A11 fires on a stalled place job');

    // A16 — pausing the tenant flips the kill-switch signal (paused_at travels
    // with the flag; the schema CHECK demands it).
    await ctx.pool.query(
      "UPDATE tenant_limit SET trading_paused = true, paused_at = now(), paused_reason = 'ops alert check' WHERE tenant_id = $1",
      [TENANT],
    );
    const paused = await readOpsReadouts(ctx.db, TENANT, [a0], NOW_MS);
    assert(paused.killSwitchOn === true, 'A16 readout must see the tenant pause');
    assert(evaluateAlerts(paused).some((a) => a.id === 'A16'), 'A16 fires when a kill switch is engaged');

    // A18 — a corrupted projection fails the L2 check.
    await ctx.pool.query(
      'UPDATE tenant_limit SET trading_paused = false, paused_at = NULL, paused_reason = NULL WHERE tenant_id = $1',
      [TENANT],
    );
    await recordFill(ctx.tdb, {
      accountId: a0, exchangeTradeId: 'op-f1', side: 'buy', asset: 'BTC', quote: 'INR',
      qty: '0.1', price: '8000000', feeMinor: '0', market: 'BTCINR', occurredAtMs: NOW_MS + 1000,
    });
    await rebuildHoldings(ctx.tdb, a0);
    await ctx.pool.query("UPDATE holding SET cost_total_minor = '1' WHERE account_id = $1 AND asset = 'BTC'", [a0]);
    const corrupted = await readOpsReadouts(ctx.db, TENANT, [a0], NOW_MS);
    assert(corrupted.ledgerInvariantBroken === true, 'A18 readout must detect the corrupted projection');
    assert(evaluateAlerts(corrupted).some((a) => a.id === 'A18'), 'A18 fires when the ledger invariant fails');
  } finally {
    await teardown(ctx);
  }
}
