// TOTP-secret envelope round trip — the whole point is that a sealed secret
// opens only under the exact identity it was bound to. A relocated row (wrong
// tenant or user) must fail authentication rather than decrypt.

import { describe, expect, it } from 'vitest';
import { totp, verifyTotp, generateTotpSecret } from '@tradex/auth';
import { LocalKms } from './local-kms.js';
import { openTotpSecret, sealTotpSecret, verifyTotpFromEnvelope } from './totp-secret.js';

const kms = new LocalKms();
const id = { tenantId: 't1', userId: 'u1', keyVersion: 1 };

describe('sealTotpSecret / openTotpSecret', () => {
  it('round-trips the secret', async () => {
    const secret = generateTotpSecret();
    const sealed = await sealTotpSecret(kms, id, secret);
    const opened = await openTotpSecret(kms, id, sealed.buffer);
    expect(opened.expose()).toBe(secret);
    expect(sealed.buffer.byteLength).toBeGreaterThan(33);
  });

  it('refuses to open under a different tenant (relocated row)', async () => {
    const sealed = await sealTotpSecret(kms, id, generateTotpSecret());
    await expect(openTotpSecret(kms, { ...id, tenantId: 'other' }, sealed.buffer)).rejects.toThrow(/authentication failed/);
  });

  it('refuses to open under a different user', async () => {
    const sealed = await sealTotpSecret(kms, id, generateTotpSecret());
    await expect(openTotpSecret(kms, { ...id, userId: 'other' }, sealed.buffer)).rejects.toThrow(/authentication failed/);
  });

  it('refuses a different key version', async () => {
    const sealed = await sealTotpSecret(kms, id, generateTotpSecret());
    await expect(openTotpSecret(kms, { ...id, keyVersion: 2 }, sealed.buffer)).rejects.toThrow(/keyVersion/);
  });
});

describe('verifyTotpFromEnvelope', () => {
  it('accepts a genuine code and rejects a wrong one', async () => {
    const secret = generateTotpSecret();
    const sealed = await sealTotpSecret(kms, id, secret);
    const now = Date.now();
    const good = totp(secret, now);
    expect(verifyTotp(secret, good, now)).toBe(true);
    expect(await verifyTotpFromEnvelope(kms, id, sealed.buffer, good, now)).toBe(true);
    expect(await verifyTotpFromEnvelope(kms, id, sealed.buffer, '000000', now)).toBe(false);
  });
});
