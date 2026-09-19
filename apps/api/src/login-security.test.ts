import { describe, it, expect } from 'vitest';
import { LoginSecurityService } from './login-security.js';

describe('LoginSecurityService', () => {
  it('extracts IP correctly from forwarded headers and remoteAddress', () => {
    const service = new LoginSecurityService({
      db: {} as never,
    });

    const mockReq1 = {
      headers: { 'x-forwarded-for': '203.0.113.195, 70.41.3.18' },
      socket: { remoteAddress: '127.0.0.1' },
    } as never;
    expect(service.extractClientIp(mockReq1)).toBe('203.0.113.195');

    const mockReq2 = {
      headers: {},
      socket: { remoteAddress: '::ffff:192.168.1.50' },
    } as never;
    expect(service.extractClientIp(mockReq2)).toBe('192.168.1.50');
  });

  it('blocks IP on the 4th failed attempt for 24 hours', async () => {
    const records = new Map<string, { failedAttempts: number; blockedUntil: Date | null }>();

    // Mock DB operations
    const mockDb = {
      selectFrom: () => ({
        selectAll: () => ({
          where: (_col: string, _op: string, ip: string) => ({
            executeTakeFirst: async () => {
              const rec = records.get(ip);
              if (!rec) return undefined;
              return {
                ip,
                failed_attempts: rec.failedAttempts,
                last_attempt_at: new Date(),
                blocked_until: rec.blockedUntil,
                created_at: new Date(),
              };
            },
          }),
        }),
      }),
      insertInto: () => ({
        values: (val: any) => ({
          onConflict: () => ({
            returning: () => ({
              executeTakeFirst: async () => {
                const prev = records.get(val.ip)?.failedAttempts ?? 0;
                const nextAttempts = prev + 1;
                const blockedUntil = nextAttempts >= 4 ? new Date(val.created_at.getTime() + 24 * 60 * 60 * 1000) : null;
                records.set(val.ip, { failedAttempts: nextAttempts, blockedUntil });
                return {
                  failed_attempts: nextAttempts,
                  blocked_until: blockedUntil,
                };
              },
            }),
          }),
        }),
      }),
      deleteFrom: () => ({
        where: (_col: string, _op: string, ip: string) => ({
          execute: async () => {
            records.delete(ip);
          },
        }),
      }),
    };

    const fakeNow = 1720000000000;
    const service = new LoginSecurityService({
      db: mockDb as never,
      now: () => fakeNow,
    });

    const ip = '198.51.100.42';

    // Attempt 1
    const res1 = await service.handleFailedLogin({ ip, email: 'test@example.com', userAgent: 'test-agent' });
    expect(res1.attempts).toBe(1);
    expect(res1.blocked).toBe(false);

    // Attempt 2
    const res2 = await service.handleFailedLogin({ ip, email: 'test@example.com', userAgent: 'test-agent' });
    expect(res2.attempts).toBe(2);
    expect(res2.blocked).toBe(false);

    // Attempt 3
    const res3 = await service.handleFailedLogin({ ip, email: 'test@example.com', userAgent: 'test-agent' });
    expect(res3.attempts).toBe(3);
    expect(res3.blocked).toBe(false);

    // Attempt 4: Should block for 24 hours
    const res4 = await service.handleFailedLogin({ ip, email: 'test@example.com', userAgent: 'test-agent' });
    expect(res4.attempts).toBe(4);
    expect(res4.blocked).toBe(true);
    expect(res4.blockedUntil?.getTime()).toBe(fakeNow + 24 * 60 * 60 * 1000);

    // Check IP block state
    const checkBlocked = await service.checkIpBlocked(ip);
    expect(checkBlocked.blocked).toBe(true);

    // Reset on successful login
    await service.handleSuccessfulLogin(ip);
    const checkAfterSuccess = await service.checkIpBlocked(ip);
    expect(checkAfterSuccess.blocked).toBe(false);
    expect(checkAfterSuccess.failedAttempts).toBe(0);
  });
});
