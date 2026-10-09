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
import { createHttpServer, listAccounts, placeFuturesOrder, planAdjustment, floorQuantityToStep, hardExit, findIntentOrder } from './dist/index.js';
import { executePositionMutation } from './dist/futures/mutation.js';
import { ResearchKeyVault } from './dist/research/ai-settings.js';
import { reservePositionIncrease } from './dist/futures/risk-reservation.js';
import { forTenant, findByAccount, getChildOrders, requeueStale, replaceFuturesPositions, recordObservedBalances, recordVenueBasis, upsertFuturesClosedTrades } from '../../packages/db/dist/index.js';
import { LocalKms, verifyTotpFromEnvelope } from '../../packages/crypto/dist/index.js';
import { Signer } from '../signer/dist/index.js';
import { deriveFundingCurrencies, futuresPairOf, freeBalanceMinor, maxInstrumentLeverage } from '../../packages/exchange/dist/index.js';
import { add, cmp, mul, scaledFromString, toPlainString } from '../../packages/money/dist/index.js';
import {
  mapOrderBook, probeCredential, send,
  submitFuturesOrderSigned, listFuturesOrdersSigned, fetchFuturesPositionsSigned, fetchFuturesInstrument, readBalancesSigned,
  attachStopAndTakeSigned, cancelFuturesOrderSigned, exitFuturesPositionSigned, updateFuturesLeverageSigned,
  listFuturesPositionsTransactionsSigned,
} from '../../packages/exchange-coindcx/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', '..', 'checks', 'fixtures');

const PORT = Number(process.env['PORT'] ?? 8080);
function validateProductionConfiguration() {
  let appOrigin;
  try { appOrigin = new URL(process.env['APP_URL']); } catch { /* validated below */ }
  if (!appOrigin || appOrigin.protocol !== 'https:' || appOrigin.username || appOrigin.password) {
    throw new Error('Production requires APP_URL set to the public HTTPS application URL');
  }
  if (!process.env['TRADEX_COOKIE_SECRET']) throw new Error('Production requires a persistent TRADEX_COOKIE_SECRET');
  if (!/^[0-9a-f]{64}$/i.test(process.env['TRADEX_LOCAL_ROOT_KEY'] ?? '') || process.env['TRADEX_LOCAL_ROOT_KEY']?.toLowerCase() === 'cd'.repeat(32)) {
    throw new Error('Production requires an explicitly configured private TRADEX_LOCAL_ROOT_KEY; the development default is forbidden');
  }
  if (process.env['TRADEX_SIGNER_URL'] && (process.env['TRADEX_SIGNER_TOKEN']?.length ?? 0) < 32) {
    throw new Error('Production requires TRADEX_SIGNER_TOKEN with at least 32 characters, shared with the signer');
  }
}
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
  USDTINR: () => ({ timestamp: Date.now(), asks: { '80.01': '1000000' }, bids: { '79.99': '1000000' } }),
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

// --- the venue, and whether we are allowed to send to it ---------------------
//
// SENDING IS OFF BY DEFAULT, and off means OFF: without `TRADEX_SEND_MODE=send`
// no venue ports are supplied at all, the engine stays null, and `confirm` keeps
// taking the rung-0 dry-run branch it has always taken. There is no mode the code
// guesses at, because guessing wrong here spends real money.
const SEND_MODE = process.env['TRADEX_SEND_MODE'] ?? 'dry_run';
if (SEND_MODE !== 'dry_run' && SEND_MODE !== 'send') {
  console.error(`TRADEX_SEND_MODE must be "dry_run" or "send", got "${SEND_MODE}"`);
  process.exit(1);
}
const sending = SEND_MODE === 'send';

const VENUE_BASE = process.env['TRADEX_VENUE_BASE'] ?? 'https://api.coindcx.com';
let VENUE_HOST = '';
try {
  VENUE_HOST = new URL(VENUE_BASE).hostname;
} catch {
  console.error(`TRADEX_VENUE_BASE is not a URL: "${VENUE_BASE}"`);
  process.exit(1);
}
/** The venue that spends real money. A sandbox host is not this. */
const REAL_VENUE = /(^|\.)coindcx\.com$/.test(VENUE_HOST);
if (process.env['NODE_ENV'] === 'production' || sending && REAL_VENUE) validateProductionConfiguration();
if (sending && REAL_VENUE && process.env['TRADEX_LIVE_BOOK'] !== '1') {
  throw new Error('Real-money sending requires TRADEX_LIVE_BOOK=1; fixture prices cannot authorize live orders');
}

/**
 * THE INVARIANT THIS ENFORCES: no plaintext credential exists outside the signer
 * process (ARCHITECTURE X12). In-process signing is fine for the sandbox, which
 * holds only credentials we invented — but against the real venue it would put a
 * customer's live secret in the API process, which is the whole thing the signer
 * boundary exists to prevent. So: refuse to boot rather than degrade quietly.
 */
const SIGNER_URL = process.env['TRADEX_SIGNER_URL'];
if (sending && REAL_VENUE && (SIGNER_URL === undefined || SIGNER_URL === '')) {
  console.error(
    'Refusing to send to the real CoinDCX without a separate signer.\n'
    + '  Invariant X12: no plaintext credential exists outside the signer process.\n'
    + '  Set TRADEX_SIGNER_URL, or point TRADEX_VENUE_BASE at the sandbox venue\n'
    + '  (npm run sandbox-venue) to send there instead.',
  );
  process.exit(1);
}

// An EPHEMERAL root key means every credential sealed in this process becomes
// unrecoverable on restart — every connected account would have to reconnect.
// Acceptable for a sandbox; fatal the moment real keys are stored. (Checked
// further down, AFTER the KMS is constructed — reading `kms` up here would be a
// temporal-dead-zone ReferenceError.)

/**
 * The client-order-id pepper. REQUIRED whenever we send, and never defaulted.
 *
 * `clientOrderIdOf` is "reproducible from the row alone" — that reproducibility is
 * the only thing that lets a crashed worker recognise an order it already sent. A
 * pepper that changed between restarts would derive a DIFFERENT id for a leg
 * already at the venue, and the venue would accept a second order: a real
 * duplicate, from our own retry logic. So this one has no dev escape hatch.
 */
let executionPepper;
if (sending) {
  const hex = process.env['TRADEX_EXECUTION_PEPPER'];
  if (hex === undefined || hex === '') {
    console.error(
      'TRADEX_SEND_MODE=send requires TRADEX_EXECUTION_PEPPER.\n'
      + '  It derives the client order ids; if it ever changes, a re-derived id will not\n'
      + '  match one already sent and the venue will accept a duplicate order.\n'
      + '  Generate once with:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
    process.exit(1);
  }
  executionPepper = Buffer.from(hex, 'hex');
  if (executionPepper.byteLength < 16) {
    console.error('TRADEX_EXECUTION_PEPPER must be at least 16 bytes (32 hex chars)');
    process.exit(1);
  }
}

// --- boot --------------------------------------------------------------------
const pool = new pg.Pool({ connectionString: url, max: 35 });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });
// KMS for the TOTP envelope. Local in dev; a stable root key is defaulted so a
// restart does not make every stored 2FA secret unrecoverable (the real CMK's
// deletion protection exists for the same reason). NODE_ENV=production refuses it.
process.env['TRADEX_LOCAL_ROOT_KEY'] ??= 'cd'.repeat(32);
/**
 * THE KMS DECISION, made explicitly. `LocalKms` refuses production by default
 * because a root key in an environment variable is not a KMS — the guard exists so
 * that going without one is a choice someone made, not a thing that happened.
 * TRADEX_ALLOW_LOCAL_KMS=1 is that choice, and it prints what it costs.
 */
const allowLocalKms = process.env['TRADEX_ALLOW_LOCAL_KMS'] === '1';
let kms;
try {
  kms = new LocalKms({ allowInProduction: allowLocalKms });
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  console.error(
    '  LocalKms refuses to run in production by default, because a root key in an\n'
    + '  environment variable is not a KMS. To go live without a managed KMS, set\n'
    + '  TRADEX_ALLOW_LOCAL_KMS=1 — and read docs/ops/go-live-gates.md first.',
  );
  process.exit(1);
}
if (allowLocalKms) {
  console.warn(
    '[kms] TRADEX_ALLOW_LOCAL_KMS=1 - the credential root key lives in an environment variable.',
  );
  console.warn(
    '      Anyone holding it AND a database dump can decrypt every customer API key.',
  );
  console.warn('      This is the documented trade-off in docs/ops/go-live-gates.md.');
}

// Now that the KMS exists, refuse an EPHEMERAL root key whenever we intend to send:
// every credential sealed with it would be unrecoverable on the next restart, and
// every connected account would have to reconnect.
if (sending && kms.keyId === 'local-kms:ephemeral') {
  console.error(
    'Refusing to send with an EPHEMERAL KMS root key.\n'
    + '  Every credential sealed now would be unrecoverable on restart.\n'
    + '  Set TRADEX_LOCAL_ROOT_KEY to a stable value (64 hex chars) and restart.',
  );
  process.exit(1);
}

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

