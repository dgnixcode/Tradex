// 05-daily-cap-ist — plan/phase-05 T05.2, the daily window must be an IST day.
//
// The per-tenant daily cap is computed over IST calendar days from
// child_order.notional_minor. IST is UTC+5:30 with no DST, so between 18:30 UTC
// and 24:00 UTC the IST calendar date is ALREADY the next day. That is the seam
// this check probes: two orders minutes apart on the SAME UTC date can fall in
// DIFFERENT IST days, and the cap must treat them that way.
//
//   B = 2026-09-07 18:00 UTC  → IST 2026-09-07 23:30  (IST day 7)
//   A = 2026-09-07 22:00 UTC  → IST 2026-09-08 03:30  (IST day 8)
//
// Both are on UTC date 07. A UTC-based window (since 00:00 UTC 07) would count
// both; the IST window (since 18:30 UTC 07 = IST midnight) must count only A.
// IST midnight is computed with the same 5h30 offset the production planner
// uses, so the two cannot drift apart.

import { TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { dailySpentMinor } from '../packages/db/dist/index.js';

const IST_OFFSET_MS = (5 * 60 + 30) * 60_000;
/** IST midnight on 2026-09-08 = 18:30 UTC on 2026-09-07. */
const IST_DAY_START = Date.UTC(2026, 8, 7, 18, 30, 0);
/** UTC midnight on the SAME UTC date (2026-09-07) — what a wrong UTC window would use. */
const UTC_DAY_START = Date.UTC(2026, 8, 7, 0, 0, 0);

let legSeq = 0;
async function insertOrder(ctx, groupTradeId, accountId, atMs, notionalMinor, state) {
  legSeq += 1;
  await ctx.pool.query(
    `INSERT INTO child_order
       (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, notional_minor, created_at)
     VALUES ($1, $2, $3, $4, 'BTCINR', 'INR', $5, $6, $7)`,
    [TENANT, groupTradeId, accountId, legSeq, state, notionalMinor, new Date(atMs)],
  );
}

export async function run(assert) {
  // The premise: IST and UTC day starts genuinely differ for this date, so the
  // test is not vacuous.
  assert(IST_DAY_START !== UTC_DAY_START, 'IST and UTC day starts coincide — the premise is broken');
  assert(IST_DAY_START + IST_OFFSET_MS === Date.UTC(2026, 8, 8, 0, 0, 0),
    'the IST offset here does not land on a real IST midnight — the window math would be wrong');

  const ctx = await setup('dailcap');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    const { accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const accountId = accountIds[0];
    const group = await ctx.pool.query('SELECT group_id FROM group_member WHERE tenant_id = $1 LIMIT 1', [TENANT]);
    const groupId = group.rows[0].group_id;
    const { rows: gt } = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'pct_allocated', '2000') RETURNING id`,
      [TENANT, groupId, USER],
    );
    const tradeId = gt[0].id;

    // B and A are both on UTC date 07 but different IST days. The skip is inside
    // today's IST window and must never count toward the cap.
    await insertOrder(ctx, tradeId, accountId, Date.UTC(2026, 8, 7, 18, 0, 0), '500000', 'planned');  // IST day 7
    await insertOrder(ctx, tradeId, accountId, Date.UTC(2026, 8, 7, 22, 0, 0), '500000', 'planned');  // IST day 8
    await insertOrder(ctx, tradeId, accountId, Date.UTC(2026, 8, 7, 22, 1, 0), '900000', 'not_placed'); // excluded

    const istWindow = await dailySpentMinor(ctx.tdb, accountId, 'INR', IST_DAY_START);
    assert(istWindow === '500000',
      `the IST window counted ${istWindow}, expected 500000 — only the order after IST midnight, not the one on IST yesterday, and not the skip`);

    const utcWindow = await dailySpentMinor(ctx.tdb, accountId, 'INR', UTC_DAY_START);
    assert(utcWindow === '1000000',
      `a UTC window would count both same-UTC-date orders (${utcWindow}); the IST window differing proves the cap is IST, not UTC`);

    // The boundary seam: 1s before IST midnight is excluded, 1s after is included.
    await insertOrder(ctx, tradeId, accountId, IST_DAY_START - 1000, '100', 'planned');
    await insertOrder(ctx, tradeId, accountId, IST_DAY_START + 1000, '200', 'planned');
    const atSeam = await dailySpentMinor(ctx.tdb, accountId, 'INR', IST_DAY_START);
    assert(atSeam === '500200',
      `the seam is wrong: an order 1s before IST midnight leaked in (expected 500200, got ${atSeam})`);
  } finally {
    await teardown(ctx);
  }
}
