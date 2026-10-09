import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { claimResearchJob, expireResearchJobs, finishResearchJob, renewResearchLease } from './dist/research/queue.js';
import { validateResearchRequest, validateResearchReport } from './dist/research/contracts.js';
import { researchEnvironment, resolveResearchPython, runResearchProcess } from './dist/research/process.js';
import { ResearchKeyVault, researchJobEnvironment } from './dist/research/ai-settings.js';

const engine = 'tradingagents';
if (!process.env['DATABASE_URL']) throw new Error('DATABASE_URL is required');
const vault = new ResearchKeyVault(process.env['TRADEX_RESEARCH_ROOT_KEY'] ?? '');
const timeoutMs = Number(process.env['TRADEX_RESEARCH_TIMEOUT_MS'] ?? 900_000);
if (!Number.isInteger(timeoutMs) || timeoutMs < 30_000 || timeoutMs > 900_000) throw new Error('Research timeout must be between 30000 and 900000 ms');
const script = fileURLToPath(new URL('../research-engine/engine.py', import.meta.url));
const python = resolveResearchPython(process.env['TRADEX_RESEARCH_PYTHON'] ?? 'python');
const preflight = spawnSync(python, ['-I', script, '--check', 'tradingagents-package'], {
  shell: false, windowsHide: true, timeout: 30_000, encoding: 'utf8', env: researchEnvironment(process.env),
});
if (preflight.status !== 0) throw new Error('Research engine preflight failed. Check the dedicated Python environment, pinned TradingAgents install and provider configuration.');
const db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: process.env['DATABASE_URL'], max: 3 }) }) });
const id = randomUUID();
let stopping = false; let controller; let active; let stage = 'Collecting market evidence'; let ticking = false;
const heartbeat = async () => {
  if (ticking || stopping) return;
  ticking = true;
  try {
    await db.insertInto('research_worker').values({ id, engine, heartbeat_at: new Date() })
      .onConflict((oc) => oc.column('id').doUpdateSet({ heartbeat_at: new Date() })).execute();
    if (active && !await renewResearchLease(db, active.id, active.lease_token, stage)) controller?.abort();
  } catch { controller?.abort(); console.error('[research-worker] Database heartbeat failed'); }
  finally { ticking = false; }
};
const shutdown = () => { stopping = true; controller?.abort(); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
await heartbeat();
const timer = setInterval(() => { void heartbeat(); }, 5000);
console.log(`[research-worker] Ready (${engine}); one job per worker, one running job per tenant`);
try {
  while (!stopping) {
    try {
      await expireResearchJobs(db);
      active = await claimResearchJob(db, engine, timeoutMs);
      if (!active) { await new Promise((resolve) => setTimeout(resolve, 2000)); continue; }
      controller = new AbortController(); stage = 'Collecting market evidence';
      try {
        const request = validateResearchRequest(active.request);
        const env = await researchJobEnvironment(db, vault, active.tenant_id, active.ai_config_id, process.env);
        const raw = await runResearchProcess({ python, script, env,
          request, timeoutMs, signal: controller.signal, onStage: (next) => { stage = next; } });
        const report = validateResearchReport(raw, request);
        await finishResearchJob(db, active.id, active.lease_token, { report });
      } catch (error) {
        const allowed = ['TIMEOUT', 'CANCELLED', 'OUTPUT_LIMIT', 'PYTHON_UNAVAILABLE', 'DATA_UNAVAILABLE', 'AMBIGUOUS_COIN',
          'IDENTITY_MISMATCH', 'ENGINE_NOT_INSTALLED', 'LLM_NOT_CONFIGURED', 'BUDGET_EXCEEDED', 'ENGINE_FAILED', 'INVALID_REPORT', 'AI_CONFIG_CHANGED', 'AI_KEY_UNAVAILABLE'];
        const code = allowed.includes(error.message) ? error.message : 'ENGINE_FAILED';
        await finishResearchJob(db, active.id, active.lease_token, { errorCode: code });
      } finally { active = undefined; controller = undefined; }
    } catch { console.error('[research-worker] Queue operation failed; retrying'); await new Promise((resolve) => setTimeout(resolve, 5000)); }
  }
} finally {
  clearInterval(timer);
  await db.deleteFrom('research_worker').where('id', '=', id).execute();
  await db.destroy();
}
