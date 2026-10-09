import { spawn, spawnSync } from 'node:child_process';
import type { ResearchRequest } from './contracts.js';

export const RESEARCH_ENV_KEYS = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'SSL_CERT_FILE',
  'USERPROFILE', 'LOCALAPPDATA', 'APPDATA',
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'COINGECKO_DEMO_API_KEY',
  'TRADEX_RESEARCH_LLM_PROVIDER', 'TRADEX_RESEARCH_DEEP_MODEL', 'TRADEX_RESEARCH_QUICK_MODEL'] as const;
export function researchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONNOUSERSITE: '1', PYTHON_DOTENV_DISABLED: '1' };
  for (const key of RESEARCH_ENV_KEYS) if (env[key]) clean[key] = env[key];
  return clean;
}

/** Resolve launchers (including Windows Store aliases) to the actual interpreter
 * so killing a job stops Python itself rather than leaving a launcher child. */
export function resolveResearchPython(executable: string): string {
  const env = researchEnvironment(process.env);
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'COINGECKO_DEMO_API_KEY']) delete env[key];
  const result = spawnSync(executable, ['-I', '-c', 'import sys; print(sys.executable)'], {
    shell: false, windowsHide: true, timeout: 10_000, encoding: 'utf8', env,
  });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('PYTHON_UNAVAILABLE');
  return result.stdout.trim();
}

export async function runResearchProcess(opts: {
  python: string; script: string; request: ResearchRequest; timeoutMs: number;
  signal: AbortSignal; env?: NodeJS.ProcessEnv; onStage?: (stage: string) => void;
}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const env = researchEnvironment(opts.env ?? process.env);
    const secrets = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY'].map((name) => env[name]).filter((key): key is string => Boolean(key));
    const child = spawn(opts.python, ['-I', opts.script], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
    const chunks: Buffer[] = []; let bytes = 0; let stderr = ''; let stopped = false;
    const stop = (reason: string) => { if (stopped) return; stopped = true; child.kill('SIGKILL'); reject(new Error(reason)); };
    const abort = () => stop('CANCELLED');
    const timer = setTimeout(() => stop('TIMEOUT'), opts.timeoutMs);
    opts.signal.addEventListener('abort', abort, { once: true });
    if (opts.signal.aborted) abort();
    child.stdin.on('error', () => { /* Exit handler reports the failure. */ });
    child.stdin.end(JSON.stringify(opts.request));
    child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2_000_000) stop('OUTPUT_LIMIT'); else chunks.push(chunk); });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4096);
      const lines = stderr.split('\n'); stderr = lines.pop() ?? '';
      for (const line of lines) {
        // Only our fixed progress markers are accepted; provider logs are discarded.
        if (line.startsWith('TRADEX_STAGE:')) {
          const stage = line.slice(13).trim();
          if (['Collecting market evidence', 'Running research analysts', 'Validating report'].includes(stage)) opts.onStage?.(stage);
        }
      }
    });
    child.on('error', () => { clearTimeout(timer); opts.signal.removeEventListener('abort', abort); stop('PYTHON_UNAVAILABLE'); });
    child.on('close', (code) => {
      clearTimeout(timer); opts.signal.removeEventListener('abort', abort);
      if (stopped) return;
      try {
        const output = Buffer.concat(chunks).toString('utf8');
        if (secrets.some((key) => output.includes(key) || output.includes(JSON.stringify(key).slice(1, -1)))) {
          reject(new Error('ENGINE_FAILED')); return;
        }
        const result: unknown = JSON.parse(output);
        if (code !== 0) {
          const error = result as { errorCode?: unknown };
          const allowed = ['DATA_UNAVAILABLE', 'AMBIGUOUS_COIN', 'IDENTITY_MISMATCH', 'ENGINE_NOT_INSTALLED', 'LLM_NOT_CONFIGURED', 'BUDGET_EXCEEDED', 'ENGINE_FAILED'];
          reject(new Error(typeof error.errorCode === 'string' && allowed.includes(error.errorCode) ? error.errorCode : 'ENGINE_FAILED'));
        } else resolve(result);
      } catch { reject(new Error('INVALID_REPORT')); }
    });
  });
}
