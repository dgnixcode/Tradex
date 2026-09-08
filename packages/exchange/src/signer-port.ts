// The signer port — plan/phase-02 T02.3, from 07-api-key-security.md F5/F6.
//
// The signer is the only process permitted to hold KMS decrypt rights, so it is
// the only place a credential's secret ever exists in plaintext. Everything else
// asks it for a signature.
//
// This port is deliberately venue-neutral. `apps/signer` must not know that
// CoinDCX exists — the CI rule ADAPTER-BOUNDARY enforces that no file outside
// `packages/exchange-coindcx` may import the adapter — and the reason is not
// tidiness: CoinDCX's API terms let them terminate without notice (D12), so the
// thing holding the keys must outlive the venue that happens to use them.
//
// The split of responsibilities that follows from that:
//   - the ADAPTER decides what bytes to sign, and which headers carry the result
//   - the SIGNER turns those bytes into a signature, and never learns why
//
// `apiKey` comes back in the clear on purpose. An API key is not a secret in the
// cryptographic sense: it travels in a plaintext header on every request, and the
// venue treats it as an identifier. The SECRET is what never leaves the signer.

export class SignerError extends Error {
  override readonly name = 'SignerError';
}

export interface SignatureRequest {
  readonly credentialId: string;
  /**
   * The exact bytes to sign — not an object to be serialised.
   *
   * A signature covers bytes. Passing a structure here and letting the signer
   * serialise it reintroduces the failure the adapter's own signing path exists
   * to prevent: the string that was signed and the string that is sent diverge
   * by key order, and the venue answers with an opaque 401 that reads like a
   * revoked credential.
   */
  readonly payload: string;
  readonly algorithm: 'hmac-sha256-hex';
  /** Recorded on the decrypt audit event. Required: an unexplained decrypt is a finding. */
  readonly reason: string;
  /** Who or what asked. `actorUserId` is null for a scheduled or reconciler call. */
  readonly actorProcess: string;
  readonly actorUserId?: string | null | undefined;
}

export interface SignatureResult {
  /** The public identifier. Sent in a cleartext header; not a secret. */
  readonly apiKey: string;
  readonly signature: string;
  /** Which key version opened the credential, for a future re-encryption sweep. */
  readonly keyVersion: number;
}

export interface SignerPort {
  sign(request: SignatureRequest): Promise<SignatureResult>;
}
