// 07-invariant — plan/phase-07 T07.8 (the periodic invariant check).
//
// The `holding` projection is trustworthy only while it equals a fresh fold of
// the ledger. This proves the rebuild writes exactly the fold, the verify is
// silent when they agree, and a deliberate corruption FAILS LOUDLY with the asset
// and field named — so the scheduled job can alarm rather than trust a bad row.

import { NOW_MS, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { rebuildHoldings, recordFill, verifyHoldings } from '../packages/db/dist/index.js';

export async function run(assert) {
  const ctx = await setup('invariant');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    const { accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const accountId = accountIds[0];

    const buy = (id, atMs) => ({
      accountId, exchangeTradeId: id, side: 'buy', asset: 'BTC', quote: 'INR',
      qty: '0.1', price: '8000000', feeMinor: '0', market: 'BTCINR', occurredAtMs: atMs,
    });

    // Two buys → the books hold 0.2 BTC. Rebuild writes exactly the fold.
    await recordFill(ctx.tdb, buy('f1', NOW_MS + 5000));
    await recordFill(ctx.tdb, buy('f2', NOW_MS + 9000));
    const projection = await rebuildHoldings(ctx.tdb, accountId);
    const btc = projection.find((h) => h.asset === 'BTC');
    assert(btc !== undefined && btc.qty === '0.2', `rebuild must project 0.2 BTC, got ${btc?.qty}`);
    assert(btc !== undefined && btc.costTotalMinor === '160000000', `cost must be 2 buys of 800,000 INR, got ${btc?.costTotalMinor}`);

    const stored = await ctx.pool.query('SELECT qty, cost_total_minor FROM holding WHERE account_id = $1 AND asset = $2', [accountId, 'BTC']);
    assert(stored.rows.length === 1 && stored.rows[0].qty === '0.2' && stored.rows[0].cost_total_minor === '160000000',
      'the rebuild must have written the projection into holding');

    // A fresh verify against an uncorrupted projection is SILENT.
    const ok1 = await verifyHoldings(ctx.tdb, accountId);
    assert(ok1.ok === true, `an uncorrupted projection must verify clean, got ${JSON.stringify(ok1.violations)}`);

    // DELIBERATELY corrupt a projection row — the check must fail loudly (L2).
    await ctx.pool.query("UPDATE holding SET cost_total_minor = '1' WHERE account_id = $1 AND asset = 'BTC'", [accountId]);
    const bad = await verifyHoldings(ctx.tdb, accountId);
    assert(bad.ok === false, 'a corrupted projection must fail the invariant check');
    assert(bad.violations.some((v) => v.asset === 'BTC' && v.field === 'cost_total_minor'),
      `the violation must name the asset and field, got ${JSON.stringify(bad.violations)}`);

    // The ledger is still the source of truth: a REBUILD repairs the corruption.
    await rebuildHoldings(ctx.tdb, accountId);
    const repaired = await verifyHoldings(ctx.tdb, accountId);
    assert(repaired.ok === true, 'rebuilding from the ledger must repair a corrupted projection');

    // A projection STALE versus the ledger also fails (a fill arrived, no rebuild yet).
    await recordFill(ctx.tdb, buy('f3', NOW_MS + 13_000)); // ledger now holds 0.3 BTC
    const stale = await verifyHoldings(ctx.tdb, accountId);
    assert(stale.ok === false, 'a projection behind the ledger must fail until rebuilt');
    await rebuildHoldings(ctx.tdb, accountId);
    assert((await verifyHoldings(ctx.tdb, accountId)).ok === true, 'after rebuild the projection is clean again');
  } finally {
    await teardown(ctx);
  }
}
