// 12-report-reproducibility — plan/phase-12 T12.6 (N5/L10): re-running a window
// returns identical numbers, the realised total equals a two-prefix fold of the
// ledger, the CSV round-trips the fills, and the Indian-FY window is respected.

import { NOW_MS, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { recordFill } from '../packages/db/dist/index.js';
import { fyRangeInclusive } from '../packages/metrics/dist/index.js';
import { analyticsReport, reportToCsv } from '../apps/api/dist/index.js';

const DAY = 86_400_000;

const buy = (accountId, id, qty, atMs) => ({
  accountId, exchangeTradeId: id, side: 'buy', asset: 'BTC', quote: 'INR',
  qty, price: '8000000', feeMinor: '0', market: 'BTCINR', occurredAtMs: atMs,
});
const sell = (accountId, id, qty, atMs) => ({
  accountId, exchangeTradeId: id, side: 'sell', asset: 'BTC', quote: 'INR',
  qty, price: '9000000', feeMinor: '0', market: 'BTCINR', occurredAtMs: atMs,
});

export async function run(assert) {
  const ctx = await setup('repro');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    const { accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const a0 = accountIds[0];
    const named = [{ accountId: a0, accountName: 'Acct 1' }];

    // The current Indian FY, in this schema's clock.
    const fy = fyRangeInclusive(NOW_MS);

    // A buy BEFORE the FY (cost basis established outside the window) then a buy
    // and a sell inside it: realised = proceeds 90,000,000 − costOut 80,000,000
    // = 10,000,000 paise, with a pre-window holding that must not leak in.
    await recordFill(ctx.tdb, buy(a0, 'r-pre', '0.1', fy.fromMs - 20 * DAY));
    await recordFill(ctx.tdb, buy(a0, 'r-b1', '0.1', fy.fromMs + 60 * DAY));
    await recordFill(ctx.tdb, sell(a0, 'r-s1', '0.1', fy.fromMs + 70 * DAY));

    const win = { fromMs: fy.fromMs, toMs: fy.toMs, label: fy.label };
    const first = await analyticsReport(ctx.tdb, named, win);

    const inr = first.totals.find((t) => t.quoteAsset === 'INR');
    assert(inr?.realised === '10000000',
      `realised over the FY must be the two-prefix fold result ₹10,000,000 (paise), got ${inr?.realised}`);
    assert(inr !== undefined && BigInt(inr.tds) > 0n, 'a sell in INR carries estimated TDS in the totals');
    assert(inr?.feeDrag === '0', 'a zero-fee sell has zero fee drag');

    // N5/L10 — re-running the same window is byte-identical.
    const second = await analyticsReport(ctx.tdb, named, win);
    assert(JSON.stringify(first.totals) === JSON.stringify(second.totals), 're-running a window must return identical totals');
    assert(first.fills.length === second.fills.length && first.fills.length > 0,
      `re-running must return the same fills, got ${first.fills.length}/${second.fills.length}`);

    // The in-window journal is the fills + fees + TDS.
    const sells = first.fills.filter((f) => f.kind === 'trade_sell');
    assert(sells.length === 1 && sells[0]?.price === '9000000', 'the in-window sell fill must appear with its price');
    assert(first.fills.some((f) => f.kind === 'tds' && f.estimated === true), 'TDS rows are always flagged estimated');

    // CSV round-trips: header, a totals comment, a quoted fill row with the price.
    const csv = reportToCsv(first);
    assert(csv.includes('occurred_at,account,kind'), 'CSV must have the fill header row');
    assert(/trade_sell/.test(csv) && /9000000/.test(csv), 'CSV must contain the sell fill and its price');
    assert(csv.includes('10,000,000') === false, 'CSV keeps minor units machine-readable, not formatted');

    // A window that excludes the sell but includes the buy realises nothing.
    const partial = await analyticsReport(ctx.tdb, named, { fromMs: fy.fromMs, toMs: fy.fromMs + 65 * DAY, label: 'partial' });
    assert(partial.totals.find((t) => t.quoteAsset === 'INR')?.realised === '0',
      'a window ending before the sell must show zero realised — the buy added cost, not P&L');
  } finally {
    await teardown(ctx);
  }
}
