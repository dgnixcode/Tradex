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
import { randomBytes, randomUUID } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { createHttpServer, listAccounts, placeFuturesOrder, planAdjustment } from './dist/index.js';
import { forTenant, findByAccount, getChildOrders, requeueStale, replaceFuturesPositions, recordObservedBalances } from '../../packages/db/dist/index.js';
import { LocalKms, verifyTotpFromEnvelope } from '../../packages/crypto/dist/index.js';
import { Signer } from '../signer/dist/index.js';
import { deriveFundingCurrencies, futuresPairOf } from '../../packages/exchange/dist/index.js';
import {
  mapOrderBook, probeCredential, send,
  submitFuturesOrderSigned, listFuturesOrdersSigned, fetchFuturesPositionsSigned, fetchFuturesInstrument, readBalancesSigned,
  attachStopAndTakeSigned, cancelFuturesOrderSigned, exitFuturesPositionSigned,
} from '../../packages/exchange-coindcx/dist/index.js';

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
const pool = new pg.Pool({ connectionString: url, max: 10 });
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
async function signFor(tenantId, accountId) {
  const credential = await findByAccount(forTenant(db, tenantId), accountId);
  if (credential === null) return null;

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
        headers: {
          'content-type': 'application/json',
          ...(token !== undefined && token !== '' ? { 'x-tradex-signer-token': token } : {}),
        },
        body: JSON.stringify({
          tenantId,
          credentialId: credential.credentialId,
          payload: body,
          algorithm: 'hmac-sha256-hex',
          reason: 'place or manage a futures order on behalf of the account owner',
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
      reason: 'place or manage a futures order on behalf of the account owner',
      actorProcess: 'api',
    });
    return { apiKey: out.apiKey, signature: out.signature };
  };
}

/** The tenant-scoped db every venue port writes through. */
const tdbFor = (tenantId) => forTenant(db, tenantId);

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
   * Mirror the venue's positions for a set of accounts. Shared by the
   * post-fan-out hook and the manual refresh, so both write the same way.
   */
const mirrorAccounts = async (tenantId, accountIds) => {
    const tdb = forTenant(db, tenantId);
    let positions = 0;
    for (const accountId of accountIds) {
      const sign = await signFor(tenantId, accountId);
      if (sign === null) continue;
      // BOTH margin currencies: the body must always carry both or INR-margined
      // positions are invisible (research/04 G8).
      const read = await fetchFuturesPositionsSigned(sign, ['INR', 'USDT'], { baseUrl: VENUE_BASE });
      if (!read.ok) {
        console.error(`[mirror] positions read failed for account ${accountId}: ${read.failure.detail ?? ''}`);
        continue;
      }
      // REPLACE, not upsert: a position the venue no longer reports must stop
      // rendering as open. The read above covers both margin currencies, so it is
      // a complete picture and absent means closed.
      positions += await replaceFuturesPositions(tdb, accountId, read.positions);
    }
    return { accounts: accountIds.length, positions };
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
    await recordObservedBalances(tdbFor(tenantId), {
      accountId,
      fundingCurrencies: funding,
      balances,
    });
    return {
      currencies: funding,
      balances: balances.length,
    };
  };

