// Fake CoinDCX — plan/phase-01 T01.8.
//
// A local server that answers with the RESPONSES THE REAL VENUE GAVE US. The
// public endpoints all serve captured fixtures, so the pathological values are
// the venue's own: 90 exponent-form numbers, an order book whose key order lies,
// `min_market_orders_qty` absent everywhere, 34 markets on quotes we do not
// support. Inventing tidy fixtures would test the adapter against a venue that
// does not exist (18 F4).
//
// It VERIFIES SIGNATURES. That is the feature that makes it worth more than a
// stub: it recomputes HMAC-SHA256 over the exact bytes received and rejects a
// mismatch with the real venue's own 401 body. The failure mode T01.2 exists to
// prevent — a body mutated or re-serialised after signing — is invisible against
// a stub and fatal against the real venue, so the fake has to catch it.
//
// It also emits the undocumented `ratelimit` headers (06 F6.2), so the
// closed-loop limiter has something to close the loop on.
//
// Minimal order state (Phase 06): orders/create assigns an exchange_order_id and
// stores by client_order_id, rejecting a DUPLICATE client_order_id with the real
// venue's idempotency error; orders/status resolves by client_order_id.
//
// Phase 09 adds the sell side: orders/cancel is REAL now (it mutates stored
// state and answers the FAQ's refusal for a settled order), orders/active_orders
// lists the stored orders still working on a market, and two control methods give
// a test the "fill-capable venue" Phase 08 never had — `settleOrder` drives a
// stored order to `filled`/`partially_filled` (so a fan-out can auto-complete,
// T09.7) and `setBalance` shapes the `users/balances` read (so a sell can be
// sized from a mutated exchange truth, T09.2). Balances are served dynamically
// from `balanceRows`, not the earlier frozen string.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_KEY_HEADER, AUTH_SIGNATURE_HEADER } from './signing.js';

const DEFAULT_FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'checks', 'fixtures');

/**
 * Balances are SYNTHESISED, not captured — reading a real account needs a real
 * key, which the developer running this does not have (E3 is still open). The
 * shape is the documented one; the values are chosen to be awkward on purpose:
 * an INR-funded and a USDT-funded currency so the funding split is exercised, a
 * locked balance, and an 8-decimal dust amount that a double would round.
 */
const SYNTHETIC_BALANCES = `[
 {"currency":"INR","balance":248750.34,"locked_balance":19870.59},
 {"currency":"USDT","balance":1420.88888888,"locked_balance":0},
 {"currency":"BTC","balance":0.00031204,"locked_balance":0.00000001},
 {"currency":"ETH","balance":0,"locked_balance":0}
]`;

/** The real 401 bodies, verbatim from the live probes in 01 F8. */
const INVALID_CREDENTIALS = '{"code":401,"message":"Invalid credentials","status":"error"}';
const INVALID_SIGNATURE = '{"code":401,"message":"Invalid signature","status":"error"}';

export interface Fault {
  /** Substring of the path this fault applies to. Omit to match everything. */
  readonly path?: string | undefined;
  readonly status?: number | undefined;
  readonly body?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Respond only after this delay — for deadline and slow-venue tests. */
  readonly delayMs?: number | undefined;
  /** Destroy the socket instead of answering: the ambiguous-failure case. */
  readonly hangUp?: boolean | undefined;
  /**
   * Let an orders/create store the order, then destroy the socket before the
   * response — the hardest ambiguous case: the venue ACCEPTED but the client
   * never heard. Only meaningful on the create route.
   */
  readonly acceptThenDrop?: boolean | undefined;
  /** Accept and never answer, so only the client's deadline ends it. */
  readonly blackhole?: boolean | undefined;
  /** How many matching requests it applies to. Default 1. */
  readonly times?: number | undefined;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly apiKey: string | null;
  readonly signatureValid: boolean | null;
  readonly atMs: number;
}

export interface FakeVenueOptions {
  /** apiKey -> apiSecret. Signatures are verified against these. */
  readonly credentials?: Readonly<Record<string, string>> | undefined;
  readonly fixturesDir?: string | undefined;
  /** Emitted as `ratelimit: limit=..., remaining=..., reset=...`. */
  readonly rateLimit?: { readonly limit: number; readonly windowSeconds: number } | undefined;
  /**
   * Bind a FIXED port instead of an ephemeral one.
   *
   * Checks want the default — an ephemeral port means two concurrent harnesses can
   * never collide. The standalone sandbox venue (`npm run sandbox-venue`) needs a
   * stable one, because the API reads its address from `TRADEX_VENUE_BASE` and that
   * is set once rather than copied out of a log line on every restart.
   */
  readonly port?: number | undefined;
}

const equalHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
};

