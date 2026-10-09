import { describe, expect, it } from 'vitest';
import { ResearchKeyVault } from './ai-settings.js';

describe('write-only research credential encryption', () => {
  const vault = new ResearchKeyVault('ab'.repeat(32));
  const key = 'synthetic-provider-secret-123456';
  const sealed = () => vault.seal('tenant-a', 'openai', 'revision-a', key);
  it('encrypts credentials with a fresh nonce and opens them only for their identity', () => {
    const blob = sealed();
    expect(blob.includes(Buffer.from(key))).toBe(false);
    expect(blob).not.toEqual(sealed());
    expect(vault.open('tenant-a', 'openai', 'revision-a', blob)).toBe(key);
  });
  it('rejects tenant, provider, revision, ciphertext and root-key substitution', () => {
    const blob = sealed();
    expect(() => vault.open('tenant-b', 'openai', 'revision-a', blob)).toThrow('AI_KEY_UNAVAILABLE');
    expect(() => vault.open('tenant-a', 'google', 'revision-a', blob)).toThrow('AI_KEY_UNAVAILABLE');
    expect(() => vault.open('tenant-a', 'openai', 'revision-b', blob)).toThrow('AI_KEY_UNAVAILABLE');
    const tampered = Buffer.from(blob); tampered[30] = tampered[30]! ^ 1;
    expect(() => vault.open('tenant-a', 'openai', 'revision-a', tampered)).toThrow('AI_KEY_UNAVAILABLE');
    expect(() => new ResearchKeyVault('cd'.repeat(32)).open('tenant-a', 'openai', 'revision-a', blob)).toThrow('AI_KEY_UNAVAILABLE');
  });
  it('requires an explicit persistent 256-bit research root', () => {
    expect(() => new ResearchKeyVault('')).toThrow('TRADEX_RESEARCH_ROOT_KEY');
    expect(() => new ResearchKeyVault('not-a-key')).toThrow('TRADEX_RESEARCH_ROOT_KEY');
  });
});
