// packages/crypto — the property under test is that a ciphertext row is useless
// anywhere except the exact identity it was sealed under.
// Source: 07-api-key-security.md F3, plan/phase-00 T00.6.

import { describe, expect, it } from 'vitest';
import {
  EnvelopeError, LocalKms, aadFor, bytesEqual, openCredential, openWithDek,
  sealCredential, sealWithDek, zero,
} from './index.js';
import type { CredentialIdentity } from './index.js';

const kms = new LocalKms();

const ID: CredentialIdentity = {
  tenantId: 'ten_01J8Z0000000000000000000',
  accountId: 'acc_01J8Z1111111111111111111',
  credentialId: 'cred_01J8Z222222222222222222',
  keyVersion: 1,
};

const API_KEY = 'b71c4e0f9a2d8536cf14a7e2905b3d68';
const API_SECRET = 'e5a2c9147bd60f38a91e74c5820db6f3417ace95028d6b1f7304ca86e29b5d70';

/** Flip one byte of a copy. `noUncheckedIndexedAccess` makes `x[i] ^= n` unsafe. */
const flipByte = (bytes: Uint8Array, index: number): Uint8Array => {
  const out = Uint8Array.from(bytes);
  out[index] = (out.at(index) ?? 0) ^ 0xff;
  return out;
};

describe('LocalKms implements the port faithfully', () => {
  it('generates a 32-byte DEK and a wrapped blob that is not the DEK', async () => {
    const { plaintext, wrapped } = await kms.generateDek();
    expect(plaintext.byteLength).toBe(32);
    expect(wrapped.byteLength).toBeGreaterThan(32);
    expect(bytesEqual(plaintext, wrapped.subarray(0, 32))).toBe(false);
  });

  it('round-trips a DEK', async () => {
    const { plaintext, wrapped } = await kms.generateDek();
    expect(bytesEqual(await kms.unwrapDek(wrapped), plaintext)).toBe(true);
  });

  it('generates a distinct DEK every time', async () => {
    const a = await kms.generateDek();
    const b = await kms.generateDek();
    expect(bytesEqual(a.plaintext, b.plaintext)).toBe(false);
    expect(bytesEqual(a.wrapped, b.wrapped)).toBe(false);
  });

  it('rejects a tampered wrapped blob', async () => {
    const { wrapped } = await kms.generateDek();
    const tampered = flipByte(wrapped, wrapped.length - 1);
    await expect(kms.unwrapDek(tampered)).rejects.toThrow(/failed authentication/);
  });

  it('rejects a blob that is too short to be valid', async () => {
    await expect(kms.unwrapDek(new Uint8Array(4))).rejects.toThrow(/too short/);
  });

  it('cannot unwrap a blob from a different root key', async () => {
    const other = new LocalKms();
    const { wrapped } = await kms.generateDek();
    await expect(other.unwrapDek(wrapped)).rejects.toThrow(/failed authentication/);
  });
});

describe('the AAD refuses a partial identity', () => {
  it('rejects an empty field', () => {
    for (const field of ['tenantId', 'accountId', 'credentialId'] as const) {
      expect(() => aadFor({ ...ID, [field]: '' })).toThrow(/refusing to bind/);
    }
  });

  it('rejects a non-positive key version', () => {
    expect(() => aadFor({ ...ID, keyVersion: 0 })).toThrow(/positive integer/);
    expect(() => aadFor({ ...ID, keyVersion: 1.5 })).toThrow(/positive integer/);
  });

  it('produces a distinct AAD per identity field', () => {
    const base = aadFor(ID).toString('utf8');
    expect(aadFor({ ...ID, tenantId: 'other' }).toString('utf8')).not.toBe(base);
    expect(aadFor({ ...ID, accountId: 'other' }).toString('utf8')).not.toBe(base);
    expect(aadFor({ ...ID, credentialId: 'other' }).toString('utf8')).not.toBe(base);
    expect(aadFor({ ...ID, keyVersion: 2 }).toString('utf8')).not.toBe(base);
  });
});