export class FakeVenue {
  private server: Server | undefined;
  private base: URL | undefined;
  private readonly faults: Array<Fault & { remaining: number }> = [];
  private readonly fixtures = new Map<string, string>();
  /**
   * Every accepted socket. `stop()` destroys them, because a blackholed request
   * holds one open forever and `server.close()` waits for it — so without this
   * the close callback never fires and the worker is torn down with a live
   * socket, which on Windows aborts the whole process (exit 0xC0000409) instead
   * of failing a test.
   */
  private readonly sockets = new Set<Socket>();
  private served = 0;
  /** One-shot: the create route stores the order, then drops the response. */
  private dropCreate = false;
  /** Every request, in order. The assertion surface for adapter tests. */
  readonly requests: RecordedRequest[] = [];
  /** Orders keyed by client_order_id — the Phase 06 order state. */
  private readonly orders = new Map<string, Record<string, unknown>>();
  private orderSeq = 0;
  /**
   * Futures state — plan/phase-15. The venue has NO client_order_id on futures
   * (research/03 Verdict), so orders here are keyed by the venue's own id.
   * Positions are keyed by their own uuid; a settle test simulates the fill by
   * setting `active_pos`, `avg_entry_price`, and optionally `mark_price`.
   */
  private readonly futuresOrders = new Map<string, Record<string, unknown>>();
  private futuresOrderSeq = 0;
  private readonly futuresPositions = new Map<string, Record<string, unknown>>();
  private futuresPositionSeq = 0;
  /** Per (account_key, pair, marginCurrency): sticky leverage the venue remembers. */
  private readonly futuresLeverage = new Map<string, string>();
  /**
   * A synthetic last-traded price per pair, used to price a filled market order.
   *
   * The real venue would report the actual fill price; a test double has no book to
   * fill against, so it needs SOME number. Kept in one place and overridable so a
   * test that cares about the price can say what it is rather than reverse it out
   * of a constant.
   */
  private readonly futuresLtp = new Map<string, string>();
  /** Per-(pair|margin) instrument overrides, so a test can set its own step. */
  private readonly futuresInstruments = new Map<string, Record<string, unknown>>();
  /**
   * Balances served from here, so a test can shape the venue's truth. A sell
   * sizes against this read (T09.2), and locking/dust scenarios need the fake to
   * show whatever free/locked split the scenario requires.
   */
  private balanceRows: Array<{ currency: string; balance: number; locked_balance: number }> =
    JSON.parse(SYNTHETIC_BALANCES) as Array<{ currency: string; balance: number; locked_balance: number }>;

  constructor(private readonly options: FakeVenueOptions = {}) {}

  private fixture(name: string): string {
    const cached = this.fixtures.get(name);
    if (cached !== undefined) return cached;
    const dir = this.options.fixturesDir ?? DEFAULT_FIXTURES;
    const text = readFileSync(join(dir, `${name}.json`), 'utf8');
    this.fixtures.set(name, text);
    return text;
  }

