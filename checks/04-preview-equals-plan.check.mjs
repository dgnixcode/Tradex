// 04-preview-equals-plan — plan/phase-04 T04.6 and invariant U2.
//
// U2 is the promise the confirmation screen depends on: the rows the customer is
// shown in the preview are EXACTLY the rows persisted as child_order, field for
// field. If they can diverge, the customer approves one thing and the system
// would send another — the single most dangerous class of bug in a trading UI.
// This check reads the preview payload and the persisted rows independently and
// asserts they agree on every field that appears in both.
//
// It also covers T04.6's token lifecycle:
//   - a fresh preview returns a token and a future expiry;
//   - the countdown the UI would show (expiry − now) matches the server's stored
//     preview_expires_at;
//   - confirming with a WRONG token is refused;
//   - confirming an EXPIRED preview is refused server-side regardless of what the
//     client believed the countdown said;
//   - confirming a valid, unexpired preview succeeds (dry-run) and marks the
//     trade completed with the send suppressed.

import {
  DAY_START_MS, NOW_MS, USER, bookProvider, ingestMarkets, seedGroupOfAccounts, setup, teardown,
} from './_plan-harness.mjs';
import {
  PlanningService, PREVIEW_TTL_MS, confirmDryRun, getChildOrders, getGroupTrade,
} from '../apps/api/dist/index.js';

