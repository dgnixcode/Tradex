// Onboarding — plan/phase-02 T02.4 and T02.5, the sequence from 19 F3.
//
// Turns a customer's typed key/secret into a validated, reconciled account.
//
// PROBE FIRST. The order matters more than any single step:
//
//   1. shape check         — reject an obviously-wrong key before touching anything
//   2. fingerprint check   — reject a duplicate, NAMING the account it clashes with
//   3. live probe          — sign with the plaintext just entered (NOT the signer,
//                            which refuses a pending credential) and read balances
//   4. on failure          — NOTHING IS WRITTEN. The three-cause message (07 F1,
//                            the IP-binding trap), or the "no INR and no USDT"
//                            refusal. The customer corrects the key and resubmits
//   5. on success          — one transaction: account, sealed credential, the
//                            venue's sizing basis, its funding currencies and its
//                            observed balances
//
// Nothing is created before the probe succeeds, so a failed connect cannot strand
// a `pending_validation` account. `pending_validation` means the key is PROVEN and
// waiting to be switched on — `confirm` does that, and it takes no payload, so a
// connect abandoned at the review step can be finished later from its own page
// with no key re-sent.
//
// The service is dependency-injected — tenant db, KMS, pepper, and a `probe`
// function — so the whole sequence runs against the fake venue in a check with
// no network and no real KMS.

import { randomUUID } from 'node:crypto';
import { fingerprintOf, keyLast4, sealCredential } from '@tradex/crypto';
import type { KmsPort } from '@tradex/crypto';
import {
  activate, activateAllocation, findByAccount, findByFingerprint, insertAccount, insertCredential,
  recordObservedBalances, recordVenueBasis,
} from '@tradex/db';
import type { TenantDb } from '@tradex/db';
import { deriveFundingCurrencies, freeBalanceMinor } from '@tradex/exchange';
import type { Balance, CredentialProbe, FundingCurrency, ProbeFn } from '@tradex/exchange';

/**
 * The Postgres unique-violation code, and the constraint a race lost on. Kysely
 * re-throws the driver error, so the fields sit on the error object itself.
 */
function uniqueViolation(e: unknown): string | null {
  const err = e as { code?: unknown; constraint?: unknown };
  return err.code === '23505' && typeof err.constraint === 'string' ? err.constraint : null;
}

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
  | { readonly kind: 'duplicate_name'; readonly message: string }
  | { readonly kind: 'auth_failed'; readonly message: string }
  | { readonly kind: 'venue_unreachable'; readonly message: string }
  | { readonly kind: 'no_funding_currency'; readonly message: string }
  | { readonly kind: 'venue_error'; readonly message: string };

/**
 * What the customer is shown before activating. Both figures come from the
 * exchange, not from the customer: the currency from what the account can
 * actually fund with, the capital from the free balance it holds. Nothing here
 * is typed, so there is no typed-vs-real divergence left to reconcile.
 */
export interface ReconciliationPayload {
  readonly accountId: string;
  readonly credentialId: string;
  readonly apiKeyLast4: string;
  /** Derived from the venue's balances: the first fundable quote, INR preferred. */
  readonly allocatedCurrency: FundingCurrency;
  /** The real free balance in that currency right now, minor units. */
  readonly realFreeMinor: string;
  readonly fundingCurrencies: readonly FundingCurrency[];
  readonly balances: readonly Balance[];
}

export type ValidateResult =
  | { readonly ok: true; readonly reconciliation: ReconciliationPayload }
  | { readonly ok: false; readonly rejection: OnboardingRejection };

export interface OnboardingInput {
  readonly accountName: string;
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
  return null;
}

export class OnboardingService {
  constructor(private readonly deps: OnboardingDeps) {}

  /**
   * Steps 1-5. Returns a reconciliation payload on success without activating —
   * the account stays `pending_validation`, with its basis and balances already
   * recorded, until `confirm` switches the key on.
   *
   * A rejection means the database is exactly as it was.
   */
  async validate(input: OnboardingInput): Promise<ValidateResult> {
    const { tdb, pepper, probe } = this.deps;
    // `kms` is not used here any more: sealing happens inside `createProvenAccount`,
    // below the probe, so that a rejection never touches it.
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

    // Step 3: the live proof, and the FIRST thing that touches the network.
    //
    // It runs before anything is written ON PURPOSE. The account and credential
    // rows used to be created first (the credential's AAD binds to the account id,
    // so it needs the account to exist), which meant every failure — a mistyped
    // secret, an IP-bound key, a venue mapping bug — left a stranded
    // `pending_validation` account behind with no way to finish or remove it.
    // Probing first means a rejection writes nothing at all, and the customer just
    // corrects the key and submits again. The audit log records the attempt.
    const result = await probe(input.apiKey, input.apiSecret);
    if (!result.ok) return { ok: false, rejection: this.rejectionFor(result) };

    // Step 4: reconcile. The currency is DERIVED from what the account can
    // actually fund with, never asked of the customer — `deriveFundingCurrencies`
    // returns them in FUNDING_CURRENCIES order, so INR wins when both are held.
    // An account that holds neither has no currency to size a percent-of-capital
    // order against, so it is refused with a reason the customer can act on. This
    // is checked here, before any row exists, for the same reason as the probe.
    const balances = result.balances ?? [];
    const fundingCurrencies = deriveFundingCurrencies(balances);
    const allocatedCurrency = fundingCurrencies[0];
    if (allocatedCurrency === undefined) {
      return {
        ok: false,
        rejection: {
          kind: 'no_funding_currency',
          message: 'This account holds no INR and no USDT, so there is nothing to size a trade against. '
            + 'Fund the account on the exchange, then connect it again.',
        },
      };
    }
    const realFreeMinor = freeBalanceMinor(balances, allocatedCurrency);

    // Step 5: the key is proven, so it is safe to write. Account, credential, the
    // venue's sizing basis and the observed balances all land together in one
    // transaction — a partial connect would be worse than none.
    const created = await this.createProvenAccount({
      input, fingerprint, credentialId: newId(), realFreeMinor, allocatedCurrency, fundingCurrencies, balances,
    });
    if (!created.ok) return { ok: false, rejection: created.rejection };

    return {
      ok: true,
      reconciliation: {
        accountId: created.accountId,
        credentialId: created.credentialId,
        apiKeyLast4: keyLast4(input.apiKey),
        allocatedCurrency,
        realFreeMinor,
        fundingCurrencies,
        balances,
      },
    };
  }

