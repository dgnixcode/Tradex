// 04-dry-run-100 — plan/phase-04 T04.9, rung 0 of the rollout.
//
// The phase's definition of done: "100 consecutive group trades planned and
// dry-run with zero exceptions; the recorded would-send bodies match the preview
// table row for row (invariant U2)." This is the gate that says the pipeline is
// stable enough to be trusted before a single real order is ever sent — the whole
// point of building the send path last.
//
// Each iteration previews a group trade, confirms it in dry-run mode, and checks
// that (a) nothing threw, (b) the trade completed with the send suppressed, and
// (c) the persisted child rows still equal the preview rows. A varied but
// DETERMINISTIC mix of sides, sizing modes and order types is used across the
// hundred, so the loop exercises the pipeline broadly rather than repeating one
// shape a hundred times. No clock, no randomness: the iteration index drives the
// variation, so a failure at run 73 is reproducible.

import {
  DAY_START_MS, NOW_MS, TENANT, USER, bookProvider, ingestMarkets, seedGroupOfAccounts, setup, teardown,
} from './_plan-harness.mjs';
import {
  PlanningService, confirmDryRun, getChildOrders, getGroupTrade,
} from '../apps/api/dist/index.js';

const RUNS = 100;

/** A deterministic request shape for iteration i — varied across the hundred. */
function requestFor(i, groupId) {
  const buy = i % 2 === 0;
  const orderType = i % 3 === 0 ? 'limit' : 'market';
  // A limit price near the BTCINR touch so limit orders legalise on the fixture.
  const limitPrice = orderType === 'limit' ? '7950000' : undefined;
  const base = { groupId, createdBy: USER, asset: 'BTC', orderType,
    ...(limitPrice !== undefined ? { limitPrice } : {}) };
  if (buy) {
    // Rotate through the buy sizing modes.
    const mode = ['pct_allocated', 'pct_free', 'quote_amount'][i % 3];
    if (mode === 'quote_amount') return { ...base, side: 'buy', sizingMode: 'quote_amount', sizingValue: '5000000' };
    return { ...base, side: 'buy', sizingMode: mode, percentBp: 1000 + (i % 5) * 500 };
  }
  // Sells: the account holds no BTC in this harness, so these will mostly skip
  // with a numbered reason — which is itself a valid dry-run outcome to record.
  const mode = ['pct_position', 'sell_all', 'base_quantity'][i % 3];
  if (mode === 'sell_all') return { ...base, side: 'sell', sizingMode: 'sell_all' };
  if (mode === 'base_quantity') return { ...base, side: 'sell', sizingMode: 'base_quantity', sizingValue: '0.01' };
  return { ...base, side: 'sell', sizingMode: 'pct_position', percentBp: 5000 };
}

export async function run(assert) {
  const ctx = await setup('dryrun');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    await ingestMarkets(ctx.db);
    const { groupId } = await seedGroupOfAccounts(ctx, ['5000000', '10000000', '20000000']);

    let planned = 0;
    let skipped = 0;
    let completed = 0;
    let exceptions = 0;

    for (let i = 0; i < RUNS; i += 1) {
      const nowMs = NOW_MS + i * 1_000; // advance the clock deterministically
      const { getOrderBook, calls } = bookProvider();
      const svc = new PlanningService({
        tdb: ctx.tdb, db: ctx.db, getOrderBook, codeVersion: 'dryrun-check',
        now: () => nowMs, dayStartMs: () => DAY_START_MS, newToken: () => `tok-dry-${i}`,
      });

      try {
        const preview = await svc.preview(requestFor(i, groupId));

        // U2 under repetition: the preview equals the persisted plan every time.
        const persisted = await getChildOrders(ctx.tdb, preview.groupTradeId);
        assert(persisted.length === preview.rows.length, `run ${i}: preview/persist row count diverged`);
        const byId = new Map(persisted.map((r) => [r.id, r]));
        for (const pr of preview.rows) {
          const db = byId.get(pr.childOrderId);
          assert(db !== undefined, `run ${i}: preview row has no persisted match`);
          assert(pr.finalQuantity === db.finalQuantity && pr.notionalMinor === db.notionalMinor
            && pr.state === db.state, `run ${i}: a preview row diverged from persistence (U2)`);
        }

        planned += preview.plannedCount;
        skipped += preview.skippedCount;

        // At most one book read per distinct market (buys resolve to BTCINR only).
        assert(calls.length <= 2, `run ${i}: more than two book reads (${calls.length}) — one-per-market violated`);

        // Confirm in dry run: completes, send suppressed, nothing sent.
        await confirmDryRun(ctx.tdb, preview.groupTradeId, preview.previewToken, nowMs + 2_000);
        const trade = await getGroupTrade(ctx.tdb, preview.groupTradeId);
        assert(trade.status === 'completed', `run ${i}: dry-run confirm did not complete the trade`);
        assert(trade.sendSuppressed === true, `run ${i}: the send was not recorded as suppressed`);
        assert(trade.dryRun === true, `run ${i}: the trade was not a dry run`);
        completed += 1;
      } catch (err) {
        exceptions += 1;
        // Surface the first failure with its run index for reproducibility.
        assert(false, `run ${i} threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // ---------------------------------------------------------- rung 0 passed
    assert(exceptions === 0, `${exceptions} of ${RUNS} dry runs threw — rung 0 not passed`);
    assert(completed === RUNS, `only ${completed} of ${RUNS} dry runs completed`);
    // The loop exercised real breadth: both planned and skipped outcomes occurred.
    assert(planned > 0, 'no run produced a planned leg — the mix was not exercised');
    assert(skipped > 0, 'no run produced a skipped leg — the sell-without-holding path never ran');

    // Every group trade for this tenant is completed and suppressed — a final
    // sweep proving nothing was left executing and nothing slipped a send.
    const { rows: agg } = await ctx.pool.query(
      `SELECT status, bool_and(send_suppressed) AS all_suppressed, count(*)::int AS n
       FROM group_trade WHERE tenant_id = $1 GROUP BY status`,
      [TENANT],
    );
    for (const row of agg) {
      assert(row.status === 'completed', `a group trade is in status ${row.status}, expected all completed`);
      assert(row.all_suppressed === true, 'a completed dry-run trade did not have its send suppressed');
    }
    const totalTrades = agg.reduce((sum, r) => sum + r.n, 0);
    assert(totalTrades === RUNS, `expected ${RUNS} group trades on record, found ${totalTrades}`);

    console.log(`     ${RUNS} dry runs: ${planned} planned legs, ${skipped} skipped legs, 0 exceptions, 0 sends`);
  } finally {
    await teardown(ctx);
  }
}
