// Keep-alive is asserted from the server's side of the socket as well as ours.
// Our own reuse counter could be wrong in the same direction as the code it is
// testing; the server's `connection` event count cannot be.
// Sources: 17 F1 (105 ms cold vs 38 ms warm), 08 F2 (the ambiguity split).

import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_SOCKETS_PER_ORIGIN, TransportError, agentFor, destroyAllAgents, originKey, send, toTransportKind,
} from './http.js';

interface Harness {
  readonly url: (path?: string) => URL;
  /** TCP connections the server accepted — the independent reuse measurement. */
  readonly connections: () => number;
  readonly bodies: string[];
  readonly close: () => Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const start = async (handler: Handler): Promise<Harness> => {
  let connections = 0;
  const bodies: string[] = [];
  const live = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    // An aborted request emits 'error' on the stream; unhandled, that throws and
    // kills the worker instead of failing a test. These tests abort on purpose.
    req.on('error', () => { /* the client went away; nothing to answer */ });
    res.on('error', () => { /* the socket died mid-write */ });
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => { bodies.push(body); handler(req, res); });
  });
  server.on('clientError', (_err, socket) => { socket.destroy(); });
  server.on('connection', (socket) => {
    connections += 1;
    live.add(socket);
    socket.once('close', () => { live.delete(socket); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: (path = '/') => new URL(`http://127.0.0.1:${port}${path}`),
    connections: () => connections,
    bodies,
    close: async () => {
      destroyAllAgents();
      // A blackholed or keep-alive socket keeps server.close() pending forever.
      for (const socket of live) socket.destroy();
      live.clear();
      await new Promise<void>((r) => { server.close(() => r()); });
    },
  };
};

const ok: Handler = (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":1}'); };

afterEach(() => { destroyAllAgents(); });

describe('the connection is reused, measured from both ends', () => {
  it('serves five sequential requests over one TCP connection', async () => {
    const h = await start(ok);
    try {
      const results = [];
      for (let i = 0; i < 5; i += 1) results.push(await send({ method: 'GET', url: h.url('/markets') }));

      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      // Request 1 opened the connection; 2-5 must not have opened another.
      expect(results.map((r) => r.timing.reusedConnection)).toEqual([false, true, true, true, true]);
      expect(new Set(results.map((r) => r.timing.socketId)).size).toBe(1);
      // The claim that matters, from the server's point of view.
      expect(h.connections(), 'the server accepted more than one connection').toBe(1);
    } finally {
      await h.close();
    }
  });

  it('opens a second connection only when the first is still busy', async () => {
    // Two overlapping requests cannot share a socket, so this must be 2 — which
    // also proves the previous test measured reuse and not a stuck counter.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const h = await start((_req, res) => { void gate.then(() => { res.writeHead(200); res.end('{}'); }); });
    try {
      const both = Promise.all([send({ method: 'GET', url: h.url() }), send({ method: 'GET', url: h.url() })]);
      release?.();
      const results = await both;
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(h.connections()).toBe(2);
      expect(new Set(results.map((r) => r.timing.socketId)).size).toBe(2);
    } finally {
      await h.close();
    }
  });

  it('reports timing for every request, cold and warm', async () => {
    // Deliberately NOT asserting that warm is faster than cold. On loopback the
    // handshake costs microseconds, so both numbers are dominated by event-loop
    // scheduling and the direction is not guaranteed — asserting it measures the
    // machine, not the pool, and it flakes when the suite runs 15 files at once.
    // The magnitude claim belongs where the handshake is real: checks/01-keepalive
    // measured cold 129.6 ms against warm median 46.8 ms on the live venue.
    const h = await start(ok);
    try {
      const cold = await send({ method: 'GET', url: h.url() });
      const warm = [];
      for (let i = 0; i < 4; i += 1) warm.push(await send({ method: 'GET', url: h.url() }));

      expect(cold.timing.ttfbMs).toBeGreaterThan(0);
      expect(cold.timing.elapsedMs).toBeGreaterThanOrEqual(cold.timing.ttfbMs);
      for (const w of warm) {
        expect(w.timing.ttfbMs).toBeGreaterThan(0);
        expect(w.timing.elapsedMs).toBeGreaterThanOrEqual(w.timing.ttfbMs);
        expect(w.timing.reusedConnection).toBe(true);
      }
      expect(h.connections()).toBe(1);
    } finally {
      await h.close();
    }
  });
});

describe('one agent per origin, shared process-wide', () => {
  it('returns the same agent for the same origin and a different one for another', () => {
    const a = agentFor(new URL('https://api.coindcx.com/exchange/v1/markets'));
    const b = agentFor(new URL('https://api.coindcx.com/exchange/v1/orders'));
    const c = agentFor(new URL('https://public.coindcx.com/market_data/trade_history'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('keys on protocol and host only', () => {
    expect(originKey(new URL('https://api.coindcx.com/a?b=c'))).toBe('https://api.coindcx.com');
    expect(originKey(new URL('http://127.0.0.1:8080/x'))).toBe('http://127.0.0.1:8080');
  });

  it('configures keep-alive rather than leaving it to the default', () => {
    const agent = agentFor(new URL('https://api.coindcx.com/x')) as unknown as {
      keepAlive: boolean; maxSockets: number; options: { keepAliveMsecs?: number; scheduling?: string };
    };
    expect(agent.keepAlive).toBe(true);
    expect(agent.maxSockets).toBe(MAX_SOCKETS_PER_ORIGIN);
    expect(agent.options.scheduling).toBe('lifo');
    expect(agent.options.keepAliveMsecs).toBe(30_000);
  });
});

describe('the bytes sent are the bytes given', () => {
  it('writes the body verbatim and does not re-serialise it', async () => {
    // T01.2's guarantee only holds if the transport treats the signed string as
    // opaque. A body of "{\"b\":1,\"a\":2}" must arrive with that key order.
    const h = await start(ok);
    try {
      const body = '{"b":1,"a":2,"q":"0.00000001","timestamp":1757000000000}';
      await send({ method: 'POST', url: h.url('/orders/create'), body, headers: { 'Content-Type': 'application/json' } });
      expect(h.bodies[0]).toBe(body);
    } finally {
      await h.close();
    }
  });

  it('sets Content-Length from the byte length, not the character count', async () => {
    const h = await start((req, res) => { res.writeHead(200); res.end(String(req.headers['content-length'])); });
    try {
      const body = '{"note":"₹100"}'; // the rupee sign is three UTF-8 bytes
      const r = await send({ method: 'POST', url: h.url(), body });
      expect(r.body).toBe(String(Buffer.byteLength(body, 'utf8')));
      expect(Number(r.body)).toBeGreaterThan(body.length);
    } finally {
      await h.close();
    }
  });
});

describe('a rejection is a result, not an exception', () => {
  it('returns 4xx with its body so the reason can be classified', async () => {
    const h = await start((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"code":400,"message":"Insufficient funds"}');
    });
    try {
      const r = await send({ method: 'POST', url: h.url('/orders/create'), body: '{}' });
      expect(r.status).toBe(400);
      expect(r.body).toContain('Insufficient funds');
      expect(r.headers['content-type']).toContain('application/json');
    } finally {
      await h.close();
    }
  });
});

describe('a transport failure says whether the request could have been sent', () => {
  it('maps a refused connection to never-sent', async () => {
    // Port 1 on loopback: nothing listens, so the connection is refused before a
    // single request byte exists. Reporting this as ambiguous would send every
    // such failure through the resolve ladder for no information.
    const err = await send({ method: 'POST', url: new URL('http://127.0.0.1:1/orders'), body: '{}' })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).kind).toBe('connect');
    expect((err as TransportError).mayHaveSent).toBe(false);
  });

  it('maps an unresolvable host to dns, also never-sent', async () => {
    const url = new URL('http://tradex-nonexistent-host.invalid/x');
    const err = await send({ method: 'GET', url }).then(() => null, (e: unknown) => e);
    expect((err as TransportError).kind).toBe('dns');
    expect((err as TransportError).mayHaveSent).toBe(false);
  });

  it('treats a deadline on an accepted connection as ambiguous', async () => {
    // The server accepted and read the request, then went silent. The order may
    // exist. This is the case that must never be retried blindly.
    const h = await start(() => { /* never responds */ });
    try {
      const err = await send({ method: 'POST', url: h.url('/orders'), body: '{}', deadlineMs: 120 })
        .then(() => null, (e: unknown) => e);
      expect((err as TransportError).kind).toBe('timeout');
      expect((err as TransportError).mayHaveSent).toBe(true);
      expect((err as Error).message).toMatch(/deadline of 120ms/);
    } finally {
      await h.close();
    }
  });

  it('treats a socket dropped mid-response as ambiguous', async () => {
    const h = await start((_req, res) => { res.writeHead(200, { 'Content-Length': '99' }); res.socket?.destroy(); });
    try {
      const err = await send({ method: 'POST', url: h.url('/orders'), body: '{}' })
        .then(() => null, (e: unknown) => e);
      expect((err as TransportError).mayHaveSent).toBe(true);
      expect(['reset', 'timeout']).toContain((err as TransportError).kind);
    } finally {
      await h.close();
    }
  });
});

describe('the error-code table, directly', () => {
  const never: ReadonlyArray<readonly [string, string]> = [
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNREFUSED', 'connect'],
    ['EHOSTUNREACH', 'connect'],
    ['ENETUNREACH', 'connect'],
    ['ERR_SOCKET_CONNECTION_TIMEOUT', 'connect'],
    // A certificate failure happens during the handshake, before the request
    // exists. If this were ambiguous, a pinning mistake would look like 20
    // possibly-placed orders instead of 20 definitely-refused connections.
    ['CERT_HAS_EXPIRED', 'connect'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'connect'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'connect'],
  ];

  it.each(never)('%s is never-sent even if the socket had connected', (code, kind) => {
    for (const connected of [true, false]) {
      const got = toTransportKind(Object.assign(new Error('x'), { code }), connected);
      expect(got, `${code} connected=${connected}`).toEqual({ kind, mayHaveSent: false });
    }
  });

  it.each([['ECONNRESET', 'reset'], ['EPIPE', 'reset'], ['ETIMEDOUT', 'timeout']] as const)(
    '%s after connect is ambiguous',
    (code, kind) => {
      expect(toTransportKind(Object.assign(new Error('x'), { code }), true)).toEqual({ kind, mayHaveSent: true });
    },
  );

  it('treats the same reset before connect as never-sent', () => {
    // ECONNRESET during the handshake and ECONNRESET mid-request are the same
    // code and opposite facts. `connected` is the only thing that tells them apart.
    expect(toTransportKind(Object.assign(new Error('x'), { code: 'ECONNRESET' }), false))
      .toEqual({ kind: 'connect', mayHaveSent: false });
  });

  it('defaults an unrecognised post-connect error to ambiguous, never to safe', () => {
    expect(toTransportKind(new Error('something new'), true)).toEqual({ kind: 'reset', mayHaveSent: true });
    expect(toTransportKind(null, true)).toEqual({ kind: 'reset', mayHaveSent: true });
  });
});