// --- the engine ports --------------------------------------------------------
//
// Everything below is supplied ONLY when sending is enabled, so the default boot
// is byte-for-byte the dry-run build it has always been.
//
// The whole block is port-shaped on purpose: `apps/api/src/*.ts` may not import
// the CoinDCX adapter (ADAPTER-BOUNDARY), and this `.mjs` is the sanctioned place
// to wire the compiled adapter into typed code — the same reason this file exists
// at all.

/** A tenant-scoped signer. One per call: it is a thin wrapper over the tdb. */
const signerFor = (tenantId) => new Signer({ tdb: forTenant(db, tenantId), kms });

/**
 * Turn `(tenant, account)` into a `BodySigner` for the venue calls.
 *
 * The credential is looked up from the ACCOUNT, never passed in — the venue call
 * needs only `accountId`, and `exchange_credential_account_unique` means there is
 * exactly one. The plaintext secret never reaches this process: the signer opens
 * the envelope, HMACs the bytes and returns `{apiKey, signature}`.
 */
async function signFor(tenantId, accountId, customReason) {
  const credential = await findByAccount(forTenant(db, tenantId), accountId);
  if (credential === null) return null;
  const reason = customReason ?? 'place or manage a futures order on behalf of the account owner';

  // READ OR SEND, the rule is the same: signing for the real exchange happens in
  // the signer process, never here. Enforced at the point of use rather than at
  // boot so that an operator can still run dry against the live venue while a
  // signer is being set up — but the moment anything tries to decrypt a real
  // customer credential in this process, it stops with something actionable
  // instead of quietly breaking invariant X12.
  if (REAL_VENUE && (SIGNER_URL === undefined || SIGNER_URL === '')) {
    throw new Error(
      'refusing to sign for the real exchange in this process: set TRADEX_SIGNER_URL '
      + '(invariant X12: no plaintext credential outside the signer)',
    );
  }
  // A configured signer means the plaintext never enters THIS process — the whole
  // point of the split. Without one we sign in-process, which boot has already
  // refused for the real venue.
  if (SIGNER_URL !== undefined && SIGNER_URL !== '') {
    const token = process.env['TRADEX_SIGNER_TOKEN'];
    return async (body) => {
      const res = await fetch(new URL('/sign', SIGNER_URL), {
        method: 'POST',
        signal: globalThis.AbortSignal.timeout(5000),
        headers: {
          'content-type': 'application/json',
          ...(token !== undefined && token !== '' ? { 'x-tradex-signer-token': token } : {}),
        },
        body: JSON.stringify({
          tenantId,
          credentialId: credential.credentialId,
          payload: body,
          algorithm: 'hmac-sha256-hex',
          reason,
          actorProcess: 'api',
        }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`the signer refused to sign: ${out.message ?? res.status}`);
      return { apiKey: out.apiKey, signature: out.signature };
    };
  }
  return async (body) => {
    const out = await signerFor(tenantId).sign({
      credentialId: credential.credentialId,
      // The exact bytes that will go on the wire — signing anything else is the
      // bug the official CoinDCX sample ships with.
      payload: body,
      algorithm: 'hmac-sha256-hex',
      // Required, and audited before the signature is returned: an unaccountable
      // decrypt is indistinguishable from an exfiltration.
      reason,
      actorProcess: 'api',
    });
    return { apiKey: out.apiKey, signature: out.signature };
  };
}


const enginePorts = {};

// --- read-only venue ports --------------------------------------------------
//
// Wired REGARDLESS of send mode, and the distinction is the point: reading a
// balance is not placing an order. Bundling these with the send ports meant an
// operator could not check what an account actually held unless they were armed to
// send real orders — the reporting surface was locked behind the weapon, and on a
// production box it answered "exchange reads are not configured in this build".
//
// They still SIGN, because a balance read is a signed venue call — so against the
// real exchange they need the signer exactly as sending does. What they do not
// need is permission to trade.

  /**
   * Synchronize verified closed trades and realized PnL directly from CoinDCX.
   */
  const syncClosedTradesForAccount = async (tdb, tenantId, accountId, sign) => {
    try {
      // 1. Fetch transactions across stages:
      // - 'exit': positions closed via CoinDCX Market Close Position
      // - 'tpsl_exit': positions closed via CoinDCX Take Profit / Stop Loss triggers
      // - 'default': trades executed directly on CoinDCX (filter for amount !== 0 to capture exit/reduce orders)
      // - 'all': catches liquidations and any other unmapped closing stages
      const rawTxMap = new Map();
      const stagesToFetch = ['exit', 'tpsl_exit', 'default', 'all'];

      for (const stg of stagesToFetch) {
        for (const page of [1, 2]) {
          const res = await listFuturesPositionsTransactionsSigned(
            sign,
            { stage: stg, page, size: 100 },
            { baseUrl: VENUE_BASE },
          );
          if (!res.ok || res.transactions.length === 0) break;
          for (const t of res.transactions) {
            const isExit =
              t.stage === 'exit' ||
              t.stage === 'tpsl_exit' ||
              t.stage === 'liquidation' ||
              (t.stage === 'default' && t.amount !== 0);
            if (isExit) {
              const txKey = `${t.parentId ?? ''}_${t.positionId ?? ''}_${t.createdAtMs}_${t.amount}`;
              rawTxMap.set(txKey, t);
            }
          }
          if (res.transactions.length < 100) break;
        }
      }

      if (rawTxMap.size === 0) return 0;

      // 2. Group by (parentId, positionId) to aggregate multi-fill orders
      const groupedOrders = new Map();
      for (const t of rawTxMap.values()) {
        const groupKey = `${t.parentId ?? ''}_${t.positionId ?? ''}`;
        const existing = groupedOrders.get(groupKey);
        if (!existing) {
          groupedOrders.set(groupKey, { ...t });
        } else {
          groupedOrders.set(groupKey, {
            ...existing,
            amount: existing.amount + t.amount,
            feeAmount: existing.feeAmount + t.feeAmount,
            createdAtMs: Math.max(existing.createdAtMs, t.createdAtMs),
            updatedAtMs: Math.max(existing.updatedAtMs, t.updatedAtMs),
          });
        }
      }

      // 3. Fetch filled orders for order details (avgPrice, quantity, side, leverage)
      const orderMap = new Map();
      for (const page of [1, 2]) {
        const [buyOrdersRes, sellOrdersRes] = await Promise.all([
          listFuturesOrdersSigned(sign, { side: 'buy', status: 'filled', page, size: 100 }, { baseUrl: VENUE_BASE }),
          listFuturesOrdersSigned(sign, { side: 'sell', status: 'filled', page, size: 100 }, { baseUrl: VENUE_BASE }),
        ]);
        if (buyOrdersRes.ok) for (const o of buyOrdersRes.orders) orderMap.set(o.venueOrderId, o);
        if (sellOrdersRes.ok) for (const o of sellOrdersRes.orders) orderMap.set(o.venueOrderId, o);
        if ((!buyOrdersRes.ok || buyOrdersRes.orders.length < 100) && (!sellOrdersRes.ok || sellOrdersRes.orders.length < 100)) break;
      }

      // 4. Preload position and trade leverage mappings for this account
      const posRows = await tdb.selectFrom('futures_position')
        .select(['venue_position_id', 'pair', 'margin_currency', 'leverage'])
        .where('account_id', '=', accountId)
        .execute()
        .catch(() => []);
      const posByVenueId = new Map();
      const posByPairCur = new Map();
      for (const p of posRows) {
        if (p.venue_position_id && p.leverage) {
          posByVenueId.set(p.venue_position_id, p.leverage);
        }
        if (p.pair && p.margin_currency && p.leverage) {
          posByPairCur.set(`${p.pair}_${p.margin_currency}`, p.leverage);
        }
      }

      const childOrderRows = await db.selectFrom('child_order as co')
        .innerJoin('group_trade as gt', 'gt.id', 'co.group_trade_id')
        .select(['co.venue_position_id', 'co.exchange_order_id', 'gt.leverage'])
        .where('co.tenant_id', '=', tenantId)
        .where('co.account_id', '=', accountId)
        .where('gt.leverage', 'is not', null)
        .execute()
        .catch(() => []);
      const tradeByVenuePosId = new Map();
      const tradeByOrderId = new Map();
      for (const co of childOrderRows) {
        if (co.venue_position_id && co.leverage) tradeByVenuePosId.set(co.venue_position_id, co.leverage);
        if (co.exchange_order_id && co.leverage) tradeByOrderId.set(co.exchange_order_id, co.leverage);
      }

      const existingClosedRows = await tdb.selectFrom('futures_closed_trade')
        .select(['venue_position_id', 'venue_order_id', 'leverage'])
        .where('account_id', '=', accountId)
        .where('leverage', 'is not', null)
        .where('leverage', '!=', '1')
        .execute()
        .catch(() => []);
      const existingClosedByPosId = new Map();
      const existingClosedByOrderId = new Map();
      for (const ec of existingClosedRows) {
        if (ec.venue_position_id && ec.leverage) existingClosedByPosId.set(ec.venue_position_id, ec.leverage);
        if (ec.venue_order_id && ec.leverage) existingClosedByOrderId.set(ec.venue_order_id, ec.leverage);
      }

      const allowedStages = new Set(['exit', 'tpsl_exit', 'liquidation', 'default']);
      const tradeInputs = [];
      for (const t of groupedOrders.values()) {
        const order = t.parentId ? orderMap.get(t.parentId) : undefined;
        const isSellExit = order ? order.side === 'sell' : true;
        const side = isSellExit ? 'long' : 'short';
        const dir = side === 'long' ? 1 : -1;

        const exitPriceNum = order?.avgPrice ? Number(order.avgPrice) : (
          order?.price ? Number(order.price) : 0
        );
        const qtyNum = order?.filledQuantity ? Number(order.filledQuantity) : (
          order?.totalQuantity ? Number(order.totalQuantity) : 0
        );

        const rawLev = (t.positionId ? posByVenueId.get(t.positionId) : null)
          ?? (t.positionId ? tradeByVenuePosId.get(t.positionId) : null)
          ?? (t.positionId ? existingClosedByPosId.get(t.positionId) : null)
          ?? (t.parentId ? tradeByOrderId.get(t.parentId) : null)
          ?? (t.parentId ? existingClosedByOrderId.get(t.parentId) : null)
          ?? (order?.leverage && Number(order.leverage) > 1 ? order.leverage : null)
          ?? posByPairCur.get(`${t.pair}_${t.marginCurrency}`)
          ?? order?.leverage
          ?? 1;
        const levNum = Number(rawLev) || 1;

        const isUsdtContract = t.pair.includes('USDT') || t.pair.endsWith('USDT');
        const peg = (t.marginCurrency === 'INR' && isUsdtContract)
          ? (order?.settlementConversionPrice ? Number(order.settlementConversionPrice) : 100)
          : 1;

        const pnlMajor = t.amount;
        const pnlMinor = t.marginCurrency === 'USDT'
          ? Math.round(pnlMajor * 100_000_000).toString()
          : Math.round(pnlMajor * 100).toString();

        const feeMinor = t.feeAmount > 0
          ? (t.marginCurrency === 'USDT'
              ? Math.round(t.feeAmount * 100_000_000).toString()
              : Math.round(t.feeAmount * 100).toString())
          : null;

        let entryPriceNum = exitPriceNum;
        if (qtyNum > 0 && peg > 0) {
          const derivedEntry = exitPriceNum - (pnlMajor / (qtyNum * dir * peg));
          if (Number.isFinite(derivedEntry) && derivedEntry > 0) {
            entryPriceNum = derivedEntry;
          }
        }

        let roePct = null;
        if (entryPriceNum > 0 && exitPriceNum > 0) {
          roePct = ((exitPriceNum - entryPriceNum) / entryPriceNum) * 100 * levNum * dir;
        }

        const closedAt = new Date(t.createdAtMs);
        const openedAtMs = order?.createdAtMs ?? t.createdAtMs;
        const durationMs = Math.max(0, closedAt.getTime() - openedAtMs);
        const exitStage = allowedStages.has(t.stage) ? t.stage : 'default';

        tradeInputs.push({
          accountId,
          pair: t.pair,
          market: t.pair,
          side,
          quantity: qtyNum > 0 ? qtyNum.toFixed(4).replace(/\.?0+$/, '') : '1',
          avgEntryPrice: entryPriceNum > 0 ? entryPriceNum.toFixed(4).replace(/\.?0+$/, '') : '0',
          avgExitPrice: exitPriceNum > 0 ? exitPriceNum.toFixed(4).replace(/\.?0+$/, '') : '0',
          leverage: String(levNum),
          realizedPnlMinor: pnlMinor,
          marginCurrency: t.marginCurrency,
          feeMinor,
          roePct,
          durationMs,
          openedAt: new Date(openedAtMs),
          closedAt,
          venuePositionId: t.positionId,
          venueOrderId: t.parentId,
          exitStage,
          hideFromPositions: false,
        });
      }

      return await upsertFuturesClosedTrades(tdb, tradeInputs);
    } catch (err) {
      console.error(`[sync-closed-trades] error for account ${accountId}:`, err instanceof Error ? err.message : String(err));
      return 0;
    }
  };

  /**
   * Mirror the venue's positions for a set of accounts. Shared by the
   * post-fan-out hook and the manual refresh, so both write the same way.
   * Concurrently processes accounts in chunks to minimize latency across large groups.
   */
  const mirrorAccounts = async (tenantId, accountIds) => {
    const tdb = forTenant(db, tenantId);
    let totalPositions = 0;
    const CHUNK_SIZE = 20;
    for (let i = 0; i < accountIds.length; i += CHUNK_SIZE) {
      const chunk = accountIds.slice(i, i + CHUNK_SIZE);
      const counts = await Promise.all(
        chunk.map(async (accountId) => {
          try {
            const sign = await signFor(tenantId, accountId, 'read orders and position history on behalf of the account owner');
            if (sign === null) return 0;
            // BOTH margin currencies: the body must always carry both or INR-margined
            // positions are invisible (research/04 G8).
            const read = await fetchFuturesPositionsSigned(sign, ['INR', 'USDT'], { baseUrl: VENUE_BASE });
            if (!read.ok) {
              console.error(`[mirror] positions read failed for account ${accountId}: ${read.failure?.detail ?? ''}`);
              return 0;
            }
            // REPLACE, not upsert: a position the venue no longer reports must stop
            // rendering as open. The read above covers both margin currencies, so it is
            // a complete picture and absent means closed.
            const written = await replaceFuturesPositions(tdb, accountId, read.positions);

            // Position mirroring never settles orders. Resting/partial limits
            // remain live until their own venue order status proves otherwise.
            // Sync verified closed trades and realized PnL directly from exchange transactions
            syncClosedTradesForAccount(tdb, tenantId, accountId, sign, VENUE_BASE).catch((err) => {
              console.error(`[sync-closed-trades] error syncing account ${accountId}:`, err instanceof Error ? err.message : String(err));
            });
            return written;
          } catch (e) {
            console.error(`[mirror] error mirroring account ${accountId}:`, e instanceof Error ? e.message : String(e));
            return 0;
          }
        }),
      );
      totalPositions += counts.reduce((sum, c) => sum + c, 0);
    }
    return { accounts: accountIds.length, positions: totalPositions };
  };

  /**
   * Every account the tenant has, so a manual refresh reaches positions whose
   * trade is long finished — which is exactly the case the fan-out hook misses.
   */
const refreshPositions = async ({ tenantId }) => {
    const accounts = (await listAccounts(forTenant(db, tenantId)))
      .filter((a) => a.status === 'active')
      .map((a) => a.id);
    return await mirrorAccounts(tenantId, accounts);
  };

  /**
   * Re-read one account's balances from the exchange and store them.
   *
   * The number every later trade is sized from. Without this it only refreshes at
   * connect time, so a withdrawal the customer made an hour ago is invisible and
   * a percentage order is sized against money that is no longer there.
   */
const accountSync = async ({ tenantId, accountId }) => {
    const sign = await signFor(tenantId, accountId);
    if (sign === null) {
      throw new Error('this account has no credential to read balances with');
    }
    const probe = await readBalancesSigned(sign, { baseUrl: VENUE_BASE });
    if (!probe.ok) {
      throw new Error(probe.failure?.detail ?? 'the exchange did not answer the balances read');
    }
    const balances = probe.balances ?? [];
    const funding = deriveFundingCurrencies(balances);
    const tdb = forTenant(db, tenantId);
    await recordObservedBalances(tdb, {
      accountId,
      fundingCurrencies: funding,
      balances,
    });
    if (funding.length > 0) {
      const primaryCurrency = funding[0];
      const realFree = freeBalanceMinor(balances, primaryCurrency);
      await recordVenueBasis(tdb, {
        accountId,
        currency: primaryCurrency,
        capitalMinor: realFree,
      });
    }
    try {
      await mirrorAccounts(tenantId, [accountId]);
    } catch (e) {
      console.error(`[accountSync] positions mirror failed for account ${accountId}:`, e instanceof Error ? e.message : String(e));
    }
    return {
      currencies: funding,
      balances: balances.length,
    };
  };

  const futuresInstrumentCache = new Map();
  const futuresInstrumentReads = new Map();
  const leverageBookReads = new Map();
  function getLeverageBook(pair) {
    let pending = leverageBookReads.get(pair);
    if (!pending) {
      pending = getOrderBook({ asset: pair.slice(2).split('_')[0], quote: pair.split('_')[1] })
        .finally(() => leverageBookReads.delete(pair));
      leverageBookReads.set(pair, pending);
    }
    return pending;
  }
  // Concurrent group accounts share one public read; completed reads are not reused at send.
  function getFreshFuturesInstrument(pair, marginCurrency) {
    const key = `${pair}|${marginCurrency}`;
    let pending = futuresInstrumentReads.get(key);
    if (!pending) {
      pending = fetchFuturesInstrument(pair, marginCurrency, { baseUrl: VENUE_BASE })
        .finally(() => futuresInstrumentReads.delete(key));
      futuresInstrumentReads.set(key, pending);
    }
    return pending;
  }
  async function getFuturesInstrumentCached(pair, marginCurrency) {
    const cacheKey = `${pair}|${marginCurrency}`;
    const cached = futuresInstrumentCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 30_000) {
      return cached.result;
    }
    const result = await getFreshFuturesInstrument(pair, marginCurrency);
    if (result.ok) {
      futuresInstrumentCache.set(cacheKey, { at: Date.now(), result });
    }
    return result;
  }

Object.assign(enginePorts, { accountSync, refreshPositions, getFuturesInstrument: getFuturesInstrumentCached,
  refreshTrailingPositions: async (targets) => {
    const byTenant = new Map();
    for (const target of targets) {
      if (!byTenant.has(target.tenantId)) byTenant.set(target.tenantId, new Set());
      byTenant.get(target.tenantId).add(target.accountId);
    }
    for (const [tenantId, ids] of byTenant) await mirrorAccounts(tenantId, [...ids]);
  },
});

if (sending) {
  /**
   * The send port. Futures only — the product does not trade spot, and a port that
   * silently falls back to a spot order would place a real order of the wrong kind.
   */
  /**
   * The L1-L4 ordering ports for one signed account.
   *
   * Shared by the fan-out submit and the position adjust ON PURPOSE: a second copy
   * of the read-back matcher is how the two drift apart, and a mismatched matcher
   * either adopts the wrong order or fails to find the right one — the two failure
   * modes L4 exists to prevent.
   */
  const protocolPortsFor = (sign, spec) => ({
    workerId: process.env['TRADEX_CODE_VERSION'] ?? 'dev',
    // L3 — signed at call time, never earlier: the venue rejects a body over 10s.
    create: async (intent) => {
      const sendQuantity = intent.quantity;
      try {
        const [inst, positions, book] = await Promise.all([
          getFreshFuturesInstrument(intent.pair, spec.marginCurrency),
          spec.allowReduce === true ? null : fetchFuturesPositionsSigned(sign, [spec.marginCurrency], { baseUrl: VENUE_BASE }),
          spec.allowReduce === true ? null : getLeverageBook(intent.pair),
        ]);
        if (!inst?.ok || !inst.instrument) {
          return { kind: 'rejected', orderMayExist: false, code: 'instrument_unavailable', detail: 'Cannot verify futures trading rules; preview again.' };
        }
        const canonical = (v) => v.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
        if (floorQuantityToStep(sendQuantity, inst.instrument.quantityIncrement) !== canonical(sendQuantity)) {
          return { kind: 'rejected', orderMayExist: false, code: 'instrument_changed', detail: 'The confirmed quantity is no longer on the futures quantity step; preview again.' };
        }
        if (intent.orderType === 'limit' && (intent.price === null || floorQuantityToStep(intent.price, inst.instrument.priceIncrement) !== canonical(intent.price))) {
          return { kind: 'rejected', orderMayExist: false, code: 'invalid_limit_price', detail: 'The limit price must be positive and on the futures price step.' };
        }
        if (inst.instrument.exitOnly && spec.allowReduce !== true) {
          return { kind: 'rejected', orderMayExist: false, code: 'exit_only', detail: 'This futures instrument allows exits only.' };
        }
        if (spec.allowReduce !== true) {
          // Re-read at the mutation boundary: a queued preview may outlive a tier change.
          if (!positions?.ok) return { kind: 'rejected', orderMayExist: false, code: 'positions_unreadable', detail: 'Cannot verify current position size against leverage limits.' };
          const existing = positions.positions.filter((p) => p.pair === intent.pair && p.marginCurrency === spec.marginCurrency);
          const quantity = existing.reduce((sum, p) => [p.activePos, p.inactivePosBuy ?? '0', p.inactivePosSell ?? '0']
            .reduce((subtotal, q) => add(subtotal, scaledFromString(q.replace(/^-/, ''), 18)), sum), scaledFromString(sendQuantity, 18));
          const references = [intent.price, book?.asks[0]?.price, book?.bids[0]?.price, ...existing.flatMap((p) => [p.markPrice, p.avgEntryPrice])]
            .filter((v) => typeof v === 'string' && /^\d+(?:\.\d{1,18})?$/.test(v)).map((v) => scaledFromString(v, 18));
          const reference = references.reduce((a, b) => cmp(a, b) >= 0 ? a : b, scaledFromString('0', 18));
          if (reference.v <= 0n) return { kind: 'rejected', orderMayExist: false, code: 'price_unavailable', detail: 'Cannot verify position notional against leverage limits.' };
          const max = maxInstrumentLeverage(inst.instrument.leverageTiers, toPlainString(mul(quantity, reference, 18)));
          if (max === 0 || Number(spec.leverage) > max) return { kind: 'rejected', orderMayExist: false, code: 'leverage_limit', detail: `The current instrument/position limit is ${max}×; preview again with a lower size or leverage.` };
        }
      } catch (e) {
        return { kind: 'rejected', orderMayExist: false, code: 'invalid_order', detail: e instanceof Error ? e.message : 'Cannot verify the futures order.' };
      }

      const placed = await submitFuturesOrderSigned(sign, {
        pair: intent.pair,
        side: intent.side,
        orderType: intent.orderType,
        quantity: sendQuantity,
        ...(intent.price !== null ? { price: intent.price } : {}),
        leverage: spec.leverage,
        marginCurrency: spec.marginCurrency,
        positionMarginType: spec.positionMarginType,
        reduceOnly: false,          // never transmitted; the clamp is the guard
        deadlineMs: Date.now() + 10_000,
      }, { baseUrl: VENUE_BASE });
      if (placed.kind === 'accepted') {
        // The create response's status is documented as meaningless
        // (research/03 G6) — the worker folds it, and the resolve ladder takes over.
        return { kind: 'accepted', venueOrderId: placed.order.venueOrderId, statusRaw: placed.order.venueStatusRaw };
      }
      if (placed.kind === 'refused_deadline') {
        console.error('[futures-order] deadline refused:', placed.reason);
        return { kind: 'rejected', orderMayExist: false, code: 'deadline', detail: placed.reason };
      }
      console.error('[futures-order] venue rejected:', placed.failure);
      return {
        kind: 'rejected',
        orderMayExist: placed.failure.orderMayExist === true,
        code: placed.failure.code ?? 'rejected',
        detail: placed.failure.detail ?? '',
      };
    },
    // L4a — the read-back that replaces the order-status endpoint futures lacks.
    listOrders: async ({ pair, side }) => {
      const read = await listFuturesOrdersSigned(sign, { pair, side, marginCurrency: spec.marginCurrency }, { baseUrl: VENUE_BASE });
      if (!read.ok) return { ok: false, detail: read.failure.detail ?? read.failure.code ?? 'unreadable' };
      return { ok: true, orders: read.orders };
    },
    // L4c — a position is evidence the order filled even when the list cannot see it.
    readPositions: async (marginCurrency) => {
      const read = await fetchFuturesPositionsSigned(sign, [marginCurrency], { baseUrl: VENUE_BASE });
      if (!read.ok) return { ok: false, detail: read.failure.detail ?? 'unreadable' };
      return { ok: true, positions: read.positions.map((p) => ({ pair: p.pair, activePos: p.activePos })) };
    },
  });

  const submit = async (coid, order) => {
    const sign = await signFor(order.tenantId, order.accountId);
    if (sign === null) {
      return {
        kind: 'rejected', orderMayExist: false, code: 'no_credential',
        detail: `account ${order.accountId} has no credential to sign with`,
      };
    }
    if (order.futures === undefined) {
      return {
        kind: 'rejected', orderMayExist: false, code: 'spot_not_supported',
        detail: 'this build trades futures only; refusing to send a spot order',
      };
    }
    if (order.futures.reduceOnly === true) {
      return { kind: 'rejected', orderMayExist: false, code: 'reduce_only_unsupported', detail: 'Use the position reduce or exit action for a futures close.' };
    }

    const outcome = await placeFuturesOrder(db, order.tenantId,
      protocolPortsFor(sign, {
        leverage: order.futures.leverage,
        marginCurrency: order.futures.marginCurrency,
        positionMarginType: order.futures.positionMarginType,
      }),
      {
        accountId: order.accountId,
        pair: order.futures.pair,
        marginCurrency: order.futures.marginCurrency,
        side: order.side,
        orderType: order.orderType,
        quantity: order.quantity,
        price: order.limitPrice,
        sentAtMs: Date.now(),
        childOrderId: order.childOrderId,
      });

    return outcome.submit;
  };

  /**
   * The resolve port. The ladder hands it a `client_order_id` and nothing else, so
   * it looks the leg up to recover what the venue needs to be asked about.
   *
   * Futures has no order-status endpoint, so "did it land?" is answered the same
   * way L4 answers it: read the order list back and match on the four fields that
   * define the intent. This is deliberately the same matcher in both places — a
   * second, differently-shaped matcher is how the two would drift apart.
   */
  const resolve = async (coid) => {
    const row = await db.selectFrom('child_order')
      .innerJoin('group_trade', 'group_trade.id', 'child_order.group_trade_id')
      .select([
        'child_order.id as childId', 'child_order.account_id as accountId',
        'child_order.tenant_id as tenantId', 'child_order.market as market',
        'child_order.final_quantity as finalQuantity', 'child_order.leg_seq as legSeq',
        'child_order.exchange_order_id as exchangeOrderId',
        'child_order.created_at as createdAt',
        'child_order.send_started_at as sendStartedAt',
        'group_trade.submitted_at as submittedAt',
        'child_order.leg_kind as legKind',
        'group_trade.order_type as orderType', 'group_trade.limit_price as limitPrice',
        'group_trade.asset as asset', 'group_trade.is_futures as isFutures',
        'group_trade.side as side', 'group_trade.margin_currency as marginCurrency',
      ])
      .where('child_order.client_order_id', '=', coid)
      .executeTakeFirst();
    if (row === undefined) return { ok: false };
    // The lookup is by a globally-unique client order id, so it is not a
    // tenant-scoped read — `child_order_client_order_id_unique` is what makes
    // that safe, not the absence of a tenant filter.
    if (row.isFutures !== true || row.finalQuantity === null || row.marginCurrency === null) {
      return { ok: false };
    }
    const pair = futuresPairOf({ asset: row.asset, quote: row.market.endsWith('USDT') ? 'USDT' : 'INR' },
      row.marginCurrency);
    const sign = await signFor(row.tenantId, row.accountId);
    if (sign === null) return { ok: false };
    const read = await listFuturesOrdersSigned(sign, { pair, side: row.side, marginCurrency: row.marginCurrency }, { baseUrl: VENUE_BASE })
      .catch(() => ({ ok: false }));
    if (read.ok === true && Array.isArray(read.orders)) {
      const match = findIntentOrder(read.orders, {
        accountId: row.accountId, childOrderId: row.childId, pair,
        marginCurrency: row.marginCurrency, side: row.side, orderType: row.orderType,
        quantity: row.finalQuantity, price: row.limitPrice,
        sentAtMs: new Date(row.sendStartedAt ?? row.submittedAt ?? row.createdAt).getTime(),
      }, row.exchangeOrderId);
      if (match !== undefined) {
        return { ok: true, order: { id: match.venueOrderId, statusRaw: match.statusRaw } };
      }
    }

    // Neither elapsed time nor a pre-existing position proves this order filled.
    // Futures read-back absence is not authoritative non-placement either.
    return { ok: false };
  };

  /** Phase-15 SL/TP: find the position this entry opened and attach protection. */
  const attachTpSl = (args) => executePositionMutation({ db, tenantId: args.tenantId,
    accountId: args.accountId, pair: args.pair, positionId: `entry:${args.entryChildOrderId}`,
    operation: 'tpsl', requestId: args.entryChildOrderId, body: args,
    execute: () => attachTpSlUnlocked(args),
  });
  const attachTpSlUnlocked = async (args) => {
    const sign = await signFor(args.tenantId, args.accountId);
    if (sign === null) return { ok: false, code: 'no_credential', detail: 'no credential to sign with' };
    const positions = await fetchFuturesPositionsSigned(sign, [args.marginCurrency], { baseUrl: VENUE_BASE });
    if (!positions.ok) {
      return { ok: false, code: 'positions_unreadable', detail: 'the venue did not answer the positions read' };
    }
    const position = positions.positions.find((p) => p.pair === args.pair);
    if (position === undefined) {
      return { ok: false, code: 'no_position', detail: `no open position on ${args.pair}` };
    }
    const out = await attachStopAndTakeSigned(sign, {
      positionId: position.venuePositionId,
      ...(args.stopLossPrice !== null
        ? { stopLoss: { triggerPrice: args.stopLossPrice, orderType: 'stop_market' } } : {}),
      ...(args.takeProfitPrice !== null
        ? { takeProfit: { triggerPrice: args.takeProfitPrice, orderType: 'take_profit_market' } } : {}),
    }, { baseUrl: VENUE_BASE });
    if (!out.ok) return { ok: false, code: out.failure.code ?? 'attach_failed', detail: out.failure.detail ?? '',
      outcomeUnknown: out.failure.orderMayExist === true, orderMayExist: out.failure.orderMayExist === true };
    if ((args.stopLossPrice !== null && out.stopLoss === undefined) || (args.takeProfitPrice !== null && out.takeProfit === undefined)
      || [out.stopLoss, out.takeProfit].some((leg) => leg?.ok === false && leg.reason === 'venue response did not include an order id')) {
      return { ok: false, code: 'TP_SL_UNCONFIRMED', detail: 'The venue did not confirm the requested protection orders', outcomeUnknown: true, orderMayExist: true };
    }
    let trailingWarning;
    if (args.trailingStopLoss && args.stopLossPrice !== null && out.stopLoss?.ok === true) {
      const { upsertTrailingSl } = await import('@tradex/db');
      let basisKey;
      if (args.trailingStepBasis === 'roe') {
        try { basisKey = roePositionBasis(position).key; }
        catch {
          // The fixed SL is confirmed. Report trailing registration separately;
          // never retry attaching that SL because collateral was unavailable.
          trailingWarning = 'Fixed SL is active; ROE trailing is inactive because current position margin/settlement data is unavailable. Refresh and re-enable trailing.';
        }
      }
      await upsertTrailingSl(forTenant(db, args.tenantId), {
        accountId: args.accountId,
        venuePositionId: position.venuePositionId,
        pair: args.pair,
        currentSlPrice: args.stopLossPrice,
        highWaterMark: position.markPrice ?? position.avgEntryPrice ?? args.stopLossPrice,
        distanceBp: args.trailingDistanceBp ?? '500',
        stepBp: args.trailingStepBp ?? '100',
        stepBasis: args.trailingStepBasis ?? 'price',
        status: trailingWarning ? 'failed' : 'active',
        ...(args.trailingStepBasis === 'roe' ? { stepAnchorPrice: position.markPrice ?? position.avgEntryPrice,
          positionBasisKey: basisKey } : {}),
      });
    }
    return {
      ok: true,
      ...(trailingWarning ? { trailingWarning } : {}),
      ...(out.stopLoss !== undefined ? { stopLoss: out.stopLoss } : {}),
      ...(out.takeProfit !== undefined ? { takeProfit: out.takeProfit } : {}),
    };
  };

  /**
   * Phase-15 hard exit: cancel the conditionals, then exit, then verify flat.
   *
   * The two READ methods THROW on a failed read rather than returning empty, and
   * that direction is deliberate:
   *
   *   * listUntriggeredConditionals returning [] on a failed read would SKIP the
   *     cancellation — and a stale SL left behind after an exit FIRES AND OPENS AN
   *     OPPOSITE POSITION. That is the R1 failure the whole sequence exists to
   *     prevent, so an unreadable list must abort, never proceed.
   *   * listPositions returning [] would make the final "is it flat?" check find
   *     nothing and report a clean exit it never verified.
   */
  const futuresExit = {
    cancelOrder: async (actor, venueOrderId) => {
      const sign = await signFor(actor.tenantId, actor.accountId);
      if (sign === null) return { ok: false, message: 'no credential for this account' };
      const out = await cancelFuturesOrderSigned(sign, venueOrderId, { baseUrl: VENUE_BASE });
      return out.ok ? { ok: true } : { ok: false, message: out.failure.detail ?? 'cancel refused' };
    },
    exitPosition: async (actor, venuePositionId) => {
      const sign = await signFor(actor.tenantId, actor.accountId);
      if (sign === null) return { ok: false, message: 'no credential for this account' };
      const out = await exitFuturesPositionSigned(sign, venuePositionId, { baseUrl: VENUE_BASE });
      if (!out.ok) {
        const isAlreadyClosed = out.failure && (
          out.failure.code === 'no_active_position' ||
          /no\s+active\s+position/i.test(out.failure.detail ?? '')
        );
        if (isAlreadyClosed) {
          return { ok: true, venueGroupId: null, alreadyClosed: true };
        }
        return { ok: false, message: out.failure.detail ?? 'exit refused' };
      }

      return { ok: true, venueGroupId: out.venueGroupId };
    },
    listPositions: async (actor, marginCurrency) => {
      const sign = await signFor(actor.tenantId, actor.accountId);
      if (sign === null) throw new Error('no credential for this account');
      const out = await fetchFuturesPositionsSigned(sign, [marginCurrency], { baseUrl: VENUE_BASE });
      if (!out.ok) throw new Error(`could not verify the exit: ${out.failure.detail ?? 'positions unreadable'}`);
      return out.positions;
    },
    listUntriggeredConditionals: async (actor, venuePositionId) => {
      const sign = await signFor(actor.tenantId, actor.accountId);
      if (sign === null) throw new Error('no credential for this account');
      // The pair comes from the venue, not from a caller: this port is addressed by
      // a position id, and orders are addressed by a pair.
      const positions = await fetchFuturesPositionsSigned(sign, ['INR', 'USDT'], { baseUrl: VENUE_BASE });
      if (!positions.ok) {
        throw new Error(`could not read the position before exiting: ${positions.failure.detail ?? 'unreadable'}`);
      }
      const position = positions.positions.find((p) => p.venuePositionId === venuePositionId);
      if (position === undefined) return [];
      const untriggered = [];
      for (const side of ['buy', 'sell']) {
        const listed = await listFuturesOrdersSigned(sign,
          { pair: position.pair, side, status: 'untriggered', marginCurrency: position.marginCurrency }, { baseUrl: VENUE_BASE });
        if (!listed.ok) {
          throw new Error(`could not list untriggered conditionals on ${position.pair}: ${listed.failure.detail ?? 'unreadable'}`);
        }
        for (const o of listed.orders) {
          if (o.pair === position.pair) {
            untriggered.push({ venueOrderId: o.venueOrderId });
          }
        }
      }
      return untriggered;
    },
  };

  /**
   * Post-entry SL/TP. create_tpsl is NOT an upsert (research/04 F12), so moving an
   * existing leg means cancel-then-create — and until that is built, a
   * moveExisting request is REFUSED rather than allowed to either fail at the
   * venue or silently leave two legs on one position.
   */
  const futuresTpSl = {
    setProtection: async (args) => {
      const sign = await signFor(args.actor.tenantId, args.actor.accountId);
      if (sign === null) return { stopLoss: { ok: false, reason: 'no credential for this account' } };
      const shouldCancelSl = args.removeStopLoss === true || (args.moveExisting === true && args.stopLossPrice !== undefined);
      const shouldCancelTp = args.removeTakeProfit === true || (args.moveExisting === true && args.takeProfitPrice !== undefined);
      if (shouldCancelSl || shouldCancelTp || args.moveExisting === true) {
        const pos = await forTenant(db, args.actor.tenantId).selectFrom('futures_position')
          .select(['pair', 'margin_currency as marginCurrency'])
          .where('venue_position_id', '=', args.venuePositionId)
          .where('account_id', '=', args.actor.accountId)
          .executeTakeFirst();
        if (pos !== undefined) {
          for (const side of ['buy', 'sell']) {
            const active = await listFuturesOrdersSigned(sign, {
              pair: pos.pair,
              side,
              status: 'untriggered',
              marginCurrency: pos.marginCurrency,
            }, { baseUrl: VENUE_BASE });
            if (!active.ok) throw new Error('Could not read existing protection; no replacement was submitted');
            if (active.ok) {
              for (const order of active.orders) {
                if (order.pair !== pos.pair) continue;
                if ((shouldCancelSl || (args.stopLossPrice !== undefined && args.moveExisting === true)) && (order.orderType === 'stop_market' || order.orderType === 'stop_limit')) {
                  const cancelled = await cancelFuturesOrderSigned(sign, order.venueOrderId, { baseUrl: VENUE_BASE });
                  if (!cancelled.ok) throw new Error('Stop-loss cancellation was not confirmed; check existing protection');
                }
                if ((shouldCancelTp || (args.takeProfitPrice !== undefined && args.moveExisting === true)) && (order.orderType === 'take_profit_market' || order.orderType === 'take_profit_limit')) {
                  const cancelled = await cancelFuturesOrderSigned(sign, order.venueOrderId, { baseUrl: VENUE_BASE });
                  if (!cancelled.ok) throw new Error('Take-profit cancellation was not confirmed; check existing protection');
                }
              }
            }
          }
          for (const side of ['buy', 'sell']) {
            const verify = await listFuturesOrdersSigned(sign, { pair: pos.pair, side, status: 'untriggered', marginCurrency: pos.marginCurrency }, { baseUrl: VENUE_BASE });
            if (!verify.ok || verify.orders.some((o) => o.pair === pos.pair && (
              shouldCancelSl && ['stop_market', 'stop_limit'].includes(o.orderType)
              || shouldCancelTp && ['take_profit_market', 'take_profit_limit'].includes(o.orderType)))) {
              throw new Error('Old protection may still be live; replacement requires reconciliation');
            }
          }
        } else {
          throw new Error('Position was not found in this account');
        }
      }
      if (args.removeStopLoss === true) {
        try {
          const { clearTrailingSl } = await import('@tradex/db');
          await clearTrailingSl(forTenant(db, args.actor.tenantId), args.actor.accountId, args.venuePositionId);
        } catch {
          // Ignore if clearTrailingSl is unavailable
        }
      }
      if (args.stopLossPrice === undefined && args.takeProfitPrice === undefined) {
        const updates = {};
        if (args.removeStopLoss === true) updates.stop_loss_trigger = null;
        if (args.removeTakeProfit === true) updates.take_profit_trigger = null;
        if (Object.keys(updates).length > 0) {
          await forTenant(db, args.actor.tenantId).updateTable('futures_position')
            .set(updates)
            .where('venue_position_id', '=', args.venuePositionId)
            .where('account_id', '=', args.actor.accountId)
            .execute();
        }
        return {
          ...(args.removeStopLoss ? { stopLoss: { ok: true } } : {}),
          ...(args.removeTakeProfit ? { takeProfit: { ok: true } } : {}),
        };
      }
      const out = await attachStopAndTakeSigned(sign, {
        positionId: args.venuePositionId,
        ...(args.stopLossPrice !== undefined
          ? { stopLoss: { triggerPrice: args.stopLossPrice, orderType: 'stop_market' } } : {}),
        ...(args.takeProfitPrice !== undefined
          ? { takeProfit: { triggerPrice: args.takeProfitPrice, orderType: 'take_profit_market' } } : {}),
      }, { baseUrl: VENUE_BASE });
      if (!out.ok) {
        if (out.failure.orderMayExist === true) throw new Error('Protection may have been created; reconcile before retrying');
        return { stopLoss: { ok: false, reason: out.failure.detail ?? 'the venue refused the attach' } };
      }
      if ((args.stopLossPrice !== undefined && out.stopLoss === undefined) || (args.takeProfitPrice !== undefined && out.takeProfit === undefined)
        || [out.stopLoss, out.takeProfit].some((leg) => leg?.ok === false && leg.reason === 'venue response did not include an order id')) {
        throw new Error('The venue did not confirm the requested protection orders; reconcile before retrying');
      }
      if (args.removeStopLoss === true || args.removeTakeProfit === true) {
        const updates = {};
        if (args.removeStopLoss === true) updates.stop_loss_trigger = null;
        if (args.removeTakeProfit === true) updates.take_profit_trigger = null;
        if (Object.keys(updates).length > 0) {
          await forTenant(db, args.actor.tenantId).updateTable('futures_position')
            .set(updates)
            .where('venue_position_id', '=', args.venuePositionId)
            .where('account_id', '=', args.actor.accountId)
            .execute();
        }
      }
      return out;
    },
  };

  /**
   * The post-fan-out mirror. Runs after the orders are sent, so it only ever reads.
   *
   * This is what gives the Positions page a producer: before it, `futures_position`
   * had a schema, a reader and index checks and NOTHING that ever wrote to it.
   * Best-effort by design — the confirm route swallows its errors, because the
   * trade is already placed and a mirroring failure is not the customer's problem.
   */


  const afterFanOut = async ({ tenantId, groupTradeId }) => {
    const children = await getChildOrders(forTenant(db, tenantId), groupTradeId);
    const accounts = [...new Set(children.map((c) => c.accountId))];
    const out = await mirrorAccounts(tenantId, accounts);
    console.log(`[mirror] trade ${groupTradeId.slice(0, 8)}: ${out.positions} position(s) over ${out.accounts} account(s)`);
  };

  /**
   * Partially close, or add to, a live position.
   *
   * `positions/exit` closes the WHOLE position, so anything less is an ordinary
   * opposite-side order. On this venue there is NO reduce_only, so an oversized
   * one does not fail — it closes the position and OPENS THE OPPOSITE ONE. The
   * sizing below floors to the instrument's own step and refuses below every
   * floor; the instrument is FETCHED rather than assumed, because nothing in the
   * system stores a futures instrument's step and inventing one is how a partial
   * close becomes a reversal.
   */
  const adjustPosition = async (args) => {
    if (!args.executionLockId) return { ok: false, code: 'lock_required', detail: 'Position changes require a durable action lock.' };
    const sign = await signFor(args.actor.tenantId, args.actor.accountId);
    if (sign === null) return { ok: false, code: 'no_credential', detail: 'no credential for this account' };

    const read = await fetchFuturesPositionsSigned(sign, ['INR', 'USDT'], { baseUrl: VENUE_BASE });
    if (!read.ok) {
      return { ok: false, code: 'positions_unreadable', detail: read.failure.detail ?? 'the venue did not answer the positions read' };
    }
    const pos = read.positions.find((p) => p.venuePositionId === args.venuePositionId);
    if (pos === undefined) {
      return { ok: false, code: 'no_position', detail: 'the exchange reports no open position with that id' };
    }

    const inst = await fetchFuturesInstrument(pos.pair, pos.marginCurrency, { baseUrl: VENUE_BASE });
    if (!inst.ok) {
      return { ok: false, code: 'instrument_unreadable', detail: inst.failure.detail ?? 'could not read the instrument' };
    }
    const price = pos.markPrice ?? pos.avgEntryPrice;
    if (price === null) {
      return { ok: false, code: 'no_price', detail: 'the venue reported neither a mark nor an entry price to size against' };
    }

    const plan = planAdjustment({
      direction: args.direction,
      activePos: pos.activePos,
      percentBp: args.percentBp,
      quantity: args.quantity,
      quantityIncrement: inst.instrument.quantityIncrement,
      minQuantity: inst.instrument.minQuantity,
      minNotional: inst.instrument.minNotional,
      price,
    });
    if (!plan.ok) return plan;

    if (args.direction === 'increase') {
      // Caps are denominated in INR; never compare USDT amounts to INR limits.
      const fxBook = await getOrderBook({ asset: 'USDT', quote: 'INR' }, 1);
      const fx = fxBook.asks[0]?.price;
      if (!fx) return { ok: false, code: 'fx_unreadable', detail: 'Cannot safely apply margin limits without INR/USDT pricing' };
      try {
        await reservePositionIncrease({ db, tdb: forTenant(db, args.actor.tenantId), requestId: args.executionLockId,
          accountId: args.actor.accountId, pair: pos.pair, quantity: plan.quantity, price, leverage: Number(pos.leverage ?? 1),
          quote: pos.pair.endsWith('_INR') ? 'INR' : 'USDT', usdtInrMid: fx });
      } catch (error) {
        return { ok: false, code: 'risk_limit', detail: error.message };
      }
    }

    // A full reduce is promoted to `positions/exit`: one atomic venue call, rather
    // than an opposite order racing fills and funding across two crossings.
    if (args.direction === 'reduce' && plan.isFull) {
      await hardExit(futuresExit, { actor: args.actor, venuePositionId: args.venuePositionId, marginCurrency: pos.marginCurrency });
      await forTenant(db, args.actor.tenantId)
        .deleteFrom('futures_position')
        .where('venue_position_id', '=', args.venuePositionId)
        .execute()
        .catch(() => {});
      setTimeout(() => {
        mirrorAccounts(args.actor.tenantId, [args.actor.accountId]).catch(() => {});
      }, 1500);
      return { ok: true, quantity: plan.quantity, venueOrderId: null, full: true };
    }

    const outcome = await placeFuturesOrder(db, args.actor.tenantId,
      { ...protocolPortsFor(sign, {
        leverage: pos.leverage ?? 1,
        marginCurrency: pos.marginCurrency,
        positionMarginType: pos.marginType ?? 'isolated',
        allowReduce: args.direction === 'reduce',
      }), lockAlreadyHeld: true },
      {
        accountId: args.actor.accountId,
        pair: pos.pair,
        marginCurrency: pos.marginCurrency,
        side: plan.side,
        orderType: 'market',
        quantity: plan.quantity,
        price: null,
        sentAtMs: Date.now(),
        // An adjust is not a child_order row; the lock is keyed by this id purely
        // to exclude a concurrent send on the same (account, pair).
        childOrderId: args.executionLockId,
      });

    if (outcome.submit.kind !== 'accepted') {
      if (outcome.submit.orderMayExist !== true && outcome.submit.needsHuman !== true) {
        await forTenant(db, args.actor.tenantId).updateTable('position_mutation').set({ risk_margin_inr_minor: null })
          .where('request_id', '=', args.executionLockId).execute();
      }
      return {
        ok: false,
        code: outcome.submit.code ?? 'not_placed',
        outcomeUnknown: outcome.submit.orderMayExist === true || outcome.submit.needsHuman === true,
        detail: outcome.submit.detail ?? `the venue did not accept the order (${outcome.resolution})`,
      };
    }
    const decimal = (v) => {
      const negative = v.startsWith('-');
      const [whole, fraction = ''] = v.replace(/^-/, '').split('.');
      return (negative ? -1n : 1n) * (BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0')));
    };
    const beforePos = decimal(pos.activePos);
    const expected = beforePos + decimal(plan.quantity) * (plan.side === 'buy' ? 1n : -1n);
    // Poll reads only while retaining the account/pair lock. Never repeat the send.
    for (const delay of [0, 250, 500, 750, 1000]) {
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const after = await fetchFuturesPositionsSigned(sign, ['INR', 'USDT'], { baseUrl: VENUE_BASE });
      if (!after.ok) continue;
      await replaceFuturesPositions(forTenant(db, args.actor.tenantId), args.actor.accountId, after.positions);
      const observed = after.positions.find((p) => p.venuePositionId === args.venuePositionId);
      const actual = decimal(observed?.activePos ?? '0');
      if (args.direction === 'reduce' && actual !== 0n && (beforePos < 0n) !== (actual < 0n)) {
        return { ok: false, code: 'position_flipped', outcomeUnknown: true, detail: 'The reduction reversed the position; exchange reconciliation is required.' };
      }
      if (actual === expected) return { ok: true, quantity: plan.quantity, venueOrderId: outcome.submit.exchangeOrderId ?? null, full: false };
    }
    return { ok: false, code: 'position_unconfirmed', outcomeUnknown: true, detail: 'The order was accepted, but the expected position change is not confirmed. Check the exchange before another adjustment.' };
  };





  const updateLeverage = async (args) => {
    const sign = await signFor(args.actor.tenantId, args.actor.accountId);
    if (sign === null) return { ok: false, code: 'no_credential', detail: 'no credential for this account' };

    const read = await fetchFuturesPositionsSigned(sign, ['INR', 'USDT'], { baseUrl: VENUE_BASE });
    if (!read.ok) {
      return { ok: false, code: 'positions_unreadable', detail: read.failure.detail ?? 'the venue did not answer the positions read' };
    }
    const pos = read.positions.find((p) => p.venuePositionId === args.venuePositionId);
    if (pos === undefined) {
      return { ok: false, code: 'no_position', detail: 'the exchange reports no open position with that id' };
    }

    const [instrument, leverageBook] = await Promise.all([
      getFreshFuturesInstrument(pos.pair, pos.marginCurrency), getLeverageBook(pos.pair),
    ]);
    if (!instrument.ok) return { ok: false, code: 'instrument_unavailable', detail: 'Cannot verify current leverage limits; try again.' };
    const quantity = scaledFromString(pos.activePos.replace(/^-/, ''), 18);
    const references = [pos.markPrice, pos.avgEntryPrice, leverageBook.asks[0]?.price, leverageBook.bids[0]?.price]
      .filter((v) => typeof v === 'string' && /^\d+(?:\.\d{1,18})?$/.test(v)).map((v) => scaledFromString(v, 18));
    const reference = references.reduce((a, b) => cmp(a, b) >= 0 ? a : b, scaledFromString('0', 18));
    const max = reference.v > 0n && quantity.v > 0n ? maxInstrumentLeverage(instrument.instrument.leverageTiers, toPlainString(mul(quantity, reference, 18))) : 0;
    if (max === 0 || Number(args.leverage) > max) return { ok: false, code: 'leverage_limit', detail: `This position currently supports at most ${max}× leverage.` };
    const out = await updateFuturesLeverageSigned(sign, {
      pair: pos.pair,
      marginCurrency: pos.marginCurrency,
      leverage: args.leverage,
      positionId: pos.venuePositionId,
    }, { baseUrl: VENUE_BASE });

    if (!out.ok) {
      return { ok: false, code: out.failure.code ?? 'leverage_refused', outcomeUnknown: out.failure.orderMayExist === true, detail: out.failure.detail ?? 'the venue refused to update leverage' };
    }

    // Immediately update local DB cache
    await forTenant(db, args.actor.tenantId)
      .updateTable('futures_position')
      .set({ leverage: String(args.leverage), updated_at: new Date() })
      .where('venue_position_id', '=', args.venuePositionId)
      .execute()
      .catch(() => {});

    // Schedule background mirror sync
    setTimeout(() => {
      mirrorAccounts(args.actor.tenantId, [args.actor.accountId]).catch((e) => {
        console.error('[mirror] post-leverage background refresh failed:', e instanceof Error ? e.message : String(e));
      });
    }, 1200);

    return { ok: true, newLeverage: String(args.leverage) };
  };

  const cancel = async (accountId, coid) => {
    const child = await db.selectFrom('child_order').select(['tenant_id', 'exchange_order_id'])
      .where('account_id', '=', accountId).where('client_order_id', '=', coid).executeTakeFirst();
    if (!child) return { kind: 'rejected', code: 'order_not_owned', detail: 'No such order in this account' };
    let venueId = child.exchange_order_id;
    if (!venueId) {
      const observed = await resolve(coid);
      if (observed.ok && observed.order) venueId = observed.order.id;
    }
    if (!venueId) return { kind: 'rejected', orderMayExist: true, code: 'order_unconfirmed', detail: 'Reconcile this order before cancelling it' };
    const sign = await signFor(child.tenant_id, accountId);
    if (!sign) return { kind: 'rejected', code: 'no_credential', detail: 'No credential for this account' };
    const result = await cancelFuturesOrderSigned(sign, venueId, { baseUrl: VENUE_BASE });
    return result.ok ? { kind: 'cancelled' } : { kind: 'rejected', orderMayExist: result.failure.orderMayExist,
      code: result.failure.code, detail: result.failure.detail };
  };
  Object.assign(enginePorts, {
    submit,
    resolve,
    cancel,
    executionPepper,
    attachTpSl,
    futuresExit,
    futuresTpSl,
    afterFanOut,
    futuresAdjust: { adjustPosition },
    futuresLeverage: { updateLeverage },
    // The sweep that keeps the resolve ladder alive after a confirm returns.
    resolverIntervalMs: 15_000,
  });
}


// --- boot the server ---
const server = createHttpServer({
  researchEnabled: process.env['TRADEX_RESEARCH_ENABLED'] === '1',
  researchVault: process.env['TRADEX_RESEARCH_ROOT_KEY'] ? new ResearchKeyVault(process.env['TRADEX_RESEARCH_ROOT_KEY']) : undefined,
  researchPolicy: {
    dailyLimit: Number(process.env['TRADEX_RESEARCH_DAILY_LIMIT'] ?? 10),
    pendingLimit: Number(process.env['TRADEX_RESEARCH_PENDING_LIMIT'] ?? 3),
  },
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
  secureCookies: process.env['NODE_ENV'] === 'production' || sending && REAL_VENUE || process.env['TRADEX_SECURE_COOKIES'] === '1',
  resendApiKey: process.env['RESEND_API_KEY'],
  resendFrom: process.env['RESEND_FROM'],
  adminAlertEmail: process.env['ADMIN_ALERT_EMAIL'] ?? 'bariaza006@gmail.com',
  appUrl: process.env['APP_URL'],
  ...enginePorts,
});

import { TrailingSlEngine } from './dist/trailing-sl-worker.js';
import { roePositionBasis, canReplaceRoeStop } from './dist/futures/roe-trailing.js';
const tslEngine = new TrailingSlEngine(
  db,
  async ({ tenantId, accountId, venuePositionId, stopLossPrice, positionBasisKey, expectedSlPrice, evaluationClaimAt }) => {
    console.log(`[TrailingSL] Target SL for position ${venuePositionId} crossed threshold, moving to ${stopLossPrice}`);
    if (!enginePorts.futuresTpSl?.setProtection) {
      console.warn('[TrailingSL] futuresTpSl port not available');
      return { ok: false, reason: 'futuresTpSl port not configured' };
    }
    try {
      const position = await forTenant(db, tenantId).selectFrom('futures_position').select('pair')
        .where('account_id', '=', accountId).where('venue_position_id', '=', venuePositionId).executeTakeFirst();
      if (!position) return { ok: false, reason: 'Position has already closed' };
      const out = await executePositionMutation({ db, tenantId, accountId, pair: position.pair,
        positionId: venuePositionId, operation: 'tpsl', body: { stopLossPrice, positionBasisKey }, execute: async () => {
          if (positionBasisKey) {
            // Configuration changes share this action lock. A step claimed
            // before a disable/re-enable must not replace that user's stop.
            const claim = evaluationClaimAt && expectedSlPrice && await forTenant(db, tenantId)
              .selectFrom('futures_trailing_sl').select('id').where('account_id', '=', accountId)
              .where('venue_position_id', '=', venuePositionId).where('status', '=', 'updating')
              .where('last_evaluated_at', '=', new Date(evaluationClaimAt))
              .where('position_basis_key', '=', positionBasisKey).where('current_sl_price', '=', expectedSlPrice)
              .executeTakeFirst();
            if (!claim) return { stopLoss: { ok: false, reason: 'Trailing configuration changed before this step' } };
            const sign = await signFor(tenantId, accountId);
            if (!sign) return { stopLoss: { ok: false, reason: 'Position could not be refreshed before ROE stop update' } };
            const fresh = await fetchFuturesPositionsSigned(sign, ['INR', 'USDT'], { baseUrl: VENUE_BASE });
            const livePosition = fresh.ok ? fresh.positions.find((p) => p.venuePositionId === venuePositionId) : undefined;
            if (!livePosition) return { stopLoss: { ok: false, reason: 'Position could not be refreshed before ROE stop update' } };
            if (roePositionBasis(livePosition).key !== positionBasisKey) {
              await enginePorts.refreshTrailingPositions?.([{ tenantId, accountId }]);
              return { stopLoss: { ok: false, reason: 'position_basis_changed' } };
            }
            if (!expectedSlPrice || !canReplaceRoeStop(livePosition, stopLossPrice, expectedSlPrice)) {
              return { stopLoss: { ok: false, reason: 'Current venue stop or mark changed; existing protection was left in place. Review and re-enable trailing.' } };
            }
          }
          return enginePorts.futuresTpSl.setProtection({
            actor: { tenantId, accountId }, venuePositionId, stopLossPrice, moveExisting: true,
          });
        } });
      if (out.stopLoss?.ok !== true) {
        console.error(`[TrailingSL] Exchange did not confirm SL move for position ${venuePositionId}:`, out.stopLoss?.reason);
        return { ok: false, reason: out.stopLoss?.reason ?? 'Stop update was not confirmed' };
      }
      console.log(`[TrailingSL] Successfully moved SL to ${stopLossPrice} on exchange for position ${venuePositionId}`);
      return { ok: true };
    } catch (err) {
      console.error(`[TrailingSL] Failed to move SL for position ${venuePositionId}:`, err);
      return { ok: false, reason: err.message };
    }
  },
  getOrderBook,
  async (pair, margin) => {
    const out = await fetchFuturesInstrument(pair, margin, { baseUrl: VENUE_BASE });
    if (!out.ok) throw new Error('Cannot trail without current price tick rules');
    return out.instrument.priceIncrement;
  },
  enginePorts.refreshTrailingPositions,
);
tslEngine.start();

// Periodic closed trade sync across accounts to keep realized PnL and trade history up to date
let isSyncingClosedTrades = false;
const syncAllClosedTrades = async () => {
  if (isSyncingClosedTrades) return;
  isSyncingClosedTrades = true;
  try {
    const tenants = await db.selectFrom('tenant').select('id').execute();
    for (const t of tenants) {
      const tdb = forTenant(db, t.id);
      const accounts = await listAccounts(tdb);
      const activeAccounts = accounts.filter((a) => a.status === 'active');
      const CHUNK_SIZE = 4;
      for (let i = 0; i < activeAccounts.length; i += CHUNK_SIZE) {
        const chunk = activeAccounts.slice(i, i + CHUNK_SIZE);
        await Promise.all(
          chunk.map(async (acc) => {
            try {
              const sign = await signFor(t.id, acc.id, 'read orders and transactions history on behalf of the account owner');
              if (sign !== null) {
                await syncClosedTradesForAccount(tdb, t.id, acc.id, sign);
              }
            } catch { /* best-effort */ }
          }),
        );
      }
    }
  } catch (e) {
    console.error('[sync-all-closed-trades] sweep failed:', e instanceof Error ? e.message : String(e));
  } finally {
    isSyncingClosedTrades = false;
  }
};

setTimeout(() => {
  syncAllClosedTrades().catch(() => {});
  setInterval(syncAllClosedTrades, 60_000);
}, 3000);

// Reaper on boot (phase-13 T13.7 / R4): before we accept traffic, release any
// stale worker lock and re-queue it as a 'resolve' job — never a second 'place'.
// A crash that left a worker half-way through a send must resolve, not re-send.
await requeueStale(db);


server.listen(PORT, '0.0.0.0', () => {
  console.log(`Tradex API listening on http://0.0.0.0:${PORT} (order book: ${live ? 'LIVE' : 'fixtures'})`);
  if (sending) {
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════════════════╗');
    console.log('  ║  SEND MODE IS ON — THIS PROCESS WILL PLACE REAL ORDERS           ║');
    console.log('  ╚══════════════════════════════════════════════════════════════════╝');
    console.log(`     venue:   ${VENUE_HOST}${REAL_VENUE ? '   <-- THE REAL EXCHANGE' : '   (sandbox)'}`);
    console.log(`     signer:  ${SIGNER_URL !== undefined && SIGNER_URL !== '' ? SIGNER_URL : 'in-process (sandbox only)'}`);
    console.log('');
  } else {
    console.log('  dry run: the SENDING ports are not wired, so a confirm records and sends nothing.');
    console.log('  Reading balances and positions still works — a read signs, but it does not trade.');
    console.log('  set TRADEX_SEND_MODE=send to enable real sending.');
  }
});

const shutdown = () => {
  server.close(() => { void db.destroy().then(() => process.exit(0)); });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
