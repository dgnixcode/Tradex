import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export function confinedStaticPath(root: string, pathname: string): string | null {
  if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0')) return null;
  const candidate = resolve(root, `.${pathname}`);
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : candidate;
}

const normaliseIp = (value: string) => value.startsWith('::ffff:') ? value.slice(7) : value;

/** Only a configured immediate proxy may supply the client address. */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, trusted: readonly string[] = []): string {
  let address = normaliseIp(req.socket.remoteAddress ?? 'unknown');
  const allowed = new Set(trusted.map(normaliseIp));
  if (!allowed.has(address)) return address;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length > 2048) return address;
  for (const raw of forwarded.split(',').reverse()) {
    if (!allowed.has(address)) break;
    const next = normaliseIp(raw.trim());
    if (!isIP(next)) return normaliseIp(req.socket.remoteAddress ?? 'unknown');
    address = next;
  }
  return address;
}

export function unsafeRequestReason(req: Pick<IncomingMessage, 'headers' | 'method'>, appUrl?: string): string | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET')) return null;
  if (req.headers['sec-fetch-site'] === 'cross-site') return 'Cross-site requests are not allowed';
  const origin = req.headers.origin;
  if (origin === undefined) return null; // Non-browser JSON API clients remain supported.
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)) return 'Invalid request origin';
    if (appUrl ? parsed.origin !== new URL(appUrl).origin : parsed.host !== req.headers.host) {
      return 'Request origin does not match this application';
    }
  } catch { return 'Invalid request origin'; }
  return null;
}
