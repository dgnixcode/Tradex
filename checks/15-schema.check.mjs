// 15-schema — plan/phase-15 foundation.
//
// The migration 014 additions to group_trade and child_order, and the two new
// tables futures_position and futures_execution_lock, must enforce their
// invariants at the SCHEMA level: no runtime code path can compensate for a
// column that could silently accept a bad value. The load-bearing invariants:
//   (i)   is_futures=true requires leverage + margin_currency + position_margin_type
//   (ii)  crossed margin only on USDT-margined
//   (iii) reduce_only only when is_futures=true
//   (iv)  leg_kind: entry has no linked_entry; SL/TP MUST have one
//   (v)   trigger_state only meaningful on SL/TP legs
//   (vi)  order_type accepts the six futures types; state accepts the four new
//   (vii) the two new tables are tenant-scoped (00-tenant-isolation still green)

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { TENANT_SCOPED_TABLES } from '../packages/db/dist/index.js';

export async function run(assert) {
  // (vii) The two new tables are listed as tenant-scoped in the DB schema.
  assert(TENANT_SCOPED_TABLES.includes('futures_position'),
    'futures_position must be in TENANT_SCOPED_TABLES — else a builder could read cross-tenant');
  assert(TENANT_SCOPED_TABLES.includes('futures_execution_lock'),
    'futures_execution_lock must be in TENANT_SCOPED_TABLES');

  const ctx = await setup('fut15');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  try {
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000']);
    const a0 = accountIds[0];

    let tokenSeq = 0;
    const insertGT = async (cols) => {
      tokenSeq += 1;
      const c = {
        tenant_id: TENANT, group_id: groupId, created_by: USER,
        asset: 'BTC', side: 'buy', order_type: 'market',
        sizing_mode: 'base_quantity', sizing_value: '0.0001',
        status: 'previewed', preview_token: `tok-15-${tokenSeq}`,
        preview_expires_at: new Date(NOW_MS + 60_000),
        is_futures: false, leverage: null, margin_currency: null,
        position_margin_type: null, stop_loss_price: null, take_profit_price: null,
        reduce_only: false, ...cols,
      };
      const keys = Object.keys(c);
      const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
      return ctx.pool.query(
        `INSERT INTO group_trade (${keys.join(', ')}) VALUES (${vals}) RETURNING id, is_futures, leverage, margin_currency, position_margin_type, reduce_only`,
        keys.map((k) => c[k]),
      );
    };

    // (vi) Widened order_type CHECK accepts every futures type.
    for (const ot of ['stop_market', 'stop_limit', 'take_profit_market', 'take_profit_limit']) {
      const needsPrice = ot === 'stop_limit' || ot === 'take_profit_limit';
      const r = await insertGT({
        order_type: ot,
        limit_price: needsPrice ? '8000000' : null,
        is_futures: true, leverage: '5', margin_currency: 'USDT', position_margin_type: 'isolated',
      });
      assert(r.rows[0].id !== undefined, `order_type '${ot}' must be legal`);
    }
    // And a spot row still lands unchanged.
    const spotRow = await insertGT({ order_type: 'market' });
    assert(spotRow.rows[0].is_futures === false && spotRow.rows[0].leverage === null,
      'a spot row defaults is_futures=false, leverage=null');

    // (i) is_futures=true without leverage/margin_currency/position_margin_type is refused.
    for (const missing of ['leverage', 'margin_currency', 'position_margin_type']) {
      const base = {
        is_futures: true, leverage: '5', margin_currency: 'USDT', position_margin_type: 'isolated',
      };
      base[missing] = null;
      let raised = false;
      try { await insertGT(base); } catch (e) {
        raised = true;
        assert(/futures_required_fields/.test(String(e.message)),
          `missing ${missing} must trip group_trade_futures_required_fields, got ${e.message}`);
      }
      assert(raised, `is_futures=true without ${missing} must be refused`);
    }

    // (ii) crossed margin on INR is refused.
    let crossInrRaised = false;
    try {
      await insertGT({
        is_futures: true, leverage: '5', margin_currency: 'INR', position_margin_type: 'crossed',
      });
    } catch (e) {
      crossInrRaised = true;
      assert(/cross_margin_usdt_only/.test(String(e.message)),
        `INR + crossed must trip group_trade_cross_margin_usdt_only, got ${e.message}`);
    }
    assert(crossInrRaised, 'crossed margin on INR must be refused');
    // Crossed on USDT is legal.
    const crossOk = await insertGT({
      is_futures: true, leverage: '5', margin_currency: 'USDT', position_margin_type: 'crossed',
    });
    assert(crossOk.rows[0].position_margin_type === 'crossed', 'crossed on USDT is legal');

    // (iii) reduce_only on a spot row (is_futures=false) is refused.
    let reduceOnlySpotRaised = false;
    try { await insertGT({ reduce_only: true, is_futures: false }); } catch (e) {
      reduceOnlySpotRaised = true;
      assert(/reduce_only_only_when_futures/.test(String(e.message)),
        `spot reduce_only must trip reduce_only_only_when_futures, got ${e.message}`);
    }
    assert(reduceOnlySpotRaised, 'reduce_only on a spot row must be refused');

    // ---- child_order: leg_kind + linked_entry + trigger_state + new states ----
    const gtFutures = await insertGT({
      is_futures: true, leverage: '5', margin_currency: 'USDT', position_margin_type: 'isolated',
    });
    const entry = await ctx.pool.query(
      `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
       VALUES ($1, $2, $3, 1, 'BTCUSDT', 'USDT', 'planned', '0.0001') RETURNING id`,
      [TENANT, gtFutures.rows[0].id, a0],
    );
    const entryId = entry.rows[0].id;

    // (iv) An entry MUST NOT carry linked_entry_child_order_id.
    let entryLinkRaised = false;
    try {
      await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity, leg_kind, linked_entry_child_order_id)
         VALUES ($1, $2, $3, 2, 'BTCUSDT', 'USDT', 'planned', '0.0001', 'entry', $4)`,
        [TENANT, gtFutures.rows[0].id, a0, entryId],
      );
    } catch (e) {
      entryLinkRaised = true;
      assert(/child_order_conditional_links/.test(String(e.message)),
        `entry with linked_entry must trip child_order_conditional_links, got ${e.message}`);
    }
    assert(entryLinkRaised, 'an entry leg must not link to another entry');

    // (iv) SL/TP MUST carry linked_entry_child_order_id.
    let slNoLinkRaised = false;
    try {
      await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity, leg_kind)
         VALUES ($1, $2, $3, 3, 'BTCUSDT', 'USDT', 'untriggered', '0.0001', 'stop_loss')`,
        [TENANT, gtFutures.rows[0].id, a0],
      );
    } catch (e) {
      slNoLinkRaised = true;
      assert(/child_order_conditional_links/.test(String(e.message)),
        `SL without linked_entry must trip child_order_conditional_links, got ${e.message}`);
    }
    assert(slNoLinkRaised, 'a stop_loss leg must link to its entry');

    // (vi) The new states accept a linked SL row.
    const slInsert = await ctx.pool.query(
      `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity, leg_kind, linked_entry_child_order_id, trigger_state)
       VALUES ($1, $2, $3, 4, 'BTCUSDT', 'USDT', 'untriggered', '0.0001', 'stop_loss', $4, 'untriggered') RETURNING id`,
      [TENANT, gtFutures.rows[0].id, a0, entryId],
    );
    assert(slInsert.rows[0].id !== undefined, "state='untriggered' with leg_kind='stop_loss' + linked entry is legal");

    let stateLeg = 10;
    for (const st of ['sl_hit', 'tp_hit', 'liquidated']) {
      stateLeg += 1;
      const r = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity, leg_kind, linked_entry_child_order_id)
         VALUES ($1, $2, $3, $4, 'BTCUSDT', 'USDT', $5, '0.0001', 'take_profit', $6) RETURNING id`,
        [TENANT, gtFutures.rows[0].id, a0, stateLeg, st, entryId],
      );
      assert(r.rows[0].id !== undefined, `state='${st}' must be accepted`);
    }

    // (v) trigger_state on an entry leg is refused.
    let entryTriggerRaised = false;
    try {
      await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity, leg_kind, trigger_state)
         VALUES ($1, $2, $3, DEFAULT, 'BTCUSDT', 'USDT', 'planned', '0.0001', 'entry', 'untriggered')`,
        [TENANT, gtFutures.rows[0].id, a0],
      );
    } catch (e) {
      entryTriggerRaised = true;
      assert(/trigger_state_only_for_conditional/.test(String(e.message)),
        `entry with trigger_state must trip trigger_state_only_for_conditional, got ${e.message}`);
    }
    assert(entryTriggerRaised, 'trigger_state on an entry leg must be refused');

    // ---- futures_position: unique per (tenant, venue_position_id) and per (tenant, account, pair, margin) ----
    const insertPos = async (over = {}) => {
      const c = {
        tenant_id: TENANT, account_id: a0, pair: 'B-BTC_USDT',
        margin_currency: 'USDT', venue_position_id: 'pos-a',
        active_pos: '0.1', avg_entry_price: '9000000', mark_price: '9050000',
        mark_observed_at: new Date(NOW_MS), liquidation_price: '7500000',
        leverage: '5', locked_margin_minor: '100000', take_profit_trigger: null,
        stop_loss_trigger: null, margin_type: 'isolated', funding_rate_bp: 5, ...over,
      };
      const keys = Object.keys(c);
      const vals = keys.map((_, i) => `$${i + 1}`).join(', ');
      return ctx.pool.query(
        `INSERT INTO futures_position (${keys.join(', ')}) VALUES (${vals}) RETURNING id`,
        keys.map((k) => c[k]),
      );
    };
    const posA = await insertPos();
    assert(posA.rows[0].id !== undefined, 'a futures_position row inserts cleanly');
    // Reinsert same venue_position_id → UNIQUE (tenant_id, venue_position_id) trips.
    let venueDupRaised = false;
    try { await insertPos(); } catch (e) {
      venueDupRaised = true;
      assert(/futures_position_venue_unique/.test(String(e.message)),
        `duplicate venue_position_id must trip futures_position_venue_unique, got ${e.message}`);
    }
    assert(venueDupRaised, 'two positions with the same venue id in one tenant must be refused');

    // ---- futures_execution_lock: (account, pair) is the PRIMARY KEY, so INSERT ON CONFLICT gives us atomic race ----
    const acquireLock = () => ctx.pool.query(
      `INSERT INTO futures_execution_lock (tenant_id, account_id, pair, child_order_id, locked_by)
       VALUES ($1, $2, 'B-BTC_USDT', $3, 'worker-1') ON CONFLICT (account_id, pair) DO NOTHING RETURNING account_id`,
      [TENANT, a0, entryId],
    );
    const first = await acquireLock();
    assert(first.rows.length === 1, 'first acquire wins the lock');
    const second = await acquireLock();
    assert(second.rows.length === 0,
      'second acquire on the same (account, pair) must lose the ON CONFLICT race (no coid — this IS the anti-duplicate substitute)');
  } finally {
    await teardown(ctx);
  }
}