export async function run(assert) {
  const ctx = await setup('preview');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    await ingestMarkets(ctx.db);
    // Five accounts of differing capital → differing quantities, so the row-by-row
    // comparison is meaningful rather than five identical rows.
    const capitals = ['5000000', '10000000', '20000000', '40000000', '60000000'];
    const { groupId } = await seedGroupOfAccounts(ctx, capitals);

    const { getOrderBook } = bookProvider();
    const svc = new PlanningService({
      tdb: ctx.tdb, db: ctx.db, getOrderBook, codeVersion: 'preview-check',
      now: () => NOW_MS, dayStartMs: () => DAY_START_MS, newToken: () => 'tok-preview-fixed',
    });

    const preview = await svc.preview({
      groupId, createdBy: USER, asset: 'BTC', side: 'buy', orderType: 'market',
      sizingMode: 'pct_allocated', percentBp: 2000,
    });

    // ------------------------------------------------------------ U2: row-for-row
    const persisted = await getChildOrders(ctx.tdb, preview.groupTradeId);
    assert(preview.rows.length === persisted.length,
      `preview has ${preview.rows.length} rows, persistence has ${persisted.length} — U2 violated`);

    // Index persisted rows by child order id; the preview carries that id.
    const byId = new Map(persisted.map((r) => [r.id, r]));
    for (const pr of preview.rows) {
      const db = byId.get(pr.childOrderId);
      assert(db !== undefined, `preview row ${pr.childOrderId} has no matching persisted row (U2)`);
      // Every field that appears in both must be identical.
      assert(pr.accountId === db.accountId, `U2: accountId mismatch for ${pr.childOrderId}`);
      assert(pr.state === db.state, `U2: state mismatch for ${pr.childOrderId} (${pr.state} vs ${db.state})`);
      assert(pr.market === db.market, `U2: market mismatch for ${pr.childOrderId}`);
      assert(pr.quoteCurrency === db.quoteCurrency, `U2: quoteCurrency mismatch for ${pr.childOrderId}`);
      assert(pr.finalQuantity === db.finalQuantity, `U2: finalQuantity mismatch for ${pr.childOrderId}`);
      assert(pr.priceUsed === db.priceUsed, `U2: priceUsed mismatch for ${pr.childOrderId}`);
      assert(pr.notionalMinor === db.notionalMinor, `U2: notionalMinor mismatch for ${pr.childOrderId}`);
      assert(pr.basisUsed === db.basisUsed, `U2: basisUsed mismatch for ${pr.childOrderId}`);
      assert(pr.basisAmountMinor === db.basisAmountMinor, `U2: basisAmountMinor mismatch for ${pr.childOrderId}`);
      assert(pr.refusalCode === db.refusalCode, `U2: refusalCode mismatch for ${pr.childOrderId}`);
      assert(pr.refusalDetail === db.refusalDetail, `U2: refusalDetail mismatch for ${pr.childOrderId}`);
    }

    // The preview must cover every persisted row (no row omitted from the screen).
    const previewIds = new Set(preview.rows.map((r) => r.childOrderId));
    for (const db of persisted) {
      assert(previewIds.has(db.id), `persisted row ${db.id} is missing from the preview (U2)`);
    }

    // ------------------------------------------------------------ T04.6: countdown
    assert(preview.previewToken === 'tok-preview-fixed', 'the preview token should be returned');
    // The countdown the UI shows is expiry − now; it must equal the TTL and match
    // the server's stored expiry exactly.
    assert(preview.previewExpiresAtMs === NOW_MS + PREVIEW_TTL_MS,
      `the expiry should be now + TTL (${NOW_MS + PREVIEW_TTL_MS}), got ${preview.previewExpiresAtMs}`);
    const trade = await getGroupTrade(ctx.tdb, preview.groupTradeId);
    assert(trade.previewExpiresAt !== null && trade.previewExpiresAt.getTime() === preview.previewExpiresAtMs,
      'the server-stored expiry must match the value handed to the client (the countdown cannot drift)');

    // ------------------------------------------------------------ T04.6: wrong token
    let wrongTokenRefused = false;
    try {
      await confirmDryRun(ctx.tdb, preview.groupTradeId, 'not-the-token', NOW_MS + 1_000);
    } catch (e) {
      wrongTokenRefused = e.reason === 'token_mismatch';
    }
    assert(wrongTokenRefused, 'confirming with the wrong token must be refused');

    // ------------------------------------------------------------ T04.6: expired
    let expiredRefused = false;
    try {
      // One millisecond past the expiry — the client might still think it is live.
      await confirmDryRun(ctx.tdb, preview.groupTradeId, preview.previewToken, preview.previewExpiresAtMs + 1);
    } catch (e) {
      expiredRefused = e.reason === 'token_expired';
    }
    assert(expiredRefused, 'confirming an expired preview must be refused server-side');
    // The trade must NOT have completed on an expired confirm.
    const afterExpired = await getGroupTrade(ctx.tdb, preview.groupTradeId);
    assert(afterExpired.status === 'previewed', `an expired confirm must leave the trade previewed, got ${afterExpired.status}`);

    // ------------------------------------------------------------ T04.6/T04.9: valid confirm
    await confirmDryRun(ctx.tdb, preview.groupTradeId, preview.previewToken, NOW_MS + 5_000);
    const afterConfirm = await getGroupTrade(ctx.tdb, preview.groupTradeId);
    assert(afterConfirm.status === 'completed', `a valid confirm should complete the trade, got ${afterConfirm.status}`);
    assert(afterConfirm.sendSuppressed === true, 'a dry-run confirm must record that the send was suppressed');
    assert(afterConfirm.completedAt !== null, 'a completed trade must carry a completion time');

    // A second confirm of an already-completed trade is refused.
    let doubleConfirmRefused = false;
    try {
      await confirmDryRun(ctx.tdb, preview.groupTradeId, preview.previewToken, NOW_MS + 6_000);
    } catch (e) {
      doubleConfirmRefused = e.reason === 'already_completed';
    }
    assert(doubleConfirmRefused, 'confirming an already-completed trade must be refused');

    // The persisted rows are unchanged by confirm — the plan the customer saw is
    // the plan on record (U2 holds after confirmation too).
    const afterRows = await getChildOrders(ctx.tdb, preview.groupTradeId);
    assert(afterRows.length === persisted.length, 'confirm must not add or remove child rows');
  } finally {
    await teardown(ctx);
  }
}
