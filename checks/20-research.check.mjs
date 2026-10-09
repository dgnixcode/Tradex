import { randomUUID, createHash } from 'node:crypto';
import { setup, teardown, TENANT, USER, bookProvider } from './_plan-harness.mjs';
import { forTenant } from '../packages/db/dist/index.js';
import { hashPassword } from '../packages/auth/dist/index.js';
import { LocalKms } from '../packages/crypto/dist/index.js';
import { createHttpServer } from '../apps/api/dist/index.js';
import { ResearchService } from '../apps/api/dist/research/service.js';
import { ResearchKeyVault, ResearchAiSettingsService, researchJobEnvironment } from '../apps/api/dist/research/ai-settings.js';
import { validateResearchReport } from '../apps/api/dist/research/contracts.js';
import { claimResearchJob, renewResearchLease, finishResearchJob, expireResearchJobs } from '../apps/api/dist/research/queue.js';

export async function run(assert) {
  const ctx = await setup('research20');
  if (!ctx) throw new Error('DATABASE_URL is required to verify research concurrency and tenant isolation');
  let server;
  try {
    const service = new ResearchService(ctx.db, true);
    const vault = new ResearchKeyVault('aa'.repeat(32));
    const ai = new ResearchAiSettingsService(ctx.db, vault);
    const configA = { provider: 'openai', deepModel: 'test-deep', quickModel: 'test-quick', apiKey: 'synthetic-openai-provider-key-a' };
    const request = { symbol: 'BTC-USD', assetType: 'crypto', horizon: 'month', engine: 'tradingagents' };
    const key = () => randomUUID();
    assert(!(await service.capabilities()).engines.some((e) => e.available), 'an absent worker must not advertise research availability');
    await ctx.db.insertInto('research_worker').values({ id: key(), engine: 'tradingagents', heartbeat_at: new Date() }).execute();
    let noConfig;
    try { await service.create(TENANT, USER, request, key()); } catch (e) { noConfig = e; }
    assert(noConfig?.code === 'AI_NOT_CONFIGURED', 'research needs the workspace provider configuration');
    const savedA = await ai.save(TENANT, USER, configA);
    assert(savedA.configured && !JSON.stringify(savedA).includes(configA.apiKey) && !('apiKey' in savedA), 'save responses never return a provider key');
    const encryptedA = await ctx.tdb.selectFrom('research_ai_settings').selectAll().executeTakeFirstOrThrow();
    assert(!encryptedA.key_ct.includes(Buffer.from(configA.apiKey)), 'the database stores ciphertext instead of the plaintext provider key');
    assert((await service.capabilities(TENANT)).engines.length === 1 && (await service.capabilities(TENANT)).engines[0].name === 'tradingagents', 'only advanced TradingAgents research is offered');
    let basic;
    try { await service.create(TENANT, USER, { ...request, engine: 'snapshot' }, key()); } catch (e) { basic = e; }
    assert(basic?.code === 'ADVANCED_RESEARCH_REQUIRED', 'snapshot report submissions must be rejected');
    const replayKey = key();
    const duplicate = await Promise.all(Array.from({ length: 6 }, () => service.create(TENANT, USER, request, replayKey)));
    assert(new Set(duplicate.map((j) => j.id)).size === 1, 'concurrent duplicate requests must create exactly one research job');
    let conflict;
    try { await service.create(TENANT, USER, { ...request, symbol: 'ETH' }, replayKey); } catch (e) { conflict = e; }
    assert(conflict?.status === 409, 'the same key must never authorize a different instrument');
    const enqueue = await Promise.allSettled(Array.from({ length: 6 }, () => service.create(TENANT, USER, request, key())));
    assert(enqueue.filter((r) => r.status === 'fulfilled').length === 2, 'concurrent enqueues must honor the tenant pending cap of three');
    assert(enqueue.filter((r) => r.status === 'rejected').every((r) => r.reason.status === 429), 'excess enqueues must be refused with a quota response');
    const claims = await Promise.allSettled(Array.from({ length: 6 }, () => claimResearchJob(ctx.db, 'tradingagents', 60_000)));
    const claimed = claims.filter((r) => r.status === 'fulfilled' && r.value).map((r) => r.value);
    assert(claimed.length === 1, 'only one worker may run a tenant research job at a time');
    const job = claimed[0];
    assert(await renewResearchLease(ctx.db, job.id, job.lease_token, 'Running research analysts'), 'the current lease must renew');
    assert(!await renewResearchLease(ctx.db, job.id, key(), 'Forged worker'), 'a stale or forged lease must not renew');
    await service.cancel(TENANT, USER, job.id);
    assert(!await finishResearchJob(ctx.db, job.id, job.lease_token, { errorCode: 'ENGINE_FAILED' }), 'a cancelled worker must not overwrite the terminal state');
    const second = await claimResearchJob(ctx.db, 'tradingagents', 60_000);
    assert(second && second.id !== job.id, 'cancelling must free the tenant research slot');
    await ctx.tdb.updateTable('research_job').set({ lease_expires_at: new Date(0) }).where('id', '=', second.id).execute();
    await expireResearchJobs(ctx.db);
    const expired = await service.get(TENANT, second.id);
    assert(expired.status === 'failed' && expired.errorCode === 'WORKER_INTERRUPTED', 'a crashed worker must become a known failure instead of repeating a paid run');
    assert(!await finishResearchJob(ctx.db, second.id, second.lease_token, { errorCode: 'ENGINE_FAILED' }), 'an expired worker must not finish its former job');

    const tenantB = key(), userB = key();
    await ctx.db.insertInto('tenant').values({ id: tenantB, name: 'Research tenant B', valuation_currency: 'INR' }).execute();
    await forTenant(ctx.db, tenantB).insertInto('app_user', { id: userB, email: 'research-b@example.test', password_hash: await hashPassword('research-test-password'), role: 'owner' }).execute();
    assert(!(await ai.get(tenantB)).configured, 'another tenant cannot see a configured provider from tenant A');
    const configB = { provider: 'anthropic', deepModel: 'test-b-deep', quickModel: 'test-b-quick', apiKey: 'synthetic-anthropic-provider-key-b' };
    await ai.save(tenantB, userB, configB);
    const probeEnvs = [];
    const testAi = new ResearchAiSettingsService(ctx.db, vault, async ({ env }) => {
      probeEnvs.push({ ...env });
      return { deep: 'OK', quick: 'AUTH_FAILED', message: configB.apiKey, apiKey: configB.apiKey };
    });
    const modelsB = { provider: configB.provider, deepModel: configB.deepModel, quickModel: configB.quickModel };
    const testConfigBefore = await forTenant(ctx.db, tenantB).selectFrom('research_ai_settings').selectAll().executeTakeFirstOrThrow();
    const testedB = await testAi.test(tenantB, userB, modelsB);
    assert(testedB.deep.ok && testedB.quick.code === 'AUTH_FAILED' && !JSON.stringify(testedB).includes(configB.apiKey), 'model tests expose only fixed outcomes for both roles');
    assert(probeEnvs[0].ANTHROPIC_API_KEY === configB.apiKey && !probeEnvs[0].OPENAI_API_KEY && !probeEnvs[0].DATABASE_URL && !probeEnvs[0].TRADEX_RESEARCH_ROOT_KEY, 'a saved-key test receives only the current tenant provider credential');
    const testConfigAfter = await forTenant(ctx.db, tenantB).selectFrom('research_ai_settings').selectAll().executeTakeFirstOrThrow();
    assert(testConfigBefore.id === testConfigAfter.id && testConfigBefore.key_ct.equals(testConfigAfter.key_ct), 'testing never mutates saved credentials or configuration revisions');
    let providerMismatch;
    try { await testAi.test(tenantB, userB, { ...modelsB, provider: 'google' }); } catch (e) { providerMismatch = e; }
    assert(providerMismatch?.code === 'AI_KEY_REQUIRED', 'a saved key is never used for a different provider');
    let testLimited;
    try { await testAi.test(tenantB, userB, modelsB); } catch (e) { testLimited = e; }
    assert(testLimited?.code === 'AI_TEST_LIMIT' && probeEnvs.length === 1, 'rapid repeated tests are blocked before another provider call');
    const tenantC = key(), userC = key();
    await ctx.db.insertInto('tenant').values({ id: tenantC, name: 'Model-test quota tenant', valuation_currency: 'INR' }).execute();
    await forTenant(ctx.db, tenantC).insertInto('app_user', { id: userC, email: 'model-quota@example.test', password_hash: await hashPassword('research-test-password'), role: 'owner' }).execute();
    for (let i = 0; i < 10; i++) await forTenant(ctx.db, tenantC).insertInto('audit_event', {
      actor_user_id: userC, actor_process: 'api', action: 'research.ai.test', subject_type: 'tenant', subject_id: tenantC,
      before: null, after: null, occurred_at: new Date(Date.now() - 120_000 - i * 1000),
    }).execute();
    testLimited = undefined;
    try { await testAi.test(tenantC, userC, configA); } catch (e) { testLimited = e; }
    assert(testLimited?.code === 'AI_TEST_LIMIT' && probeEnvs.length === 1, 'ten rolling hourly reservations prevent more provider tests');
    const b = await service.create(tenantB, userB, { ...request, assetType: 'stock', symbol: 'AAPL' }, key());
    const bRow = await forTenant(ctx.db, tenantB).byId('research_job', b.id).selectAll().executeTakeFirstOrThrow();
    const bEnv = await researchJobEnvironment(ctx.db, vault, tenantB, bRow.ai_config_id, { DATABASE_URL: 'private-db', TRADEX_RESEARCH_ROOT_KEY: 'private-root', OPENAI_API_KEY: configA.apiKey });
    assert(bEnv.ANTHROPIC_API_KEY === configB.apiKey && !bEnv.OPENAI_API_KEY && !bEnv.DATABASE_URL && !bEnv.TRADEX_RESEARCH_ROOT_KEY, 'each worker subprocess receives only its tenant provider key and never vault/database credentials');
    let wrongRevision;
    try { await researchJobEnvironment(ctx.db, vault, TENANT, bRow.ai_config_id, {}); } catch (e) { wrongRevision = e; }
    assert(wrongRevision?.message === 'AI_CONFIG_CHANGED', 'a worker cannot use a different tenant configuration revision');
    assert(!(await service.list(TENANT)).some((j) => j.id === b.id), 'history must exclude other tenants');
    let leak;
    try { await service.get(TENANT, b.id); } catch (e) { leak = e; }
    assert(leak?.status === 404, 'an arbitrary report ID must not reveal another tenant report');
    let cancelledOther;
    try { await service.cancel(TENANT, USER, b.id); } catch (e) { cancelledOther = e; }
    assert(cancelledOther?.status === 404, 'one tenant cannot cancel another tenant job');
    const third = await claimResearchJob(ctx.db, 'tradingagents', 60_000);
    const fourth = await claimResearchJob(ctx.db, 'tradingagents', 60_000);
    assert(third && fourth && third.tenant_id !== fourth.tenant_id, 'workers must make concurrent progress for different tenants');
    const snapshot = '{"value":"10"}'; const timestamp = new Date().toISOString();
    const report = validateResearchReport({ schemaVersion: 1, request: third.request, summary: 'Persisted evidence',
      generatedAt: timestamp, analysisDate: timestamp.slice(0, 10), instrument: { symbol: third.request.symbol, name: 'Test instrument', currency: 'USD', exchange: 'Test' },
      engine: { name: 'tradingagents', version: 'test', models: ['test-deep', 'test-analyst'] }, metrics: [{ label: 'Test observation', value: '10', sourceId: 'fixture' }],
      sources: [{ id: 'fixture', title: 'Test evidence', provider: 'Fixture', url: 'https://example.com/evidence', retrievedAt: timestamp, asOf: timestamp,
        snapshot, sha256: createHash('sha256').update(snapshot).digest('hex') }], sections: ['Research conclusion', 'Investment thesis', 'Trade scenarios', 'Technical interpretation', 'Sentiment interpretation', 'News and catalysts', 'Bull and bear debate', 'Risk review', ...(third.request.assetType === 'stock' ? ['Company fundamentals'] : [])]
        .map((title) => ({ title, content: 'Controlled research interpretation.', kind: 'interpretation', sourceIds: [] })), warnings: [], coverage: [], usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 } }, third.request);
    assert(await finishResearchJob(ctx.db, third.id, third.lease_token, { report }), 'a current worker can atomically publish its validated report');
    assert((await service.get(third.tenant_id, third.id)).report.summary === 'Persisted evidence', 'a completed report must survive a fresh service read');
    assert((await service.list(third.tenant_id)).every((j) => j.report === null), 'history must not load full report bodies');
    await finishResearchJob(ctx.db, fourth.id, fourth.lease_token, { errorCode: 'ENGINE_FAILED' });

    const limited = new ResearchService(ctx.db, true, { dailyLimit: 2, pendingLimit: 1 });
    const quotaKey = key();
    const firstQuotaJob = await limited.create(tenantB, userB, request, quotaKey);
    await limited.cancel(tenantB, userB, firstQuotaJob.id);
    // Tenant B already submitted one earlier job: cancellations must not erase
    // its spend reservation or let another request bypass the rolling daily cap.
    let dailyError;
    try { await limited.create(tenantB, userB, request, key()); } catch (e) { dailyError = e; }
    assert(dailyError?.code === 'DAILY_LIMIT', 'cancelled work must still count toward the daily spend quota');
    assert((await limited.create(tenantB, userB, request, quotaKey)).id === firstQuotaJob.id, 'replaying an accepted request must not consume another daily reservation');

    // Real HTTP requests prove role enforcement and authenticated routing.
    const viewer = key();
    await ctx.tdb.insertInto('app_user', { id: viewer, email: 'research-viewer@example.test', password_hash: await hashPassword('research-test-password'), role: 'viewer' }).execute();
    await ctx.tdb.updateTable('app_user').set({ password_hash: await hashPassword('research-test-password') }).where('id', '=', USER).execute();
    server = createHttpServer({ db: ctx.db, getOrderBook: bookProvider().getOrderBook, cookieSecret: Buffer.alloc(32, 0x74),
      verifySecondFactor: async () => false, kms: new LocalKms(Buffer.alloc(32, 0x75)), pepper: Buffer.alloc(32, 0x76),
      probe: async () => ({ ok: false, reason: 'not used' }), codeVersion: 'research-check', secureCookies: false, researchEnabled: true, researchVault: vault,
      researchModelProbe: async ({ env }) => { probeEnvs.push({ ...env }); return { deep: 'OK', quick: 'MODEL_UNAVAILABLE', secret: env.OPENAI_API_KEY }; } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': key(), ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    assert((await fetch(base + '/api/research/jobs')).status === 401, 'anonymous research reads must be refused');
    assert((await fetch(base + '/api/settings/research-ai')).status === 401, 'anonymous provider settings access must be refused');
    assert((await post('/api/settings/research-ai/test', configA)).status === 401, 'anonymous model tests must be refused');
    const viewerLogin = await post('/api/login', { email: 'research-viewer@example.test', password: 'research-test-password' });
    const cookie = viewerLogin.headers.get('set-cookie').split(';')[0];
    const putAi = (input, credential) => fetch(base + '/api/settings/research-ai', { method: 'PUT', headers: { 'content-type': 'application/json', cookie: credential }, body: JSON.stringify(input) });
    assert((await putAi(configA, cookie)).status === 403, 'viewers cannot change provider credentials');
    assert((await post('/api/settings/research-ai/test', configA, cookie)).status === 403, 'viewers cannot run paid model tests');
    assert((await fetch(base + '/api/settings/research-ai', { method: 'DELETE', headers: { cookie } })).status === 403, 'viewers cannot remove provider credentials');
    const safeRead = await fetch(base + '/api/settings/research-ai', { headers: { cookie } });
    const safeText = await safeRead.text();
    assert(safeRead.status === 200 && safeRead.headers.get('cache-control') === 'no-store' && !safeText.includes(configA.apiKey) && !safeText.includes('key_ct'), 'settings reads return only uncached metadata');
    assert((await post('/api/research/jobs', request, cookie)).status === 403, 'a viewer cannot start paid research');
    assert((await post('/api/research/jobs/' + b.id + '/cancel', {}, cookie)).status === 403, 'a viewer cannot cancel research');
    assert((await fetch(base + '/api/research/jobs', { headers: { cookie } })).status === 200, 'viewers can read saved research');
    assert((await fetch(base + '/api/research/jobs/' + b.id, { headers: { cookie } })).status === 404, 'HTTP report reads must preserve tenant isolation');
    const ownerLogin = await post('/api/login', { email: 'plan@t.example', password: 'research-test-password' });
    const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];
    const created = await post('/api/research/jobs', request, ownerCookie);
    assert(created.status === 202 && (await created.json()).status === 'queued', 'an owner research request must enqueue and return immediately');
    assert((await post('/api/research/jobs', { ...request, date: '2020-01-01' }, ownerCookie)).status === 400, 'historical analysis must be rejected over HTTP until data is point-in-time');
    const configBeforeTest = await ctx.tdb.selectFrom('research_ai_settings').selectAll().executeTakeFirstOrThrow();
    const jobsBeforeTest = await service.list(TENANT);
    assert((await post('/api/settings/research-ai/test', { ...configA, endpoint: 'https://example.test' }, ownerCookie)).status === 400, 'model tests reject custom destinations and extra input');
    const pastedTestKey = 'synthetic-transient-provider-key';
    const concurrentTests = await Promise.all(Array.from({ length: 3 }, () => post('/api/settings/research-ai/test', { ...configA, apiKey: pastedTestKey }, ownerCookie)));
    assert(concurrentTests.filter((r) => r.status === 200).length === 1 && concurrentTests.filter((r) => r.status === 429).length === 2, 'concurrent HTTP tests atomically reserve a single workspace test');
    const tested = concurrentTests.find((r) => r.status === 200);
    const testText = await tested.text();
    assert(tested.headers.get('cache-control') === 'no-store' && !testText.includes(pastedTestKey) && JSON.parse(testText).quick.code === 'MODEL_UNAVAILABLE', 'HTTP model-test responses are uncached and never contain transient credentials or raw provider content');
    assert(probeEnvs.at(-1).OPENAI_API_KEY === pastedTestKey, 'a pasted key overrides the saved key only for this test');
    const configAfterTest = await ctx.tdb.selectFrom('research_ai_settings').selectAll().executeTakeFirstOrThrow();
    assert(configAfterTest.id === configBeforeTest.id && configAfterTest.key_ct.equals(configBeforeTest.key_ct) && JSON.stringify(await service.list(TENANT)) === JSON.stringify(jobsBeforeTest), 'testing does not save credentials, create jobs, or cancel existing research');
    const aiUpdated = await putAi({ ...configA, apiKey: 'synthetic-replacement-provider-key-a' }, ownerCookie);
    assert(aiUpdated.status === 200 && !(await aiUpdated.text()).includes('synthetic-replacement-provider-key-a'), 'owners can replace a provider key without retrieving it');
    assert((await service.list(TENANT)).filter((j) => ['queued', 'running'].includes(j.status)).length === 0, 'changing credentials cancels unfinished jobs for that workspace');
    assert((await ai.get(tenantB)).provider === 'anthropic', 'credential replacement never modifies another workspace');
    const beforeRetain = await ctx.tdb.selectFrom('research_ai_settings').selectAll().executeTakeFirstOrThrow();
    await ai.save(TENANT, USER, { provider: 'openai', deepModel: 'updated-deep', quickModel: 'test-quick' });
    const retained = await ctx.tdb.selectFrom('research_ai_settings').selectAll().executeTakeFirstOrThrow();
    assert(retained.id !== beforeRetain.id && vault.open(TENANT, 'openai', retained.id, retained.key_ct) === 'synthetic-replacement-provider-key-a', 'model edits retain the key by re-encrypting it under a new configuration revision');
    let needsKey;
    try { await ai.save(TENANT, USER, { provider: 'google', deepModel: 'test', quickModel: 'test' }); } catch (e) { needsKey = e; }
    assert(needsKey?.code === 'AI_KEY_REQUIRED', 'a provider switch needs a new key');
    const audit = await ctx.tdb.selectFrom('audit_event').select(['before', 'after']).where('action', 'like', 'research.ai.%').execute();
    assert(!JSON.stringify(audit).includes(configA.apiKey) && !JSON.stringify(audit).includes('synthetic-replacement-provider-key-a'), 'audit events never contain credentials or encrypted key material');
    await ctx.tdb.updateTable('app_user').set({ totp_secret_ct: Buffer.alloc(32, 1), totp_enabled: true }).where('id', '=', USER).execute();
    assert((await putAi(configA, ownerCookie)).status === 403, 'owners enrolled in 2FA must supply a fresh second factor before changing keys');
    assert((await post('/api/settings/research-ai/test', configA, ownerCookie)).status === 403, 'enrolled owners need a fresh second factor before paid model tests');
    await ctx.tdb.updateTable('app_user').set({ totp_secret_ct: null, totp_enabled: false }).where('id', '=', USER).execute();
    const remove = await fetch(base + '/api/settings/research-ai', { method: 'DELETE', headers: { cookie: ownerCookie } });
    assert(remove.status === 200 && !(await remove.json()).configured, 'owners can remove their saved key');
    assert(!(await ai.get(TENANT)).configured && (await ai.get(tenantB)).configured, 'removal is tenant scoped');
    await ctx.db.deleteFrom('research_worker').execute();
    const replay = await service.create(TENANT, USER, request, replayKey);
    assert(replay.id === duplicate[0].id, 'idempotent replays must work even while the engine is offline');
    let offline;
    try { await service.create(tenantB, userB, request, key()); } catch (e) { offline = e; }
    assert(offline?.status === 503, 'new work must not silently accumulate without a live worker');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await teardown(ctx);
  }
}
