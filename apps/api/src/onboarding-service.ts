// Onboarding — plan/phase-02 T02.4 and T02.5, the sequence from 19 F3.
//
// Turns a customer's typed key/secret + allocated capital into a validated,
// reconciled account. The sequence is fixed and each step guards the next:
//
//   1. shape check         — reject an obviously-wrong key before touching anything
//   2. fingerprint check   — reject a duplicate, NAMING the account it clashes with
//   3. create account      — pending_validation
//   4. seal + insert cred  — pending_validation; the DB unique index is the real
//                            race guard, the step-2 check is only for the message
//   5. live probe          — sign with the plaintext just entered (NOT the signer,
//                            which refuses a pending credential) and read balances
//   6. on failure          — the three-cause message (07 F1: the IP-binding trap)
//   7. on success          — derive funding currencies, return a reconciliation
//                            payload; the customer confirms in a second step
//
// `validate` stops at the reconciliation payload without activating: the customer
// must choose which capital figure to keep (T02.5). `confirm` does the activation.
//
// The service is dependency-injected — tenant db, KMS, pepper, and a `probe`
// function — so the whole sequence runs against the fake venue in a check with
// no network and no real KMS.

import { randomUUID } from 'node:crypto';
import { fingerprintOf, keyLast4, sealCredential } from '@tradex/crypto';
import type { KmsPort } from '@tradex/crypto';
import {
  activate, confirmAllocation, findByFingerprint, insertAccount, insertCredential,
} from '@tradex/db';
import type { TenantDb } from '@tradex/db';
import { deriveFundingCurrencies, freeBalanceMinor } from '@tradex/exchange';
import type { Balance, CredentialProbe, FundingCurrency, ProbeFn } from '@tradex/exchange';

/** The message every onboarding auth failure carries. The third cause is the common one. */
export const THREE_CAUSE_MESSAGE =
  'The exchange rejected these credentials. The likely causes, in order: '
  + '(1) the API key or secret was mistyped or copied with a stray space; '
  + '(2) the secret belongs to a different key; '
  + '(3) the key was created with "Bind IP Address" ticked — Tradex trades from its own servers, '
  + 'so an IP-bound key can never authenticate here. Create the key without IP binding.';

export type OnboardingRejection =
  | { readonly kind: 'shape_invalid'; readonly message: string }
  | { readonly kind: 'duplicate_key'; readonly message: string; readonly conflictingAccountName: string }
  | { readonly kind: 'auth_failed'; readonly message: string }
  | { readonly kind: 'venue_unreachable'; readonly message: string }
  | { readonly kind: 'venue_error'; readonly message: string };

export interface ReconciliationPayload {
  readonly accountId: string;
  readonly credentialId: string;
  readonly apiKeyLast4: string;
  readonly allocatedCurrency: FundingCurrency;
  /** What the customer typed, minor units. */
  readonly typedCapitalMinor: string;
  /** The real free balance in that currency right now, minor units. */
  readonly realFreeMinor: string;
  /** True when the two differ at all — the panel must appear whenever they do. */
  readonly diverges: boolean;
  readonly fundingCurrencies: readonly FundingCurrency[];
  readonly balances: readonly Balance[];
}

export type ValidateResult =
  | { readonly ok: true; readonly reconciliation: ReconciliationPayload }
  | { readonly ok: false; readonly rejection: OnboardingRejection };

export interface OnboardingInput {
  readonly accountName: string;
  readonly allocatedCapitalMinor: string;
  readonly allocatedCurrency: FundingCurrency;
  readonly apiKey: string;
  readonly apiSecret: string;
}

export interface OnboardingDeps {
  readonly tdb: TenantDb;
  readonly kms: KmsPort;
  readonly pepper: Uint8Array;
  /** Injected so the fake venue can stand in; production passes the coindcx probe. */
  readonly probe: ProbeFn;
  readonly newId?: (() => string) | undefined;
}

/** A key/secret that cannot possibly be real is rejected before any I/O. */
function checkShape(input: OnboardingInput): string | null {
  const key = input.apiKey.trim();
  const secret = input.apiSecret.trim();
  if (key.length < 8) return 'the API key is too short to be a CoinDCX key';
  if (secret.length < 8) return 'the API secret is too short to be a CoinDCX secret';
  if (input.accountName.trim() === '') return 'the account needs a name';
  if (!/^\d+$/.test(input.allocatedCapitalMinor) || input.allocatedCapitalMinor === '0') {
    return 'the allocated capital must be a positive amount';
  }
  return null;
}

export class OnboardingService {
  constructor(private readonly deps: OnboardingDeps) {}

