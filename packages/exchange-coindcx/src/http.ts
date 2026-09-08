// Pooled HTTP transport — plan/phase-01 T01.3.
//
// One keep-alive agent per origin, and nothing in this package opens a socket
// any other way. Measured in `17` F1: a cold request to api.coindcx.com costs
// ~105 ms to first byte, a warm one ~38 ms. A group trade across 20 accounts is
// 20 sequential authenticated calls, so cold connections cost roughly 1.3 s of
// extra wall clock per leg — time during which the price moves and the whole
// fan-out drifts apart.
//
// The correctness argument is the stronger one. Every fresh connection is a new
// opportunity for an ambiguous failure, and an ambiguous failure on a *write*
// costs a resolve round trip at best and a duplicate position at worst. Fewer
// handshakes is fewer chances to be uncertain.
//
// This layer deliberately does not retry, queue, or rate-limit. Retrying needs
// the failure classification (T01.7) plus idempotency (Phase 06); rate limiting
// is T01.6. A transport that silently retries is a transport that can duplicate
// an order, so it declines to make that decision.

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';

/** Well under any plausible server idle timeout, so we close before they do. */
export const KEEP_ALIVE_MSECS = 30_000;
/** Per origin. The rate limit binds long before this does (T01.5, T01.6). */
export const MAX_SOCKETS_PER_ORIGIN = 8;
/** Whole-request deadline. A hung read must not hold a fan-out slot open. */
export const DEFAULT_DEADLINE_MS = 15_000;
/** markets_details is ~554 KB; this is headroom, not a target. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Transport failure kinds, in the vocabulary `packages/exchange` classifies.
 * `dns` and `connect` mean provably nothing was sent; `timeout` and `reset`
 * mean the request may have been written and the outcome is unknown.
 */
export type TransportKind = 'timeout' | 'reset' | 'dns' | 'connect';

export class TransportError extends Error {
  override readonly name = 'TransportError';
  readonly kind: TransportKind;
  /** True when request bytes may already have reached the venue. */
  readonly mayHaveSent: boolean;

  constructor(message: string, kind: TransportKind, mayHaveSent: boolean, cause?: unknown) {
    super(message, { cause });
    this.kind = kind;
    this.mayHaveSent = mayHaveSent;
  }
}

/**
 * Error codes that prove the failure happened before any request byte was
 * written. DNS resolution, TCP connect and the TLS handshake all complete first,
 * so a failure in any of them cannot have created an order — including a
 * certificate failure, which must not be allowed to trigger a resolve ladder.
 */
const NEVER_SENT_CODES: Readonly<Record<string, TransportKind>> = {
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  ECONNREFUSED: 'connect',
  EHOSTUNREACH: 'connect',
  ENETUNREACH: 'connect',
  EADDRNOTAVAIL: 'connect',
  ERR_SOCKET_CONNECTION_TIMEOUT: 'connect',
  ERR_TLS_CERT_ALTNAME_INVALID: 'connect',
  CERT_HAS_EXPIRED: 'connect',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'connect',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'connect',
  SELF_SIGNED_CERT_IN_CHAIN: 'connect',
};

const AFTER_CONNECT_CODES: Readonly<Record<string, TransportKind>> = {
  ECONNRESET: 'reset',
  ECONNABORTED: 'reset',
  EPIPE: 'reset',
  ETIMEDOUT: 'timeout',
  ESOCKETTIMEDOUT: 'timeout',
};

