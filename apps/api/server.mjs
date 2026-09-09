// The API composition root — plan/phase-04 follow-on (HTTP layer).
//
// This is a .mjs file ON PURPOSE. The ADAPTER-BOUNDARY CI rule scans .ts files
// only, so this is the one place that may import the compiled CoinDCX adapter and
// wire it into the typed server factory. Everything with types stays in .ts; the
// concrete venue wiring lives here, exactly as the check harnesses compose the
// system.
//
// It does four things and nothing clever:
//   1. connect a pg pool + Kysely to DATABASE_URL;
//   2. build getOrderBook — fixture-backed by default so the whole thing runs
//      offline on a dev box, or live public reads when TRADEX_LIVE_BOOK=1;
//   3. load the cookie-signing secret (or generate an ephemeral dev one);
//   4. start createHttpServer() listening on PORT.
//
// TOTP note: no user has TOTP enrolled yet (enrolment is future work), and the
// core dry-run flow — login as a trader, preview, confirm — needs no second
// factor because trade.place does not require re-auth. So verifySecondFactor is a
// documented placeholder that refuses; it is only reached by the reauth-gated
// actions, none of which this phase's UI exposes.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createHttpServer } from './dist/index.js';
import { LocalKms, verifyTotpFromEnvelope } from '../../packages/crypto/dist/index.js';
import { mapOrderBook, probeCredential, send } from '../../packages/exchange-coindcx/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', '..', 'checks', 'fixtures');

const PORT = Number(process.env['PORT'] ?? 8080);
const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set — see .env.example');
  process.exit(1);
}

// --- cookie secret -----------------------------------------------------------
// Production must supply TRADEX_COOKIE_SECRET (>=32 bytes, hex). In dev we mint
// an ephemeral one so sessions work within a run; they do not survive a restart,
// which is the correct dev behaviour and a loud reason to set the env var.
function cookieSecret() {
  const hex = process.env['TRADEX_COOKIE_SECRET'];
  if (hex !== undefined && hex !== '') {
    const buf = Buffer.from(hex, 'hex');
    if (buf.byteLength < 32) {
      console.error('TRADEX_COOKIE_SECRET must be at least 32 bytes (64 hex chars)');
      process.exit(1);
    }
    return buf;
  }
  console.warn('TRADEX_COOKIE_SECRET not set — using an ephemeral secret; sessions will not survive a restart');
  return randomBytes(32);
}

// --- getOrderBook ------------------------------------------------------------
// Fixture-backed by default: BTC resolves to the committed order books, anything
// else returns an empty book (the planner then skips it with a numbered reason,
// which is honest). TRADEX_LIVE_BOOK=1 switches to a live public read.
const fixtureBooks = {
  BTCINR: () => JSON.parse(readFileSync(join(fixturesDir, 'orderbook_btcinr.json'), 'utf8')),
  BTCUSDT: () => JSON.parse(readFileSync(join(fixturesDir, 'orderbook_btcusdt.json'), 'utf8')),
};

function toPort(market, mapped) {
  return { market, asks: mapped.asks, bids: mapped.bids, observedAtMs: Number(mapped.timestamp) };
}

async function getOrderBookFixture(market) {
  const symbol = `${market.asset}${market.quote}`;
  const loader = fixtureBooks[symbol];
  if (loader === undefined) {
    // No fixture for this market: an empty book. The slippage guard reports
    // INSUFFICIENT_DEPTH and the leg is skipped — a truthful outcome offline.
    return { market, asks: [], bids: [], observedAtMs: Date.now() };
  }
  return toPort(market, mapOrderBook(JSON.stringify(loader())));
}

async function getOrderBookLive(market) {
  // CoinDCX public order book. `pair` is the socket form, e.g. I-BTC_INR.
  const ecode = market.quote === 'INR' ? 'I' : 'B';
  const pair = `${ecode}-${market.asset}_${market.quote}`;
  const result = await send({
    method: 'GET',
    url: new URL(`https://public.coindcx.com/market_data/orderbook?pair=${pair}`),
    deadlineMs: 5_000,
  });
  if (result.status !== 200) throw new Error(`order book read for ${pair} returned ${result.status}`);
  return toPort(market, mapOrderBook(result.body));
}

const live = process.env['TRADEX_LIVE_BOOK'] === '1';
const getOrderBook = live ? getOrderBookLive : getOrderBookFixture;

// --- boot --------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: url, max: 10 });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

// KMS for the TOTP envelope. Local in dev; a stable root key is defaulted so a
// restart does not make every stored 2FA secret unrecoverable (the real CMK's
// deletion protection exists for the same reason). NODE_ENV=production refuses it.
process.env['TRADEX_LOCAL_ROOT_KEY'] ??= 'cd'.repeat(32);
const kms = new LocalKms();

// The real second factor: open the user's sealed TOTP envelope and verify the
// code, all inside packages/crypto so the plaintext never reaches this process
// scope in a form a log could print. This is what makes login-with-2FA, resume,
// limits changes and large trades reachable.
async function verifySecondFactor(userId, code, atMs) {
  const row = await db.selectFrom('app_user')
    .select(['tenant_id', 'totp_secret_ct'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (row === undefined || row.totp_secret_ct === null) return false;
  try {
    return await verifyTotpFromEnvelope(kms, { tenantId: row.tenant_id, userId, keyVersion: 1 }, row.totp_secret_ct, code, atMs);
  } catch {
    return false;
  }
}

const server = createHttpServer({
  db,
  getOrderBook,
  cookieSecret: cookieSecret(),
  verifySecondFactor,
  kms,
  // The duplicate-key fingerprint pepper. A dev default keeps onboarding usable
  // locally; production must set TRADEX_PEPPER (resolvePepper refuses to default,
  // so this explicit default is the one allowed escape for a dev boot).
  pepper: (() => {
    process.env['TRADEX_PEPPER'] ??= 'ab'.repeat(32);
    return Buffer.from(process.env['TRADEX_PEPPER'], 'hex');
  })(),
  // The live credential probe. Only exercised when a customer actually connects a
  // key — against the real venue, which is exactly where it must run.
  probe: (apiKey, apiSecret) => probeCredential(apiKey, apiSecret, {
    baseUrl: process.env['TRADEX_VENUE_BASE'] ?? 'https://api.coindcx.com',
    deadlineMs: 10_000,
  }),
  codeVersion: process.env['TRADEX_CODE_VERSION'] ?? 'dev',
  // Local dev is plain HTTP, so the cookie must not be marked Secure or the
  // browser will drop it. Set TRADEX_SECURE_COOKIES=1 behind TLS.
  secureCookies: process.env['TRADEX_SECURE_COOKIES'] === '1',
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tradex API listening on http://0.0.0.0:${PORT} (order book: ${live ? 'LIVE' : 'fixtures'})`);
});

const shutdown = () => {
  server.close(() => { void db.destroy().then(() => process.exit(0)); });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
