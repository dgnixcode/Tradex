import { createHash } from 'node:crypto';

export type ResearchEngine = 'snapshot' | 'tradingagents';
export type ResearchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export interface ResearchRequest {
  readonly symbol: string;
  readonly assetType: 'crypto' | 'stock';
  readonly horizon: 'week' | 'month' | 'long_term';
  readonly engine: ResearchEngine;
  readonly coinId?: string;
}
export interface ResearchSource {
  readonly id: string;
  readonly title: string;
  readonly provider: string;
  readonly url: string;
  readonly retrievedAt: string;
  readonly asOf: string;
  readonly timestampBasis?: 'provider' | 'retrieval';
  readonly sha256: string;
  /** Canonical JSON of the retrieved evidence, retained for inspection and replay. */
  readonly snapshot: string;
}
export interface ResearchMetric {
  readonly label: string;
  readonly value: string;
  readonly rawValue?: string;
  readonly sourceId: string;
}
export interface ResearchSection {
  readonly title: string;
  readonly content: string;
  readonly kind: 'evidence' | 'interpretation';
  readonly sourceIds: readonly string[];
}
export interface ResearchReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly analysisDate: string;
  readonly request: ResearchRequest;
  readonly instrument: { readonly symbol: string; readonly name: string; readonly currency: string; readonly exchange: string };
  readonly engine: { readonly name: ResearchEngine; readonly version: string; readonly models: readonly string[] };
  readonly summary: string;
  readonly metrics: readonly ResearchMetric[];
  readonly sources: readonly ResearchSource[];
  readonly sections: readonly ResearchSection[];
  readonly warnings: readonly string[];
  readonly coverage: readonly { readonly topic: string; readonly status: 'available' | 'missing' | 'partial'; readonly detail: string }[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number; readonly llmCalls: number };
}
export interface ResearchJob {
  readonly id: string;
  readonly request: ResearchRequest;
  readonly status: ResearchStatus;
  readonly stage: string;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
  readonly report: ResearchReport | null;
}
export interface ResearchCapabilities {
  readonly workerAvailable: boolean;
  readonly aiConfigured: boolean;
  readonly engines: readonly { readonly name: ResearchEngine; readonly available: boolean }[];
  readonly dailyLimit: number;
  readonly pendingLimit: number;
}

export class ResearchError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function validateResearchRequest(value: unknown): ResearchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResearchError(400, 'INVALID_REQUEST', 'Choose an instrument and research mode.');
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((key) => !['symbol', 'assetType', 'horizon', 'engine', 'coinId'].includes(key))) {
    throw new ResearchError(400, 'INVALID_REQUEST', 'Unsupported research option. Historical analysis is not available yet.');
  }
  if (v['assetType'] !== 'crypto' && v['assetType'] !== 'stock') throw new ResearchError(400, 'INVALID_ASSET', 'Choose crypto or stocks.');
  if (typeof v['symbol'] !== 'string') throw new ResearchError(400, 'INVALID_SYMBOL', 'Enter a ticker.');
  let symbol = v['symbol'].trim().toUpperCase();
  if (v['assetType'] === 'crypto' && /^[A-Z0-9]{2,15}$/.test(symbol)) symbol += '-USD';
  if (v['assetType'] === 'crypto' ? !/^[A-Z0-9]{2,15}-USD$/.test(symbol) : !/^[A-Z0-9^][A-Z0-9.^-]{0,24}$/.test(symbol)) {
    throw new ResearchError(400, 'INVALID_SYMBOL', 'Use BTC or BTC-USD for crypto, or a stock ticker such as AAPL or RELIANCE.NS.');
  }
  if (!['week', 'month', 'long_term'].includes(String(v['horizon']))) throw new ResearchError(400, 'INVALID_HORIZON', 'Choose a research horizon.');
  if (v['engine'] !== 'snapshot' && v['engine'] !== 'tradingagents') throw new ResearchError(400, 'INVALID_ENGINE', 'Choose a supported research mode.');
  if (v['coinId'] !== undefined && (v['assetType'] !== 'crypto' || typeof v['coinId'] !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(v['coinId']))) {
    throw new ResearchError(400, 'INVALID_COIN_ID', 'Use a valid CoinGecko coin identifier for crypto.');
  }
  return { symbol, assetType: v['assetType'], horizon: v['horizon'] as ResearchRequest['horizon'], engine: v['engine'],
    ...(v['coinId'] !== undefined ? { coinId: v['coinId'] as string } : {}) };
}

