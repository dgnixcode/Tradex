// Credential probe result — plan/phase-02 T02.4, the venue-neutral port shape.
//
// The RESULT of validating a credential is domain-shaped: onboarding branches on
// "did it work / was it an auth failure / did the request even leave", and none
// of that is CoinDCX vocabulary. The concrete probe that signs a CoinDCX read
// and maps the response lives in the adapter; this is the shape it returns, so
// the onboarding service can depend on the port and never on the venue.

import type { Balance } from './adapter.js';
import type { ClassifiedFailure } from './adapter.js';

export interface CredentialProbe {
  /** True only when the venue returned a usable success (200 with a parseable body). */
  readonly ok: boolean;
  /** Present when ok. Empty is legal — a funded-but-idle account holds nothing yet. */
  readonly balances?: readonly Balance[] | undefined;
  /** Present when not ok. Classified so the caller can pick the right message. */
  readonly failure?: ClassifiedFailure | undefined;
  /** True when the request never reached the venue (DNS, connect) — retry is safe. */
  readonly neverSent?: boolean | undefined;
}

/** The signature of a credential-validation probe, injectable for testing. */
export type ProbeFn = (apiKey: string, apiSecret: string) => Promise<CredentialProbe>;
