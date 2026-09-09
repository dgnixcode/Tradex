// 12-badges-labels — plan/phase-12 T12.2/T12.3 (N3/N4/N8).
//
// N3: an account with an unclassified external_adjustment badges EXACTLY M6/M12/M13
// approximate — never more. N4: TDS rows are always flagged estimated. N8: a
// metric with no backing (here M16, no slippage capture) renders "not captured"
// with a reason — never zero, which would read as perfect execution.

import { NOW_MS, TENANT, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { recordFill } from '../packages/db/dist/index.js';
import { fyRangeInclusive } from '../packages/metrics/dist/index.js';
import { analyticsReport } from '../apps/api/dist/index.js';

const buy = (accountId, id, atMs) => ({
  accountId, exchangeTradeId: id, side: 'buy', asset: 'BTC', quote: 'INR',
  qty: '0.1', price: '8000000', feeMinor: '0', market: 'BTCINR', occurredAtMs: atMs,
});
const sell = (accountId, id, atMs) => ({
  accountId, exchangeTradeId: id, side: 'sell', asset: 'BTC', quote: 'INR',
  qty: '0.1', price: '9000000', feeMinor: '0', market: 'BTCINR', occurredAtMs: atMs,
});

export async function run(assert) {
  const ctx = await setup('badges');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    const { accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const a0 = accountIds[0];
    const named = [{ accountId: a0, accountName: 'Acct 1' }];

    // A buy and a sell inside the window (so a realised figure exists to badge),
    // then an UNCLASSIFIED external_adjustment — the approximate trigger.
    await recordFill(ctx.tdb, buy(a0, 'b-b1', NOW_MS + 1000));
    await recordFill(ctx.tdb, sell(a0, 'b-s1', NOW_MS + 2000));
    await ctx.pool.query(
      `INSERT INTO ledger_entry (tenant_id, account_id, kind, asset, quote_asset, delta_minor, scale, occurred_at)
       VALUES ($1, $2, 'external_adjustment', 'BTC', 'INR', '1000', 8, $3)`,
      [TENANT, a0, new Date(NOW_MS + 3000)],
    );

    const fy = fyRangeInclusive(NOW_MS);
    const report = await analyticsReport(ctx.tdb, named, { fromMs: 0, toMs: fy.toMs, label: 'x' });

    assert(report.approximate === true, 'an unclassified adjustment must mark the report approximate');

    // N3 — exactly M6/M12/M13 carry the approximate flag.
    const approx = new Set(report.metrics.filter((m) => m.approximate).map((m) => m.metricId));
    assert(approx.size === 3 && approx.has('M6') && approx.has('M12') && approx.has('M13'),
      `approximate must badge exactly M6/M12/M13, got ${[...approx].join(',')}`);

    // The approximate M6 number is still the fold value (shown as approximate).
    const m6 = report.metrics.find((m) => m.metricId === 'M6' && m.quoteAsset === 'INR');
    assert(m6?.approximate === true && m6?.status === 'ok', 'M6 stays ok but carries the approximate badge');

    // N4 — TDS rows are always estimated.
    const tds = report.fills.filter((f) => f.kind === 'tds');
    assert(tds.length > 0, 'the INR sell must emit a TDS row');
    assert(tds.every((f) => f.estimated === true), 'every TDS row must be flagged estimated');

    // N8 — a metric with no backing is not_captured with a reason, never zero.
    const m16 = report.metrics.find((m) => m.metricId === 'M16');
    assert(m16?.status === 'not_captured' && m16.value === null && (m16.reason ?? '') !== '',
      'M16 must be not captured (never 0.00%) when no decision-mid slippage is captured');

    // The adjustment itself is visible in the journal, not silently absorbed.
    assert(report.fills.some((f) => f.kind === 'external_adjustment'), 'the unclassified adjustment must appear in the journal');
  } finally {
    await teardown(ctx);
  }
}
