import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAiModelProbe, safeModelTest } from './ai-model-test.js';
import { resolveResearchPython } from './process.js';

describe('safe model test outcomes', () => {
  it('keeps only allowlisted codes and fixed messages', () => {
    const result = safeModelTest({ deep: 'OK', quick: 'AUTH_FAILED', apiKey: 'secret', message: 'secret-provider-error' });
    expect(result.deep.ok).toBe(true); expect(result.quick.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
    for (const value of [null, [], 'raw-provider-error', { deep: '__proto__', quick: 'synthetic-private-key' }]) {
      expect(safeModelTest(value).deep.code).toBe('TEST_FAILED');
      expect(safeModelTest(value).quick.code).toBe('TEST_FAILED');
    }
  });
});

describe('bounded isolated model-test subprocess', () => {
  let dir: string; let python: string;
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'tradex-ai-test-')); python = resolveResearchPython('python'); });
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
  const run = async (source: string, timeoutMs = 3000, env: NodeJS.ProcessEnv = {}) => {
    const script = join(dir, `fixture-${crypto.randomUUID()}.py`); await writeFile(script, source);
    return runAiModelProbe({ python, script, env, timeoutMs });
  };
  it('passes only allowlisted environment values and suppresses provider stderr', async () => {
    const raw = await run("import os,json,sys\nprint('private provider error',file=sys.stderr)\nprint(json.dumps({'deep':'OK' if os.environ.get('OPENAI_API_KEY') == 'synthetic-provider-secret' and not os.environ.get('DATABASE_URL') and not os.environ.get('TRADEX_RESEARCH_ROOT_KEY') else 'TEST_FAILED','quick':'OK'}))",
      3000, { OPENAI_API_KEY: 'synthetic-provider-secret', DATABASE_URL: 'private-db', TRADEX_RESEARCH_ROOT_KEY: 'private-root' });
    expect(safeModelTest(raw).deep.ok).toBe(true);
  });
  it('kills timed-out and excessive-output probes', async () => {
    expect(safeModelTest(await run('import time\ntime.sleep(20)', 100)).deep.code).toBe('TIMEOUT');
    expect(safeModelTest(await run("print('x'*5000)")).deep.code).toBe('TEST_FAILED');
  });
  it('rejects secret-bearing, invalid and failed process output', async () => {
    expect(safeModelTest(await run("import os,json\nprint(json.dumps({'deep':'OK','quick':'OK','leak':os.environ['OPENAI_API_KEY']}))", 3000,
      { OPENAI_API_KEY: 'synthetic-provider-secret' })).deep.code).toBe('TEST_FAILED');
    expect(safeModelTest(await run("print('invalid-json')")).deep.code).toBe('TEST_FAILED');
    expect(safeModelTest(await run("import sys\nprint('{\"deep\":\"OK\",\"quick\":\"OK\"}')\nsys.exit(1)")).deep.code).toBe('TEST_FAILED');
  });
});
