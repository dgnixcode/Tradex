// Reproduce a new API running before migrations 035–039, then recover with the
// existing forward migrations. Disposable local schema; no exchange send port.
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readMigrationStatus, loadMigrations, dailySpentMinor } from '../packages/db/dist/index.js';
import { createHttpServer } from '../apps/api/dist/index.js';
import { hashPassword } from '../packages/auth/dist/index.js';
import { LocalKms } from '../packages/crypto/dist/index.js';
import { ResearchKeyVault } from '../apps/api/dist/research/ai-settings.js';
import { setup, teardown, seedGroupOfAccounts, ingestMarkets, USER, TENANT, bookProvider } from './_plan-harness.mjs';

export async function run(assert) {
  const ctx = await setup('apiupgrade23');
  if (!ctx) { assert(true, 'skipped without DATABASE_URL'); return; }
  let server;
  try {
    const files = loadMigrations('db/migrations');
    await ctx.pool.query('DROP TABLE schema_migration');
    const emptyStatus = await readMigrationStatus(ctx.pool, 'db/migrations');
    assert(emptyStatus.every(row => !row.applied), 'missing migration history is reported as pending');
    assert((await ctx.pool.query('SELECT to_regclass($1) AS present', [`${ctx.schema}.schema_migration`])).rows[0].present === null, 'read-only status does not create migration history');
    await ctx.pool.query('CREATE TABLE schema_migration (version text PRIMARY KEY, checksum text NOT NULL)');
    for (const file of files.filter(file => file.version < '035')) await ctx.pool.query('INSERT INTO schema_migration VALUES ($1, $2)', [file.version, file.checksum]);
    const releaseEnv = { ...process.env, DATABASE_URL: `${process.env.DATABASE_URL}?options=${encodeURIComponent(`-c search_path=${ctx.schema},public`)}` };
    const execute = promisify(execFile);
    let blocked = false;
    try { await execute(process.execPath, ['scripts/deploy-guard.mjs'], { env: releaseEnv, windowsHide: true }); }
    catch (error) { blocked = error.code === 1 && error.stderr.includes('035_position_mutation_safety') && error.stderr.includes('039_trailing_roe_steps'); }
    assert(blocked, 'activation guard refuses the production migration mismatch');
    await ingestMarkets(ctx.db);
    const { groupId, accountIds: [accountId] } = await seedGroupOfAccounts(ctx, ['10000000']);
    await ctx.pool.query(`INSERT INTO account_balance (tenant_id, account_id, currency, free_minor, locked_minor, scale, observed_at)
      VALUES ($1, $2, 'USDT', '1000000000000', '0', 8, now())`, [TENANT, accountId]);
    await ctx.tdb.updateTable('app_user').set({ password_hash: await hashPassword('api-upgrade-test-password') }).where('id', '=', USER).execute();
    const books = bookProvider();
    server = createHttpServer({ db: ctx.db, cookieSecret: Buffer.alloc(32, 0x63), pepper: Buffer.alloc(32, 0x64),
      kms: new LocalKms(), verifySecondFactor: async () => false, probe: async () => ({ ok: false }),
      codeVersion: 'api-upgrade-test', secureCookies: false, researchVault: new ResearchKeyVault('aa'.repeat(32)),
      getOrderBook: async (market) => market.asset === 'USDT'
        ? { market, asks: [{ price: '83.5', quantity: '100000' }], bids: [{ price: '83.5', quantity: '100000' }], observedAtMs: Date.now() }
        : { ...await books.getOrderBook(market), observedAtMs: Date.now() },
      getFuturesInstrument: async () => ({ ok: true, instrument: { quantityIncrement: '0.00001', priceIncrement: '0.01',
        minNotional: '1', minQuantity: '0.00001', leverageTiers: [{ upToNotional: '1000000', maxLeverage: 20 }] } }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const login = await post('/api/login', { email: 'plan@t.example', password: 'api-upgrade-test-password' });
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    assert(login.status === 200 && cookie, 'synthetic owner login succeeds');
    const intent = { groupId, asset: 'BTC', side: 'buy', orderType: 'market', sizingMode: 'base_quantity', sizingValue: '0.001',
      isFutures: true, leverage: '5', marginCurrency: 'USDT', quoteCurrency: 'USDT', positionMarginType: 'isolated' };
    await ctx.pool.query('DROP TABLE research_ai_settings');
    await ctx.pool.query('DROP TABLE research_job, research_worker');
    await ctx.pool.query('ALTER TABLE child_order DROP COLUMN position_mutation_request_id, DROP COLUMN send_started_at');
    await ctx.pool.query('DROP TABLE position_mutation');
    await ctx.pool.query('ALTER TABLE algo_strategy DROP COLUMN execution_token, DROP COLUMN execution_started_at');
    await ctx.pool.query('ALTER TABLE futures_closed_trade ALTER COLUMN roe_pct TYPE double precision USING roe_pct::double precision');
    await ctx.pool.query('ALTER TABLE group_trade DROP COLUMN trailing_step_basis');
    await ctx.pool.query('ALTER TABLE futures_trailing_sl DROP COLUMN step_basis, DROP COLUMN step_anchor_price, DROP COLUMN position_basis_key');
    const aiBefore = await fetch(base + '/api/settings/research-ai', { headers: { cookie } });
    const aiError = await aiBefore.json();
    assert(aiBefore.status === 503 && aiError.error === 'DATABASE_UPDATE_REQUIRED', `missing AI migration is actionable: ${aiBefore.status} ${JSON.stringify(aiError)}`);
    const tradeBefore = await post('/api/group-trades/preview', intent, cookie);
    const tradeError = await tradeBefore.json();
    assert(tradeBefore.status === 503 && tradeError.error === 'DATABASE_UPDATE_REQUIRED', `missing trading migration is actionable: ${tradeBefore.status} ${JSON.stringify(tradeError)}`);
    const beforeRows = await ctx.tdb.selectFrom('group_trade').select('id').execute();
    assert(beforeRows.length === 0, 'failed preview leaves no partially persisted trade');
    for (const name of ['035_position_mutation_safety.sql', '036_roe_decimal_storage.sql', '037_research_jobs.sql', '038_research_ai_settings.sql', '039_trailing_roe_steps.sql']) await ctx.pool.query(readFileSync(`db/migrations/${name}`, 'utf8'));
    for (const file of files.filter(file => file.version >= '035')) await ctx.pool.query('INSERT INTO schema_migration VALUES ($1, $2)', [file.version, file.checksum]);
    assert((await readMigrationStatus(ctx.pool, 'db/migrations')).every(row => row.applied), 'completed upgrade passes the read-only schema check');
    const guard = await execute(process.execPath, ['scripts/deploy-guard.mjs'], { env: releaseEnv, windowsHide: true });
    assert(guard.stdout.includes('PASS deploy-guard'), 'activation guard accepts a current, idle database');
    await ctx.pool.query("UPDATE schema_migration SET checksum = 'changed' WHERE version = $1", [files[0].version]);
    let immutable = false;
    try { await readMigrationStatus(ctx.pool, 'db/migrations'); } catch (error) { immutable = error.name === 'MigrationError'; }
    assert(immutable, 'edited applied migrations are refused');
    await ctx.pool.query('UPDATE schema_migration SET checksum = $1 WHERE version = $2', [files[0].checksum, files[0].version]);
    const aiAfter = await fetch(base + '/api/settings/research-ai', { headers: { cookie } });
    const settings = await aiAfter.json();
    assert(aiAfter.status === 200 && settings.storageAvailable && !settings.configured, 'AI settings loads after the matching forward migration');
    assert(!('apiKey' in settings) && !('key_ct' in settings), 'AI settings never exposes a saved provider key');
    for (const scope of [{ groupId }, { accountId }]) {
      for (const orderType of ['market', 'limit']) {
        const result = await post('/api/group-trades/preview', { ...intent, groupId: undefined, ...scope, orderType, ...(orderType === 'limit' ? { limitPrice: '80000' } : {}) }, cookie);
        const preview = await result.json();
        assert(result.status === 200 && preview.plannedCount === 1, `${Object.keys(scope)[0]} ${orderType} preview recovers: ${JSON.stringify(preview)}`);
        const confirm = await post(`/api/group-trades/${preview.groupTradeId}/confirm`, { previewToken: preview.previewToken }, cookie);
        assert(confirm.status === 200, 'isolated dry-run confirmation succeeds without any exchange send');
      }
    }
    const historical = await ctx.pool.query(`INSERT INTO group_trade
      (tenant_id, group_id, created_by, asset, side, order_type, sizing_mode, sizing_value, status, preview_token, preview_expires_at, is_futures, leverage, margin_currency, position_margin_type)
      VALUES ($1,$2,$3,'BTC','buy','market','base_quantity','0.001','completed','historical-token',now(),true,'1.6','INR','isolated') RETURNING id`, [TENANT,groupId,USER]);
    await ctx.pool.query(`INSERT INTO child_order (tenant_id, group_trade_id, account_id, leg_seq, state, notional_minor, quote_currency)
      VALUES ($1,$2,$3,0,'filled','101','INR')`, [TENANT,historical.rows[0].id,accountId]);
    assert(await dailySpentMinor(ctx.tdb, accountId, 'INR', 0, true) === '64', 'historical 1.6x leverage reserves exact margin rounded up');
    assert(await dailySpentMinor(ctx.tdb, accountId, 'INR', 0, false) === '101', 'notional daily limits retain the original full notional');
    await ctx.pool.query('UPDATE group_trade SET leverage = $1 WHERE id = $2', ['1.600000000000000001',historical.rows[0].id]);
    assert(await dailySpentMinor(ctx.tdb, accountId, 'INR', 0, true) === '64', 'fractional leverage retains 18-place precision');
    const withHistory = await post('/api/group-trades/preview', intent, cookie);
    assert(withHistory.status === 200, 'new preview succeeds with fractional historical leverage');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await teardown(ctx);
  }
}
