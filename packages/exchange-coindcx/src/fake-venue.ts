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
// No order state. Placement returns 501 until Phase 06 adds fills,
// `client_order_id` uniqueness and the fault scenarios that need them.

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
  /** Every request, in order. The assertion surface for adapter tests. */
  readonly requests: RecordedRequest[] = [];

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
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
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
      if (fault.blackhole === true) return; // only the client's deadline ends this
      if (fault.hangUp === true) { req.socket.destroy(); return; }
      if (fault.delayMs !== undefined && fault.delayMs > 0) {
        await new Promise<void>((r) => { setTimeout(r, fault.delayMs); });
      }
      if (fault.status !== undefined || fault.body !== undefined) {
        this.send(res, fault.status ?? 500, fault.body ?? '{"message":"injected fault"}', fault.headers);
        return;
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

    // ---- authenticated ----
    if (route.startsWith('/exchange/v1/')) {
      if (req.method !== 'POST') {
        this.send(res, 404, '{"code":404,"message":"Not Found","status":"error"}');
        return;
      }
      if (valid === null) { this.send(res, 401, INVALID_CREDENTIALS); return; }
      if (!valid) { this.send(res, 401, INVALID_SIGNATURE); return; }
      // The real venue carried NO rate-limit headers on an authenticated
      // response we have seen (only a 401), so E3 stays open and the adapter
      // must keep working when they are absent.
      if (route === '/exchange/v1/users/balances') { this.send(res, 200, SYNTHETIC_BALANCES); return; }
      if (route === '/exchange/v1/orders/create' || route === '/exchange/v1/orders/cancel') {
        this.send(res, 501,
          '{"code":501,"message":"the fake venue has no order state until Phase 06","status":"error"}');
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
