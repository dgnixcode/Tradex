// 08-fairness — plan/phase-08 T08.2.
//
// A 100-account fan-out must not starve another tenant's 2-account trade. The
// GLOBAL claim is a single FIFO by run_after, so a big tenant that queued first
// eats every slot. claimJobsFair cycles tenants one share at a time; this proves
// the small tenant's job is claimed in the same first batch, while the global
// claim would have starved it.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { claimJobs, claimJobsFair } from '../packages/db/dist/index.js';

const T2 = '77777777-7777-7777-7777-777777777777';

export async function run(assert) {
  const ctx = await setup('fairness');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    // Tenant A (the harness tenant) gets SIX older jobs after its seed.
    const seedA = await seedGroupOfAccounts(ctx, ['10000000']);
    const acctA = seedA.accountIds[0];
    const groupA = seedA.groupId;

    // A second tenant with the minimal rows a child_order needs.
    await ctx.pool.query("INSERT INTO tenant (id, name) VALUES ($1, 'T2')", [T2]);
    await ctx.pool.query('INSERT INTO tenant_limit (tenant_id) VALUES ($1)', [T2]);
    await ctx.pool.query("INSERT INTO app_user (id, tenant_id, email, password_hash, role) VALUES ('88888888-8888-8888-8888-888888888888', $1, 't2@x.example', 'x', 'owner')", [T2]);
    await ctx.pool.query("INSERT INTO account_group (id, tenant_id, name, created_by) VALUES ('99999999-9999-9999-9999-999999999999', $1, 'G2', '88888888-8888-8888-8888-888888888888')", [T2]);
    await ctx.pool.query("INSERT INTO exchange_account (id, tenant_id, name, allocated_capital_minor, allocated_currency, status) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', $1, 'A2', '10000000', 'INR', 'active')", [T2]);
    await ctx.pool.query("INSERT INTO group_member (tenant_id, group_id, account_id) VALUES ($1, '99999999-9999-9999-9999-999999999999', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')", [T2]);
    const gt = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
       VALUES ($1, '99999999-9999-9999-9999-999999999999', '88888888-8888-8888-8888-888888888888', 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'previewed', 'tok-t2', $2) RETURNING id`,
      [T2, new Date(NOW_MS + 60_000)],
    );
    const tradeId = gt.rows[0].id;
    // Tenant B: TWO planned children, jobs due NOW (later than tenant A's).
    for (let i = 0; i < 2; i += 1) {
      const child = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, state)
         VALUES ($1, $2, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', $3, 'BTCINR', 'planned') RETURNING id`,
        [T2, tradeId, i + 1],
      );
      await ctx.pool.query(
        `INSERT INTO execution_job (child_order_id, tenant_id, kind, run_after) VALUES ($1, $2, 'place', $3)`,
        [child.rows[0].id, T2, new Date(NOW_MS)],
      );
    }

    // Tenant A (the harness tenant) gets SIX jobs, ALL older (so the global FIFO
    // would take them first and starve B).
    const { rows: gtA } = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'previewed', 'tok-a', $4) RETURNING id`,
      [TENANT, groupA, USER, new Date(NOW_MS + 60_000)],
    );
    for (let i = 0; i < 6; i += 1) {
      const child = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, state)
         VALUES ($1, $2, $3, $4, 'BTCINR', 'planned') RETURNING id`,
        [TENANT, gtA[0].id, acctA, i + 1],
      );
      await ctx.pool.query(
        `INSERT INTO execution_job (child_order_id, tenant_id, kind, run_after) VALUES ($1, $2, 'place', $3)`,
        [child.rows[0].id, TENANT, new Date(NOW_MS - 5000)], // older → global FIFO starves B
      );
    }

    // The GLOBAL claim of 3 takes only A's (B is starved).
    const starved = await claimJobs(ctx.db, 'global-w', { limit: 3, now: new Date(NOW_MS) });
    assert(starved.length === 3 && starved.every((j) => j.tenantId === TENANT),
      'the global FIFO claim of 3 must take only the older tenant A (starving B)');

    // The FAIR claim of 3 must include tenant B within the first batch.
    const fair = await claimJobsFair(ctx.db, 'fair-w', { limit: 3, now: new Date(NOW_MS) });
    const hasB = fair.some((j) => j.tenantId === T2);
    assert(fair.length === 3, `the fair claim should still fill its limit, got ${fair.length}`);
    assert(hasB, 'the fair claim must include the small tenant B in the same batch — not starved');

    // And the small tenant's job is taken in B's first turn (a bounded delay).
    const again = await claimJobsFair(ctx.db, 'fair-w2', { limit: 3, now: new Date(NOW_MS) });
    const bStill = await ctx.pool.query("SELECT count(*)::int n FROM execution_job WHERE tenant_id = $1 AND locked_by IS NULL", [T2]);
    assert(bStill.rows[0].n <= 0, 'after two fair batches the small tenant must be fully drained');

    void again;
  } finally {
    await teardown(ctx);
  }
}