  /**
   * Write a proven connect: the account, its sealed credential, the venue's sizing
   * basis and the balances the venue reported — one transaction, so a half-created
   * account can never survive.
   *
   * The two unique indexes are the real guard against a concurrent connect. The
   * step-2 fingerprint pre-check exists only to name the conflicting account in the
   * common case; here the race is caught and turned into the same friendly refusal
   * rather than a 500 about a perfectly ordinary concurrent request.
   */
  private async createProvenAccount(args: {
    input: OnboardingInput;
    fingerprint: Uint8Array;
    credentialId: string;
    realFreeMinor: string;
    allocatedCurrency: FundingCurrency;
    fundingCurrencies: readonly FundingCurrency[];
    balances: readonly Balance[];
  }): Promise<
    | { readonly ok: true; readonly accountId: string; readonly credentialId: string }
    | { readonly ok: false; readonly rejection: OnboardingRejection }
  > {
    const { tdb, kms } = this.deps;
    const { credentialId } = args;
    try {
      const accountId = await tdb.transaction(async (tx) => {
        const id = await insertAccount(tx, {
          name: args.input.accountName,
          allocatedCapitalMinor: null,
          allocatedCurrency: null,
        });
        const sealed = await sealCredential(
          kms,
          { tenantId: tdb.tenantId, accountId: id, credentialId, keyVersion: 1 },
          args.input.apiKey,
          args.input.apiSecret,
        );
        await insertCredential(tx, {
          id: credentialId,
          accountId: id,
          kmsKeyArn: sealed.kmsKeyId,
          keyVersion: sealed.keyVersion,
          dekWrapped: sealed.dekWrapped,
          apiKeyCt: sealed.apiKey.ct,
          apiKeyNonce: sealed.apiKey.nonce,
          apiKeyTag: sealed.apiKey.tag,
          apiSecretCt: sealed.apiSecret.ct,
          apiSecretNonce: sealed.apiSecret.nonce,
          apiSecretTag: sealed.apiSecret.tag,
          apiKeyLast4: keyLast4(args.input.apiKey),
          fingerprint: args.fingerprint,
        });
        // The basis is written HERE, not at confirm: this is the only moment the
        // venue's answer is in hand, and writing it now means no client can later
        // assert a figure the exchange never reported. Every percentage-of-capital
        // order is sized from this column.
        await recordVenueBasis(tx, {
          accountId: id, capitalMinor: args.realFreeMinor, currency: args.allocatedCurrency,
        });
        await recordObservedBalances(tx, {
          accountId: id, fundingCurrencies: args.fundingCurrencies, balances: args.balances,
        });
        return id;
      });
      return { ok: true, accountId, credentialId };
    } catch (e) {
      const constraint = uniqueViolation(e);
      if (constraint === 'exchange_credential_fingerprint_unique') {
        const winner = await findByFingerprint(tdb, args.fingerprint);
        return {
          ok: false,
          rejection: {
            kind: 'duplicate_key',
            conflictingAccountName: winner?.accountName ?? 'another account',
            message: 'This API key was connected a moment ago by another request. A CoinDCX key may '
              + 'only be connected once — connecting it twice would place two legs of every group '
              + 'trade on the same exchange account.',
          },
        };
      }
      if (constraint === 'exchange_account_name_unique') {
        return {
          ok: false,
          rejection: {
            kind: 'duplicate_name',
            message: `An account named “${args.input.accountName.trim()}” already exists. `
              + 'Pick a different name to tell them apart.',
          },
        };
      }
      throw e;
    }
  }

  /**
   * Step 6 (T02.5): switch the account on.
   *
   * No payload is accepted — not even the credential id. `validate` already wrote
   * the basis, the funding currencies and the observed balances from the venue
   * read, and `exchange_credential_account_unique` means the credential can be
   * looked up from the account. That is also why a connect abandoned before this
   * step can be finished later from the account's own page, with nothing
   * re-entered and no key re-sent.
   */
  async confirm(input: { accountId: string }): Promise<void> {
    const credential = await findByAccount(this.deps.tdb, input.accountId);
    if (credential === null) throw new Error(`account ${input.accountId} has no credential to activate`);

    await activateAllocation(this.deps.tdb, input.accountId);
    const activated = await activate(this.deps.tdb, credential.credentialId);
    if (!activated) throw new Error(`credential ${credential.credentialId} could not be activated`);
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
