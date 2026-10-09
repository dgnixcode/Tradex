import { randomUUID } from 'node:crypto';
import { setup, teardown, seedGroupOfAccounts, ingestMarkets, bookProvider, TENANT, USER } from './_plan-harness.mjs';
import { createHttpServer } from '../apps/api/dist/index.js';
import { recordObservedBalances, recordVenueBasis, listGroups, DEFAULT_GROUP_NAME } from '../packages/db/dist/index.js';
import { hashPassword } from '../packages/auth/dist/index.js';
import { LocalKms } from '../packages/crypto/dist/index.js';

export async function run(assert) {
  const ctx = await setup('balance21');
  if (!ctx) { assert(true, 'database check skipped without DATABASE_URL'); return; }
  let server;
  try {
    await ingestMarkets(ctx.db);
    const { groupId, accountIds } = await seedGroupOfAccounts(ctx, Array(4).fill('10000000'));
    const outside = await seedGroupOfAccounts(ctx, ['10000000'], 'Outside');
    await ctx.tdb.updateTable('group_member').set({ enabled: false }).where('group_id', '=', groupId).where('account_id', '=', accountIds[2]).execute();
    await ctx.tdb.updateTable('exchange_account').set({ status: 'suspended' }).where('id', '=', accountIds[3]).execute();
    await ctx.db.updateTable('app_user').set({ password_hash: await hashPassword('balance-test-password-123') }).where('id', '=', USER).execute();

    const wallet = (amount) => amount === '0' ? [] : [
      { currency: 'INR', freeMinor: amount, lockedMinor: '0', scale: 2 },
      { currency: 'USDT', freeMinor: '10000000000', lockedMinor: '0', scale: 8 },
    ];
    const snapshot = (accountId, amount) => recordObservedBalances(ctx.tdb, {
      accountId, balances: wallet(amount), fundingCurrencies: amount === '0' ? [] : ['INR', 'USDT'],
    });
    await snapshot(accountIds[0], '10000000');
    await recordObservedBalances(ctx.tdb, { accountId: accountIds[0], balances: [wallet('12345')[0]], fundingCurrencies: ['INR'] });
    let rows = await ctx.tdb.selectFrom('account_balance').selectAll().where('account_id', '=', accountIds[0]).execute();
    assert(rows.find((row) => row.currency === 'INR').free_minor === '12345', 'fresh INR balance replaces saved INR');
    assert(rows.find((row) => row.currency === 'USDT').free_minor === '0', 'omitted zero USDT cannot retain an old balance');
    await snapshot(accountIds[0], '0');
    rows = await ctx.tdb.selectFrom('account_balance').selectAll().where('account_id', '=', accountIds[0]).execute();
    assert(rows.every((row) => row.free_minor === '0' && row.locked_minor === '0'), 'a successful empty wallet clears every old balance');
    await snapshot(accountIds[0], '12345');
    let rejected = false;
    try {
      await recordObservedBalances(ctx.tdb, { accountId: accountIds[0], fundingCurrencies: [], balances: [
        { currency: 'INR', freeMinor: 'invalid', lockedMinor: '0', scale: 2 },
      ] });
    } catch { rejected = true; }
    rows = await ctx.tdb.selectFrom('account_balance').selectAll().where('account_id', '=', accountIds[0]).execute();
    assert(rejected && rows.find((row) => row.currency === 'USDT').free_minor === '10000000000', 'snapshot errors roll back omitted-currency clearing');

    let reads = [], failId = null, amount = '5000000', active = 0, peak = 0, reactivateDuringRead = false;
    const books = bookProvider();
    server = createHttpServer({ db: ctx.db, getOrderBook: async (...args) => ({ ...await books.getOrderBook(...args), observedAtMs: Date.now() }),
      cookieSecret: Buffer.alloc(32, 7), verifySecondFactor: async () => false, kms: new LocalKms(),
      pepper: Buffer.alloc(32, 8), probe: async () => { throw new Error('not used'); }, codeVersion: 'balance-refresh-test',
      secureCookies: false,
      getFuturesInstrument: async () => ({ ok: true, instrument: { quantityIncrement: '0.00001', priceIncrement: '0.01', minNotional: '1', minQuantity: '0.00001' } }),
      accountSync: async ({ tenantId, accountId }) => {
        assert(tenantId === TENANT, 'every sync uses the authenticated tenant');
        reads.push(accountId); active++; peak = Math.max(peak, active);
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (accountId === failId) throw new Error('fake exchange unavailable');
          if (reactivateDuringRead) await ctx.tdb.updateTable('exchange_account').set({ status: 'active' }).where('id', '=', accountIds[3]).execute();
          await snapshot(accountId, amount);
          if (amount !== '0') await recordVenueBasis(ctx.tdb, { accountId, capitalMinor: amount, currency: 'INR' });
          return { currencies: amount === '0' ? [] : ['INR', 'USDT'], balances: wallet(amount).length };
        } finally { active--; }
      },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let cookie = '';
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    const login = await post('/api/login', { email: 'plan@t.example', password: 'balance-test-password-123' });
    cookie = `tradex_session=${/tradex_session=([^;]*)/.exec(login.headers.get('set-cookie'))?.[1]}`;
    assert(login.status === 200, 'test session established');
    reads = [];
    const manual = await post(`/api/accounts/${accountIds[0]}/sync`, {});
    assert(manual.status === 200 && reads.length === 1 && reads[0] === accountIds[0], 'manual account refresh reads the exchange port');
    const detail = await fetch(`${base}/api/groups/${groupId}`, { headers: { cookie } });
    const groupDetail = await detail.json();
    assert(detail.status === 200 && groupDetail.members.filter((member) => member.enabled && member.status === 'active').length === 2, 'group detail provides the exact active membership for selection refresh');
    reads = [];
    const unknownRefresh = await post(`/api/accounts/${randomUUID()}/sync`, {});
    assert(unknownRefresh.status === 404 && reads.length === 0, 'manual refresh cannot read an unowned account');
    const preview = async (scope, orderType = 'market', futures = false) => {
      reads = [];
      const response = await post('/api/group-trades/preview', { ...scope, asset: 'BTC', side: 'buy', orderType,
        sizingMode: 'pct_allocated', percentBp: 1000, ...(orderType === 'limit' ? { limitPrice: futures ? '30000' : '2500000' } : {}),
        ...(futures ? { isFutures: true, leverage: '5', quoteCurrency: 'USDT', marginCurrency: 'USDT', positionMarginType: 'isolated' } : { quoteCurrency: 'INR' }),
      });
      return { status: response.status, body: await response.json() };
    };
    for (const type of ['market', 'limit']) {
      const single = await preview({ groupId, accountId: accountIds[0] }, type);
      assert(single.status === 200 && reads.length === 1 && reads[0] === accountIds[0], `${type} single-account preview refreshes only that account`);
      const grouped = await preview({ groupId }, type);
      assert(grouped.status === 200 && reads.length === 2 && reads.every((id) => accountIds.slice(0, 2).includes(id)), `${type} group preview refreshes enabled active members only`);
      assert(grouped.body.rows.length === 3, 'inactive member is refused by planning while disabled member is excluded');
    }
    assert(peak >= 2, 'group exchange balance reads run concurrently');
    const defaultId = (await listGroups(ctx.tdb)).find((group) => group.name === DEFAULT_GROUP_NAME).id;
    for (const scope of [{ groupId: defaultId }, {}]) {
      const all = await preview(scope);
      const expected = [...accountIds.slice(0, 3), outside.accountIds[0]];
      assert(all.status === 200 && reads.length === expected.length && expected.every((id) => reads.includes(id)), 'explicit and implicit Default previews refresh all active accounts across groups');
    }
    const fallback = await preview({ groupId: outside.groupId, accountId: accountIds[0] });
    assert(fallback.status === 200 && reads.length === 1 && reads[0] === accountIds[0], 'planner fallback scope receives the same fresh-balance protection');
    for (const type of ['market', 'limit']) {
      const future = await preview({ groupId, accountId: accountIds[0] }, type, true);
      assert(future.status === 200 && reads.length === 1 && future.body.rows.length === 1, `${type} futures preview uses fresh balances`);
    }
    amount = '0';
    const empty = await preview({ groupId, accountId: accountIds[0] });
    assert(empty.status === 200 && empty.body.plannedCount === 0, 'preview refuses stale funded trades when the refreshed wallet is empty');
    const beforeCount = await ctx.tdb.selectFrom('group_trade').select('id').execute();
    failId = accountIds[1]; amount = '5000000';
    const failure = await preview({ groupId });
    assert(failure.status === 503 && failure.body.message.includes('Fresh balances'), 'one failed refresh blocks the entire preview');
    const afterCount = await ctx.tdb.selectFrom('group_trade').select('id').execute();
    assert(beforeCount.length === afterCount.length, 'failed freshness check persists no preview or executable token');
    reads = [];
    const retry = await post(`/api/group-trades/${empty.body.groupTradeId}/retry-failed`, {});
    assert(retry.status === 201 && reads.length === 1 && reads[0] === accountIds[0], 'retry-failed independently refreshes the failed subset');
    reads = [];
    const unowned = await preview({ groupId, accountIds: [accountIds[0], randomUUID()] });
    assert(unowned.status === 404 && reads.length === 0, 'mixed unowned scope is rejected before any exchange read');
    failId = null; reactivateDuringRead = true;
    const changed = await preview({ groupId });
    assert(changed.status === 503 && !reads.includes(accountIds[3]), 'reactivating an unsynced member mid-refresh requires a new preview');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await teardown(ctx);
  }
}
