import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ResearchJob, ResearchReport, ResearchRequest } from '@tradex/api';
import { cancelResearchJob, createResearchJob, fetchResearchCapabilities, fetchResearchJob, fetchResearchJobs } from '../api.ts';
import { useAuth } from '../auth.tsx';
import './research.css';

const active = (job: ResearchJob) => job.status === 'queued' || job.status === 'running';
const displayTime = (value: string) => new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' IST';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Research could not be completed.';
const failureMessages: Record<string, string> = {
  AMBIGUOUS_COIN: 'Several coins share this ticker. Enter the CoinGecko coin ID to identify the correct asset.',
  IDENTITY_MISMATCH: 'The data provider returned a different instrument. No report was published.',
  DATA_UNAVAILABLE: 'Current evidence could not be retrieved. Try again later.',
  ENGINE_NOT_INSTALLED: 'The TradingAgents worker needs administrator setup.',
  LLM_NOT_CONFIGURED: 'Configure your AI provider in Settings → AI Research.',
  AI_CONFIG_CHANGED: 'The AI configuration changed. Start a new report with your current settings.',
  AI_KEY_UNAVAILABLE: 'Your AI key could not be opened. Ask an owner to replace it in AI Research settings.',
  BUDGET_EXCEEDED: 'The analysis reached its research budget. No incomplete report was published.',
  WORKER_INTERRUPTED: 'The analysis was interrupted. You can start a new report.',
  TIMEOUT: 'The analysis took too long. You can start a new report.',
  INVALID_REPORT: 'The report did not pass validation. No result was published.',
};

