import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { clientIp, confinedStaticPath, unsafeRequestReason } from './request-security.js';

describe('request boundaries', () => {
  const req = (headers: IncomingMessage['headers'], remoteAddress = '203.0.113.10') => ({ headers, socket: { remoteAddress } }) as IncomingMessage;
  it('ignores forged forwarding headers from direct clients', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4' }))).toBe('203.0.113.10');
  });
  it('uses the nearest untrusted hop and strips mapped IPv4', () => {
    expect(clientIp(req({ 'x-forwarded-for': '1.2.3.4, 203.0.113.10' }, '::ffff:127.0.0.1'), ['127.0.0.1'])).toBe('203.0.113.10');
  });
  it('rejects cross-site and sibling-domain mutations', () => {
    expect(unsafeRequestReason({ method: 'POST', headers: { host: 'trade.example', origin: 'https://evil.example' } })).toBeTruthy();
    expect(unsafeRequestReason({ method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } })).toBeTruthy();
    expect(unsafeRequestReason({ method: 'POST', headers: { origin: 'null' } })).toBeTruthy();
  });
  it('accepts same-origin browsers and non-browser clients', () => {
    expect(unsafeRequestReason({ method: 'POST', headers: { host: 'trade.example', origin: 'https://trade.example' } })).toBeNull();
    expect(unsafeRequestReason({ method: 'POST', headers: {} }, 'https://trade.example')).toBeNull();
    expect(unsafeRequestReason({ method: 'POST', headers: { origin: 'http://trade.example' } }, 'https://trade.example')).toBeTruthy();
  });
  it('confines decoded static paths before reading files', () => {
    const root = process.cwd();
    for (const path of ['/../../../.env', '/..\\..\\.env', '/x\0', '/../Tradex-evil/private']) {
      expect(confinedStaticPath(root, path)).toBeNull();
    }
    expect(confinedStaticPath(root, '/assets/app.js')).toContain('app.js');
  });
});
