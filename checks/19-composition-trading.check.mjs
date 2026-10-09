// Exercise the actual production composition root with local credentials and a
// signature-verifying fake exchange. No .env file or live trading endpoint.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setup, teardown, seedGroupOfAccounts, ingestMarkets, TENANT, USER } from './_plan-harness.mjs';
import { FakeVenue } from '../packages/exchange-coindcx/dist/index.js';
import { LocalKms, sealCredential } from '../packages/crypto/dist/index.js';
import { hashPassword } from '../packages/auth/dist/index.js';

export async function run(assert) {
  const ctx = await setup('composition19');
  if (!ctx) { assert(true, 'skipped without DATABASE_URL'); return; }
  const priorRoot = process.env.TRADEX_LOCAL_ROOT_KEY;
  let api;
  const key = 'composition-test-key', secret = 'composition-test-secret';
  const venue = new FakeVenue({ credentials: { [key]: secret } });
  venue.setFuturesLtp('B-BTC_USDT', '80000');
  venue.settleFuturesPosition({ pair: 'B-BTC_USDT', marginCurrency: 'USDT', activePos: '0', lockedMargin: '160' });
  let logs = '';
  try {
    process.env.TRADEX_LOCAL_ROOT_KEY = 'e9'.repeat(32);
    const kms = new LocalKms();
    await ingestMarkets(ctx.db);
    const { groupId, accountIds: [accountId] } = await seedGroupOfAccounts(ctx, ['10000000']);
    await ctx.db.updateTable('app_user').set({ password_hash: await hashPassword('composition-password-123') }).where('id', '=', USER).execute();
    const cred = await ctx.tdb.selectFrom('exchange_credential').select('id').where('account_id', '=', accountId).executeTakeFirstOrThrow();
    const sealed = await sealCredential(kms, { tenantId: TENANT, accountId, credentialId: cred.id, keyVersion: 1 }, key, secret);
    await ctx.tdb.updateTable('exchange_credential').set({
      kms_key_arn: sealed.kmsKeyId, dek_wrapped: sealed.dekWrapped,
      api_key_ct: sealed.apiKey.ct, api_key_nonce: sealed.apiKey.nonce, api_key_tag: sealed.apiKey.tag,
      api_secret_ct: sealed.apiSecret.ct, api_secret_nonce: sealed.apiSecret.nonce, api_secret_tag: sealed.apiSecret.tag,
    }).where('id', '=', cred.id).execute();
    const venueBase = (await venue.start()).toString();
    const portProbe = createServer(); await new Promise((r) => portProbe.listen(0, '127.0.0.1', r));
    const port = portProbe.address().port; await new Promise((r) => portProbe.close(r));
    const testUrl = new URL(process.env.DATABASE_URL); testUrl.searchParams.set('options', `-c search_path=${ctx.schema},public`);
    api = spawn(process.execPath, ['apps/api/server.mjs'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...process.env, NODE_ENV: 'test', DATABASE_URL: testUrl.toString(), PORT: String(port), APP_URL: `http://127.0.0.1:${port}`,
      TRADEX_VENUE_BASE: venueBase, TRADEX_SEND_MODE: 'send', TRADEX_LIVE_BOOK: '0', TRADEX_KILL_SWITCH: '0',
      TRADEX_SIGNER_URL: '', TRADEX_SIGNER_TOKEN: '', TRADEX_EXECUTION_PEPPER: 'e7'.repeat(32), TRADEX_COOKIE_SECRET: 'e6'.repeat(32),
      TRADEX_PEPPER: 'e5'.repeat(32), TRADEX_SECURE_COOKIES: '0', RESEND_API_KEY: '', TRADEX_ALLOW_LOCAL_KMS: '0',
    } });
    api.stdout.on('data', (v) => { logs += v; }); api.stderr.on('data', (v) => { logs += v; });
    const base = `http://127.0.0.1:${port}`;
    for (let n = 0; n < 100 && !logs.includes('Tradex API listening'); n++) {
      if (api.exitCode !== null) throw new Error(`Composition root stopped: ${logs.slice(-4000)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    assert(logs.includes('Tradex API listening'), 'composition root must start against the isolated database');
    const post = (path, body, cookie, requestId) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(cookie ? { cookie } : {}), ...(requestId ? { 'idempotency-key': requestId } : {}) }, body: JSON.stringify(body) });
    const login = await post('/api/login', { email: 'plan@t.example', password: 'composition-password-123' });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert(login.status === 200 && cookie, 'composition login must work');
    const intent = { groupId, asset: 'BTC', side: 'buy', orderType: 'market', sizingMode: 'base_quantity', sizingValue: '0.01',
      isFutures: true, leverage: '5', marginCurrency: 'USDT', quoteCurrency: 'USDT', positionMarginType: 'isolated', stopLossPrice: '70000', takeProfitPrice: '90000',
      trailingStopLoss: true, trailingStepBasis: 'roe', trailingStepBp: 100, trailingDistanceBp: 500 };
    const previewRes = await post('/api/group-trades/preview', intent, cookie); const preview = await previewRes.json();
    assert(previewRes.status === 200 && preview.plannedCount === 1, `group market preview must plan: ${JSON.stringify(preview)}`);
    assert(preview.trailingStepBasis === 'roe' && preview.trailingStepBp === '100', 'preview reports the persisted ROE trailing intent for confirmation');
    const reread = await (await fetch(`${base}/api/group-trades/${preview.groupTradeId}`, { headers: { cookie } })).json();
    assert(reread.trailingStepBasis === 'roe' && reread.trailingStopLoss, 'reloaded confirmation retains the ROE basis');
    const confirm = await post(`/api/group-trades/${preview.groupTradeId}/confirm`, { previewToken: preview.previewToken }, cookie);
    const confirmed = await confirm.json();
    assert(confirm.status === 200, `group market confirmation must execute: ${JSON.stringify(confirmed)}`);
    const legs = await ctx.tdb.selectFrom('child_order').selectAll().where('group_trade_id', '=', preview.groupTradeId).execute();
    assert(legs.find((l) => l.leg_kind === 'entry')?.state === 'filled', 'market entry must be confirmed filled');
    assert(legs.filter((l) => l.leg_kind !== 'entry').every((l) => l.state === 'untriggered' && l.exchange_order_id), 'automatic protection must sign with tenant context and retain venue IDs');
    const position = await ctx.tdb.selectFrom('futures_position').selectAll().where('account_id', '=', accountId).executeTakeFirstOrThrow();
    const trailing = await ctx.tdb.selectFrom('futures_trailing_sl').selectAll().where('account_id', '=', accountId).executeTakeFirstOrThrow();
    assert(trailing.step_basis === 'roe' && trailing.position_basis_key && trailing.step_anchor_price && trailing.status === 'active', `filled market entry registers ROE trailing with venue collateral and its initial stop: ${JSON.stringify(trailing)}`);
    const reduceId = randomUUID();
    const reduce = await post(`/api/futures/positions/${position.venue_position_id}/adjust`, { direction: 'reduce', percentBp: 5000 }, cookie, reduceId);
    const reduction = await reduce.json();
    assert(reduce.status === 200 && reduction.quantity === '0.005', `partial reduce must stay on the quantity step: ${JSON.stringify(reduction)}`);
    const creates = venue.futuresOrdersSnapshot().length;
    const replay = await post(`/api/futures/positions/${position.venue_position_id}/adjust`, { direction: 'reduce', percentBp: 5000 }, cookie, reduceId);
    assert(replay.status === 200 && venue.futuresOrdersSnapshot().length === creates, 'replayed adjustment must not send another order');
    const audits = await ctx.tdb.selectFrom('child_order').select('id').where('position_mutation_request_id', '=', reduceId).execute();
    assert(audits.length === 1, 'replayed adjustment must not duplicate its audit row');
    const increaseId = randomUUID();
    const increase = await post(`/api/futures/positions/${position.venue_position_id}/adjust`, { direction: 'increase', quantity: '0.002' }, cookie, increaseId);
    const increased = await increase.json();
    assert(increase.status === 200 && increased.quantity === '0.002', `increase must reserve margin and execute: ${JSON.stringify(increased)}`);
    const reservation = await ctx.tdb.selectFrom('position_mutation').select(['status', 'risk_margin_inr_minor']).where('request_id', '=', increaseId).executeTakeFirstOrThrow();
    assert(reservation.status === 'completed' && BigInt(reservation.risk_margin_inr_minor) > 0n, 'successful increase must keep its durable daily margin reservation');
    const leverage = await post(`/api/futures/positions/${position.venue_position_id}/leverage`, { leverage: '10' }, cookie, randomUUID());
    assert(leverage.status === 200, `leverage mutation must work under the action lock: ${JSON.stringify(await leverage.json())}`);
    const protection = await post(`/api/futures/positions/${position.venue_position_id}/tpsl`, { stopLossPrice: '71000', takeProfitPrice: '89000', moveExisting: true }, cookie, randomUUID());
    const protectedResult = await protection.json();
    assert(protection.status === 200 && protectedResult.stopLoss?.ok && protectedResult.takeProfit?.ok, `protection replacement must cancel old legs and confirm new ones: ${JSON.stringify(protectedResult)}`);
    assert(!await ctx.tdb.selectFrom('futures_trailing_sl').select('id').where('account_id', '=', accountId).executeTakeFirst(), 'manual stop replacement removes the previous ROE baseline');
    const exit = await post(`/api/futures/positions/${position.venue_position_id}/exit`, { marginCurrency: 'USDT' }, cookie, randomUUID());
    assert(exit.status === 200, `hard exit must cancel protection and verify flat: ${JSON.stringify(await exit.json())}`);
    const limitRes = await post('/api/group-trades/preview', { ...intent, groupId: undefined, accountId, orderType: 'limit', limitPrice: '79700' }, cookie);
    const limit = await limitRes.json();
    assert(limitRes.status === 200 && limit.plannedCount === 1, `individual limit preview must plan: ${JSON.stringify(limit)}`);
    const limitConfirm = await post(`/api/group-trades/${limit.groupTradeId}/confirm`, { previewToken: limit.previewToken }, cookie);
    assert(limitConfirm.status === 200, 'individual limit confirmation must execute');
    const limitEntry = await ctx.tdb.selectFrom('child_order').selectAll().where('group_trade_id', '=', limit.groupTradeId).where('leg_kind', '=', 'entry').executeTakeFirstOrThrow();
    assert(['open', 'acked'].includes(limitEntry.state), 'a resting limit must stay live instead of being fabricated filled');
    await ctx.tdb.updateTable('child_order').set({ created_at: new Date(0) }).where('id', '=', limitEntry.id).execute();
    const refreshed = await post('/api/futures/positions/refresh', {}, cookie);
    assert(refreshed.status === 200, 'position mirroring must work while an old limit rests');
    const afterRefresh = await ctx.tdb.byId('child_order', limitEntry.id).select('state').executeTakeFirstOrThrow();
    assert(afterRefresh.state !== 'filled', 'position mirroring must never fabricate a fill for an old resting limit');
    venue.settleFuturesOrder(limitEntry.exchange_order_id, 'open'); // Model venue activation after its initial create response.
    const cancelled = await post('/api/orders/cancel', { groupTradeId: limit.groupTradeId }, cookie);
    const cancellation = await cancelled.json();
    assert(cancelled.status === 200 && cancellation.cancelled === 1, `pending limit cancellation must be wired in the actual server: ${JSON.stringify(cancellation)}`);
    const finalEntry = await ctx.tdb.byId('child_order', limitEntry.id).select('state').executeTakeFirstOrThrow();
    assert(finalEntry.state === 'cancelled', 'limit cancellation must be confirmed by exchange read-back');
    const retrySourceRes = await post('/api/group-trades/preview', intent, cookie);
    const retrySource = await retrySourceRes.json();
    assert(retrySourceRes.status === 200 && retrySource.plannedCount === 1, 'ROE retry source is previewed');
    await ctx.tdb.updateTable('child_order').set({ state: 'rejected' }).where('group_trade_id', '=', retrySource.groupTradeId).where('leg_kind', '=', 'entry').execute();
    const retryRes = await post(`/api/group-trades/${retrySource.groupTradeId}/retry-failed`, {}, cookie);
    const retry = await retryRes.json();
    assert(retryRes.status === 201 && retry.trailingStopLoss && retry.trailingStepBasis === 'roe' && retry.trailingStepBp === '100', `fresh retry preserves ROE intent rather than silently switching back to price: ${JSON.stringify(retry)}`);
    // Missing collateral must not cause a confirmed fixed SL to be recorded as
    // rejected (which could encourage a duplicate protection attachment).
    venue.settleFuturesPosition({ pair: 'B-BTC_USDT', marginCurrency: 'USDT', activePos: '0', lockedMargin: '0' });
    const missingRes = await post('/api/group-trades/preview', intent, cookie);
    const missing = await missingRes.json();
    assert(missingRes.status === 200, 'missing-margin scenario still plans an entry');
    const missingConfirm = await post(`/api/group-trades/${missing.groupTradeId}/confirm`, { previewToken: missing.previewToken }, cookie);
    assert(missingConfirm.status === 200, 'confirmed fixed protection survives missing ROE collateral');
    const missingSl = await ctx.tdb.selectFrom('child_order').selectAll().where('group_trade_id', '=', missing.groupTradeId).where('leg_kind', '=', 'stop_loss').executeTakeFirstOrThrow();
    assert(missingSl.state === 'untriggered' && missingSl.exchange_order_id && missingSl.refusal_code === 'TRAILING_INACTIVE', 'order history retains the confirmed SL id and surfaces inactive trailing separately');
    const inactive = await ctx.tdb.selectFrom('futures_trailing_sl').selectAll().where('account_id', '=', accountId).executeTakeFirstOrThrow();
    assert(inactive.status === 'failed' && inactive.step_basis === 'roe', 'missing collateral cannot silently enable an incorrect trailing calculation');
  } finally {
    if (api && api.exitCode === null) { const stopped = once(api, 'exit'); api.kill(); await stopped; }
    await venue.stop(); await teardown(ctx);
    if (priorRoot === undefined) delete process.env.TRADEX_LOCAL_ROOT_KEY; else process.env.TRADEX_LOCAL_ROOT_KEY = priorRoot;
  }
}
