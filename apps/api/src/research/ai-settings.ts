import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import { forTenant } from '@tradex/db';
import type { DB } from '@tradex/db';
import { ResearchError } from './contracts.js';
import { researchEnvironment } from './process.js';
import { runAiModelProbe, safeModelTest } from './ai-model-test.js';
import type { ResearchModelProbe, ResearchAiTestResult } from './ai-model-test.js';

export type ResearchProvider = 'openai' | 'anthropic' | 'google';
export interface ResearchAiSettings {
  readonly storageAvailable: boolean;
  readonly configured: boolean;
  readonly provider: ResearchProvider | null;
  readonly deepModel: string;
  readonly quickModel: string;
  readonly updatedAt: string | null;
}
export interface SaveResearchAiSettings {
  readonly provider: ResearchProvider;
  readonly deepModel: string;
  readonly quickModel: string;
  /** Write-only. Omit to retain the existing key for the same provider. */
  readonly apiKey?: string;
}

/** A separate research root cannot decrypt exchange credentials. Never sent to Python. */
export class ResearchKeyVault {
  readonly #root: Buffer;
  constructor(rootHex: string) {
    if (!/^[a-fA-F0-9]{64}$/.test(rootHex)) throw new Error('TRADEX_RESEARCH_ROOT_KEY must contain 64 hex characters');
    this.#root = Buffer.from(rootHex, 'hex');
  }
  private aad(tenantId: string, provider: ResearchProvider, id: string): Buffer {
    return Buffer.from(JSON.stringify(['tradex-research-key-v1', tenantId, provider, id]));
  }
  seal(tenantId: string, provider: ResearchProvider, id: string, key: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#root, nonce);
    cipher.setAAD(this.aad(tenantId, provider, id));
    const plain = Buffer.from(key);
    try {
      const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
      return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ct]);
    } finally { plain.fill(0); }
  }
  open(tenantId: string, provider: ResearchProvider, id: string, sealed: Uint8Array): string {
    const blob = Buffer.from(sealed);
    if (blob.length < 30 || blob[0] !== 1) throw new Error('AI_KEY_UNAVAILABLE');
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#root, blob.subarray(1, 13));
      decipher.setAAD(this.aad(tenantId, provider, id)); decipher.setAuthTag(blob.subarray(13, 29));
      const plain = Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
      try { return plain.toString('utf8'); } finally { plain.fill(0); }
    } catch { throw new Error('AI_KEY_UNAVAILABLE'); }
  }
}

function validateSettings(body: unknown): SaveResearchAiSettings {
  const fail = (): never => { throw new ResearchError(400, 'INVALID_AI_SETTINGS', 'Choose a supported provider and valid model IDs. Enter a new key when changing providers.'); };
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail();
  const v = body as Record<string, unknown>;
  if (Object.keys(v).some((k) => !['provider', 'deepModel', 'quickModel', 'apiKey'].includes(k))) return fail();
  if (!['openai', 'anthropic', 'google'].includes(String(v['provider']))) return fail();
  for (const name of ['deepModel', 'quickModel']) {
    if (typeof v[name] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(v[name])) return fail();
  }
  if (v['apiKey'] !== undefined && (typeof v['apiKey'] !== 'string' || !/^[\x21-\x7e]{16,2048}$/.test(v['apiKey']))) {
    throw new ResearchError(400, 'INVALID_AI_KEY', 'Enter a valid provider API key.');
  }
  return v as unknown as SaveResearchAiSettings;
}

