// 15-fanout — plan/phase-15 T15.5 (SL/TP fan-out for a futures group trade).
//
// The gap this closes: a customer could type an SL and TP on the ticket, watch
// them persist, and get nothing at the venue — `GroupExecutor.enqueue` placed
// only entry legs, and the conditionals were never materialised, let alone
// attached. Four properties, in the order they matter:
//
//   1. Enqueue MATERIALISES the conditional legs for a futures trade (correct
//      leg_kind / linked_entry / trigger price / 'planned'), and creates none
//      for a spot trade or a futures trade with no triggers configured.
//   2. An entry that FILLS triggers the attach, and the venue's per-leg answer
//      decides each conditional's final state ('untriggered' when it landed).
//   3. An entry that does NOT fill skips its conditionals with a labelled
//      reason — never a leg left 'planned', which would wedge the trade open.
//   4. With no attach port wired (pre-Phase-14 builds) the conditionals are
//      skipped with a reason, so the trade still completes honestly.
//
// The entry leg is placed through the coid-addressed order-create port because
// that is what lets the venue settle it to `filled` on command; the create route
// itself is proven separately by `15-place-and-read`. The ATTACH path here is
// the real thing: the claim-less futures `positions/create_tpsl` route.

import { NOW_MS, TENANT, USER, seedGroupOfAccounts, setup, teardown } from './_plan-harness.mjs';
import { ExecutionWorker, GroupExecutor } from '../apps/api/dist/index.js';
import {
  attachStopAndTake, FakeVenue, fetchFuturesPositions, fetchOrderByClientId, submitOrder,
} from '../packages/exchange-coindcx/dist/index.js';

const KEY = 'fan-key-abcdef0123456789';
const SECRET = 'fan-secret-abcdef0123456789';
const PEPPER = Buffer.from('f1'.repeat(16), 'hex');