  async start(): Promise<URL> {
    const server = createServer((req, res) => {
      // A client that vanishes mid-request makes the body iterator in handle()
      // reject. Unhandled, that rejection kills the worker rather than failing
      // anything, which is exactly the fault this venue is built to simulate —
      // so it must be caught here.
      this.handle(req, res).catch(() => { req.socket.destroy(); });
    });
    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => { this.sockets.delete(socket); });
    });
    // An aborted request emits 'error' on the request stream; unhandled, an
    // 'error' event throws.
    server.on('clientError', (_err, socket) => { socket.destroy(); });
    this.server = server;
    await new Promise<void>((resolve) => { server.listen(this.options.port ?? 0, '127.0.0.1', resolve); });
    const { port } = server.address() as AddressInfo;
    this.base = new URL(`http://127.0.0.1:${port}`);
    return this.base;
  }

  /** The base URL to point the adapter at. The only change a test should need. */
  get baseUrl(): URL {
    if (this.base === undefined) throw new Error('FakeVenue.start() has not been called');
    return this.base;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (server === undefined) return;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }

  injectFault(fault: Fault): void {
    this.faults.push({ ...fault, remaining: fault.times ?? 1 });
  }

  clearFaults(): void { this.faults.length = 0; }

  reset(): void {
    this.clearFaults();
    this.requests.length = 0;
    this.served = 0;
  }

  /** The orders currently held by the fake, for test assertions. */
  ordersSnapshot(): ReadonlyArray<Record<string, unknown>> {
    return [...this.orders.values()];
  }

  /**
   * Drive a stored order to a new venue state — the fill-capable control. A test
   * settles an order to `filled` (or `partially_filled`) after create, and the
   * next status/active_orders read observes it. That is the whole trigger a
   * fan-out needs to auto-complete (T09.7). The state is stored verbatim, like
   * the real venue's; the reconciler maps it, so this accepts any literal a test
   * wants to simulate.
   */
  settleOrder(clientOrderId: string, nextState: string): void {
    const order = this.orders.get(clientOrderId);
    if (order === undefined) throw new Error(`settleOrder: no stored order with client_order_id ${clientOrderId}`);
    order['status'] = nextState;
  }

  /**
   * Set an account's free (`balance`) and `locked_balance` for one currency. The
   * venue numbers are major units, exactly as `users/balances` returns them.
   */
  setBalance(currency: string, balance: number, lockedBalance: number): void {
    const row = this.balanceRows.find((r) => r.currency === currency);
    if (row !== undefined) {
      row.balance = balance;
      row.locked_balance = lockedBalance;
    } else {
      this.balanceRows.push({ currency, balance, locked_balance: lockedBalance });
    }
  }

  /**
   * Phase-15 futures control: create or update a synthetic position. The venue
   * gives every position a stable uuid; here we return it so a test can drive
   * further reads or an exit against it. A subsequent call with the same
   * (pair, marginCurrency) updates the existing row (venue behaviour: one
   * position per pair per margin currency per account, research/04 F2).
   */
  settleFuturesPosition(opts: {
    readonly pair: string;
    readonly marginCurrency: 'INR' | 'USDT';
    /** Signed base quantity: positive long, negative short, zero closed. */
    readonly activePos: string;
    readonly avgEntryPrice?: string | undefined;
    readonly markPrice?: string | undefined;
    readonly leverage?: string | undefined;
    readonly liquidationPrice?: string | undefined;
    readonly stopLossTrigger?: string | null | undefined;
    readonly takeProfitTrigger?: string | null | undefined;
    readonly marginType?: 'isolated' | 'crossed' | undefined;
  }): string {
    const key = `${opts.pair}|${opts.marginCurrency}`;
    let existing: Record<string, unknown> | undefined;
    for (const p of this.futuresPositions.values()) {
      if (p['pair'] === opts.pair && p['margin_currency_short_name'] === opts.marginCurrency) {
        existing = p; break;
      }
    }
    if (existing === undefined) {
      this.futuresPositionSeq += 1;
      const id = `pos-${this.futuresPositionSeq}`;
      existing = {
        id, pair: opts.pair, margin_currency_short_name: opts.marginCurrency,
        active_pos: opts.activePos, avg_price: opts.avgEntryPrice ?? null,
        mark_price: opts.markPrice ?? null,
        liquidation_price: opts.liquidationPrice ?? null,
        leverage: opts.leverage ?? this.futuresLeverage.get(key) ?? null,
        locked_margin: '0', locked_user_margin: '0', locked_order_margin: '0',
        maintenance_margin: '0',
        take_profit_trigger: opts.takeProfitTrigger ?? null,
        stop_loss_trigger: opts.stopLossTrigger ?? null,
        margin_type: opts.marginType ?? 'isolated',
        updated_at: new Date().toISOString(),
      };
      this.futuresPositions.set(id, existing);
    } else {
      if (opts.activePos !== undefined) existing['active_pos'] = opts.activePos;
      if (opts.avgEntryPrice !== undefined) existing['avg_price'] = opts.avgEntryPrice;
      if (opts.markPrice !== undefined) existing['mark_price'] = opts.markPrice;
      if (opts.liquidationPrice !== undefined) existing['liquidation_price'] = opts.liquidationPrice;
      if (opts.leverage !== undefined) existing['leverage'] = opts.leverage;
      if (opts.stopLossTrigger !== undefined) existing['stop_loss_trigger'] = opts.stopLossTrigger;
      if (opts.takeProfitTrigger !== undefined) existing['take_profit_trigger'] = opts.takeProfitTrigger;
      if (opts.marginType !== undefined) existing['margin_type'] = opts.marginType;
      existing['updated_at'] = new Date().toISOString();
    }
    return String(existing['id']);
  }

  /** Update just the mark price on an existing position — the socket-arrives tick. */
  /**
   * Move a futures order to a new venue status, by the id the venue assigned on
   * create. Phase-15 control: the counterpart of `settleOrder` for futures.
   *
   * It exists because a freshly created futures order reports `initial`, which is
   * in NEITHER of the documented List Orders status sets (research/03 F6) — so an
   * L4 read-back genuinely cannot see an order until the venue has moved it on.
   * That is the real behaviour, and a test of the read-back has to be able to
   * reproduce both halves of it.
   */
  settleFuturesOrder(venueOrderId: string, nextState: string): void {
    const order = this.futuresOrders.get(venueOrderId);
    if (order === undefined) return;
    order['status'] = nextState;
  }

  /** Read one futures order back, for assertions. */
  futuresOrderSnapshot(venueOrderId: string): Record<string, unknown> | undefined {
    return this.futuresOrders.get(venueOrderId);
  }

  /** Replace what the instrument endpoint reports for one (pair, margin). */
  setFuturesInstrument(pair: string, marginCurrency: string, instrument: Record<string, unknown>): void {
    this.futuresInstruments.set(`${pair}|${marginCurrency}`, instrument);
  }

  /** Set the synthetic fill price a market order will be filled at. */
  setFuturesLtp(pair: string, price: string): void {
    this.futuresLtp.set(pair, price);
  }

  setFuturesMark(positionId: string, markPrice: string): void {
    const pos = this.futuresPositions.get(positionId);
    if (pos === undefined) throw new Error(`setFuturesMark: no position ${positionId}`);
    pos['mark_price'] = markPrice;
    pos['updated_at'] = new Date().toISOString();
  }

  /** Current futures orders (test assertion surface). */
  futuresOrdersSnapshot(): ReadonlyArray<Record<string, unknown>> {
    return [...this.futuresOrders.values()];
  }

  private takeFault(path: string): Fault | undefined {
    for (let i = 0; i < this.faults.length; i += 1) {
      const f = this.faults[i];
      if (f === undefined) continue;
      if (f.path !== undefined && !path.includes(f.path)) continue;
      f.remaining -= 1;
      if (f.remaining <= 0) this.faults.splice(i, 1);
      return f;
    }
    return undefined;
  }

  private rateHeaders(): Record<string, string> {
    const rl = this.options.rateLimit;
    if (rl === undefined) return {};
    const remaining = Math.max(0, rl.limit - this.served);
    return {
      'ratelimit-policy': `${rl.limit};w=${rl.windowSeconds}`,
      ratelimit: `limit=${rl.limit}, remaining=${remaining}, reset=${rl.windowSeconds}`,
      // Every route but /exchange/ticker returned DYNAMIC live (01 F2).
      'cf-cache-status': 'DYNAMIC',
    };
  }

  /**
   * Recompute the HMAC over the exact bytes received.
   *
   * Returns null when no auth headers were sent at all, which the real venue
   * answers with "Invalid credentials" rather than "Invalid signature" — two
   * different 401s that must not be conflated, because one means "bad key" and
   * the other means "your signing is broken" (12 F7).
   */
  private verify(req: IncomingMessage, body: string): { apiKey: string | null; valid: boolean | null } {
    const apiKeyHeader = req.headers[AUTH_KEY_HEADER.toLowerCase()];
    const signatureHeader = req.headers[AUTH_SIGNATURE_HEADER.toLowerCase()];
    const apiKey = typeof apiKeyHeader === 'string' ? apiKeyHeader : null;
    const signature = typeof signatureHeader === 'string' ? signatureHeader : null;
    if (apiKey === null || signature === null) return { apiKey, valid: null };
    const secret = this.options.credentials?.[apiKey];
    if (secret === undefined) return { apiKey, valid: false };
    const expected = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    return { apiKey, valid: equalHex(expected, signature) };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body = '';
    for await (const chunk of req) body += (chunk as Buffer).toString('utf8');

    const path = req.url ?? '/';
    const { apiKey, valid } = this.verify(req, body);
    this.requests.push({
      method: req.method ?? 'GET', path, body, apiKey, signatureValid: valid, atMs: Date.now(),
    });
    this.served += 1;

    const fault = this.takeFault(path);
    if (fault !== undefined) {
      if (fault.acceptThenDrop === true) {
        // The create handler runs (storing the order) but its response is dropped.
        this.dropCreate = true;
      } else if (fault.blackhole === true) {
        return; // only the client's deadline ends this
      } else if (fault.hangUp === true) {
        req.socket.destroy(); return;
      } else {
        if (fault.delayMs !== undefined && fault.delayMs > 0) {
          await new Promise<void>((r) => { setTimeout(r, fault.delayMs); });
        }
        if (fault.status !== undefined || fault.body !== undefined) {
          this.send(res, fault.status ?? 500, fault.body ?? '{"message":"injected fault"}', fault.headers);
          return;
        }
      }
    }

    this.route(req, res, path, body, apiKey, valid);
  }

  private send(
    res: ServerResponse,
    status: number,
    body: string,
    extra: Readonly<Record<string, string>> = {},
  ): void {
    // The client may have gone (a deadline fired, an agent was destroyed).
    // Writing to a dead response throws asynchronously.
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...this.rateHeaders(),
      ...extra,
    });
    res.end(body);
  }

  private route(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    body: string,
    apiKey: string | null,
    valid: boolean | null,
  ): void {
    const [route = '/', query = ''] = path.split('?');
    const params = new URLSearchParams(query);

    // ---- public: captured fixtures, served byte-for-byte ----
    if (route === '/exchange/v1/markets_details') { this.send(res, 200, this.fixture('markets_details')); return; }
    if (route === '/exchange/ticker') {
      // The one route that came back cached live, so the counters are not ours.
      this.send(res, 200, this.fixture('ticker'), { 'cf-cache-status': 'HIT' });
      return;
    }
    if (route === '/market_data/orderbook') {
      const pair = params.get('pair') ?? '';
      if (pair === '') { this.send(res, 400, '{"code":400,"message":"Invalid Request.","status":"error"}'); return; }
      const name = pair.endsWith('_INR') ? 'orderbook_btcinr' : 'orderbook_btcusdt';
      this.send(res, 200, this.fixture(name));
      return;
    }
    if (route === '/market_data/trade_history') { this.send(res, 200, this.fixture('trade_history')); return; }
    if (route === '/market_data/candlesticks') { this.send(res, 200, this.fixture('candlesticks')); return; }

    // ---- public: the futures instrument catalogue ----
    // A PUBLIC GET, so it must be handled before the POST-only guard over
    // /exchange/v1/ below. Modelling it matters more than it looks: without it no
    // caller can learn a pair's quantity step, and the sandbox would silently
    // accept a quantity the real venue would reject — or, worse, accept one that
    // is fine here and flips a position there.
    if (route === '/exchange/v1/derivatives/futures/data/instrument') {
      const params = new URLSearchParams(query);
      const pair = params.get('pair') ?? '';
      const margin = params.get('margin_currency_short_name') ?? 'USDT';
      if (pair === '') {
        this.send(res, 400, '{"code":400,"message":"pair is required","status":"error"}');
        return;
      }
      const override = this.futuresInstruments.get(`${pair}|${margin}`);
      this.send(res, 200, JSON.stringify(override ?? {
        pair,
        margin_currency_short_name: margin,
        underlying_currency_short_name: pair.split('-')[1]?.split('_')[0] ?? 'BTC',
        quote_currency_short_name: margin === 'INR' ? 'INR' : 'USDT',
        contract_size: '1',
        price_increment: '0.5',
        // Deliberately NOT a round number: a step of 0.00001 is what makes the
        // difference between rounding down and rounding up observable, and an
        // instrument whose step divides every test quantity evenly would hide it.
        quantity_increment: '0.00001',
        min_quantity: '0.00001',
        max_quantity: '9500',
        min_notional: '100',
        max_market_order_quantity: '9500',
        maker_fee: '0.0002',
        taker_fee: '0.0005',
        funding_frequency_hours: 8,
        exit_only: false,
      }));
      return;
    }

    // ---- authenticated ----
    if (route.startsWith('/exchange/v1/')) {
      if (req.method !== 'POST' && !(req.method === 'GET' && route.includes('wallets'))) {
        this.send(res, 404, '{"code":404,"message":"Not Found","status":"error"}');
        return;
      }
      if (valid === null) { this.send(res, 401, INVALID_CREDENTIALS); return; }
      if (!valid) { this.send(res, 401, INVALID_SIGNATURE); return; }
      // The real venue carried NO rate-limit headers on an authenticated
      // response we have seen (only a 401), so E3 stays open and the adapter
      // must keep working when they are absent.
      if (route === '/exchange/v1/derivatives/futures/wallets' && req.method === 'GET') {
        // map our synthetic balances to the futures wallet response format
        const futuresWallets = this.balanceRows.map(r => ({
          id: 'uuid',
          currency_short_name: r.currency,
          balance: String(r.balance),
          locked_balance: String(r.locked_balance ?? 0),
          cross_order_margin: '0.0',
          cross_user_margin: '0.0'
        }));
        this.send(res, 200, JSON.stringify(futuresWallets));
        return;
      }
      if (route === '/exchange/v1/users/balances' && req.method === 'POST') {
        this.send(res, 200, JSON.stringify(this.balanceRows));
        return;
      }

      if (route === '/exchange/v1/orders/create') {
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        const coid = parsed?.['client_order_id'];
        if (typeof coid !== 'string' || coid === '') {
          this.send(res, 400, '{"code":400,"message":"client_order_id is required","status":"error"}');
          return;
        }
        if (this.orders.has(coid)) {
          // The real duplicate-client-order-id rejection — the idempotency backstop.
          this.send(res, 400, '{"code":400,"message":"duplicate client_order_id","status":"error"}');
          return;
        }
        this.orderSeq += 1;
        const order: Record<string, unknown> = {
          id: String(this.orderSeq),
          client_order_id: coid,
          status: 'open',
          ...(parsed ?? {}),
        };
        this.orders.set(coid, order);
        if (this.dropCreate) {
          this.dropCreate = false;
          req.socket.destroy(); // the order is stored; the client never hears
          return;
        }
        this.send(res, 200, JSON.stringify({ id: order['id'], client_order_id: coid, status: order['status'] }));
        return;
      }

      if (route === '/exchange/v1/orders/status') {
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        const coid = parsed?.['client_order_id'];
        const order = typeof coid === 'string' ? this.orders.get(coid) : undefined;
        if (order === undefined) { this.send(res, 200, '{}'); return; }
        this.send(res, 200, JSON.stringify(order));
        return;
      }

      if (route === '/exchange/v1/orders/active_orders') {
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        const market = parsed?.['market'];
        if (typeof market !== 'string' || market === '') {
          this.send(res, 400, '{"code":400,"message":"market is required","status":"error"}');
          return;
        }
        // The venue's active set is exactly the states that can still trade. A
        // settled or cancelled order has left it and must not reappear here, or
        // Loop B would report a phantom.
        const active = ['open', 'acked', 'partially_filled'];
        const orders = [...this.orders.values()].filter(
          (o) => o['market'] === market && typeof o['status'] === 'string' && active.includes(o['status'] as string),
        );
        this.send(res, 200, JSON.stringify({ orders }));
        return;
      }

      if (route === '/exchange/v1/orders/cancel') {
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        const coid = parsed?.['client_order_id'];
        const byId = parsed?.['id'];
        let order: Record<string, unknown> | undefined;
        if (typeof coid === 'string' && coid !== '') {
          order = this.orders.get(coid);
        } else if (typeof byId === 'string' || typeof byId === 'number') {
          const want = String(byId);
          order = [...this.orders.values()].find((o) => String(o['id']) === want);
        }
        if (order === undefined) {
          // The venue does not know this order — a fill-and-purge or a bad id.
          // Distinguishable from a refusal so Loop B can tell "gone" from "stuck".
          this.send(res, 404, '{"code":404,"message":"Order not found","status":"error"}');
          return;
        }
        const status = typeof order['status'] === 'string' ? order['status'] : '';
        // The FAQ is explicit: a filled/cancelled/rejected order cannot be
        // cancelled, only one in open or partially_filled. The literal body maps
        // through classify() to `order_not_cancellable`.
        const cancellable = status === 'open' || status === 'partially_filled';
        if (!cancellable) {
          this.send(res, 400, '{"code":400,"message":"This order cannot be cancelled","status":"error"}');
          return;
        }
        order['status'] = 'cancelled';
        this.send(res, 200, '{"message":"success","status":"success","code":200}');
        return;
      }

      // ---------- phase-15 futures endpoints ----------
      // The venue has NO client_order_id on futures (research/03 Verdict). Orders
      // are keyed by the venue's own id; the anti-duplicate spine (per-pair lock
      // + read-back via listRecentOrders) lives ABOVE this adapter, not in it.
      if (route === '/exchange/v1/derivatives/futures/orders/create') {
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        if (parsed === null) {
          this.send(res, 400, '{"code":400,"message":"Invalid Request.","status":"error"}');
          return;
        }
        // Venue rule (research/03 F4): a signed body older than 10 s is rejected
        // outright. This is the failure the adapter's own deadline exists to
        // prevent — but the venue enforces it too, so a test can exercise it.
        const ts = Number(parsed['timestamp'] ?? 0);
        if (Number.isFinite(ts) && ts > 0 && Date.now() - ts > 10_000) {
          this.send(res, 400, '{"code":400,"message":"Orders with a delay of more than 10 seconds will be rejected","status":"error"}');
          return;
        }
        const orderObj = (parsed['order'] !== null && typeof parsed['order'] === 'object' && !Array.isArray(parsed['order']))
          ? (parsed['order'] as Record<string, unknown>)
          : parsed;
        const pair = typeof orderObj['pair'] === 'string' ? orderObj['pair'] as string : '';
        const side = typeof orderObj['side'] === 'string' ? orderObj['side'] as string : '';
        const orderTypeRaw = typeof orderObj['order_type'] === 'string' ? orderObj['order_type'] as string : '';
        const orderType = (orderTypeRaw === 'market_order' || orderTypeRaw === 'market')
          ? 'market'
          : (orderTypeRaw === 'limit_order' || orderTypeRaw === 'limit')
            ? 'limit'
            : orderTypeRaw;
        const marginCurrency = typeof orderObj['margin_currency_short_name'] === 'string'
          ? orderObj['margin_currency_short_name'] as string : 'USDT';
        if (pair === '' || side === '' || orderType === '') {
          this.send(res, 400, '{"code":400,"message":"pair, side and order_type are required","status":"error"}');
          return;
        }
        this.futuresOrderSeq += 1;
        const orderId = `ford-${this.futuresOrderSeq}`;
        const order: Record<string, unknown> = {
          id: orderId,
          pair, side, order_type: orderTypeRaw,
          margin_currency_short_name: marginCurrency,
          total_quantity: orderObj['total_quantity'] ?? null,
          price: orderObj['price'] ?? null,
          stop_price: orderObj['stop_price'] ?? null,
          leverage: orderObj['leverage'] ?? null,
          position_margin_type: orderObj['position_margin_type'] ?? 'isolated',
          reduce_only: orderObj['reduce_only'] ?? false,
          // Documented as meaningless on create (research/03 G6): "'initial' for
          // all newly placed orders … Ignore this". Kept for wire-shape fidelity.
          status: 'initial',
          created_at: new Date().toISOString(),
        };
        this.futuresOrders.set(orderId, order);

        // A MARKET order fills immediately, and a fill on a futures market opens
        // or extends a POSITION (research/04 F2: one position per pair per margin
        // currency). Modelled here because a venue that accepts an order and
        // creates no position makes the whole Positions surface — reader, mirror,
        // page — impossible to exercise end to end.
        if (orderType === 'market') {
          order['status'] = 'filled';
          const qty = Number(orderObj['total_quantity'] ?? 0);
          const signed = side === 'sell' ? -qty : qty;
          const prior = [...this.futuresPositions.values()]
            .find((p) => p['pair'] === pair && p['margin_currency_short_name'] === marginCurrency);
          const before = prior === undefined ? 0 : Number(prior['active_pos'] ?? 0);
          // A test double may do float arithmetic; the venue would not. Rounded to
          // the quantity precision these fixtures use so it reads as a real number.
          const next = (before + signed).toFixed(10).replace(/\.?0+$/, '');
          const price = this.futuresLtp.get(pair) ?? '8500000';
          const lev = orderObj['leverage'];
          const marginType = orderObj['position_margin_type'];
          this.settleFuturesPosition({
            pair,
            marginCurrency: marginCurrency as 'INR' | 'USDT',
            activePos: next === '' || next === '-0' ? '0' : next,
            avgEntryPrice: price,
            markPrice: price,
            ...(typeof lev === 'number' ? { leverage: String(lev) } : {}),
            ...(marginType === 'isolated' || marginType === 'crossed' ? { marginType } : {}),
          });
        }

        this.send(res, 200, JSON.stringify([order]));
        return;
      }

      if (route === '/exchange/v1/derivatives/futures/orders') {
        // List Orders — the L4a read-back. All four of status, side, page and size
        // are mandatory on the real endpoint, and there is no "all" value, so the
        // caller must enumerate every status it cares about. This mirrors that:
        // a status the caller omits is genuinely invisible here too.
        let parsedList: Record<string, unknown> | null = null;
        try { parsedList = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        if (parsedList === null) {
          this.send(res, 400, '{"code":400,"message":"Invalid Request.","status":"error"}');
          return;
        }
        const wantPair = typeof parsedList['pair'] === 'string' ? parsedList['pair'] as string : '';
        const wantSide = typeof parsedList['side'] === 'string' ? parsedList['side'] as string : '';
        const rawStatus = typeof parsedList['status'] === 'string' ? parsedList['status'] as string : '';
        if (wantPair === '' || wantSide === '' || rawStatus === '') {
          this.send(res, 400, '{"code":400,"message":"pair, side and status are required","status":"error"}');
          return;
        }
        // `cancelled` (two L) in the request, `CANCELED` (one L) in the response —
        // both spellings must select the same orders. The optional `l` folds them
        // onto one form; case-folding alone would not.
        const norm = (s: string): string => s.trim().toLowerCase().replace(/cancell?ed/, 'cancelled');
        const wanted = new Set(rawStatus.split(',').map(norm).filter((s) => s !== ''));
        const page = Number(parsedList['page'] ?? 1);
        const size = Number(parsedList['size'] ?? 100);
        const all = [...this.futuresOrders.values()].filter((o) => {
          if (o['pair'] !== wantPair) return false;
          if (o['side'] !== wantSide) return false;
          return wanted.has(norm(typeof o['status'] === 'string' ? o['status'] as string : ''));
        });
        const start = Math.max(0, (Number.isFinite(page) && page > 0 ? page - 1 : 0) * (Number.isFinite(size) && size > 0 ? size : 100));
        const take = Number.isFinite(size) && size > 0 ? size : 100;
        this.send(res, 200, JSON.stringify({ data: all.slice(start, start + take) }));
        return;
      }

      if (route === '/exchange/v1/derivatives/futures/positions') {
        // Client passes `margin_currency_short_name` as an array (research/04 G8:
        // must always be sent, or INR rows are invisible). We accept the array
        // and return the intersecting positions; a test that omits it gets an
        // empty response by design.
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        const raw = parsed?.['margin_currency_short_name'];
        const requested = Array.isArray(raw)
          ? raw.filter((x) => x === 'INR' || x === 'USDT')
          : [];
        const out = [...this.futuresPositions.values()].filter((p) =>
          requested.includes(p['margin_currency_short_name'] as string),
        );
        this.send(res, 200, JSON.stringify(out));
        return;
      }

      if (route === '/exchange/v1/derivatives/futures/orders/cancel') {
        // Futures cancel is by venue order id — there is no client_order_id.
        // Not idempotent; the caller is responsible for not double-firing (the
        // per-(account, pair) lock in T15.4 covers this).
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        const id = parsed?.['id'];
        if (typeof id !== 'string' || id === '') {
          this.send(res, 400, '{"code":400,"message":"id is required","status":"error"}');
          return;
        }
        const order = this.futuresOrders.get(id);
        if (order === undefined) {
          this.send(res, 404, '{"code":404,"message":"Order not found","status":"error"}');
          return;
        }
        const status = typeof order['status'] === 'string' ? order['status'] as string : '';
        if (status !== 'open' && status !== 'untriggered' && status !== 'partially_filled') {
          this.send(res, 400, '{"code":400,"message":"This order cannot be cancelled","status":"error"}');
          return;
        }
        order['status'] = 'cancelled';
        // If it was a tpsl leg, clear the trigger on the parent position so a
        // repeat `create_tpsl` for the same leg is legal again (moving a TP is
        // cancel-then-create per research/04 F12).
        const positionId = typeof order['position_id'] === 'string' ? order['position_id'] as string : null;
        if (positionId !== null) {
          const position = this.futuresPositions.get(positionId);
          if (position !== undefined) {
            const orderType = typeof order['order_type'] === 'string' ? order['order_type'] as string : '';
            if (orderType.startsWith('stop_')) position['stop_loss_trigger'] = null;
            if (orderType.startsWith('take_profit_')) position['take_profit_trigger'] = null;
          }
        }
        this.send(res, 200, '{"message":"success","status":"success","code":200}');
        return;
      }

      if (route === '/exchange/v1/derivatives/futures/positions/exit') {
        // Close a position at market. NO idempotency key (research/04 F11): the
        // caller MUST protect against double-fire above this layer, else a second
        // call opens an opposite position. This fake mirrors that behaviour: a
        // second call on a zero position would reverse it. The test drives the
        // safe sequence and asserts.
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        const id = typeof parsed?.['id'] === 'string' ? parsed['id'] as string : '';
        const position = this.futuresPositions.get(id);
        if (position === undefined) {
          this.send(res, 400, '{"code":400,"message":"position not found","status":"error"}');
          return;
        }
        position['active_pos'] = '0';
        position['avg_price'] = null;
        position['liquidation_price'] = null;
        position['locked_margin'] = '0';
        position['updated_at'] = new Date().toISOString();
        this.futuresPositionSeq += 1;
        const groupId = `exit-${this.futuresPositionSeq}`;
        this.send(res, 200, JSON.stringify({ message: 'success', status: 'success', code: 200, data: { group_id: groupId } }));
        return;
      }

      if (route === '/exchange/v1/derivatives/futures/positions/create_tpsl') {
        // Per-leg partial success at HTTP 200 (research/04 F12). SL and TP are
        // independent conditional orders; attaching one that already exists is
        // an error for that leg only. Not an upsert — moving a TP is a cancel
        // of the untriggered TP order followed by a fresh create_tpsl.
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        const positionId = typeof parsed?.['id'] === 'string' ? parsed['id'] as string : '';
        const position = this.futuresPositions.get(positionId);
        if (position === undefined) {
          this.send(res, 400, '{"code":400,"message":"position not found","status":"error"}');
          return;
        }
        const sl = parsed?.['stop_loss'] as Record<string, unknown> | undefined;
        const tp = parsed?.['take_profit'] as Record<string, unknown> | undefined;
        const outcome: Record<string, unknown> = {};

        const attach = (
          leg: Record<string, unknown> | undefined,
          existingTriggerKey: string,
          defaultOrderType: string,
        ): Record<string, unknown> | undefined => {
          if (leg === undefined) return undefined;
          if (position[existingTriggerKey] !== null && position[existingTriggerKey] !== undefined) {
            return { success: false, error: `${defaultOrderType} already exists` };
          }
          const triggerPrice = leg['stop_price'];
          if (typeof triggerPrice !== 'string' || triggerPrice === '') {
            return { success: false, error: 'stop_price is required' };
          }
          const orderType = typeof leg['order_type'] === 'string' ? leg['order_type'] as string : defaultOrderType;
          this.futuresOrderSeq += 1;
          const orderId = `ford-tpsl-${this.futuresOrderSeq}`;
          const order = {
            id: orderId, pair: position['pair'], order_type: orderType,
            stop_price: triggerPrice, status: 'untriggered',
            stage: 'tpsl_exit', position_id: positionId,
            created_at: new Date().toISOString(),
          };
          this.futuresOrders.set(orderId, order);
          position[existingTriggerKey] = triggerPrice;
          position['updated_at'] = new Date().toISOString();
          return order;
        };

        const slOut = attach(sl, 'stop_loss_trigger', 'stop_market');
        const tpOut = attach(tp, 'take_profit_trigger', 'take_profit_market');
        if (slOut !== undefined) outcome['stop_loss'] = slOut;
        if (tpOut !== undefined) outcome['take_profit'] = tpOut;
        this.send(res, 200, JSON.stringify(outcome));
        return;
      }

      if (route === '/exchange/v1/derivatives/futures/positions/update_leverage') {
        let parsed: Record<string, unknown> | null = null;
        try { parsed = JSON.parse(body) as Record<string, unknown>; } catch { /* handled below */ }
        const pair = typeof parsed?.['pair'] === 'string' ? parsed['pair'] as string : '';
        const marginCurrency = typeof parsed?.['margin_currency_short_name'] === 'string'
          ? parsed['margin_currency_short_name'] as string : 'USDT';
        const leverage = parsed?.['leverage'];
        if (pair === '' || (typeof leverage !== 'number' && typeof leverage !== 'string')) {
          this.send(res, 400, '{"code":400,"message":"pair and leverage are required","status":"error"}');
          return;
        }
        this.futuresLeverage.set(`${pair}|${marginCurrency}`, String(leverage));
        this.send(res, 200, '{"message":"success","status":"success","code":200}');
        return;
      }

      this.send(res, 404, `{"code":404,"message":"no fake route for ${route}","status":"error"}`);
      return;
    }

    void apiKey;
    void body;
    this.send(res, 404, `{"code":404,"message":"no fake route for ${route}","status":"error"}`);
  }
}