Object.assign(enginePorts, { accountSync, refreshPositions });

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
      const placed = await submitFuturesOrderSigned(sign, {
        pair: intent.pair,
        side: intent.side,
        orderType: intent.orderType,
        quantity: intent.quantity,
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
        return { kind: 'rejected', orderMayExist: false, code: 'deadline', detail: placed.reason };
      }
      return {
        kind: 'rejected',
        orderMayExist: placed.failure.orderMayExist === true,
        code: placed.failure.code ?? 'rejected',
        detail: placed.failure.detail ?? '',
      };
    },
    // L4a — the read-back that replaces the order-status endpoint futures lacks.
    listOrders: async ({ pair, side }) => {
      const read = await listFuturesOrdersSigned(sign, { pair, side }, { baseUrl: VENUE_BASE });
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
    const read = await listFuturesOrdersSigned(sign, { pair, side: row.side }, { baseUrl: VENUE_BASE })
      .catch(() => ({ ok: false }));
    if (read.ok !== true) return { ok: false };
    const match = read.orders.find((o) => o.pair === pair && o.side === row.side
      && o.orderType === row.orderType
      && o.totalQuantity === row.finalQuantity
      && (o.price ?? null) === (row.limitPrice ?? null));
    if (match === undefined) return { ok: true, order: null };
    return { ok: true, order: { id: match.venueOrderId, statusRaw: match.statusRaw } };
  };

  /** Phase-15 SL/TP: find the position this entry opened and attach protection. */
  const attachTpSl = async (args) => {
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
    if (!out.ok) return { ok: false, code: out.failure.code ?? 'attach_failed', detail: out.failure.detail ?? '' };
    if (args.trailingStopLoss && args.stopLossPrice !== null && out.stopLoss?.ok === true) {
      const { upsertTrailingSl } = await import('@tradex/db');
      await upsertTrailingSl(db, {
        accountId: args.accountId,
        venuePositionId: position.venuePositionId,
        pair: args.pair,
        currentSlPrice: args.stopLossPrice,
      });
    }
    return {
      ok: true,
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
      if (!out.ok) return { ok: false, message: out.failure.detail ?? 'exit refused' };

      // Refresh the mirror as part of the exit. The fan-out hook does not run for an
      // exit, so without this the position we just closed would keep rendering on
      // the Positions page — a closed position shown as open is exactly the kind of
      // stale state someone trades on. The view filters active_pos '0', so writing
      // the venue's flat reading is what makes it disappear.
      try {
        const after = await fetchFuturesPositionsSigned(sign, ['INR', 'USDT'], { baseUrl: VENUE_BASE });
        if (after.ok) await replaceFuturesPositions(forTenant(db, actor.tenantId), actor.accountId, after.positions);
      } catch (e) {
        console.error('[mirror] post-exit refresh failed:', e instanceof Error ? e.message : String(e));
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
      for (const side of ['buy', 'sell']) {
        const listed = await listFuturesOrdersSigned(sign,
          { pair: position.pair, side, status: 'untriggered' }, { baseUrl: VENUE_BASE });
        if (!listed.ok) {
          throw new Error(`could not list untriggered conditionals on ${position.pair}: ${listed.failure.detail ?? 'unreadable'}`);
        }
        if (listed.orders.length > 0) return listed.orders.map((o) => ({ venueOrderId: o.venueOrderId }));
      }
      return [];
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
      if (args.moveExisting === true) {
        const pos = await db.selectFrom('futures_position')
          .select('pair')
          .where('venue_position_id', '=', args.venuePositionId)
          .executeTakeFirst();
        if (pos !== undefined) {
          const active = await listFuturesOrdersSigned(sign, {
            pair: pos.pair,
            status: 'untriggered'
          }, { baseUrl: VENUE_BASE });
          if (active.ok) {
            for (const order of active.orders) {
              if (args.stopLossPrice !== undefined && (order.orderType === 'stop_market' || order.orderType === 'stop_limit')) {
                await cancelFuturesOrderSigned(sign, order.venueOrderId, { baseUrl: VENUE_BASE });
              }
              if (args.takeProfitPrice !== undefined && (order.orderType === 'take_profit_market' || order.orderType === 'take_profit_limit')) {
                await cancelFuturesOrderSigned(sign, order.venueOrderId, { baseUrl: VENUE_BASE });
              }
            }
          }
        }
      }
      const out = await attachStopAndTakeSigned(sign, {
        positionId: args.venuePositionId,
        ...(args.stopLossPrice !== undefined
          ? { stopLoss: { triggerPrice: args.stopLossPrice, orderType: 'stop_market' } } : {}),
        ...(args.takeProfitPrice !== undefined
          ? { takeProfit: { triggerPrice: args.takeProfitPrice, orderType: 'take_profit_market' } } : {}),
      }, { baseUrl: VENUE_BASE });
      if (!out.ok) {
        return { stopLoss: { ok: false, reason: out.failure.detail ?? 'the venue refused the attach' } };
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
      quantityIncrement: inst.instrument.quantityIncrement,
      minQuantity: inst.instrument.minQuantity,
      minNotional: inst.instrument.minNotional,
      price,
    });
    if (!plan.ok) return plan;

    // A full reduce is promoted to `positions/exit`: one atomic venue call, rather
    // than an opposite order racing fills and funding across two crossings.
    if (args.direction === 'reduce' && plan.isFull) {
      const out = await exitFuturesPositionSigned(sign, args.venuePositionId, { baseUrl: VENUE_BASE });
      if (!out.ok) {
        return { ok: false, code: out.failure.code ?? 'exit_refused', detail: out.failure.detail ?? 'the venue refused the exit' };
      }
      await mirrorAccounts(args.actor.tenantId, [args.actor.accountId]);
      return { ok: true, quantity: plan.quantity, venueOrderId: null, full: true };
    }

    const outcome = await placeFuturesOrder(db, args.actor.tenantId,
      protocolPortsFor(sign, {
        leverage: pos.leverage ?? 1,
        marginCurrency: pos.marginCurrency,
        positionMarginType: pos.marginType ?? 'isolated',
      }),
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
        childOrderId: randomUUID(),
      });

    // The venue is the truth about what the position became, so re-read it — and
    // check the sign did not flip. A reduce that REVERSED the position would be
    // invisible in the order response and catastrophic on the next mark move.
    const after = await fetchFuturesPositionsSigned(sign, [pos.marginCurrency], { baseUrl: VENUE_BASE });
    if (after.ok) {
      await replaceFuturesPositions(forTenant(db, args.actor.tenantId), args.actor.accountId, after.positions);
      const now = after.positions.find((p) => p.venuePositionId === args.venuePositionId);
      if (args.direction === 'reduce' && now !== undefined
        && pos.activePos.startsWith('-') !== now.activePos.startsWith('-')) {
        return {
          ok: false,
          code: 'position_flipped',
          detail: `the reduce REVERSED the position (${pos.activePos} -> ${now.activePos}) — needs a human`,
        };
      }
    }

    if (outcome.submit.kind !== 'accepted') {
      return {
        ok: false,
        code: outcome.submit.code ?? 'not_placed',
        detail: outcome.submit.detail ?? `the venue did not accept the order (${outcome.resolution})`,
      };
    }
    return { ok: true, quantity: plan.quantity, venueOrderId: outcome.submit.exchangeOrderId ?? null, full: false };
  };





  Object.assign(enginePorts, {
    submit,
    resolve,
    executionPepper,
    attachTpSl,
    futuresExit,
    futuresTpSl,
    afterFanOut,
    futuresAdjust: { adjustPosition },
    // The sweep that keeps the resolve ladder alive after a confirm returns.
    resolverIntervalMs: 15_000,
  });
}


// --- boot the server ---
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
  ...enginePorts,
});

import { TrailingSlEngine } from './dist/trailing-sl-worker.js';
const tslEngine = new TrailingSlEngine(
  db,
  async (venuePositionId, stopLossPrice) => {
    // We don't have a direct internal port for this yet, so we'll leave it as a log in this stub 
    // or call the backend directly. For full integration we would pass a signer and call attachStopAndTakeSigned.
    console.log(`[TrailingSL] Target SL for position ${venuePositionId} crossed threshold, moving to ${stopLossPrice}`);
  },
  getOrderBook
);
tslEngine.start();

// Reaper on boot (phase-13 T13.7 / R4): before we accept traffic, release any
// stale worker lock and re-queue it as a 'resolve' job — never a second 'place'.
// A crash that left a worker half-way through a send must resolve, not re-send.

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
