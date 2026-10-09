import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateResearchReport, validateResearchRequest } from './contracts.js';
import type { ResearchReport, ResearchRequest } from './contracts.js';
import { researchEnvironment, resolveResearchPython, runResearchProcess } from './process.js';

const request: ResearchRequest = { symbol: 'BTC-USD', assetType: 'crypto', horizon: 'month', engine: 'snapshot' };
function report(): ResearchReport {
  const snapshot = '{"close":"100"}';
  return { schemaVersion: 1, generatedAt: '2026-10-09T00:00:00Z', analysisDate: '2026-10-09', request,
    instrument: { symbol: request.symbol, name: 'Bitcoin', currency: 'USD', exchange: 'Composite' },
    engine: { name: 'snapshot', version: 'v1', models: [] }, summary: 'Observed evidence.', metrics: [{ label: 'Price', value: '100', sourceId: 'market' }],
    sources: [{ id: 'market', title: 'Prices', provider: 'Yahoo', url: 'https://finance.yahoo.com/quote/BTC-USD', retrievedAt: '2026-10-09T00:00:00Z',
      asOf: '2026-10-09T00:00:00Z', snapshot, sha256: createHash('sha256').update(snapshot).digest('hex') }],
    sections: [{ title: 'Evidence', content: 'Observation.', kind: 'evidence', sourceIds: ['market'] }], warnings: [], coverage: [],
    usage: { inputTokens: 0, outputTokens: 0, llmCalls: 0 } };
}

describe('research input and report trust boundary', () => {
  it('normalizes a crypto shorthand but preserves exchange-suffixed stocks', () => {
    expect(validateResearchRequest({ ...request, symbol: ' btc ' }).symbol).toBe('BTC-USD');
    expect(validateResearchRequest({ ...request, assetType: 'stock', symbol: 'reliance.ns' }).symbol).toBe('RELIANCE.NS');
  });
  it.each(['../../secrets', 'BTC;exit', 'https://localhost', '', 'BTC-USDT'])('rejects unsafe or unsupported crypto identifiers: %s', (symbol) => {
    expect(() => validateResearchRequest({ ...request, symbol })).toThrow();
  });
  it('rejects historical dates and caller-controlled models or data endpoints', () => {
    for (const extra of [{ date: '2020-01-01' }, { model: 'unbounded' }, { url: 'http://localhost' }]) {
      expect(() => validateResearchRequest({ ...request, ...extra })).toThrow();
    }
  });
  it('accepts an intact report and rejects wrong identity, unresolved sources and altered snapshots', () => {
    expect(validateResearchReport(report(), request)).toEqual(report());
    for (const mutate of [
      (r: ResearchReport) => ({ ...r, instrument: { ...r.instrument, symbol: 'ETH-USD' } }),
      (r: ResearchReport) => ({ ...r, metrics: [{ label: 'Price', value: '100', sourceId: 'invented' }] }),
      (r: ResearchReport) => ({ ...r, sources: r.sources.map((s) => ({ ...s, snapshot: '{"close":"999"}' })) }),
      (r: ResearchReport) => ({ ...r, sections: [{ ...r.sections[0]!, sourceIds: [] }] }),
    ]) expect(() => validateResearchReport(mutate(report()), request)).toThrow();
  });
  it.each(['javascript:alert(1)', 'file:///secrets', 'https://user:secret@example.com', 'not a URL'])('rejects unsafe source link %s', (url) => {
    const r = report(); expect(() => validateResearchReport({ ...r, sources: r.sources.map((s) => ({ ...s, url })) }, request)).toThrow();
  });
  it('does not mistake interpretation for sourced evidence', () => {
    const r = report();
    expect(() => validateResearchReport({ ...r, sections: [{ title: 'Opinion', content: 'A hypothesis.', kind: 'interpretation', sourceIds: [] }] }, request)).not.toThrow();
  });
  it('compares request values independently of PostgreSQL JSONB key order', () => {
    const reordered = { engine: request.engine, horizon: request.horizon, assetType: request.assetType, symbol: request.symbol };
    expect(() => validateResearchReport(report(), reordered)).not.toThrow();
  });
  it('requires the full analyst, debate, thesis and risk workflow for advanced reports', () => {
    const advanced = { ...request, engine: 'tradingagents' as const };
    const titles = ['Research conclusion', 'Investment thesis', 'Trade scenarios', 'Technical interpretation', 'Sentiment interpretation', 'News and catalysts', 'Bull and bear debate', 'Risk review'];
    const r: ResearchReport = { ...report(), request: advanced, engine: { name: 'tradingagents', version: 'test', models: ['deep', 'analyst'] },
      sections: titles.map((title) => ({ title, content: 'Research interpretation.', kind: 'interpretation', sourceIds: [] })) };
    expect(() => validateResearchReport(r, advanced)).not.toThrow();
    expect(() => validateResearchReport({ ...r, sections: r.sections.filter((s) => s.title !== 'Risk review') }, advanced)).toThrow();
    expect(() => validateResearchReport({ ...r, sections: [] }, advanced)).toThrow();
  });
});

describe('isolated research subprocess', () => {
  const python = resolveResearchPython('python');
  const script = fileURLToPath(new URL('../../../research-engine/tests/runner_fixture.py', import.meta.url));
  const run = (symbol = 'BTC-USD', timeoutMs = 3000, signal = new AbortController().signal) => runResearchProcess({ python, script,
    request: { ...request, symbol }, timeoutMs, signal, env: { ...process.env, DATABASE_URL: 'private-db', TRADEX_PEPPER: 'private-exchange-key', OPENAI_API_KEY: 'provider-test-key' } });
  it('passes the configured provider key without database or exchange credentials', async () => {
    expect(researchEnvironment({ DATABASE_URL: 'secret', OPENAI_API_KEY: 'provider' })).toEqual({
      PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1', PYTHON_DOTENV_DISABLED: '1', OPENAI_API_KEY: 'provider' });
    expect(await run()).toEqual({ hasDatabase: false, hasExchangeKey: false, hasProviderKey: true });
  });
  it('hard-stops a run at its timeout', async () => { await expect(run('WAIT-USD', 200)).rejects.toThrow('TIMEOUT'); });
  it('aborts a running subprocess when its lease is lost or cancelled', async () => {
    const controller = new AbortController(); const pending = run('WAIT-USD', 3000, controller.signal);
    controller.abort(); await expect(pending).rejects.toThrow('CANCELLED');
  });
  it('rejects excessive output and safe engine error envelopes', async () => {
    await expect(run('LARGE-USD')).rejects.toThrow('OUTPUT_LIMIT');
    await expect(run('EXIT-USD')).rejects.toThrow('LLM_NOT_CONFIGURED');
  });
  it('refuses to publish a provider key echoed by an engine', async () => {
    await expect(run('LEAK-USD')).rejects.toThrow('ENGINE_FAILED');
  });
});
