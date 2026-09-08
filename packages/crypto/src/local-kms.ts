// Local development KMS — plan/phase-00 T00.6.
//
// Implements the same port as the AWS adapter so nothing above it can tell the
// difference. It wraps a DEK under a root key held in the environment, using the
// same AES-256-GCM construction KMS uses internally.
//
// This is a DEVELOPMENT adapter and it says so loudly:
//   - it refuses to run when NODE_ENV is 'production'
//   - the root key comes from TRADEX_LOCAL_ROOT_KEY (64 hex chars); if absent
//     it generates an ephemeral one and warns, because a restart then makes
//     every stored ciphertext unrecoverable — which is exactly the failure the
//     real CMK's deletion protection exists to prevent (07 F8)

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { DekBytes, GeneratedDek, KmsPort } from './kms.js';
import { KmsError } from './kms.js';

const ROOT_KEY_ENV = 'TRADEX_LOCAL_ROOT_KEY';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;

function resolveRootKey(): { key: Buffer; ephemeral: boolean } {
  const hex = process.env[ROOT_KEY_ENV];
  if (hex !== undefined && hex !== '') {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new KmsError(`${ROOT_KEY_ENV} must be exactly 64 hex characters (32 bytes)`);
    }
    return { key: Buffer.from(hex, 'hex'), ephemeral: false };
  }
  return { key: randomBytes(DEK_BYTES), ephemeral: true };
}

export class LocalKms implements KmsPort {
  readonly keyId: string;
  readonly #rootKey: Buffer;

  constructor(opts: { allowInProduction?: boolean } = {}) {
    if (process.env['NODE_ENV'] === 'production' && opts.allowInProduction !== true) {
      throw new KmsError(
        'LocalKms must never run in production — a root key in an environment variable is not a KMS',
      );
    }
    const { key, ephemeral } = resolveRootKey();
    this.#rootKey = key;
    this.keyId = ephemeral ? 'local-kms:ephemeral' : 'local-kms:env';
    if (ephemeral) {
      console.warn(
        `[LocalKms] no ${ROOT_KEY_ENV} set — generated an ephemeral root key. ` +
          'Every credential sealed in this process becomes unrecoverable on restart.',
      );
    }
  }

  async generateDek(): Promise<GeneratedDek> {
    const plaintext = randomBytes(DEK_BYTES);
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.#rootKey, nonce);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    // wrapped = nonce || tag || ciphertext, mirroring an opaque KMS blob.
    return { plaintext, wrapped: Buffer.concat([nonce, tag, ct]) };
  }

  async unwrapDek(wrapped: Uint8Array): Promise<DekBytes> {
    if (wrapped.byteLength < NONCE_BYTES + TAG_BYTES + 1) {
      throw new KmsError('wrapped DEK is too short to be valid');
    }
    const buf = Buffer.from(wrapped);
    const nonce = buf.subarray(0, NONCE_BYTES);
    const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
    const ct = buf.subarray(NONCE_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', this.#rootKey, nonce);
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch {
      throw new KmsError('wrapped DEK failed authentication — wrong root key or tampered blob');
    }
  }
}
