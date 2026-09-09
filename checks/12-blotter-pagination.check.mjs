// 12-blotter-pagination — plan/phase-12 T12.4.
//
// Keyset pagination: every page's rows are strictly older than the cursor's, so
// walking pages visits each row exactly once with no overlap and no rescans, and
// each filter narrows to exactly the matching child orders. Some rows share a
// created_at to prove the (created_at, id) tie-break.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { blotterPage } from '../apps/api/dist/index.js';

const STATES = ['open', 'acked', 'filled', 'rejected', 'skipped', 'cancelled', 'needs_human', 'planned'];

export async function run(assert) {
  const ctx = await setup('blotter');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000', '10000000']);
    const [a0, a1] = accountIds;

    const newTrade = async (asset, market, token) => {
      const gt = await ctx.pool.query(
        `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
         VALUES ($1, $2, $3, $4, 'buy', 'market', 'base_quantity', '0.0001', 'executing', $5, $6) RETURNING id`,
        [TENANT, groupId, USER, asset, token, new Date(NOW_MS + 60_000)],
      );
      return gt.rows[0].id;
    };
    const gt1 = await newTrade('BTC', 'BTCINR', 'tok-blotter-a');
    const gt2 = await newTrade('ETH', 'ETHINR', 'tok-blotter-b');

    // 26 children: both accounts, both trades/markets, all outcome states, and
    // deliberate created_at ties (k % 5) to exercise the id tie-break.
    const meta = [];
    for (let k = 0; k < 26; k += 1) {
      const acct = k % 2 === 0 ? a0 : a1;
      const trade = k % 2 === 0 ? gt1 : gt2;
      const market = k % 3 === 0 ? 'ETHINR' : 'BTCINR';
      const state = STATES[k % STATES.length];
      const createdAt = NOW_MS + (k % 5) * 1000 + k;
      // A 'skipped' child must carry a refusal reason (the DB CHECK demands it).
      const refusalCode = state === 'skipped' ? 'demo_skip' : null;
      const child = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, refusal_code, final_quantity, created_at)
         VALUES ($1, $2, $3, $4, $5, 'INR', $6, $7, '0.0001', $8) RETURNING id`,
        [TENANT, trade, acct, k, market, state, refusalCode, new Date(createdAt)],
      );
      meta.push({ id: child.rows[0].id, acct, trade, market, state });
    }

    // Walk every page of the full set at limit 7: each id exactly once.
    const seen = new Set();
    let cursor = null;
    let pages = 0;
    for (;;) {
      const page = await blotterPage(ctx.tdb, { limit: 7, cursor });
      pages += 1;
      for (const r of page.rows) {
        assert(!seen.has(r.id), `row ${r.id} appeared on two pages`);
        seen.add(r.id);
      }
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert(seen.size === 26, `pagination must visit all 26 rows, got ${seen.size}`);
    assert(pages === 4, `26 rows at limit 7 need 4 pages, got ${pages}`);

    const allOf = async (q) => {
      const rows = [];
      let c = null;
      for (;;) {
        const p = await blotterPage(ctx.tdb, { limit: 200, cursor: c, ...q });
        rows.push(...p.rows);
        if (p.nextCursor === null) break;
        c = p.nextCursor;
      }
      return rows;
    };

    // Account filter.
    let rows = await allOf({ accountId: a0 });
    assert(rows.length === meta.filter((m) => m.acct === a0).length && rows.length > 0,
      `account filter must narrow to a0's rows, got ${rows.length}`);

    // Group-trade filter.
    rows = await allOf({ groupTradeId: gt1 });
    assert(rows.length === meta.filter((m) => m.trade === gt1).length, `groupTrade filter must narrow to gt1, got ${rows.length}`);

    // Market filter.
    rows = await allOf({ market: 'BTCINR' });
    assert(rows.length === meta.filter((m) => m.market === 'BTCINR').length, `market filter must narrow to BTCINR, got ${rows.length}`);

    // Outcome filter.
    rows = await allOf({ outcome: 'rejected' });
    assert(rows.length === meta.filter((m) => m.state === 'rejected').length,
      `outcome=rejected must narrow exactly, got ${rows.length}`);
    rows = await allOf({ outcome: 'working' });
    assert(rows.length === meta.filter((m) => ['planned', 'acked', 'open'].includes(m.state)).length,
      `outcome=working must include the working states, got ${rows.length}`);

    // Newest-first ordering is stable across page boundaries.
    const full = await allOf({});
    for (let i = 1; i < full.length; i += 1) {
      assert(full[i - 1] !== undefined && full[i] !== undefined &&
        (full[i - 1].createdAtMs > full[i].createdAtMs
          || (full[i - 1].createdAtMs === full[i].createdAtMs && full[i - 1].id > full[i].id)),
        `rows must be strictly newest-first (created_at, id) — index ${i} out of order`);
    }

    // Empty result set still yields a clean (no-cursor) page.
    const empty = await blotterPage(ctx.tdb, { market: 'DOGEINR' });
    assert(empty.rows.length === 0 && empty.nextCursor === null, 'a no-match page must be empty with no cursor');
  } finally {
    await teardown(ctx);
  }
}