const codeOf = (err: unknown): string => {
  const c = (err as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : '';
};

/**
 * Map a Node error to a transport kind. `connected` is the fact that decides the
 * ambiguous cases: the same ECONNRESET means "refused the handshake" before
 * connect and "dropped mid-request" after it, and only the second is in doubt.
 */
export function toTransportKind(err: unknown, connected: boolean): { kind: TransportKind; mayHaveSent: boolean } {
  const code = codeOf(err);
  const never = NEVER_SENT_CODES[code];
  if (never !== undefined) return { kind: never, mayHaveSent: false };
  if (!connected) return { kind: 'connect', mayHaveSent: false };
  const after = AFTER_CONNECT_CODES[code];
  return { kind: after ?? 'reset', mayHaveSent: true };
}

// --------------------------------------------------------------- agent pooling

type PoolAgent = HttpAgent | HttpsAgent;
const agents = new Map<string, PoolAgent>();

/** `https://api.coindcx.com` — protocol and host, never the path. */
export const originKey = (url: URL): string => `${url.protocol}//${url.host}`;

/**
 * The one agent for an origin. Shared process-wide on purpose: two callers with
 * separate agents would each keep their own pool warm and neither would reuse
 * the other's socket, which is how "we enabled keep-alive" quietly becomes
 * "we enabled keep-alive twice and reuse nothing".
 */
export function agentFor(url: URL): PoolAgent {
  const key = originKey(url);
  const existing = agents.get(key);
  if (existing !== undefined) return existing;
  const opts = {
    keepAlive: true,
    keepAliveMsecs: KEEP_ALIVE_MSECS,
    maxSockets: MAX_SOCKETS_PER_ORIGIN,
    maxFreeSockets: MAX_SOCKETS_PER_ORIGIN,
    // LIFO returns the most recently used socket, keeping one connection hot.
    // FIFO round-robins the pool and walks every socket toward its idle timeout,
    // so a low-rate caller ends up handshaking about as often as with no pool.
    scheduling: 'lifo' as const,
  };
  const agent: PoolAgent = url.protocol === 'https:' ? new HttpsAgent(opts) : new HttpAgent(opts);
  agents.set(key, agent);
  return agent;
}

/** Close every pooled socket. For test teardown and shutdown, not for retries. */
export function destroyAllAgents(): void {
  for (const agent of agents.values()) agent.destroy();
  agents.clear();
}

// ------------------------------------------------------ per-socket bookkeeping

interface SocketInfo { readonly id: string; requests: number; }
const socketInfo = new WeakMap<Socket, SocketInfo>();
let socketSeq = 0;

/**
 * Reuse is measured by counting requests per socket, not by reading
 * `socket.connecting`. The counter answers the question the acceptance test
 * actually asks — "is request 4 on the same connection as request 1" — and it
 * keeps answering it when a request waits for a free socket rather than a new one.
 */
function markSocket(socket: Socket): { id: string; reused: boolean } {
  let info = socketInfo.get(socket);
  if (info === undefined) {
    socketSeq += 1;
    info = { id: `sock-${socketSeq}`, requests: 0 };
    socketInfo.set(socket, info);
  }
  const reused = info.requests > 0;
  info.requests += 1;
  return { id: info.id, reused };
}

// ------------------------------------------------------------------- the request

export interface Timing {
  /** True when this request travelled over an already-established connection. */
  readonly reusedConnection: boolean;
  /** Stable id for the socket, so a test can assert two requests shared one. */
  readonly socketId: string;
  /** Request start to response headers. The number `17` F1 measured. */
  readonly ttfbMs: number;
  /** Request start to last body byte. */
  readonly elapsedMs: number;
}

export interface HttpResult {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The raw response text. Parsing is the caller's business (D01). */
  readonly body: string;
  readonly timing: Timing;
}

export interface HttpRequestSpec {
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly url: URL;
  /** The exact bytes to send. For a signed request this is `SignedRequest.body`. */
  readonly body?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly deadlineMs?: number | undefined;
}

const flattenHeaders = (h: IncomingHttpHeaders): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
};

/**
 * Send one request over the pooled connection and read the whole response.
 *
 * A non-2xx status is returned, not thrown: the body carries the venue's reason
 * and `classify()` needs both. Only a transport failure throws, because there
 * is no response to hand back.
 */
export async function send(spec: HttpRequestSpec): Promise<HttpResult> {
  const { method, url } = spec;
  const deadline = spec.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const startedAt = performance.now();

  return await new Promise<HttpResult>((resolve, reject) => {
    let connected = false;
    let settled = false;
    let socketId = 'unassigned';
    let reusedConnection = false;
    let ttfbMs = 0;

    const headers: Record<string, string> = { ...spec.headers };
    if (spec.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(spec.body, 'utf8'));

    const req = requestFn({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port === '' ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      agent: agentFor(url),
    });

    const timer = setTimeout(() => {
      // A deadline is not the same thing as a socket inactivity timeout: a server
      // that dribbles one byte a second never trips inactivity but still holds a
      // fan-out slot open indefinitely.
      fail(new TransportError(
        `deadline of ${deadline}ms exceeded after ${Math.round(performance.now() - startedAt)}ms`,
        connected ? 'timeout' : 'connect',
        connected,
      ));
    }, deadline);

    const cleanup = (): void => { clearTimeout(timer); };

    const fail = (err: TransportError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      // Destroying a keep-alive socket on failure is deliberate: a socket whose
      // state we are unsure of must not be handed to the next request, where a
      // stale half-response would be read as that request's answer.
      req.destroy();
      reject(err);
    };

    const succeed = (result: HttpResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    req.on('socket', (socket: Socket) => {
      const marked = markSocket(socket);
      socketId = marked.id;
      reusedConnection = marked.reused;
      if (marked.reused) connected = true;
      socket.once('connect', () => { connected = true; });
      socket.once('secureConnect', () => { connected = true; });
    });

    req.on('error', (err) => {
      const { kind, mayHaveSent } = toTransportKind(err, connected);
      fail(new TransportError(`${method} ${url.pathname} failed: ${err.message}`, kind, mayHaveSent, err));
    });

    req.on('response', (res: IncomingMessage) => {
      ttfbMs = performance.now() - startedAt;
      res.setEncoding('utf8');
      let body = '';
      let bytes = 0;
      res.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > MAX_BODY_BYTES) {
          fail(new TransportError(`response exceeded ${MAX_BODY_BYTES} bytes`, 'reset', true));
          res.destroy();
          return;
        }
        body += chunk;
      });
      res.on('aborted', () => {
        fail(new TransportError('response aborted before it finished', 'reset', true));
      });
      res.on('end', () => {
        succeed({
          status: res.statusCode ?? 0,
          headers: flattenHeaders(res.headers),
          body,
          timing: {
            reusedConnection,
            socketId,
            ttfbMs: Math.round(ttfbMs * 100) / 100,
            elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
          },
        });
      });
    });

    if (spec.body !== undefined) req.write(spec.body, 'utf8');
    req.end();
  });
}
