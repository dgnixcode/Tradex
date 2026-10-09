import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { AiResearchSettings } from './AiResearchSettings.tsx';

const api = vi.hoisted(() => ({ test: vi.fn(), save: vi.fn(), remove: vi.fn(), stepUp: vi.fn() }));
vi.mock('../auth.tsx', () => ({ useAuth: () => ({ state: { status: 'authenticated', session: { tenantId: 'tenant-a', role: 'owner', totpEnabled: false } } }) }));
vi.mock('../api.ts', () => ({
  fetchResearchAiSettings: async () => ({ storageAvailable: true, configured: true, provider: 'openai', deepModel: 'test-deep', quickModel: 'test-quick', updatedAt: null }),
  testResearchAiModels: api.test, saveResearchAiSettings: api.save, removeResearchAiSettings: api.remove, stepUp: api.stepUp,
}));
let root: Root | undefined; let container: HTMLDivElement | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); container?.remove(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it('clears a pasted key before testing, avoids secret caches and invalidates results on edits', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(container);
  await act(async () => root!.render(<MemoryRouter><QueryClientProvider client={client}><AiResearchSettings /></QueryClientProvider></MemoryRouter>));
  await act(async () => { await vi.waitFor(() => expect(container!.querySelector('button[value="test"]')).not.toBeNull()); });
  const key = container.querySelector<HTMLInputElement>('input[type="password"]')!;
  const form = container.querySelector('form')!;
  const testButton = container.querySelector<HTMLButtonElement>('button[value="test"]')!;
  key.value = 'synthetic-transient-secret';
  let finish: (value: unknown) => void = () => {};
  api.test.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await act(async () => form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: testButton })));
  expect(key.value).toBe(''); expect(api.test).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'synthetic-transient-secret' }));
  expect(container.textContent).toContain('Testing models…');
  expect(JSON.stringify(client.getQueryCache().getAll().map((q) => q.state.data))).not.toContain('synthetic-transient-secret');
  expect(client.getMutationCache().getAll()).toHaveLength(0);
  await act(async () => finish({ deep: { ok: true, code: 'OK', message: 'Connection confirmed.' },
    quick: { ok: false, code: 'AUTH_FAILED', message: 'Check the provider key.' }, testedAt: new Date().toISOString() }));
  expect(container.textContent).toContain('Deep reasoning model · Passed');
  expect(container.textContent).toContain('Analyst model · Check needed');
  expect(container.textContent).toContain('Paste it again to save');
  expect(api.save).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('synthetic-transient-secret');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(key, 'replacement-key');
    key.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(container.querySelector('.ai-research-test-results')).toBeNull();
  client.clear();
});
