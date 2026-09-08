// Account-connection disclosures — plan/phase-02 T02.8, from 21 F5 and 07 F1.
//
// Two things every customer MUST be told before they paste a key, because both
// are counterintuitive and both cost real money if ignored:
//
//   1. CoinDCX has no read-only / restricted API keys. The key they give us can
//      trade and move funds between their own wallets. There is no "trading-only"
//      option to reassure them with — our encryption is the whole defence (07 F1).
//
//   2. Do NOT tick "Bind IP Address" when creating the key. CoinDCX binds a key
//      to the IP of the device that CREATED it; Tradex trades from its own
//      servers, so an IP-bound key can never authenticate here. This is the
//      single most common onboarding failure for a server-side platform, and the
//      three-cause auth message names it too (onboarding-service.ts).
//
// Plus the standing policy: Tradex never asks for the exchange account password
// or the exchange 2FA seed, and there is exactly one page that accepts an API
// key. Anything else asking for those is phishing (24 F-, the R24 mitigation).
//
// This is content, not chrome: it lives here as structured data so the eventual
// UI renders it verbatim and a test asserts it is present on every add path,
// rather than the copy living in a template nobody checks.

export interface Disclosure {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  /** True when hiding or skipping it would let a customer make a costly mistake. */
  readonly mustAcknowledge: boolean;
}

export const DISCLOSURE_NO_RESTRICTED_KEYS: Disclosure = {
  id: 'no-restricted-keys',
  title: 'CoinDCX API keys cannot be made read-only',
  body:
    'CoinDCX does not offer read-only or trade-only API keys — every key has full permissions and '
    + 'can place trades and move funds between your own CoinDCX wallets. It cannot withdraw off the '
    + 'platform. Tradex stores your key encrypted so that even a database breach cannot read it, but '
    + 'you should still treat connecting a key as granting trading access.',
  mustAcknowledge: true,
};

export const DISCLOSURE_NO_IP_BINDING: Disclosure = {
  id: 'no-ip-binding',
  title: 'Do not tick "Bind IP Address" when you create the key',
  body:
    'CoinDCX binds an API key to the IP address of the device that created it. Tradex trades from its '
    + 'own servers, not your device, so a key created with "Bind IP Address" ticked can never '
    + 'authenticate here and every trade will fail. Create the key with IP binding left off.',
  mustAcknowledge: true,
};

/** Every disclosure that must appear on the add-account page. Order is display order. */
export const ADD_ACCOUNT_DISCLOSURES: readonly Disclosure[] = [
  DISCLOSURE_NO_IP_BINDING,
  DISCLOSURE_NO_RESTRICTED_KEYS,
];

/**
 * The never-ask policy, stated once and rendered near the key field.
 *
 * A customer who has read this can recognise a phishing page: the real Tradex
 * never asks for these, and there is only one page that ever accepts a key.
 */
export const NEVER_ASK_NOTICE =
  'Tradex will never ask for your CoinDCX account password or your CoinDCX 2FA/Google Authenticator '
  + 'code. It asks only for an API key and secret, and only on this page. If anything else asks you '
  + 'for those, it is not Tradex.';

/** The one canonical route that accepts an API key. Referenced by the single-entry check. */
export const KEY_ENTRY_ROUTE = '/accounts/connect';