// The worker's JSON is an untrusted boundary. Reports may contain plain text only;
// source references must resolve, and externally supplied links must be HTTPS.
export function validateResearchReport(value: unknown, request: ResearchRequest): ResearchReport {
  const fail = (): never => { throw new ResearchError(502, 'INVALID_REPORT', 'The research engine returned an invalid report.'); };
  const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
  const str = (v: unknown, max = 100_000): string => typeof v === 'string' && v.length <= max ? v : fail();
  const date = (v: unknown): string => { const s = str(v, 40); return Number.isFinite(Date.parse(s)) ? s : fail(); };
  const arr = (v: unknown, max = 100): unknown[] => Array.isArray(v) && v.length <= max ? v : fail();
  const r = obj(value);
  if (r['schemaVersion'] !== 1 || JSON.stringify(validateResearchRequest(r['request'])) !== JSON.stringify(validateResearchRequest(request))) fail();
  date(r['generatedAt']); date(r['analysisDate']); str(r['summary']);
  const instrument = obj(r['instrument']);
  if (instrument['symbol'] !== request.symbol) fail();
  ['symbol', 'name', 'currency', 'exchange'].forEach((key) => str(instrument[key], 200));
  const engine = obj(r['engine']);
  if (engine['name'] !== request.engine) fail();
  str(engine['version'], 100); arr(engine['models'], 5).forEach((s) => str(s, 200));
  const sources = arr(r['sources']); const ids = new Set<string>();
  for (const value of sources) {
    const s = obj(value); const id = str(s['id'], 100);
    if (!id || ids.has(id)) fail(); ids.add(id);
    str(s['title'], 500); str(s['provider'], 100); date(s['retrievedAt']); date(s['asOf']);
    if (s['timestampBasis'] !== undefined && s['timestampBasis'] !== 'provider' && s['timestampBasis'] !== 'retrieval') fail();
    if (!/^[a-f0-9]{64}$/.test(str(s['sha256'], 64))) fail();
    const snapshot = str(s['snapshot'], 200_000);
    try { JSON.parse(snapshot); } catch { fail(); }
    if (createHash('sha256').update(snapshot).digest('hex') !== s['sha256']) fail();
    let u: URL;
    try { u = new URL(str(s['url'], 2000)); } catch { return fail(); }
    if (u.protocol !== 'https:' || u.username || u.password) fail();
  }
  if (!sources.length) fail();
  for (const value of arr(r['metrics'])) {
    const m = obj(value); str(m['label'], 200); str(m['value'], 500); if (!ids.has(str(m['sourceId'], 100))) fail();
    if (m['rawValue'] !== undefined) str(m['rawValue'], 500);
  }
  const sections = arr(r['sections'], 30);
  for (const value of sections) {
    const s = obj(value); str(s['title'], 300); str(s['content']);
    if (s['kind'] !== 'evidence' && s['kind'] !== 'interpretation') fail();
    const refs = arr(s['sourceIds']); refs.forEach((id) => { if (!ids.has(str(id, 100))) fail(); });
    if (s['kind'] === 'evidence' && !refs.length) fail();
  }
  if (request.engine === 'tradingagents') {
    const required = ['Research conclusion', 'Investment thesis', 'Trade scenarios', 'Technical interpretation', 'Sentiment interpretation', 'News and catalysts', 'Bull and bear debate', 'Risk review'];
    if (request.assetType === 'stock') required.push('Company fundamentals');
    if (required.some((title) => !sections.some((value) => {
      const s = obj(value); return s['title'] === title && s['kind'] === 'interpretation' && str(s['content']).trim().length > 0;
    })) || arr(engine['models']).length !== 2) fail();
  }
  arr(r['warnings']).forEach((s) => str(s, 2000));
  for (const value of arr(r['coverage'])) {
    const c = obj(value); str(c['topic'], 200); str(c['detail'], 2000);
    if (!['available', 'partial', 'missing'].includes(String(c['status']))) fail();
  }
  const usage = obj(r['usage']);
  ['inputTokens', 'outputTokens', 'llmCalls'].forEach((key) => { if (!Number.isSafeInteger(usage[key]) || Number(usage[key]) < 0) fail(); });
  return value as ResearchReport;
}
