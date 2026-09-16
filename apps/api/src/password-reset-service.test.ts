import { describe, expect, it } from 'vitest';
import { PasswordResetService } from './password-reset-service.js';

describe('PasswordResetService', () => {
  it('enforces password policy on reset', async () => {
    const service = new PasswordResetService({
      db: {} as never,
    });

    const shortRes = await service.resetPassword('sometoken', 'short');
    expect(shortRes.ok).toBe(false);
    if (!shortRes.ok) {
      expect(shortRes.code).toBe('weak_password');
      expect(shortRes.message).toContain('at least 12');
    }
  });

  it('rejects empty or missing token', async () => {
    const service = new PasswordResetService({
      db: {} as never,
    });

    const res = await service.resetPassword('   ', 'valid-length-password-123');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('invalid_token');
    }
  });
});
