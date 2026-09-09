// 07-loop-d — plan/phase-07 T07.5/T07.7.
//
// The ledger WRITER is idempotent (re-ingesting a page adds zero rows and does
// not inflate market_seen), and Loop D catches outside activity without touching
// cost basis: a manual deposit the books know nothing about shows up as
// UNEXPLAINED and badges the account `approximate`.

import { NOW_MS, TENANT, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { reconcileBalances, recordFill } from '../packages/db/dist/index.js';

export async function run(assert) {
  const ctx = await setup('loopd');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    const { accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const accountId = accountIds[0];

    const fill = {
      accountId, exchangeTradeId: 'f1', side: 'buy', asset: 'BTC', quote: 'INR',
      qty: '0.1', price: '8000000', feeMinor: '0', market: 'BTCINR',
      occurredAtMs: NOW_MS + 5000,
    };

    // ---- the writer is idempotent, and market_seen bumps once per NEW fill ----
    const first = await recordFill(ctx.tdb, fill);
    assert(first.inserted === true && first.rows === 3, `an INR buy must insert 3 rows, got ${JSON.stringify(first)}`);

    const ledgerCount = async () => {
      const r = await ctx.pool.query('SELECT count(*)::int n FROM ledger_entry WHERE account_id = $1 AND exchange_trade_id = $2', [accountId, 'f1']);
      return r.rows[0].n;
    };
    assert(await ledgerCount() === 3, 'exactly 3 ledger rows after one ingest');

    const second = await recordFill(ctx.tdb, fill); // re-ingest the same page
    assert(second.inserted === false, 're-ingesting the same fill must insert nothing');
    assert(await ledgerCount() === 3, 're-ingesting must add zero rows (L4)');

    const seen = async () => {
      const r = await ctx.pool.query('SELECT fill_count n, last_fill_at l FROM account_market_seen WHERE account_id = $1 AND market = $2', [accountId, 'BTCINR']);
      return r.rows[0];
    };
    const s1 = await seen();
    assert(s1.n === 1, `market_seen must count 1 after one fill, got ${s1.n}`);

    // A genuinely NEW fill (later time) bumps market_seen, not the duplicate above.
    await recordFill(ctx.tdb, { ...fill, exchangeTradeId: 'f2', occurredAtMs: NOW_MS + 9000 });
    const s2 = await seen();
    assert(s2.n === 2, `market_seen must count 2 after a second new fill, got ${s2.n}`);
    assert(new Date(s2.l).getTime() === NOW_MS + 9000, 'last_fill_at must advance to the newest fill');

    // ---- Loop D: a manual deposit the books know nothing about is flagged ----
    // The books hold 0.1 BTC (from f1 + f2 above — wait, two BUY fills = 0.2 held).
    // Make the venue hold MORE than the books (a manual deposit of 0.1):
    const held = await reconcileBalances(ctx.tdb, accountId).then((r) => r.items.find((i) => i.asset === 'BTC'));
    // books: f1 + f2 = 0.2 BTC. venue currently has none → books exceed venue.
    assert(held !== undefined && held.unexplained === true,
      `a books-vs-venue gap must be unexplained, got ${held === undefined ? 'no BTC item' : JSON.stringify(held)}`);

    // Now the classic case: venue reports more than the books (a deposit).
    await ctx.pool.query(
      `INSERT INTO account_balance (tenant_id, account_id, currency, free_minor, locked_minor, scale, observed_at)
       VALUES ($1, $2, 'BTC', $3, '0', 8, $4)
       ON CONFLICT (account_id, currency) DO UPDATE SET free_minor = $3, locked_minor = '0', observed_at = $4`,
      [TENANT, accountId, '30000000', new Date(NOW_MS + 10_000)], // 0.3 BTC at scale 8
    );
    const rec = await reconcileBalances(ctx.tdb, accountId);
    const btc = rec.items.find((i) => i.asset === 'BTC');
    assert(btc !== undefined && btc.unexplained === true, 'a manual deposit must be flagged unexplained');
    assert(rec.approximate === true, 'an unexplained difference must badge the account approximate');
    assert(btc !== undefined && btc.diffMinor === '10000000', `the deposit of 0.1 BTC (1e7 minor @ scale 8) must be the diff, got ${btc?.diffMinor}`);

    // Align the venue with the books → reconciled, not approximate, cost intact.
    await ctx.pool.query(
      `UPDATE account_balance SET free_minor = '20000000', locked_minor = '0' WHERE account_id = $1 AND currency = 'BTC'`,
      [accountId],
    );
    const aligned = await reconcileBalances(ctx.tdb, accountId);
    assert(aligned.approximate === false, 'once venue matches books, nothing is unexplained');
    assert(aligned.items.every((i) => i.unexplained === false), 'no item may be unexplained when the books match the venue');
  } finally {
    await teardown(ctx);
  }
}