describe('sealing and opening a credential', () => {
  it('round-trips the key and the secret', async () => {
    const sealed = await sealCredential(kms, ID, API_KEY, API_SECRET);
    const opened = await openCredential(kms, ID, sealed);
    expect(opened.apiKey.expose()).toBe(API_KEY);
    expect(opened.apiSecret.expose()).toBe(API_SECRET);
  });

  it('returns Secret wrappers, not bare strings', async () => {
    const sealed = await sealCredential(kms, ID, API_KEY, API_SECRET);
    const opened = await openCredential(kms, ID, sealed);
    expect(String(opened.apiSecret)).toBe('[redacted]');
    expect(JSON.stringify(opened)).not.toContain(API_SECRET);
  });

  it('stores nothing reversible: no plaintext appears in the sealed record', async () => {
    const sealed = await sealCredential(kms, ID, API_KEY, API_SECRET);
    const asHex = [
      Buffer.from(sealed.apiKey.ct).toString('hex'),
      Buffer.from(sealed.apiSecret.ct).toString('hex'),
      Buffer.from(sealed.dekWrapped).toString('hex'),
    ].join('');
    expect(asHex).not.toContain(Buffer.from(API_KEY, 'utf8').toString('hex'));
    expect(asHex).not.toContain(Buffer.from(API_SECRET, 'utf8').toString('hex'));
  });

  it('keeps only the last four characters of the key as display metadata', async () => {
    const sealed = await sealCredential(kms, ID, API_KEY, API_SECRET);
    expect(sealed.apiKeyLast4).toBe('3d68');
    expect(API_KEY).toContain(sealed.apiKeyLast4);
  });

  it('uses independent nonces for the key and the secret', async () => {
    const sealed = await sealCredential(kms, ID, API_KEY, API_SECRET);
    expect(bytesEqual(sealed.apiKey.nonce, sealed.apiSecret.nonce)).toBe(false);
  });

  it('produces different ciphertext for the same input each time', async () => {
    const a = await sealCredential(kms, ID, API_KEY, API_SECRET);
    const b = await sealCredential(kms, ID, API_KEY, API_SECRET);
    expect(bytesEqual(a.apiSecret.ct, b.apiSecret.ct)).toBe(false);
  });

  it('refuses an implausibly short credential', async () => {
    await expect(sealCredential(kms, ID, 'short', API_SECRET)).rejects.toThrow(EnvelopeError);
    await expect(sealCredential(kms, ID, API_KEY, 'short')).rejects.toThrow(EnvelopeError);
  });
});

describe('AAD binding — a relocated row cannot be opened', () => {
  it('fails when the account id differs', async () => {
    const sealed = await sealCredential(kms, ID, API_KEY, API_SECRET);
    await expect(
      openCredential(kms, { ...ID, accountId: 'acc_someone_else' }, sealed),
    ).rejects.toThrow(/authentication failed/);
  });

  it('fails when the tenant id differs', async () => {
    const sealed = await sealCredential(kms, ID, API_KEY, API_SECRET);
    await expect(
      openCredential(kms, { ...ID, tenantId: 'ten_someone_else' }, sealed),
    ).rejects.toThrow(/authentication failed/);
  });

  it('fails when the credential id differs', async () => {
    const sealed = await sealCredential(kms, ID, API_KEY, API_SECRET);
    await expect(
      openCredential(kms, { ...ID, credentialId: 'cred_other' }, sealed),
    ).rejects.toThrow(/authentication failed/);
  });

  it('fails when the key version differs', async () => {
    const sealed = await sealCredential(kms, ID, API_KEY, API_SECRET);
    await expect(openCredential(kms, { ...ID, keyVersion: 2 }, sealed)).rejects.toThrow(/authentication failed/);
  });

  it('fails when the auth tag is tampered with', async () => {
    const { plaintext: dek } = await kms.generateDek();
    const sealed = sealWithDek(dek, API_SECRET, ID);
    const tag = flipByte(sealed.tag, 0);
    expect(() => openWithDek(dek, { ...sealed, tag }, ID)).toThrow(/authentication failed/);
  });

  it('fails when the ciphertext is tampered with', async () => {
    const { plaintext: dek } = await kms.generateDek();
    const sealed = sealWithDek(dek, API_SECRET, ID);
    const ct = flipByte(sealed.ct, 0);
    expect(() => openWithDek(dek, { ...sealed, ct }, ID)).toThrow(/authentication failed/);
  });

  it('rejects a DEK of the wrong length', () => {
    expect(() => sealWithDek(new Uint8Array(16), API_SECRET, ID)).toThrow(/32 bytes/);
  });
});

describe('key material hygiene', () => {
  it('zero() overwrites in place', () => {
    const b = Uint8Array.from([1, 2, 3, 4]);
    zero(b);
    expect([...b]).toEqual([0, 0, 0, 0]);
  });

  it('the DEK is zeroed after sealing, so the caller cannot retain it', async () => {
    // sealCredential zeroes in a finally block; observing it directly requires a
    // spy on the port, which is the honest way to assert the contract.
    let captured: Uint8Array | undefined;
    const spy = {
      keyId: kms.keyId,
      generateDek: async () => {
        const g = await kms.generateDek();
        captured = g.plaintext;
        return g;
      },
      unwrapDek: (w: Uint8Array) => kms.unwrapDek(w),
    };
    await sealCredential(spy, ID, API_KEY, API_SECRET);
    expect(captured).toBeDefined();
    expect(captured!.every((byte) => byte === 0)).toBe(true);
  });
});
