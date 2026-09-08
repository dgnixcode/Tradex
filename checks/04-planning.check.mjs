// 04-planning — plan/phase-04 T04.3, T04.5, T04.10.
//
// The planning stage end to end against a real database: a group trade fans out
// across every enabled account, each producing one child_order row that is
// either `planned` with a concrete legal quantity or `skipped` with a numbered
// reason. This check asserts the three properties the phase's definition of done
// names:
//
//   - a 12-account group plans into exactly 12 rows (T04.3);
//   - every capture-or-lose-forever field is non-null on a planned row, and
//     decision_mid is captured before any sizing (T04.5);
//   - exactly one order-book read happens per distinct market (T04.10) — a
//     12-account single-currency group reads one book, not twelve.
//
// It runs the real PlanningService with the committed order-book fixture injected
// as getOrderBook, so no venue is contacted and — the whole point of the phase —
// nothing is sent.

import {
  DAY_START_MS, NOW_MS, USER, bookProvider, ingestMarkets, seedGroupOfAccounts, setup, teardown,
} from './_plan-harness.mjs';
import { PlanningService, getChildOrders, getGroupTrade } from '../apps/api/dist/index.js';

export async function run(assert) {
  const ctx = await setup('planning');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    await ingestMarkets(ctx.db);
    // Twelve accounts, capitals from Rs 50,000 to Rs 6,00,000 so quantities differ.
    const capitals = Array.from({ length: 12 }, (_, i) => String(5_000_000 + i * 5_000_000));
    const { groupId } = await seedGroupOfAccounts(ctx, capitals);

    const { getOrderBook, calls } = bookProvider();
    const svc = new PlanningService({
      tdb: ctx.tdb, db: ctx.db, getOrderBook, codeVersion: 'phase04-check',
      now: () => NOW_MS, dayStartMs: () => DAY_START_MS,
      newToken: () => 'tok-planning-fixed',
    });

    // A 20% buy of BTC, market order — the owner's worked example, fanned out.
    const result = await svc.preview({
      groupId, createdBy: USER, asset: 'BTC', side: 'buy', orderType: 'market',
      sizingMode: 'pct_allocated', percentBp: 2000,
    });

    // ---------------------------------------------------------- T04.3: 12 rows
    assert(result.rows.length === 12, `a 12-account group should plan 12 rows, got ${result.rows.length}`);
    assert(result.plannedCount + result.skippedCount === 12, 'planned + skipped should equal the member count');
    assert(result.plannedCount >= 1, `expected at least one planned row, got ${result.plannedCount}`);

    const persisted = await getChildOrders(ctx.tdb, result.groupTradeId);
    assert(persisted.length === 12, `12 child_order rows should be persisted, got ${persisted.length}`);

    // Every account appears exactly once — invariant X1 in practice.
    const accountIds = new Set(persisted.map((r) => r.accountId));
    assert(accountIds.size === 12, 'each account should produce exactly one leg (X1)');

    // ------------------------------------------------ T04.10: one book per market
    // Every account funds only in INR, so every account resolves to BTCINR, and
    // the service must read that one book exactly ONCE — not once per account.
    assert(calls.length === 1, `expected exactly one order-book read for a single-currency group, got ${calls.length}`);
    assert(calls[0].quote === 'INR', `the one book read should be the INR market, got ${calls[0].quote}`);

    // ---------------------------------------------- T04.5: capture fields non-null
    const trade = await getGroupTrade(ctx.tdb, result.groupTradeId);
    assert(trade !== null, 'the group trade should be readable');
    assert(trade.decisionMid !== null, 'decision_mid must be captured (T04.5)');
    assert(trade.marketMetaVersion !== null, 'market_meta_version must be captured');
    assert(trade.codeVersion === 'phase04-check', 'code_version must be captured');
    assert(trade.dryRun === true, 'the trade should be a dry run in this phase');

    // decision_mid is a plain decimal — the reference book's mid, computed from
    // the book read that happens BEFORE the per-account sizing loop.
    assert(/^\d+(\.\d+)?$/.test(trade.decisionMid), `decision_mid should be a plain decimal, got ${trade.decisionMid}`);

    // On every PLANNED row, all the per-leg capture fields are non-null.
    let checkedPlanned = 0;
    for (const row of persisted) {
      if (row.state !== 'planned') continue;
      checkedPlanned += 1;
      for (const [field, value] of [
        ['market', row.market], ['quoteCurrency', row.quoteCurrency], ['basisUsed', row.basisUsed],
        ['basisAmountMinor', row.basisAmountMinor], ['priceSource', row.priceSource], ['priceUsed', row.priceUsed],
        ['feeRateAssumed', row.feeRateAssumed], ['tdsRateApplied', row.tdsRateApplied],
        ['rawQuantity', row.rawQuantity], ['finalQuantity', row.finalQuantity], ['notionalMinor', row.notionalMinor],
        ['currencyChoiceReason', row.currencyChoiceReason], ['spreadBp', row.spreadBp],
      ]) {
        assert(value !== null && value !== undefined, `planned row ${row.accountId} has null ${field} — capture-or-lose (T04.5)`);
      }
      // The basis for pct_allocated is the account's allocated capital.
      assert(row.basisUsed === 'allocated', `pct_allocated should record basis 'allocated', got ${row.basisUsed}`);
      // Price source is the book ask for a buy.
      assert(row.priceSource === 'book_ask', `a market buy should price at book_ask, got ${row.priceSource}`);
      // The book timestamp was carried onto the leg.
      assert(row.bookObservedAt !== null, 'the book observation time must be recorded on a planned leg');
    }
    assert(checkedPlanned >= 1, 'expected to verify capture fields on at least one planned row');

    // ---------------------------------------- quantities differ by allocated capital
    // The largest account should get a strictly larger quantity than the smallest,
    // because 20% of more capital buys more BTC (R12: the largest accounts are the
    // ones a percentage sizing stresses).
    const planned = persisted.filter((r) => r.state === 'planned' && r.finalQuantity !== null);
    if (planned.length >= 2) {
      const qtys = planned.map((r) => Number(r.finalQuantity));
      assert(Math.max(...qtys) > Math.min(...qtys), 'a percentage buy should size differently across different capitals');
    }

    // ---------------------------------------- a skipped row (if any) carries numbers
    for (const row of persisted) {
      if (row.state !== 'skipped') continue;
      assert(row.refusalCode !== null, 'a skipped row must carry a refusal code');
      assert(row.refusalDetail !== null && row.refusalDetail.length > 0, 'a skipped row must carry a message');
    }

    // ---------------------------------------- preview token + expiry were stamped
    assert(result.previewToken === 'tok-planning-fixed', 'the preview token should be returned');
    assert(result.previewExpiresAtMs > NOW_MS, 'the preview must expire in the future');
    assert(trade.status === 'previewed', `after preview the trade should be 'previewed', got ${trade.status}`);
  } finally {
    await teardown(ctx);
  }
}
