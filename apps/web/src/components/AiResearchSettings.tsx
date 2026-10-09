import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ResearchProvider, ResearchAiTestResult } from '@tradex/api';
import { fetchResearchAiSettings, removeResearchAiSettings, saveResearchAiSettings, testResearchAiModels, stepUp } from '../api.ts';
import { useAuth } from '../auth.tsx';
import './ai-research-settings.css';

export function AiResearchSettings() {
  const { state } = useAuth();
  const tenant = state.status === 'authenticated' ? state.session.tenantId : 'anonymous';
  const owner = state.status === 'authenticated' && state.session.role === 'owner';
  const totp = state.status === 'authenticated' && state.session.totpEnabled;
  const client = useQueryClient();
  const queryKey = ['research', tenant, 'ai-settings'] as const;
  const settings = useQuery({ queryKey, queryFn: fetchResearchAiSettings });
  const [provider, setProvider] = useState<ResearchProvider>('openai');
  const [deepModel, setDeepModel] = useState('');
  const [quickModel, setQuickModel] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | 'test' | null>(null);
  const [testResult, setTestResult] = useState<ResearchAiTestResult | null>(null);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  // Secrets live only in uncontrolled password fields until submission. They
  // never enter React state, query/mutation caches, URLs, or browser storage.
  const keyField = useRef<HTMLInputElement>(null);
  const codeField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (settings.data) {
      setProvider(settings.data.provider ?? 'openai'); setDeepModel(settings.data.deepModel); setQuickModel(settings.data.quickModel);
      setTestResult(null);
    }
  }, [settings.data]);
  const editable = owner && settings.data?.storageAvailable === true;
  const update = async (action: 'save' | 'remove' | 'test') => {
    if (busy || !editable) return;
    let apiKey = keyField.current?.value.trim() ?? '';
    let code = codeField.current?.value.trim() ?? '';
    if (keyField.current) keyField.current.value = '';
    if (codeField.current) codeField.current.value = '';
    setBusy(action); setNotice(null); setTestResult(null);
    try {
      if (totp) await stepUp(code); code = '';
      const input = { provider, deepModel: deepModel.trim(), quickModel: quickModel.trim(), ...(apiKey ? { apiKey } : {}) };
      if (action === 'test') {
        const pastedKey = Boolean(apiKey);
        const result = await testResearchAiModels(input);
        apiKey = '';
        setTestResult(result);
        if (pastedKey) setNotice({ error: false, text: 'The pasted key was used only for this test and cleared. Paste it again to save AI settings.' });
        return;
      }
      const result = action === 'remove' ? await removeResearchAiSettings() : await saveResearchAiSettings(input);
      apiKey = '';
      client.setQueryData(queryKey, result);
      await client.invalidateQueries({ queryKey: ['research', tenant] });
      setNotice({ error: false, text: action === 'remove' ? 'AI credentials removed. Unfinished research was cancelled.' : 'AI settings saved. Your API key cannot be viewed or retrieved from this page.' });
    } catch (error) {
      setNotice({ error: true, text: error instanceof Error ? error.message : 'AI settings action could not be completed.' });
    } finally { apiKey = ''; code = ''; setBusy(null); }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    void update(button?.value === 'test' ? 'test' : 'save');
  };
  return <section className="settings-section-card ai-research-settings">
    <div className="ai-research-settings-heading"><div><h3>AI Research</h3><p className="sub">Connect your AI provider to run full TradingAgents research for this workspace.</p></div>
      <span className={`ai-research-key-status ${settings.data?.configured ? 'saved' : ''}`}>{settings.data?.configured ? 'Key saved' : 'Not configured'}</span></div>
    <p className="ai-research-explainer">The research team analyses markets, sentiment, news and company fundamentals, debates the bull and bear cases, and produces an investment thesis and risk review. Crypto uses the applicable analysts and token evidence.</p>
    {settings.isPending && <p role="status">Loading AI settings…</p>}
    {settings.isError && <p className="error" role="alert">AI settings could not be loaded.</p>}
    {settings.data && <>
      <div className="ai-research-privacy">Saved API keys are encrypted and write-only. This page never receives a saved key. Paste a replacement key to change it; leave the field empty to keep the current key for the same provider.</div>
      {!owner && <p className="sub">A workspace owner can manage AI credentials. Traders can run research with the saved configuration.</p>}
      {!settings.data.storageAvailable && <p className="error">Secure key storage needs administrator setup before you can save a provider key.</p>}
      <form onSubmit={submit} onChange={() => { setTestResult(null); setNotice(null); }} autoComplete="off">
        <fieldset disabled={!editable || busy !== null}>
          <div className="ai-research-fields">
            <label>AI provider<select aria-label="AI provider" value={provider} onChange={(e) => {
              const next = e.target.value as ResearchProvider; setProvider(next);
              setDeepModel(next === settings.data?.provider ? settings.data.deepModel : '');
              setQuickModel(next === settings.data?.provider ? settings.data.quickModel : '');
              if (keyField.current) keyField.current.value = '';
            }}><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google Gemini</option></select></label>
            <label>Provider API key<input ref={keyField} type="password" autoComplete="new-password" spellCheck={false}
              placeholder={settings.data.configured && provider === settings.data.provider ? 'Saved securely · paste only to replace' : 'Paste your provider API key'}
              required={!settings.data.configured || provider !== settings.data.provider} maxLength={2048} /></label>
            <label>Deep reasoning model<input value={deepModel} onChange={(e) => setDeepModel(e.target.value)} maxLength={120} required placeholder="Model ID supported by your provider" /></label>
            <label>Analyst model<input value={quickModel} onChange={(e) => setQuickModel(e.target.value)} maxLength={120} required placeholder="Model ID for analysts and researchers" /></label>
          </div>
          <p className="sub">Use model IDs available to your provider account. Your provider bills the AI usage. Changing the key or models cancels unfinished research.</p>
          {totp && <label className="ai-research-code">Authenticator code<input ref={codeField} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} minLength={6} required autoComplete="one-time-code" placeholder="6-digit code" /></label>}
          <div className="ai-research-actions"><button type="submit" className="btn">{busy === 'save' ? 'Saving…' : 'Save AI settings'}</button>
            <button type="submit" value="test" className="btn secondary">{busy === 'test' ? 'Testing models…' : 'Test models'}</button>
            {settings.data.configured && <button type="button" className="btn secondary" onClick={() => void update('remove')}>{busy === 'remove' ? 'Removing…' : 'Remove saved key'}</button>}
            <Link className="btn ghost" to="/app/research">Open Research</Link></div>
        </fieldset>
      </form>
      <p className="sub">Test models uses a pasted key or the saved key for this provider. It makes up to two small AI requests (one for a shared model); your provider may charge for them. Tests do not save settings or start research.</p>
      {busy === 'test' && <p role="status">Checking the selected models…</p>}
      {testResult && <div className="ai-research-test-results" role="status" aria-live="polite">
        {(['deep', 'quick'] as const).map((role) => <div key={role} className={`ai-research-test-result ${testResult[role].ok ? 'passed' : 'failed'}`}>
          <strong>{role === 'deep' ? 'Deep reasoning model' : 'Analyst model'} · {testResult[role].ok ? 'Passed' : 'Check needed'}</strong>
          <p>{testResult[role].message}</p>
        </div>)}
        <p className="sub">Checked {new Date(testResult.testedAt).toLocaleTimeString('en-IN')}. This checks connection, model access and acceptance of the research tool schema. Full research also needs available market data.</p>
      </div>}
      {settings.data.updatedAt && <p className="sub">Updated {new Date(settings.data.updatedAt).toLocaleString('en-IN')}</p>}
    </>}
    {notice && <p className={notice.error ? 'error' : 'ai-research-success'} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </section>;
}