export async function run(assert) {
  const ctx = await setup('fanout15');
  if (ctx === null) {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }
  const venue = new FakeVenue({ credentials: { [KEY]: SECRET } });
  try {
    const base = (await venue.start()).toString();
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['10000000', '10000000']);
    const [a0, a1] = accountIds;

    const submit = async (coid, order) => {
      const out = await submitOrder(KEY, SECRET, {
        client_order_id: coid, side: order.side,
        market_order: { market: order.market, side: order.side, order_type: order.orderType, total_quantity: order.quantity, price: 0 },
      }, { baseUrl: base });
      if (out.kind === 'accepted') return { kind: 'accepted', exchangeOrderId: out.order.id, statusRaw: out.order.statusRaw };
      return { kind: 'rejected', orderMayExist: out.failure.orderMayExist, code: out.failure.code, detail: out.failure.detail };
    };
    const resolve = async (coid) => {
      const r = await fetchOrderByClientId(KEY, SECRET, coid, { baseUrl: base });
      if (!r.ok) return { ok: false };
      return { ok: true, order: r.order === null ? null : { id: r.order.id, statusRaw: r.order.statusRaw } };
    };

    // The attach port the worker calls once an entry fills. It resolves the
    // venue POSITION for the account's pair and attaches both legs — exactly
    // what the composition root will do against the live venue.
    const attachCalls = [];
    const attachTpSl = async (args) => {
      attachCalls.push(args);
      const positions = await fetchFuturesPositions(KEY, SECRET, [args.marginCurrency], { baseUrl: base });
      if (!positions.ok) return { ok: false, code: 'positions_unreadable', detail: 'the venue did not answer the positions read' };
      const pos = positions.positions.find((p) => p.pair === args.pair);
      if (pos === undefined) return { ok: false, code: 'no_position', detail: `no open position on ${args.pair}` };
      const out = await attachStopAndTake(KEY, SECRET, {
        positionId: pos.venuePositionId,
        ...(args.stopLossPrice !== null ? { stopLoss: { triggerPrice: args.stopLossPrice, orderType: 'stop_market' } } : {}),
        ...(args.takeProfitPrice !== null ? { takeProfit: { triggerPrice: args.takeProfitPrice, orderType: 'take_profit_market' } } : {}),
      }, { baseUrl: base });
      if (!out.ok) return { ok: false, code: out.failure.code, detail: out.failure.detail };
      return {
        ok: true,
        ...(out.stopLoss !== undefined ? { stopLoss: out.stopLoss } : {}),
        ...(out.takeProfit !== undefined ? { takeProfit: out.takeProfit } : {}),
      };
    };

    const mkWorker = (deps = {}) => new ExecutionWorker({ db: ctx.db, pepper: PEPPER, submit, resolve, ...deps });

    const newFuturesTrade = async (over = {}) => {
      const t = await ctx.pool.query(
        `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type,
           sizing_mode, sizing_value, status, preview_token, preview_expires_at,
           is_futures, leverage, margin_currency, position_margin_type, stop_loss_price, take_profit_price)
         VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'previewed', $4, $5,
                 true, '5', 'USDT', 'isolated', $6, $7) RETURNING id`,
        [TENANT, groupId, USER, `tok-fan-${over.token ?? 'x'}`, new Date(NOW_MS + 60_000),
          over.stopLoss ?? '8000000', over.takeProfit ?? '9000000'],
      );
      return t.rows[0].id;
    };
    const addEntry = async (tradeId, accountId, leg, market, quote) => {
      const c = await ctx.pool.query(
        `INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, market, quote_currency, state, final_quantity)
         VALUES ($1, $2, $3, $4, $5, $6, 'planned', '0.0001') RETURNING id`,
        [TENANT, tradeId, accountId, leg, market, quote],
      );
      return c.rows[0].id;
    };
    const childrenOf = async (tradeId) => (await ctx.pool.query(
      `SELECT id, leg_kind, linked_entry_child_order_id, state, trigger_state, price_used, refusal_code, account_id
       FROM child_order WHERE group_trade_id = $1 ORDER BY leg_seq`, [tradeId],
    )).rows;
    const statusOf = async (tradeId) => (await ctx.pool.query(
      'SELECT status FROM group_trade WHERE id = $1', [tradeId],
    )).rows[0].status;
    // `enqueue` also queues a 'place' job per entry. The materialisation-only
    // scenarios below must not be placed by a later runPlaceOnce (two of them
    // share a0/BTCUSDT and would trip the in-flight refusal), so drop their jobs.
    const dropEntryJobs = async (tradeId) => {
      await ctx.pool.query(
        `DELETE FROM execution_job WHERE child_order_id IN
           (SELECT id FROM child_order WHERE group_trade_id = $1)`, [tradeId],
      );
    };

    // ============ 1. materialisation: 2 accounts x (SL + TP) = 4 legs ============
    const tradeA = await newFuturesTrade({ token: 'a' });
    await addEntry(tradeA, a0, 1, 'BTCUSDT', 'USDT');
    await addEntry(tradeA, a1, 2, 'BTCUSDT', 'USDT');
    const execA = new GroupExecutor({ db: ctx.db, worker: mkWorker({ attachTpSl }) });
    const enqA = await execA.enqueue(ctx.tdb, tradeA);
    await dropEntryJobs(tradeA); // materialisation only — never placed in this scenario
    assert(enqA.enqueued === 2, `two entry legs must be enqueued, got ${enqA.enqueued}`);
    assert(enqA.conditionals === 4, `2 accounts x (SL+TP) must materialise 4 conditionals, got ${enqA.conditionals}`);

    const kidsA = await childrenOf(tradeA);
    assert(kidsA.length === 6, `three legs per account (entry+SL+TP), got ${kidsA.length}`);
    const condsA = kidsA.filter((c) => c.leg_kind !== 'entry');
    assert(condsA.length === 4, 'four conditional legs exist');
    assert(condsA.every((c) => c.state === 'planned'), 'conditionals start planned — the trade stays executing until they resolve');
    assert(condsA.every((c) => c.linked_entry_child_order_id !== null), 'every conditional links to its entry');
    const slLegs = condsA.filter((c) => c.leg_kind === 'stop_loss');
    const tpLegs = condsA.filter((c) => c.leg_kind === 'take_profit');
    assert(slLegs.length === 2 && tpLegs.length === 2, 'exactly one SL and one TP per account');
    assert(slLegs.every((c) => c.price_used === '8000000'), 'each SL leg carries the trade SL trigger');
    assert(tpLegs.every((c) => c.price_used === '9000000'), 'each TP leg carries the trade TP trigger');
    assert(condsA.every((c) => c.trigger_state === null), 'a not-yet-attached conditional has no trigger state');

    // A spot trade materialises nothing.
    const spotTrade = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type,
         sizing_mode, sizing_value, status, preview_token, preview_expires_at)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'previewed', 'tok-spot-15', $4) RETURNING id`,
      [TENANT, groupId, USER, new Date(NOW_MS + 60_000)],
    );
    await addEntry(spotTrade.rows[0].id, a0, 1, 'BTCINR', 'INR');
    const enqSpot = await new GroupExecutor({ db: ctx.db, worker: mkWorker({ attachTpSl }) }).enqueue(ctx.tdb, spotTrade.rows[0].id);
    await dropEntryJobs(spotTrade.rows[0].id);
    assert(enqSpot.conditionals === 0, `a spot trade must materialise no conditionals, got ${enqSpot.conditionals}`);

    // A futures trade with NO triggers configured materialises nothing either.
    const tradeNoTrig = await ctx.pool.query(
      `INSERT INTO group_trade (tenant_id, group_id, created_by, asset, side, order_type,
         sizing_mode, sizing_value, status, preview_token, preview_expires_at,
         is_futures, leverage, margin_currency, position_margin_type)
       VALUES ($1, $2, $3, 'BTC', 'buy', 'market', 'base_quantity', '0.0001', 'previewed', 'tok-notrig-15', $4,
               true, '5', 'USDT', 'isolated') RETURNING id`,
      [TENANT, groupId, USER, new Date(NOW_MS + 60_000)],
    );
    await addEntry(tradeNoTrig.rows[0].id, a0, 1, 'BTCUSDT', 'USDT');
    const enqNoTrig = await new GroupExecutor({ db: ctx.db, worker: mkWorker({ attachTpSl }) }).enqueue(ctx.tdb, tradeNoTrig.rows[0].id);
    await dropEntryJobs(tradeNoTrig.rows[0].id);
    assert(enqNoTrig.conditionals === 0, 'a futures trade with neither trigger configured materialises nothing');

    // ============ 2. entry fills → conditionals attach ============
    // One account only: the fake venue models positions per (pair, margin), not
    // per account, so a single-account trade is the honest end-to-end shape here.
    const tradeB = await newFuturesTrade({ token: 'b' });
    await addEntry(tradeB, a0, 1, 'BTCUSDT', 'USDT');
    const worker = mkWorker({ attachTpSl });
    const exec = new GroupExecutor({ db: ctx.db, worker });
    await exec.enqueue(ctx.tdb, tradeB);
    await worker.runPlaceOnce();

    const entryB = (await childrenOf(tradeB)).find((c) => c.leg_kind === 'entry');
    assert(entryB !== undefined && entryB.state === 'open', `the entry must be placed and open, got ${entryB?.state}`);

    // The venue reports the fill; the poll settles the entry, and the settle is
    // what owes the attach. A fill on a futures entry also OPENS A POSITION —
    // that is what the attach is against, so the fake must show one.
    const coid = (await ctx.pool.query('SELECT client_order_id c FROM child_order WHERE id = $1', [entryB.id])).rows[0].c;
    venue.settleOrder(coid, 'filled');
    venue.settleFuturesPosition({
      pair: 'B-BTC_USDT', marginCurrency: 'USDT', activePos: '0.0001',
      avgEntryPrice: '8500000', markPrice: '8500000', leverage: '5',
    });
    await worker.pollTrade(ctx.tdb, tradeB);

    assert(attachCalls.length === 1, `the attach must be attempted exactly once, got ${attachCalls.length}`);
    const call = attachCalls[0];
    assert(call.accountId === a0, 'the attach targets the account whose entry filled');
    assert(call.pair === 'B-BTC_USDT', `the attach uses the venue pair form, got ${call.pair}`);
    assert(call.marginCurrency === 'USDT' && call.stopLossPrice === '8000000' && call.takeProfitPrice === '9000000',
      'the attach carries the trade leverage currency and both triggers');

    const kidsB = await childrenOf(tradeB);
    const slB = kidsB.find((c) => c.leg_kind === 'stop_loss');
    const tpB = kidsB.find((c) => c.leg_kind === 'take_profit');
    assert(slB !== undefined && slB.state === 'untriggered', `the SL must rest untriggered, got ${slB?.state}`);
    assert(tpB !== undefined && tpB.state === 'untriggered', `the TP must rest untriggered, got ${tpB?.state}`);
    assert(slB.trigger_state === 'untriggered' && tpB.trigger_state === 'untriggered',
      'both legs record trigger_state=untriggered once attached');
    assert(await statusOf(tradeB) === 'completed',
      `once every leg is out of the working set the trade completes, got ${await statusOf(tradeB)}`);

    // ============ 3. entry never fills → conditionals skipped ============
    const tradeC = await newFuturesTrade({ token: 'c' });
    await addEntry(tradeC, a0, 1, 'BTCUSDT', 'USDT');
    const workerC = mkWorker({ attachTpSl });
    const execC = new GroupExecutor({ db: ctx.db, worker: workerC });
    await execC.enqueue(ctx.tdb, tradeC);
    await workerC.runPlaceOnce();
    const entryC = (await childrenOf(tradeC)).find((c) => c.leg_kind === 'entry');
    const coidC = (await ctx.pool.query('SELECT client_order_id c FROM child_order WHERE id = $1', [entryC.id])).rows[0].c;
    // The venue rejects it — the entry can never open a position.
    const attachCallsBefore = attachCalls.length;
    venue.settleOrder(coidC, 'rejected');
    await workerC.pollTrade(ctx.tdb, tradeC);
    const kidsC = await childrenOf(tradeC);
    const condsC = kidsC.filter((c) => c.leg_kind !== 'entry');
    assert(condsC.every((c) => c.state === 'skipped'), 'an entry that never filled must skip its conditionals');
    assert(condsC.every((c) => c.refusal_code === 'ENTRY_DID_NOT_FILL'),
      `the skip must name the entry outcome, got ${condsC.map((c) => `${c.state}/${c.refusal_code}`).join(',')}`);
    assert(attachCalls.length === attachCallsBefore, 'no attach is attempted when the entry did not fill');
    assert(await statusOf(tradeC) === 'completed', 'the trade still completes — no leg is left planned');

    // ============ 4. no attach port wired → labelled skip, trade completes ============
    const tradeD = await newFuturesTrade({ token: 'd' });
    await addEntry(tradeD, a0, 1, 'BTCUSDT', 'USDT');
    const workerD = mkWorker(); // no attachTpSl
    const execD = new GroupExecutor({ db: ctx.db, worker: workerD });
    await execD.enqueue(ctx.tdb, tradeD);
    await workerD.runPlaceOnce();
    const entryD = (await childrenOf(tradeD)).find((c) => c.leg_kind === 'entry');
    const coidD = (await ctx.pool.query('SELECT client_order_id c FROM child_order WHERE id = $1', [entryD.id])).rows[0].c;
    venue.settleOrder(coidD, 'filled');
    await workerD.pollTrade(ctx.tdb, tradeD);
    const condsD = (await childrenOf(tradeD)).filter((c) => c.leg_kind !== 'entry');
    assert(condsD.every((c) => c.state === 'skipped'), 'with no attach port the conditionals are skipped, not left planned');
    assert(condsD.every((c) => c.refusal_code === 'TP_SL_NOT_ATTACHED'),
      `the skip names the reason, got ${condsD.map((c) => c.refusal_code).join(',')}`);
    assert(await statusOf(tradeD) === 'completed', 'the trade completes honestly rather than hanging on an unattachable leg');
  } finally {
    await venue.stop();
    await teardown(ctx);
  }
}
