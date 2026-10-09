import { randomUUID } from 'node:crypto';
import { setup, teardown, seedGroupOfAccounts, TENANT, USER } from './_plan-harness.mjs';
import { upsertTrailingSl, acquireFuturesLock, releaseFuturesLock } from '../packages/db/dist/index.js';
import { TrailingSlEngine } from '../apps/api/dist/trailing-sl-worker.js';
import { roePositionBasis } from '../apps/api/dist/futures/roe-trailing.js';
import { createHttpServer } from '../apps/api/dist/index.js';
import { hashPassword } from '../packages/auth/dist/index.js';
import { LocalKms } from '../packages/crypto/dist/index.js';

export async function run(assert) {
  const ctx = await setup('roe22');
  if (!ctx) { assert(true, 'skipped without DATABASE_URL'); return; }
  let server;
  try {
    const { accountIds } = await seedGroupOfAccounts(ctx, ['10000000', '10000000']);
    let live = '100.1', result = { ok: true }, staleBook = false;
    const moves = [];
    const book = async (market) => ({ market, observedAtMs: Date.now() - (staleBook ? 6000 : 0), bids: [{ price: live, quantity: '10' }], asks: [{ price: live, quantity: '10' }] });
    const config = async (index, overrides = {}) => {
      const p = await ctx.tdb.selectFrom('futures_position').selectAll().where('account_id', '=', accountIds[index]).executeTakeFirstOrThrow();
      const basis = roePositionBasis({ activePos: p.active_pos, lockedMarginMinor: p.locked_margin_minor,
        pair: p.pair, marginCurrency: p.margin_currency, avgEntryPrice: p.avg_entry_price, settlementCurrencyAvgPrice: p.settlement_currency_avg_price });
      await upsertTrailingSl(ctx.tdb, { accountId: accountIds[index], venuePositionId: `roe-${index}`, pair: p.pair,
        distanceBp: '500', stepBp: '100', currentSlPrice: '95', highWaterMark: '100',
        stepBasis: 'roe', stepAnchorPrice: '100', positionBasisKey: basis.key, ...overrides });
    };
    const read = (index) => ctx.tdb.selectFrom('futures_trailing_sl').selectAll().where('account_id', '=', accountIds[index]).executeTakeFirstOrThrow();
    for (let i = 0; i < 2; i++) await ctx.tdb.insertInto('futures_position', {
      account_id: accountIds[i], venue_position_id: `roe-${i}`, pair: 'B-BTC_USDT', margin_currency: 'USDT', active_pos: '1',
      avg_entry_price: '100', locked_margin_minor: i === 0 ? '1000000000' : '2000000000', stop_loss_trigger: '95', updated_at: new Date(),
    }).execute();
    await config(0); await config(1);
    const engine = new TrailingSlEngine(ctx.db, async (args) => { moves.push(args); return result; }, book, async () => '0.01');
    await Promise.all([engine.evaluate(), engine.evaluate()]);
    assert(moves.length === 1 && moves[0].accountId === accountIds[0] && moves[0].stopLossPrice === '95.1', 'same coin moves only the account that gained a full 1 percentage point ROE');
    assert(moves[0].positionBasisKey && Number(moves[0].expectedSlPrice) === 95, 'exchange step carries its exact margin basis and prior stop for a fresh check');
    assert(Number((await read(0)).step_anchor_price) === 100.1 && Number((await read(0)).current_sl_price) === 95.1, 'sub-unit stop and consumed ROE baseline persist without whole-number rounding');
    live = '100.2'; await engine.evaluate();
    assert(moves.filter((m) => m.accountId === accountIds[1]).length === 1, 'account with twice the margin waits for twice the price movement');
    assert(moves.filter((m) => m.accountId === accountIds[0]).length === 2, 'first account advances by another full ROE step');
    live = '99'; await engine.evaluate();
    assert(moves.length === 3, 'reversal never loosens either stop');

    await ctx.tdb.updateTable('futures_position').set({ locked_margin_minor: '2000000000', updated_at: new Date() }).where('account_id', '=', accountIds[0]).execute();
    live = '110'; await engine.evaluate();
    const rebased = await read(0);
    assert(Number(rebased.step_anchor_price) === 110 && Number(rebased.current_sl_price) === 95.2, 'added margin rebases without treating the changed ROE denominator as profit');
    const before = moves.filter((m) => m.accountId === accountIds[0]).length;
    live = '110.2'; await engine.evaluate();
    assert(moves.filter((m) => m.accountId === accountIds[0]).length === before + 1 && Number((await read(0)).current_sl_price) === 95.4, 'subsequent steps use the new margin basis');
    await ctx.tdb.updateTable('futures_position').set({ updated_at: new Date(Date.now() - 61000) }).where('account_id', '=', accountIds[0]).execute();
    const frozen = moves.filter((m) => m.accountId === accountIds[0]).length;
    live = '111'; await engine.evaluate();
    assert(moves.filter((m) => m.accountId === accountIds[0]).length === frozen, 'stale collateral prevents stop replacement');
    await ctx.tdb.updateTable('futures_position').set({ updated_at: new Date() }).where('account_id', '=', accountIds[0]).execute();
    staleBook = true; const priorMoves = moves.length; await engine.evaluate();
    assert(moves.length === priorMoves, 'stale fallback prices cannot move stops'); staleBook = false;
    await config(0); result = { ok: false, reason: 'position_basis_changed' }; await engine.evaluate();
    assert((await read(0)).status === 'active' && Number((await read(0)).current_sl_price) === 95, 'basis change caught under the action lock retries from a refreshed basis without claiming a move');
    result = { ok: false, reason: 'venue_refused' }; await engine.evaluate();
    assert((await read(0)).status === 'failed' && Number((await read(0)).current_sl_price) === 95, 'exchange refusal never records an unconfirmed stop');
    await config(0); result = undefined; await engine.evaluate();
    assert((await read(0)).status === 'failed' && Number((await read(0)).current_sl_price) === 95, 'missing exchange confirmation cannot consume a ROE step');

    await upsertTrailingSl(ctx.tdb, { accountId: accountIds[0], venuePositionId: 'roe-0', pair: 'B-BTC_USDT',
      distanceBp: '500', stepBp: '100', highWaterMark: '100', currentSlPrice: '95.123456789' });
    assert((await read(0)).step_basis === 'price' && (await read(0)).step_anchor_price === null, 'legacy callers retain price-based intent');
    assert(Number((await read(0)).current_sl_price) === 95.123456789, 'migration preserves fractional stop prices');

    await ctx.db.updateTable('app_user').set({ password_hash: await hashPassword('roe-test-password-123') }).where('id', '=', USER).execute();
    server = createHttpServer({ db: ctx.db, getOrderBook: book, cookieSecret: Buffer.alloc(32, 7),
      verifySecondFactor: async () => false, kms: new LocalKms(), pepper: Buffer.alloc(32, 8),
      probe: async () => { throw new Error('not used'); }, codeVersion: 'roe-test', secureCookies: false,
      futuresTpSl: { setProtection: async () => ({ stopLoss: { ok: true, venueOrderId: 'fixed-sl' } }) },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie = '';
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    const login = await post('/api/login', { email: 'plan@t.example', password: 'roe-test-password-123' });
    cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert(login.status === 200, 'test session established');
    const request = { enable: true, stepBasis: 'roe', stepBp: '100', currentSlPrice: '95' };
    const enable = await post('/api/futures/positions/roe-0/trailing-tpsl', request);
    assert(enable.status === 200 && (await read(0)).step_basis === 'roe', 'management enables ROE trailing without a forced distance percentage');
    assert(Number((await read(0)).step_anchor_price) === Number(live), 'management anchors at current market rather than entry profit');
    assert((await post('/api/futures/positions/roe-0/trailing-tpsl', { ...request, enable: 'true' })).status === 400, 'mistyped enable cannot silently disable a live trail');
    const lockId = randomUUID();
    await acquireFuturesLock(ctx.db, { tenantId: TENANT, accountId: accountIds[0], pair: 'B-BTC_USDT', childOrderId: lockId, workerId: 'roe-test' });
    assert((await post('/api/futures/positions/roe-0/trailing-tpsl', { enable: false })).status === 409, 'configuration cannot race a position mutation already in flight');
    assert((await read(0)).step_basis === 'roe', 'conflicting disable leaves the protected configuration intact');
    await releaseFuturesLock(ctx.db, { accountId: accountIds[0], pair: 'B-BTC_USDT', childOrderId: lockId });
    assert((await post('/api/futures/positions/roe-0/trailing-tpsl', { ...request, stepBasis: 'untrusted' })).status === 400, 'unknown trailing bases are refused');
    assert((await post(`/api/futures/positions/${randomUUID()}/trailing-tpsl`, request)).status === 404, 'unowned position cannot configure trailing');
    await ctx.tdb.updateTable('futures_position').set({ margin_currency: 'INR', settlement_currency_avg_price: null }).where('account_id', '=', accountIds[0]).execute();
    assert((await post('/api/futures/positions/roe-0/trailing-tpsl', request)).status === 409, 'INR without a settlement rate cannot silently use an invented FX rate');
    await ctx.tdb.updateTable('futures_position').set({ margin_currency: 'USDT', updated_at: new Date(Date.now() - 61000) }).where('account_id', '=', accountIds[0]).execute();
    assert((await post('/api/futures/positions/roe-0/trailing-tpsl', request)).status === 409, 'stale positions cannot enable ROE tracking');
    await ctx.tdb.updateTable('futures_position').set({ updated_at: new Date() }).where('account_id', '=', accountIds[0]).execute();
    const manual = await post('/api/futures/positions/roe-0/tpsl', { stopLossPrice: '96', moveExisting: true });
    assert(manual.status === 200, 'manual fixed stop still works');
    const trail = await ctx.tdb.selectFrom('futures_trailing_sl').select('id').where('account_id', '=', accountIds[0]).executeTakeFirst();
    assert(!trail, 'manual SL change cancels its prior trailing baseline under the position lock');
    assert((await read(1)).tenant_id === TENANT, 'other account configuration is unaffected');
  } finally {
    if (server) await new Promise((r) => server.close(r));
    await teardown(ctx);
  }
}