export class ResearchAiSettingsService {
  constructor(private readonly db: Kysely<DB>, private readonly vault?: ResearchKeyVault,
    private readonly probe: ResearchModelProbe = runAiModelProbe) {}
  async test(tenantId: string, userId: string, body: unknown): Promise<ResearchAiTestResult> {
    const input = validateSettings(body);
    if (!this.vault) throw new ResearchError(503, 'AI_STORAGE_UNAVAILABLE', 'Secure AI key storage is unavailable. Contact your administrator.');
    if (activeTests >= 4) throw new ResearchError(429, 'AI_TEST_BUSY', 'Model testing is busy. Try again shortly.');
    activeTests++;
    try {
      const vault = this.vault;
      // A short transaction reserves spend across replicas. Never hold a database
      // transaction open while waiting for a provider or modify saved settings/jobs.
      const apiKey = await forTenant(this.db, tenantId).transaction(async (tdb) => {
        await tdb.lockResearch();
        const previous = input.apiKey ? undefined : await tdb.selectFrom('research_ai_settings').selectAll().executeTakeFirst();
        if (!input.apiKey && (!previous || previous.provider !== input.provider)) {
          throw new ResearchError(400, 'AI_KEY_REQUIRED', 'Paste an API key for the selected provider.');
        }
        const key = input.apiKey ?? vault.open(tenantId, previous!.provider, previous!.id, previous!.key_ct);
        const { now } = await tdb.selectFrom('app_user').select(sql<Date>`clock_timestamp()`.as('now'))
          .where('id', '=', userId).executeTakeFirstOrThrow();
        const recent = await tdb.selectFrom('audit_event').select(sql<Date>`occurred_at`.as('tested_at')).where('action', '=', 'research.ai.test')
          .where(sql<boolean>`occurred_at > ${new Date(now.getTime() - 3_600_000)}`).orderBy('occurred_at', 'desc').limit(10).execute();
        if (recent.length >= 10 || (recent[0] && recent[0].tested_at.getTime() > now.getTime() - 60_000)) {
          throw new ResearchError(429, 'AI_TEST_LIMIT', 'Wait one minute between model tests. A workspace can run up to 10 tests per hour.');
        }
        await tdb.insertInto('audit_event', { actor_user_id: userId, actor_process: 'api', action: 'research.ai.test',
          subject_type: 'tenant', subject_id: tenantId, before: null, occurred_at: now,
          after: JSON.stringify({ provider: input.provider, deepModel: input.deepModel, quickModel: input.quickModel }) }).execute();
        return key;
      });
      const env = researchEnvironment(process.env);
      for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'COINGECKO_DEMO_API_KEY']) delete env[key];
      env[{ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_API_KEY' }[input.provider]] = apiKey;
      env['TRADEX_RESEARCH_LLM_PROVIDER'] = input.provider;
      env['TRADEX_RESEARCH_DEEP_MODEL'] = input.deepModel;
      env['TRADEX_RESEARCH_QUICK_MODEL'] = input.quickModel;
      try {
        const raw = await this.probe({ env });
        return safeModelTest(raw);
      } catch {
        return safeModelTest({ deep: 'TEST_FAILED', quick: 'TEST_FAILED' });
      } finally {
        for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) delete env[key];
      }
    } finally { activeTests--; }
  }
  async get(tenantId: string): Promise<ResearchAiSettings> {
    // Explicit column selection: no ciphertext or key bytes cross the read API.
    const row = await forTenant(this.db, tenantId).selectFrom('research_ai_settings')
      .select(['provider', 'deep_model', 'quick_model', 'updated_at']).executeTakeFirst();
    return { storageAvailable: Boolean(this.vault), configured: Boolean(row), provider: row?.provider ?? null,
      deepModel: row?.deep_model ?? '', quickModel: row?.quick_model ?? '', updatedAt: row?.updated_at.toISOString() ?? null };
  }
  async save(tenantId: string, userId: string, body: unknown): Promise<ResearchAiSettings> {
    const input = validateSettings(body);
    if (!this.vault) throw new ResearchError(503, 'AI_STORAGE_UNAVAILABLE', 'Secure AI key storage is unavailable. Contact your administrator.');
    const vault = this.vault;
    await forTenant(this.db, tenantId).transaction(async (tdb) => {
      await tdb.lockResearch();
      const previous = await tdb.selectFrom('research_ai_settings').selectAll().executeTakeFirst();
      if (!input.apiKey && (!previous || previous.provider !== input.provider)) {
        throw new ResearchError(400, 'AI_KEY_REQUIRED', 'Paste an API key for the selected provider.');
      }
      const id = randomUUID();
      const key = input.apiKey ?? vault.open(tenantId, previous!.provider, previous!.id, previous!.key_ct);
      const keyCt = vault.seal(tenantId, input.provider, id, key);
      const values = { id, provider: input.provider, deep_model: input.deepModel, quick_model: input.quickModel,
        key_ct: keyCt, updated_by: userId, updated_at: new Date() };
      await tdb.insertInto('research_ai_settings', values).onConflict((oc) => oc.column('tenant_id').doUpdateSet(values)).execute();
      await tdb.updateTable('research_job').set({ status: 'cancelled', stage: 'AI configuration changed', finished_at: new Date(),
        lease_token: null, lease_expires_at: null, deadline_at: null }).where('engine', '=', 'tradingagents').where('status', 'in', ['queued', 'running']).execute();
      await tdb.insertInto('audit_event', { actor_user_id: userId, actor_process: 'api', action: 'research.ai.configure',
        subject_type: 'research_ai_settings', subject_id: id, before: null,
        after: JSON.stringify({ provider: input.provider, deepModel: input.deepModel, quickModel: input.quickModel, keyReplaced: Boolean(input.apiKey) }) }).execute();
    });
    return this.get(tenantId);
  }
  async remove(tenantId: string, userId: string): Promise<ResearchAiSettings> {
    await forTenant(this.db, tenantId).transaction(async (tdb) => {
      await tdb.lockResearch();
      await tdb.deleteFrom('research_ai_settings').execute();
      await tdb.updateTable('research_job').set({ status: 'cancelled', stage: 'AI credentials removed', finished_at: new Date(),
        lease_token: null, lease_expires_at: null, deadline_at: null }).where('engine', '=', 'tradingagents').where('status', 'in', ['queued', 'running']).execute();
      await tdb.insertInto('audit_event', { actor_user_id: userId, actor_process: 'api', action: 'research.ai.remove',
        subject_type: 'tenant', subject_id: tenantId, before: null, after: JSON.stringify({ configured: false }) }).execute();
    });
    return this.get(tenantId);
  }
}

let activeTests = 0;

/** Called only in a worker. Reads one tenant and refuses changed job configuration. */
export async function researchJobEnvironment(db: Kysely<DB>, vault: ResearchKeyVault, tenantId: string, configId: string | null,
  base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const row = await forTenant(db, tenantId).selectFrom('research_ai_settings').selectAll().executeTakeFirst();
  if (!row || row.id !== configId) throw new Error('AI_CONFIG_CHANGED');
  const env = researchEnvironment(base);
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']) delete env[key];
  const providerKey = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', google: 'GOOGLE_API_KEY' }[row.provider];
  env[providerKey] = vault.open(tenantId, row.provider, row.id, row.key_ct);
  env['TRADEX_RESEARCH_LLM_PROVIDER'] = row.provider;
  env['TRADEX_RESEARCH_DEEP_MODEL'] = row.deep_model;
  env['TRADEX_RESEARCH_QUICK_MODEL'] = row.quick_model;
  return env;
}
