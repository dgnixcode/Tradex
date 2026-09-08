// The KMS port — plan/phase-00 T00.6, from 07-api-key-security.md F3.
//
// Envelope encryption has exactly two operations, and they are deliberately
// shaped to match AWS KMS's GenerateDataKey / Decrypt so the real adapter is a
// thin translation rather than a redesign:
//
//   generateDek() -> { plaintext, wrapped }   // KMS: GenerateDataKey
//   unwrapDek(wrapped) -> plaintext          // KMS: Decrypt
//
// The port exists from day one so that no order path is ever written against a
// concrete KMS. The process split in Phase 06 moves the only holder of these
// permissions into apps/signer.

/** 256-bit data encryption key material. */
export type DekBytes = Uint8Array;

export interface GeneratedDek {
  /** Live key material. The caller MUST zero this after use. */
  readonly plaintext: DekBytes;
  /** The wrapped form we persist in `exchange_credential.dek_wrapped`. */
  readonly wrapped: Uint8Array;
}

export interface KmsPort {
  /**
   * Identifier recorded in `exchange_credential.kms_key_arn` so a future
   * re-encryption knows which key wrapped which row.
   */
  readonly keyId: string;
  generateDek(): Promise<GeneratedDek>;
  unwrapDek(wrapped: Uint8Array): Promise<DekBytes>;
}

export class KmsError extends Error {
  override readonly name = 'KmsError';
}

/**
 * What the AWS adapter must do when T00.10 unblocks (no AWS CLI or account is
 * configured on this machine, so it is not written yet rather than written
 * unverified):
 *
 *   generateDek():
 *     GenerateDataKeyCommand({ KeyId: keyArn, KeySpec: 'AES_256' })
 *       -> { Plaintext, CiphertextBlob }
 *   unwrapDek(wrapped):
 *     DecryptCommand({ KeyId: keyArn, CiphertextBlob: wrapped })
 *       -> { Plaintext }
 *
 * Requirements that are not the adapter's code but are part of this task:
 *   - the CMK lives in ap-south-1 with deletion protection ON and a
 *     multi-region replica (07 F8: losing the CMK means every customer
 *     re-onboards by hand, because CoinDCX shows a secret exactly once)
 *   - only the signer's IAM role holds kms:Decrypt; an assertion test proves
 *     the api and worker roles do not (plan/phase-00 T00.10)
 *   - every Decrypt call is audited with actor, process and reason (07 F3)
 *   - measure and record Decrypt latency: it is the largest assumed number in
 *     22 F2's latency budget, at 20 calls per group trade
 */
export const AWS_KMS_ADAPTER_NOTES = true;
