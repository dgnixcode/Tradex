import { createHash } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import { forTenant } from '@tradex/db';
import type { DB, ResearchJobTable } from '@tradex/db';
import { ResearchError, validateResearchRequest } from './contracts.js';
import type { ResearchCapabilities, ResearchJob, ResearchReport } from './contracts.js';

export const DAILY_LIMIT = 10;
export const PENDING_LIMIT = 3;
export function mapResearchJob(row: Selectable<ResearchJobTable>): ResearchJob {
  return { id: row.id, request: validateResearchRequest(row.request), status: row.status, stage: row.stage,
    createdAt: row.created_at.toISOString(), startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null, errorCode: row.error_code, report: row.report as ResearchReport | null };
}

export class ResearchService {
  private readonly dailyLimit: number;
  private readonly pendingLimit: number;
  constructor(private readonly db: Kysely<DB>, private readonly enabled = false,
    policy: { dailyLimit?: number; pendingLimit?: number } = {}) {
    this.dailyLimit = policy.dailyLimit ?? DAILY_LIMIT;
    this.pendingLimit = policy.pendingLimit ?? PENDING_LIMIT;
    if (![this.dailyLimit, this.pendingLimit].every((n) => Number.isInteger(n) && n > 0 && n <= 1000)) {
      throw new Error('Research limits must be integers between 1 and 1000');
    }
  }

  async capabilities(tenantId?: string): Promise<ResearchCapabilities> {
    const live = this.enabled ? await this.db.selectFrom('research_worker').select('engine')
      .where('heartbeat_at', '>', new Date(Date.now() - 60_000)).execute() : [];
    const config = tenantId ? await forTenant(this.db, tenantId).selectFrom('research_ai_settings').select('id').executeTakeFirst() : undefined;
    const workerAvailable = live.some((w) => w.engine === 'tradingagents');
    const aiConfigured = Boolean(config);
    return { engines: [{ name: 'tradingagents', available: workerAvailable && aiConfigured }], workerAvailable, aiConfigured,
      dailyLimit: this.dailyLimit, pendingLimit: this.pendingLimit };
  }

  async create(tenantId: string, userId: string, body: unknown, key: unknown): Promise<ResearchJob> {
    const request = validateResearchRequest(body);
    if (request.engine !== 'tradingagents') throw new ResearchError(400, 'ADVANCED_RESEARCH_REQUIRED', 'Research uses the full TradingAgents analysis. Market snapshot reports are not available.');
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(key)) throw new ResearchError(400, 'INVALID_KEY', 'A valid Idempotency-Key is required.');
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return forTenant(this.db, tenantId).transaction(async (tdb) => {
      await tdb.lockResearch();
      const previous = await tdb.selectFrom('research_job').selectAll().where('idempotency_key', '=', key).executeTakeFirst();
      if (previous) {
        if (previous.request_hash !== hash) throw new ResearchError(409, 'KEY_CONFLICT', 'This request key was already used for different research.');
        return mapResearchJob(previous);
      }
      const config = await tdb.selectFrom('research_ai_settings').select('id').executeTakeFirst();
      if (!config) throw new ResearchError(409, 'AI_NOT_CONFIGURED', 'Set up your AI provider in Settings → AI Research before starting research.');
      if (!(await this.capabilities(tenantId)).workerAvailable) throw new ResearchError(503, 'ENGINE_UNAVAILABLE', 'The advanced research worker is currently offline. Return later.');
      const pending = await tdb.selectFrom('research_job').select((eb) => eb.fn.countAll<string>().as('count'))
        .where('status', 'in', ['queued', 'running']).executeTakeFirstOrThrow();
      const daily = await tdb.selectFrom('research_job').select((eb) => eb.fn.countAll<string>().as('count'))
        .where('created_at', '>', new Date(Date.now() - 86_400_000)).executeTakeFirstOrThrow();
      if (Number(pending.count) >= this.pendingLimit) throw new ResearchError(429, 'QUEUE_LIMIT', 'Finish or cancel pending research before starting another report.');
      if (Number(daily.count) >= this.dailyLimit) throw new ResearchError(429, 'DAILY_LIMIT', 'The research limit for the last 24 hours has been reached.');
      const row = await tdb.insertInto('research_job', { created_by: userId, idempotency_key: key, request_hash: hash,
        request: JSON.stringify(request), engine: request.engine, ai_config_id: config.id }).returningAll().executeTakeFirstOrThrow();
      await tdb.insertInto('audit_event', { actor_user_id: userId, actor_process: 'api', action: 'research.create',
        subject_type: 'research_job', subject_id: (row as Selectable<ResearchJobTable>).id, before: null,
        after: JSON.stringify({ symbol: request.symbol, engine: request.engine }) }).execute();
      return mapResearchJob(row as Selectable<ResearchJobTable>);
    });
  }

  async list(tenantId: string): Promise<ResearchJob[]> {
    // Report bodies are loaded individually; a history refresh stays bounded.
    const rows = await forTenant(this.db, tenantId).selectFrom('research_job')
      .select(['id', 'request', 'status', 'stage', 'created_at', 'started_at', 'finished_at', 'error_code'])
      .where('engine', '=', 'tradingagents')
      .orderBy('created_at', 'desc').orderBy('id', 'desc').limit(50).execute();
    return rows.map((row) => mapResearchJob({ ...row, report: null } as Selectable<ResearchJobTable>));
  }

  async get(tenantId: string, id: string): Promise<ResearchJob> {
    const row = await forTenant(this.db, tenantId).byId('research_job', id).selectAll().executeTakeFirst();
    if (!row || row.engine !== 'tradingagents') throw new ResearchError(404, 'NOT_FOUND', 'Research report not found.');
    return mapResearchJob(row);
  }

  async cancel(tenantId: string, userId: string, id: string): Promise<ResearchJob> {
    return forTenant(this.db, tenantId).transaction(async (tdb) => {
      const row = await tdb.updateTable('research_job').set({ status: 'cancelled', stage: 'Cancelled', finished_at: new Date(),
        lease_token: null, lease_expires_at: null, deadline_at: null }).where('id', '=', id)
        .where('status', 'in', ['queued', 'running']).returningAll().executeTakeFirst();
      if (!row) return this.get(tenantId, id);
      await tdb.insertInto('audit_event', { actor_user_id: userId, actor_process: 'api', action: 'research.cancel',
        subject_type: 'research_job', subject_id: id, before: null, after: JSON.stringify({ status: 'cancelled' }) }).execute();
      return mapResearchJob(row as Selectable<ResearchJobTable>);
    });
  }
}
