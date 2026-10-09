import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { researchEnvironment, resolveResearchPython } from './process.js';

export const AI_TEST_MESSAGES = {
  OK: 'Connection and model access confirmed.',
  AUTH_FAILED: 'The provider rejected this API key. Check or replace it.',
  MODEL_UNAVAILABLE: 'Model unavailable or access denied. Check the model ID and account permissions.',
  QUOTA_EXCEEDED: 'Provider quota or billing limit reached. Check your provider account.',
  RATE_LIMITED: 'The provider rate limit was reached. Try again later.',
  CONNECTION_FAILED: 'Could not connect to the provider. Check connectivity and try again.',
  TIMEOUT: 'The model did not respond in time. Try again later.',
  UNSUPPORTED_MODEL: 'The model rejected the research client or tool configuration. Choose a compatible model.',
  TOKEN_LIMIT: 'The small test reached its token limit. Model access was reached, but the response could not be confirmed.',
  ENGINE_NOT_INSTALLED: 'The pinned research engine is unavailable. Contact your administrator.',
  TEST_FAILED: 'The model test could not be completed. Check your provider settings and try again.',
} as const;
export type ResearchAiTestCode = keyof typeof AI_TEST_MESSAGES;
export interface ResearchModelTestOutcome { readonly ok: boolean; readonly code: ResearchAiTestCode; readonly message: string }
export interface ResearchAiTestResult {
  readonly deep: ResearchModelTestOutcome;
  readonly quick: ResearchModelTestOutcome;
  readonly testedAt: string;
}
export type ResearchModelProbe = (input: { env: NodeJS.ProcessEnv }) => Promise<unknown>;

/** Neither provider-generated content nor exception messages reach the browser. */
export function safeModelTest(raw: unknown): ResearchAiTestResult {
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const outcome = (input: unknown): ResearchModelTestOutcome => {
    const code = typeof input === 'string' && Object.hasOwn(AI_TEST_MESSAGES, input) ? input as ResearchAiTestCode : 'TEST_FAILED';
    return { ok: code === 'OK', code, message: AI_TEST_MESSAGES[code] };
  };
  return { deep: outcome(value['deep']), quick: outcome(value['quick']), testedAt: new Date().toISOString() };
}

let defaultPython: string | undefined;
export async function runAiModelProbe(input: { env: NodeJS.ProcessEnv; python?: string; script?: string; timeoutMs?: number }): Promise<unknown> {
  const failed = { deep: 'TEST_FAILED', quick: 'TEST_FAILED' };
  let python: string;
  try {
    python = input.python ?? (defaultPython ??= resolveResearchPython(process.env['TRADEX_RESEARCH_PYTHON'] ?? 'python'));
  } catch { return { deep: 'ENGINE_NOT_INSTALLED', quick: 'ENGINE_NOT_INSTALLED' }; }
  const script = input.script ?? fileURLToPath(new URL('../../../research-engine/engine.py', import.meta.url));
  const env = researchEnvironment(input.env);
  const secrets = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY'].map((name) => env[name]).filter((v): v is string => Boolean(v));
  return new Promise((resolve) => {
    const child = spawn(python, ['-I', script, '--test-models'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env });
    const chunks: Buffer[] = []; let bytes = 0; let finished = false;
    const finish = (result: unknown, kill = false) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (kill) child.kill('SIGKILL');
      resolve(result);
    };
    // This plus the <=10s interpreter resolution finishes inside the 60s reservation.
    const timer = setTimeout(() => finish({ deep: 'TIMEOUT', quick: 'TIMEOUT' }, true), input.timeoutMs ?? 45_000);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 4096) finish(failed, true); else chunks.push(chunk);
    });
    child.stderr.on('data', () => { /* Discard provider diagnostics without retaining them. */ });
    child.on('error', () => finish({ deep: 'ENGINE_NOT_INSTALLED', quick: 'ENGINE_NOT_INSTALLED' }, true));
    child.on('close', (code) => {
      if (finished) return;
      const output = Buffer.concat(chunks).toString('utf8');
      if (code !== 0 || secrets.some((key) => output.includes(key) || output.includes(JSON.stringify(key).slice(1, -1)))) { finish(failed); return; }
      try { finish(JSON.parse(output)); } catch { finish(failed); }
    });
  });
}