  /**
   * Steps 1-7. Returns a reconciliation payload on success WITHOUT activating —
   * the account stays `pending_validation` until `confirm` records the
   * customer's basis choice.
   */
  async validate(input: OnboardingInput): Promise<ValidateResult> {
    const { tdb, kms, pepper, probe } = this.deps;
    const newId = this.deps.newId ?? randomUUID;

    const shape = checkShape(input);
    if (shape !== null) return { ok: false, rejection: { kind: 'shape_invalid', message: shape } };

    // Step 2: the friendly duplicate message. The DB unique index (step 4) is the
    // race-safe guard; this pre-check exists to name the conflicting account.
    const fingerprint = fingerprintOf(pepper, input.apiKey);
    const existing = await findByFingerprint(tdb, fingerprint);
    if (existing !== null) {
      return {
        ok: false,
        rejection: {
          kind: 'duplicate_key',
          conflictingAccountName: existing.accountName,
          message: `This API key is already connected to the account "${existing.accountName}". `
            + 'A CoinDCX key may only be connected once — connecting it twice would place two legs '
            + 'of every group trade on the same exchange account.',
        },
      };
    }

    // Steps 3-4: create the account, then seal and insert the credential. Both
    // pending_validation. The credential id is chosen here because the AAD binds
    // the ciphertext to it.
    const accountId = await insertAccount(tdb, {
      name: input.accountName,
      allocatedCapitalMinor: input.allocatedCapitalMinor,
      allocatedCurrency: input.allocatedCurrency,
    });
    const credentialId = newId();
    const sealed = await sealCredential(
      kms,
      { tenantId: tdb.tenantId, accountId, credentialId, keyVersion: 1 },
      input.apiKey,
      input.apiSecret,
    );
    await insertCredential(tdb, {
      id: credentialId,
      accountId,
      kmsKeyArn: sealed.kmsKeyId,
      keyVersion: sealed.keyVersion,
      dekWrapped: sealed.dekWrapped,
      apiKeyCt: sealed.apiKey.ct,
      apiKeyNonce: sealed.apiKey.nonce,
      apiKeyTag: sealed.apiKey.tag,
      apiSecretCt: sealed.apiSecret.ct,
      apiSecretNonce: sealed.apiSecret.nonce,
      apiSecretTag: sealed.apiSecret.tag,
      apiKeyLast4: keyLast4(input.apiKey),
      fingerprint,
    });

    // Step 5: the live proof. Signed with the plaintext still in hand.
    const result = await probe(input.apiKey, input.apiSecret);
    if (!result.ok) return { ok: false, rejection: this.rejectionFor(result) };

    // Step 7: reconcile. The account and credential remain pending until confirm.
    const balances = result.balances ?? [];
    const fundingCurrencies = deriveFundingCurrencies(balances);
    const realFreeMinor = freeBalanceMinor(balances, input.allocatedCurrency);
    return {
      ok: true,
      reconciliation: {
        accountId,
        credentialId,
        apiKeyLast4: keyLast4(input.apiKey),
        allocatedCurrency: input.allocatedCurrency,
        typedCapitalMinor: input.allocatedCapitalMinor,
        realFreeMinor,
        diverges: realFreeMinor !== input.allocatedCapitalMinor,
        fundingCurrencies,
        balances,
      },
    };
  }

  /**
   * Step 8 (T02.5): record the customer's basis choice, persist the observed
   * balances and funding currencies, and activate. `adoptRealAsBasis` false keeps
   * the typed figure; true adopts the real balance. Both are always retained.
   */
  async confirm(input: {
    accountId: string;
    credentialId: string;
    confirmedAgainstMinor: string;
    adoptRealAsBasis: boolean;
    fundingCurrencies: readonly FundingCurrency[];
    balances: readonly Balance[];
  }): Promise<void> {
    await confirmAllocation(this.deps.tdb, {
      accountId: input.accountId,
      confirmedAgainstMinor: input.confirmedAgainstMinor,
      adoptRealAsBasis: input.adoptRealAsBasis,
      fundingCurrencies: input.fundingCurrencies,
      balances: input.balances,
    });
    const activated = await activate(this.deps.tdb, input.credentialId);
    if (!activated) throw new Error(`credential ${input.credentialId} could not be activated`);
  }

  private rejectionFor(result: CredentialProbe): OnboardingRejection {
    if (result.neverSent === true) {
      return {
        kind: 'venue_unreachable',
        message: 'Could not reach the exchange to validate the key. Nothing was placed — please try again.',
      };
    }
    const cls = result.failure?.class;
    if (cls === 'auth_failure' || cls === 'signature_error') {
      return { kind: 'auth_failed', message: THREE_CAUSE_MESSAGE };
    }
    if (cls === 'rate_limited') {
      return { kind: 'venue_error', message: 'The exchange is rate-limiting this key right now. Please try again shortly.' };
    }
    return {
      kind: 'venue_error',
      message: `The exchange returned an unexpected error while validating the key: ${result.failure?.detail ?? 'unknown'}.`,
    };
  }
}
