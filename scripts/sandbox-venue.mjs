// The sandbox venue — a stand-in for CoinDCX you can actually trade against.
//
// WHY THIS EXISTS: CoinDCX has no sandbox. Not a testnet, not read-only keys, not
// a paper-trading endpoint (see the venue-traps notes). Every order placed against
// the real API is a real order with real money, and an unfunded account cannot
// even be connected — the onboarding flow refuses an account holding no spendable
// INR or USDT. So there is no way to exercise the system end to end using the real
// venue unless you are willing to fund it.
//
// This runs the same `FakeVenue` the check harnesses drive: a real HTTP server
// that speaks the CoinDCX wire format and VERIFIES HMAC SIGNATURES, so a body
// mutated or re-serialised after signing is rejected exactly as the real venue
// would reject it. It is not a stub — it is the whole reason the send path can be
// tested without sending.
//
// WHAT IT DOES NOT DO: it does not make trades execute. `server.mjs` wires no
// execution engine, so a confirm is a rung-0 dry run that marks the trade
// completed without fanning out. Pointing the API here lets you exercise the
// connect flow, the accounts UI, the ticket, planning, preview and confirm — not
// the send path.
//
// Usage:
//   npm run sandbox-venue                 # then set TRADEX_VENUE_BASE in .env
//   SANDBOX_PORT=9000 npm run sandbox-venue
//   SANDBOX_INR=1000000 npm run sandbox-venue     # fund it with Rs 10,000
//
// The API reads the address from TRADEX_VENUE_BASE (see .env.example). Nothing
// else needs changing: the order book is already fixture-backed offline.

import { FakeVenue } from '../packages/exchange-coindcx/dist/index.js';

const PORT = Number(process.env['SANDBOX_PORT'] ?? 8099);

/**
 * Three keys, so you can connect three accounts and run a group trade across them.
 *
 * FIXED on purpose: the key's fingerprint is what the database uses to tell accounts
 * apart, so a random key on every restart would leave you with a new account (and a
 * new duplicate-key collision against the old one) each time you relaunched this.
 */
const CREDENTIALS = {
  'sandbox-account-1-key-0001': 'sandbox-account-1-secret-0001',
  'sandbox-account-2-key-0002': 'sandbox-account-2-secret-0002',
  'sandbox-account-3-key-0003': 'sandbox-account-3-secret-0003',
};

/**
 * What each account holds, in MAJOR units — the venue's own quoting.
 *
 * Defaults to Rs 2,48,750.34 free plus some USDT, which is the same shape the
 * check fixtures use. INR is what a percentage-of-capital buy sizes against, so
 * it has to be non-zero or onboarding refuses the account outright.
 */
const INR_FREE = Number(process.env['SANDBOX_INR'] ?? 248_750.34);
const USDT_FREE = Number(process.env['SANDBOX_USDT'] ?? 1_420.88888888);

const venue = new FakeVenue({ credentials: CREDENTIALS, port: PORT });

try {
  const url = await venue.start();
  venue.setBalance('INR', INR_FREE, 0);
  venue.setBalance('USDT', USDT_FREE, 0);

  const base = url.toString().replace(/\/$/, '');
  const keys = Object.keys(CREDENTIALS);

  console.log('');
  console.log('  Sandbox venue listening on ' + base);
  console.log('  ─────────────────────────────────────────────────────────────');
  console.log('  Point the API at it — put this in .env, then restart `npm run api`:');
  console.log('');
  console.log(`      TRADEX_VENUE_BASE=${base}`);
  console.log('');
  console.log('  Then connect accounts at /app/accounts/connect with any of:');
  console.log('');
  for (const key of keys) {
    console.log(`      key     ${key}`);
    console.log(`      secret  ${CREDENTIALS[key]}`);
    console.log('');
  }
  console.log(`  Every account holds Rs ${INR_FREE.toLocaleString('en-IN')} free and ${USDT_FREE} USDT.`);
  console.log('');
  console.log('  Reminder: a confirm is a DRY RUN — no engine is wired, so nothing is');
  console.log('  fanned out and no child order is placed. This exercises connect, the');
  console.log('  accounts UI, the ticket, planning, preview and confirm.');
  console.log('');
  console.log('  Ctrl-C to stop.');
  console.log('');
} catch (e) {
  console.error(`Could not start the sandbox venue on port ${PORT}: ${e instanceof Error ? e.message : String(e)}`);
  console.error('Another process may already be listening. Try SANDBOX_PORT=9000.');
  process.exit(1);
}

const shutdown = () => {
  void venue.stop().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