function exportReport(report: ResearchReport, format: 'json' | 'md') {
  const content = format === 'json' ? JSON.stringify(report, null, 2) : [
    `# ${report.instrument.name} (${report.instrument.symbol})`, `Generated: ${report.generatedAt}`, report.summary,
    ...report.sections.filter((s) => s.kind === 'interpretation').flatMap((s) => [`## ${s.title}`, s.content]),
    '## Supporting observations', ...report.metrics.map((m) => `- ${m.label}: ${m.value} [${m.sourceId}]`),
    ...report.sections.filter((s) => s.kind === 'evidence').flatMap((s) => [`## ${s.title}`, s.content, s.sourceIds.length ? `Evidence: ${s.sourceIds.join(', ')}` : '']),
    '## Sources', ...report.sources.map((s) => `- [${s.id}] ${s.title}: ${s.url}\n  As of ${s.asOf}; retrieved ${s.retrievedAt}; SHA-256 ${s.sha256}`),
    '## Coverage', ...report.coverage.map((c) => `- ${c.topic}: ${c.status}. ${c.detail}`),
    '## Limitations', ...report.warnings.map((w) => `- ${w}`),
  ].join('\n\n');
  const url = URL.createObjectURL(new Blob([content], { type: format === 'json' ? 'application/json' : 'text/markdown' }));
  const a = document.createElement('a'); a.href = url; a.download = `${report.instrument.symbol}-research.${format}`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ReportView({ report }: { report: ResearchReport }) {
  const priority = ['Research conclusion', 'Investment thesis', 'Bull and bear debate', 'Risk review', 'Trade scenarios', 'News and catalysts', 'Company fundamentals', 'Sentiment interpretation', 'Technical interpretation'];
  const analysis = report.sections.filter((s) => s.kind === 'interpretation').sort((a, b) => priority.indexOf(a.title) - priority.indexOf(b.title));
  const sectionView = (section: ResearchReport['sections'][number], index: number) => <section key={section.title} id={`analysis-${index}`} className="research-section">
    <div className="research-section-title"><h3>{section.title}</h3><span className={`research-state ${section.kind}`}>{section.kind === 'evidence' ? 'Sourced evidence' : 'AI interpretation'}</span></div>
    <div className="research-narrative"><Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={(value) => {
      if (value.startsWith('#')) return value;
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? value : ''; } catch { return ''; }
    }} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>, img: () => null }}>{section.content}</Markdown></div>
    {section.sourceIds.length > 0 && <div className="research-source-refs">{section.sourceIds.map((id) => <a key={id} href={`#source-${id}`}>View {id} evidence ↗</a>)}</div>}
  </section>;
  return <article className="research-report">
    <header className="research-report-heading">
      <div><span className="research-eyebrow">RESEARCH REPORT</span><h2>{report.instrument.name}</h2>
        <p className="sub">{report.instrument.symbol} · {report.instrument.exchange} · {report.instrument.currency}</p>
        <p className="sub">Generated {displayTime(report.generatedAt)}</p></div>
      <div className="research-export"><button type="button" className="btn secondary" onClick={() => exportReport(report, 'md')}>Export report</button>
        <button type="button" className="btn ghost" onClick={() => exportReport(report, 'json')}>Export data</button></div>
    </header>
    <p className="research-summary">{report.summary}</p>
    <nav className="research-report-nav" aria-label="Report sections">{analysis.map((section, index) => <a href={`#analysis-${index}`} key={section.title}>{section.title}</a>)}</nav>
    {analysis.map(sectionView)}
    <details className="research-supporting"><summary>Supporting observations and source evidence</summary>
    {report.metrics.length > 0 && <div className="research-metrics">{report.metrics.map((metric) => <div key={metric.label} className="research-metric">
      <span>{metric.label}</span><strong className="mono" title={metric.rawValue}>{metric.value}</strong><a href={`#source-${metric.sourceId}`}>Source ↗</a>
    </div>)}</div>}
    {report.sections.filter((s) => s.kind === 'evidence').map((section, index) => sectionView(section, index + analysis.length))}
    <section className="research-section"><h3>Sources and observations</h3><p className="sub">Each observation retains its provider response and retrieval time.</p>
      {report.sources.map((source) => <div className="research-source" id={`source-${source.id}`} key={source.id}>
        <a href={source.url} target="_blank" rel="noopener noreferrer">{source.title} ↗</a><span>{source.provider}</span>
        <p className="sub">{source.timestampBasis === 'retrieval' ? 'Snapshot time' : 'Observation'}: {displayTime(source.asOf)} · Retrieved: {displayTime(source.retrievedAt)}</p>
        <details><summary>Inspect evidence snapshot</summary><pre>{JSON.stringify(JSON.parse(source.snapshot), null, 2)}</pre><p className="research-hash">SHA-256: {source.sha256}</p></details>
      </div>)}
    </section>
    </details>
    <section className="research-coverage"><h3>Research coverage</h3><p className="sub">See what this report can support and where evidence is missing.</p>
      <div className="research-coverage-list">{report.coverage.map((item) => <div key={item.topic}>
        <span className={`research-state ${item.status}`}>{item.status}</span><div><strong>{item.topic}</strong><p>{item.detail}</p></div>
      </div>)}</div>
    </section>
    <section className="research-limitations"><h3>Limitations</h3><ul>{report.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section>
    <details className="research-method"><summary>Research method</summary><p>Engine: {report.engine.name} · Version: {report.engine.version}</p>
      <p>Horizon: {report.request.horizon.replaceAll('_', ' ')} · Analysis date (UTC): {report.analysisDate}</p>
      {report.engine.models.length > 0 && <><p>Models: {report.engine.models.join(', ')}</p><p>Reported usage: {report.usage.llmCalls} model calls · {report.usage.inputTokens} input tokens · {report.usage.outputTokens} output tokens</p></>}
    </details>
  </article>;
}

