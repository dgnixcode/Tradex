// Password reset service — request link generation and reset verification.
import { randomBytes, createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@tradex/db';
import {
  findUserByEmail,
  createPasswordResetToken,
  findValidResetToken,
  consumeResetTokenAndUpdatePassword,
} from '@tradex/db';
import { assertPasswordAcceptable, hashPassword } from '@tradex/auth';

export interface PasswordResetDeps {
  readonly db: Kysely<DB>;
  readonly resendApiKey?: string | undefined;
  readonly resendFrom?: string | undefined;
  readonly appUrl?: string | undefined;
  readonly now?: (() => number) | undefined;
}

export class PasswordResetService {
  private readonly db: Kysely<DB>;
  private readonly resendApiKey: string | undefined;
  private readonly resendFrom: string;
  private readonly appUrl: string | undefined;
  private readonly now: () => number;

  constructor(deps: PasswordResetDeps) {
    this.db = deps.db;
    this.resendApiKey = deps.resendApiKey;
    this.resendFrom = deps.resendFrom ?? 'Aza WealthKare <onboarding@resend.dev>';
    this.appUrl = deps.appUrl;
    this.now = deps.now ?? (() => Date.now());
  }

  async requestReset(email: string, requestHost?: string): Promise<{ ok: boolean; message: string }> {
    const trimmed = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (!trimmed) {
      return { ok: true, message: 'If an account exists with that email, a password reset link has been sent.' };
    }

    try {
      const user = await findUserByEmail(this.db, trimmed);
      if (!user) {
        // Uniform response to prevent email enumeration
        return { ok: true, message: 'If an account exists with that email, a password reset link has been sent.' };
      }

      // Generate 32 bytes (256 bits) of entropy
      const rawToken = randomBytes(32).toString('hex');
      const tokenHash = createHash('sha256').update(rawToken).digest();
      const expiresAt = new Date(this.now() + 15 * 60 * 1000); // 15 minutes

      await createPasswordResetToken(this.db, user.id, tokenHash, expiresAt);

      const baseUrl = this.appUrl || requestHost || 'http://localhost:8080';
      const resetLink = `${baseUrl.replace(/\/+$/, '')}/reset-password?token=${rawToken}`;

      await this.sendEmail(user.email, resetLink);
    } catch (err) {
      console.error('[PasswordResetService] Failed to process password reset request:', err);
    }

    return { ok: true, message: 'If an account exists with that email, a password reset link has been sent.' };
  }

  private async sendEmail(toEmail: string, resetLink: string): Promise<void> {
    if (!this.resendApiKey) {
      console.warn('[PasswordResetService] RESEND_API_KEY not configured. Generated reset link:');
      console.warn(`[PasswordResetService] Target: ${toEmail} | Link: ${resetLink}`);
      return;
    }

    const brandName = this.resendFrom.includes('<') ? this.resendFrom.split('<')[0]!.trim() : 'Aza WealthKare';

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Reset Your Password</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; color: #f3f4f6;">
  <div style="max-width: 520px; margin: 40px auto; padding: 32px 24px; background-color: #111827; border: 1px solid #1f2937; border-radius: 12px;">
    <div style="margin-bottom: 24px;">
      <h2 style="margin: 0 0 8px 0; font-size: 20px; color: #60a5fa; font-weight: 700; letter-spacing: -0.02em;">${brandName}</h2>
      <h1 style="margin: 0; font-size: 18px; color: #ffffff; font-weight: 600;">Password Reset Request</h1>
    </div>
    <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #9ca3af;">
      We received a request to reset the password for your ${brandName} operator account (<span style="color: #e5e7eb;">${toEmail}</span>).
    </p>
    <p style="margin: 0 0 24px 0; font-size: 14px; line-height: 1.6; color: #9ca3af;">
      Click the button below to set a new password. This link is valid for <strong>15 minutes</strong>.
    </p>
    <div style="margin: 32px 0; text-align: center;">
      <a href="${resetLink}" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 6px; font-weight: 600; font-size: 14px; box-shadow: 0 2px 4px rgba(0,0,0,0.2);">Reset Password</a>
    </div>
    <p style="margin: 0 0 16px 0; font-size: 13px; line-height: 1.5; color: #6b7280;">
      If the button above does not work, copy and paste this URL into your browser:
      <br>
      <a href="${resetLink}" style="color: #60a5fa; word-break: break-all; font-size: 12px;">${resetLink}</a>
    </p>
    <hr style="border: none; border-top: 1px solid #1f2937; margin: 24px 0;" />
    <p style="margin: 0; font-size: 12px; line-height: 1.5; color: #4b5563;">
      If you did not request a password reset, you can safely ignore this email. No changes will be made to your account.
    </p>
  </div>
</body>
</html>
    `.trim();

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.resendFrom,
          to: [toEmail],
          subject: `Reset your ${brandName} password`,
          html,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[PasswordResetService] Resend API error (${res.status}): ${errText}`);

        // If custom domain is not yet verified on Resend, gracefully fallback to onboarding@resend.dev
        if (!this.resendFrom.includes('onboarding@resend.dev') && (res.status === 403 || errText.includes('not verified'))) {
          console.warn('[PasswordResetService] Domain pending verification on Resend; retrying with onboarding@resend.dev fallback...');
          const fallbackRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.resendApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: `${brandName} <onboarding@resend.dev>`,
              to: [toEmail],
              subject: `Reset your ${brandName} password`,
              html,
            }),
          });

          if (fallbackRes.ok) {
            console.log(`[PasswordResetService] Password reset email successfully dispatched via fallback onboarding@resend.dev to ${toEmail}`);
            return;
          }
          const fallbackErr = await fallbackRes.text();
          console.error(`[PasswordResetService] Fallback dispatch failed (${fallbackRes.status}): ${fallbackErr}`);
        }

        console.warn(`[PasswordResetService] Fallback reset link for ${toEmail}: ${resetLink}`);
      } else {
        console.log(`[PasswordResetService] Password reset email successfully dispatched to ${toEmail} via Resend (${this.resendFrom})`);
      }
    } catch (err) {
      console.error('[PasswordResetService] Failed to send email via Resend:', err);
      console.warn(`[PasswordResetService] Fallback reset link for ${toEmail}: ${resetLink}`);
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<
    | { readonly ok: true; readonly message: string }
    | { readonly ok: false; readonly code: string; readonly message: string }
  > {
    if (typeof token !== 'string' || !token.trim()) {
      return { ok: false, code: 'invalid_token', message: 'Invalid reset token provided.' };
    }

    try {
      assertPasswordAcceptable(newPassword);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid password';
      return { ok: false, code: 'weak_password', message: msg };
    }

    const tokenHash = createHash('sha256').update(token.trim()).digest();
    const now = new Date(this.now());
    const valid = await findValidResetToken(this.db, tokenHash, now);

    if (!valid) {
      return {
        ok: false,
        code: 'invalid_or_expired_token',
        message: 'The password reset link is invalid or has expired. Please request a new one.',
      };
    }

    const newHash = await hashPassword(newPassword);
    await consumeResetTokenAndUpdatePassword(this.db, valid.id, valid.userId, newHash, now);

    return { ok: true, message: 'Password has been successfully reset. You can now log in.' };
  }
}
