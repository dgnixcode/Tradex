import { PlanningService } from '../apps/api/dist/index.js';
import { futuresRequiredLeveragedMinor } from '../packages/sizing/dist/index.js';
import { setup, teardown, seedGroupOfAccounts, ingestMarkets, USER } from './_plan-harness.mjs';

export async function run(assert) {
  const ctx = await setup('collateral24');
  if (!ctx) { assert(true, 'skipped without DATABASE_URL'); return; }
  try {
    await ingestMarkets(ctx.db);
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, ['1020000','510000']);
    let rate = '102', rateReads = 0, spotFxReads = 0;
    const deps = { db: ctx.db, tdb: ctx.tdb, codeVersion:'collateral-test', dryRun:true,
      getFuturesSettlementRate: async () => { rateReads++; return rate; },
      getOrderBook: async market => {
        if (market.asset === 'USDT') spotFxReads++;
        const price = market.asset === 'USDT' ? '99' : '80000';
        return { market, observedAtMs:Date.now(), asks:[{ price,quantity:'1000' }], bids:[{ price,quantity:'1000' }] };
      },
      getFuturesInstrument: async () => ({ ok:true, instrument: { quantityIncrement:'0.00001',priceIncrement:'0.01',minNotional:'1',minQuantity:'0.00001',
        takerFee:'0.0006',leverageTiers:[{ upToNotional:'10000000',maxLeverage:100 }] } }),
    };
    const service = new PlanningService(deps);
    const intent = { groupId,createdBy:USER,asset:'BTC',side:'buy',orderType:'market',sizingMode:'pct_allocated',percentBp:10000,
      isFutures:true,leverage:'4',marginCurrency:'INR',quoteCurrency:'USDT',positionMarginType:'isolated' };
    const preview = await service.preview(intent);
    assert(preview.plannedCount === 2, 'both funded accounts plan 100% requests successfully');
    assert(rateReads === 1 && spotFxReads === 0, 'group uses one futures settlement read and never spot FX');
    for (let i=0;i<preview.rows.length;i++) {
      const row = preview.rows[i];
      const free = row.accountId === accountIds[0] ? 10000000000n : 5000000000n;
      const required = futuresRequiredLeveragedMinor(BigInt(row.notionalMinor),{ leverage:'4',takerFeeRate:'0.0006' });
      assert(required <= free * 4n * 99n / 100n, 'planned margin plus notional fees fit actual 102 INR conversion and retain headroom');
    }
    const trade = await ctx.tdb.selectFrom('group_trade').selectAll().where('id','=',preview.groupTradeId).executeTakeFirstOrThrow();
    const fx = await ctx.db.selectFrom('fx_snapshot').selectAll().where('id','=',trade.fx_snapshot_id).executeTakeFirstOrThrow();
    assert(fx.rate === '102' && fx.source === 'coindcx_futures_conversion', 'exact conversion and origin are persisted with the immutable trade');
    const children = await ctx.tdb.selectFrom('child_order').selectAll().where('group_trade_id','=',preview.groupTradeId).execute();
    assert(children.every(c=>c.tds_rate_applied==='0' && c.fee_rate_assumed==='0.0006'), 'futures fee assumptions are accurate and exclude spot TDS');
    for (const side of ['buy','sell']) for (const orderType of ['market','limit']) {
      const explicit = await service.preview({ ...intent,accountId:accountIds[0],side,orderType,sizingMode:'base_quantity',sizingValue:'0.005',
        ...(orderType==='limit' ? { limitPrice:'80000' } : {}) });
      assert(explicit.plannedCount === 0 && explicit.rows[0].refusalCode==='INSUFFICIENT_BALANCE', 'explicit quantity exhausting margin is refused before authorization because fees also require collateral');
    }
    const smaller = await service.preview({ ...intent,accountId:accountIds[0],sizingMode:'base_quantity',sizingValue:'0.004' });
    assert(smaller.plannedCount === 1 && smaller.rows[0].finalQuantity==='0.004', 'an affordable explicit quantity is preserved exactly');
    const before = await ctx.tdb.selectFrom('group_trade').select('id').execute(); rate = null;
    let refused = false;
    try { await service.preview(intent); } catch (error) { refused = error.reason==='no_market_data'; }
    assert(refused, 'missing futures conversion fails closed without spot fallback');
    assert((await ctx.tdb.selectFrom('group_trade').select('id').execute()).length === before.length, 'failed conversion leaves no new trade plan');
  } finally { await teardown(ctx); }
}