export function Research() {
  const { state } = useAuth(); const client = useQueryClient(); const [params, setParams] = useSearchParams();
  const scope = state.status === 'authenticated' ? state.session.tenantId : 'anonymous';
  const jobsKey = ['research', scope, 'jobs'] as const;
  const jobKey = (id: string | null) => ['research', scope, 'job', id] as const;
  const selectedId = params.get('job');
  const [symbol, setSymbol] = useState('BTC'); const [assetType, setAssetType] = useState<ResearchRequest['assetType']>('crypto');
  const [horizon, setHorizon] = useState<ResearchRequest['horizon']>('month'); const engine = 'tradingagents' as const;
  const [coinId, setCoinId] = useState('');
  const submission = useRef<{ fingerprint: string; key: string } | null>(null);
  const canRun = state.status === 'authenticated' && state.session.role !== 'viewer';
  const capabilities = useQuery({ queryKey: ['research', scope, 'capabilities'], queryFn: fetchResearchCapabilities, refetchInterval: 15_000 });
  const jobs = useQuery({ queryKey: jobsKey, queryFn: fetchResearchJobs,
    refetchInterval: (query) => query.state.data?.some(active) ? 4000 : 15_000 });
  const selected = useQuery({ queryKey: jobKey(selectedId), queryFn: () => fetchResearchJob(selectedId!), enabled: Boolean(selectedId),
    refetchInterval: (query) => query.state.data && active(query.state.data) ? 3000 : false });
  const start = useMutation({ mutationFn: ({ request, key }: { request: ResearchRequest; key: string }) => createResearchJob(request, key),
    onSuccess: (job) => { submission.current = null; setParams({ job: job.id }); client.setQueryData(jobKey(job.id), job); void client.invalidateQueries({ queryKey: jobsKey }); } });
  const cancel = useMutation({ mutationFn: cancelResearchJob, onSuccess: (job) => {
    client.setQueryData(jobKey(job.id), job); void client.invalidateQueries({ queryKey: jobsKey });
  } });
  const available = capabilities.data?.engines.find((e) => e.name === engine)?.available ?? false;
  const anyAvailable = capabilities.data?.engines.some((e) => e.available) ?? false;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const request: ResearchRequest = { symbol: symbol.trim().toUpperCase(), assetType, horizon, engine,
      ...(assetType === 'crypto' && coinId.trim() ? { coinId: coinId.trim().toLowerCase() } : {}) };
    const fingerprint = JSON.stringify(request);
    // Retain the key on a network error: retrying cannot create a second paid job.
    if (submission.current?.fingerprint !== fingerprint) submission.current = { fingerprint, key: crypto.randomUUID() };
    start.mutate({ request, key: submission.current.key });
  };
  return <div className="full-width-page research-page">
    <header className="research-page-heading"><div><span className="research-eyebrow">THE RESEARCH DESK</span><h2>Understand the asset. Examine the evidence.</h2>
      <p className="sub">A full TradingAgents research team: analyst findings, opposing investment cases, a thesis, catalysts and risk committee review.</p></div>
      <span className="research-state evidence">Research only</span></header>
    <div className="research-layout"><aside className="research-controls">
      <form className="research-card" onSubmit={submit}><h3>New research</h3>
        <label>Asset class<select aria-label="Asset class" value={assetType} onChange={(e) => { setAssetType(e.target.value as ResearchRequest['assetType']); setSymbol(e.target.value === 'crypto' ? 'BTC' : 'RELIANCE.NS'); setCoinId(''); }}>
          <option value="crypto">Crypto</option><option value="stock">Stocks & ETFs</option></select></label>
        <label>Ticker<input value={symbol} onChange={(e) => setSymbol(e.target.value)} required maxLength={25} placeholder={assetType === 'crypto' ? 'BTC, ETH, SOL' : 'AAPL, RELIANCE.NS'} autoCapitalize="characters" autoComplete="off" /></label>
        <p className="research-field-note">{assetType === 'crypto' ? 'Crypto observations use USD pairs.' : 'Use .NS for NSE and .BO for BSE.'}</p>
        <label>Research horizon<select aria-label="Research horizon" value={horizon} onChange={(e) => setHorizon(e.target.value as ResearchRequest['horizon'])}>
          <option value="week">One week</option><option value="month">One month</option><option value="long_term">Six months</option></select></label>
        <div className="research-team"><strong>TradingAgents research team</strong><p>Market, sentiment and news analysts{assetType === 'stock' ? ', plus company fundamentals' : ', with token evidence'}. Bull and bear researchers challenge the thesis before the risk committee reviews it.</p></div>
        <Link className="research-settings-link" to="/app/settings?tab=ai">AI provider settings ↗</Link>
        {assetType === 'crypto' && <details className="research-identity"><summary>Resolve a shared coin ticker</summary><label>CoinGecko coin ID<input value={coinId} onChange={(e) => setCoinId(e.target.value)} placeholder="e.g. bitcoin" maxLength={100} /></label></details>}
        {canRun ? <button className="btn" type="submit" disabled={start.isPending || !available || !symbol.trim()}>{start.isPending ? 'Starting research…' : 'Start advanced research'}</button>
          : <p className="research-field-note">An owner or trader can start research. You can read saved reports.</p>}
        {capabilities.isError && <p className="error" role="alert">Research availability could not be checked.</p>}
        {!capabilities.isPending && !capabilities.isError && !anyAvailable && <p className="research-field-note">{!capabilities.data?.aiConfigured ? 'Connect your AI provider in AI Research settings to start.' : 'The research worker is currently offline. Saved reports remain available.'}</p>}
        {start.isError && <p className="error" role="alert">{errorMessage(start.error)}</p>}
        {capabilities.data && <p className="research-field-note">Up to {capabilities.data.dailyLimit} reports per workspace in 24 hours, with {capabilities.data.pendingLimit} pending at a time.</p>}
      </form>
      <div className="research-card research-history"><h3>Recent research</h3>
        {jobs.isPending && <p className="sub">Loading reports…</p>}{jobs.isError && <p className="error" role="alert">Saved reports could not be loaded.</p>}
        {jobs.data?.length === 0 && <p className="sub">Your reports will appear here. Research keeps running when you leave this page.</p>}
        {jobs.data?.map((job) => <button key={job.id} type="button" className={`research-history-item ${selectedId === job.id ? 'selected' : ''}`} onClick={() => setParams({ job: job.id })} aria-pressed={selectedId === job.id}>
          <div><strong>{job.request.symbol}</strong><span className={`research-state ${job.status}`}>{job.status}</span></div>
          <span>TradingAgents · {displayTime(job.createdAt)}</span>
        </button>)}
      </div>
    </aside><main className="research-results">
      {!selectedId && <div className="research-empty"><svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden="true"><path d="M4 3h12l4 4v14H4zM16 3v5h4M8 12h8M8 16h5" /></svg>
        <span className="research-eyebrow">FROM DATA TO UNDERSTANDING</span><h3>Build a research case before a trade.</h3>
        <p>Choose an instrument for a full analyst investigation. Review the thesis, opposing cases, catalysts and risk scenarios alongside the evidence and limitations.</p>
        <div><span>01 · Analyst investigation</span><span>02 · Bull and bear debate</span><span>03 · Thesis and risk review</span></div></div>}
      {selectedId && selected.isPending && <p className="sub" role="status">Loading research…</p>}
      {selected.isError && <p className="error" role="alert">{errorMessage(selected.error)}</p>}
      {selected.data && active(selected.data) && <div className="research-progress" role="status" aria-live="polite">
        <span className="research-state running">{selected.data.status}</span><h3>{selected.data.request.symbol}</h3><p>{selected.data.stage}</p>
        <p className="sub">You can leave this page and return to the saved job. Deep analysis may take several minutes.</p>
        {canRun && <button type="button" className="btn secondary" disabled={cancel.isPending} onClick={() => cancel.mutate(selected.data!.id)}>Cancel research</button>}
        {cancel.isError && <p className="error">{errorMessage(cancel.error)}</p>}
      </div>}
      {selected.data?.status === 'failed' && <div className="research-progress"><span className="research-state failed">Could not complete research</span><h3>{selected.data.request.symbol}</h3>
        <p>{failureMessages[selected.data.errorCode ?? ''] ?? 'The research engine could not complete the full analysis. Check your provider settings and start a new report.'}</p></div>}
      {selected.data?.status === 'cancelled' && <div className="research-progress"><h3>Research cancelled</h3><p>No report was published. You can start new research from the form.</p></div>}
      {selected.data?.report && <ReportView report={selected.data.report} />}
    </main></div>
  </div>;
}
