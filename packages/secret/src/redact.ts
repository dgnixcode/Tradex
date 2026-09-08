// Deep redaction — plan/phase-00 T00.7.
//
// Used in three places, deliberately the same code in all three:
//   1. the pino log serialiser
//   2. the audit writer's `before`/`after` payloads (DATA-MODEL.md domain 7)
//   3. HTTP error response bodies
//
// Two independent mechanisms, because either alone has a gap:
//   - a field-name denylist catches a plaintext secret in a known field
//   - a shape heuristic catches one in an unexpected field
//
// Source: 07-api-key-security.md F6.

import { REDACTED, isSecret } from './secret.js';

/** Field names whose value is never safe to record, matched case-insensitively. */
export const DENIED_KEYS: readonly string[] = [
  'secret',
  'apisecret',
  'api_secret',
  'apikey',
  'api_key',
  'signature',
  'authorization',
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'accesstoken',
  'refreshtoken',
  'totpsecret',
  'totp_secret',
  'dek',
  'dekwrapped',
  'dek_wrapped',
  'pepper',
  'privatekey',
  'private_key',
  'cookie',
  'setcookie',
  'set_cookie',
];

const normaliseKey = (k: string): string => k.toLowerCase().replace(/[-_]/g, '');
const DENIED = new Set(DENIED_KEYS.map(normaliseKey));

/** Any header starting `x-auth-` is a CoinDCX auth header (`06`). */
const isDeniedKey = (key: string): boolean => {
  const n = normaliseKey(key);
  return DENIED.has(n) || n.startsWith('xauth');
};

/**
 * Shape heuristic for a plaintext credential in an unexpected field.
 *
 * Deliberately over-inclusive: masking a hash we would have liked to see is a
 * cosmetic loss, while printing a secret is not recoverable. Pure-digit strings
 * are excluded so exchange order ids (numeric strings, `01`) survive.
 */
export function looksSecret(value: string): boolean {
  if (value.length < 32) return false;
  if (/^\d+$/.test(value)) return false;
  if (/^[0-9a-f]{32,}$/i.test(value)) return true; // hex
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(value)) return true; // base64
  if (/^[A-Za-z2-7]{40,}={0,6}$/.test(value)) return true; // base32
  return false;
}

const MAX_DEPTH = 12;

/**
 * Mask secret-shaped tokens *within* a string, not only strings that are
 * entirely secret-shaped.
 *
 * This distinction is not academic. The canary check caught it on its first
 * run: `new Error(\`rejected key ${key} with secret ${secret}\`)` produces a
 * mixed string, so a whole-string test passes it straight through with both
 * credentials intact. Interpolating a plaintext secret into a message is the
 * realistic mistake, so token-level masking is the correct granularity.
 */
export function maskSecretTokens(text: string): string {
  return text.replace(/[A-Za-z0-9+/=]{32,}/g, (m) => (looksSecret(m) ? REDACTED : m));
}

/**
 * Returns a redacted deep clone. Never mutates its input, so it is safe to call
 * on a live domain object.
 */
export function redact<T>(input: T, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth-limit]';
  if (input === null || input === undefined) return input;
  if (isSecret(input)) return REDACTED;

  const t = typeof input;
  if (t === 'string') return maskSecretTokens(input as string);
  if (t === 'number' || t === 'boolean' || t === 'bigint') return input;
  if (t === 'function') return '[function]';
  if (t === 'symbol') return input.toString();

  if (input instanceof Date) return input.toISOString();
  if (input instanceof Error) {
    // Own enumerable properties are preserved, redacted. Errors routinely carry
    // diagnostic fields (`code`, `statusCode`, `market`) that are the whole
    // reason for logging them - dropping every extra field would make the log
    // useless, and dropping a field is also not the same as redacting it: the
    // canary check specifically asserts that a secret attached to an error is
    // visibly masked rather than silently disappeared.
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as unknown as Record<string, unknown>)) {
      if (k === 'name' || k === 'message' || k === 'stack') continue;
      extra[k] = isDeniedKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return {
      name: input.name,
      message: redact(input.message, depth + 1),
      ...(typeof input.stack === 'string' ? { stack: redactStack(input.stack) } : {}),
      ...extra,
    };
  }
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  if (input instanceof Map) {
    return Object.fromEntries(
      [...input.entries()].map(([k, v]) => [String(k), isDeniedKey(String(k)) ? REDACTED : redact(v, depth + 1)]),
    );
  }
  if (input instanceof Set) return [...input].map((v) => redact(v, depth + 1));
  if (input instanceof Uint8Array) return `[bytes:${input.byteLength}]`;

  if (t === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = isDeniedKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return String(input);
}

/**
 * A stack trace can carry a secret inside an interpolated frame. Mask any
 * secret-shaped token rather than dropping the stack, which is diagnostically
 * valuable.
 */
export function redactStack(stack: string): string {
  return maskSecretTokens(stack);
}

/** pino-compatible serialisers. Attach to the logger, not to call sites. */
export const logSerialisers = {
  err: (e: unknown) => redact(e),
  req: (r: unknown) => redact(r),
  res: (r: unknown) => redact(r),
} as const;

/**
 * A last-resort scan of a fully-rendered log line. The canary check drives a
 * sentinel through this so that a leak fails the build rather than production.
 */
export function containsSecretShaped(text: string): boolean {
  return /[A-Za-z0-9+/=]{32,}/.test(text)
    ? text.match(/[A-Za-z0-9+/=]{32,}/g)!.some(looksSecret)
    : false;
}
