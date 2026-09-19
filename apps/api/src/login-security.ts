// Login security service — brute-force protection, IP rate limiting, and alert dispatch.
import type { IncomingMessage } from 'node:http';
import type { Kysely } from 'kysely';
import type { DB } from '@tradex/db';
import {
  findUserByEmail,
  getLoginIpAttempt,
  isIpBlocked,
  recordLoginFailure,
  resetLoginIpAttempt,
} from '@tradex/db';

export interface LoginSecurityDeps {
  readonly db: Kysely<DB>;
  readonly resendApiKey?: string | undefined;
  readonly resendFrom?: string | undefined;
  readonly adminAlertEmail?: string | undefined;
  readonly now?: (() => number) | undefined;
}

export interface FailedLoginDetails {
  readonly ip: string;
  readonly email: string;
  readonly userAgent: string;
  readonly host?: string | undefined;
}

export interface FailedLoginResult {
  readonly blocked: boolean;
  readonly attempts: number;
  readonly blockedUntil: Date | null;
}

export class LoginSecurityService {
  private readonly db: Kysely<DB>;
  private readonly resendApiKey: string | undefined;
  private readonly resendFrom: string;
  private readonly adminAlertEmail: string;
  private readonly now: () => number;

  constructor(deps: LoginSecurityDeps) {
    this.db = deps.db;
    this.resendApiKey = deps.resendApiKey;
    this.resendFrom = deps.resendFrom ?? 'Tradex Security <onboarding@resend.dev>';
    this.adminAlertEmail = deps.adminAlertEmail ?? process.env['ADMIN_ALERT_EMAIL'] ?? 'bariaza006@gmail.com';
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Extract normalized client IP address from incoming HTTP request.
   */
  extractClientIp(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    let ip = '';
    if (typeof forwarded === 'string') {
      ip = forwarded.split(',')[0]?.trim() ?? '';
    } else if (Array.isArray(forwarded) && forwarded.length > 0) {
      ip = forwarded[0]?.split(',')[0]?.trim() ?? '';
    }

    if (!ip) {
      ip = req.socket.remoteAddress ?? 'unknown';
    }

    // Strip IPv4-mapped IPv6 prefix (e.g., ::ffff:192.168.1.1 -> 192.168.1.1)
    if (ip.startsWith('::ffff:')) {
      ip = ip.slice(7);
    }

    return ip || 'unknown';
  }

  /**
   * Check whether an IP address is currently blocked.
   */
  async checkIpBlocked(ip: string): Promise<{ blocked: boolean; blockedUntil: Date | null; failedAttempts: number }> {
    if (!ip || ip === 'unknown') {
      return { blocked: false, blockedUntil: null, failedAttempts: 0 };
    }
    return isIpBlocked(this.db, ip, this.now());
  }

  /**
   * Handle a failed login attempt:
   * 1. Reads current failure count for IP.
   * 2. If new count >= 4: sets 24-hour block and dispatches block alert.
   * 3. If new count < 4: records failure and dispatches warning alert.
   */
  async handleFailedLogin(details: FailedLoginDetails): Promise<FailedLoginResult> {
    const ip = details.ip || 'unknown';
    const nowMs = this.now();

    // Check current count
    const existing = await getLoginIpAttempt(this.db, ip);
    const prevAttempts = existing ? existing.failedAttempts : 0;
    const newAttempts = prevAttempts + 1;

    let blockedUntil: Date | null = null;
    let blocked = false;

    // Rule: if more than 3 attempts, block IP for 24 hours on the 4th attempt
    if (newAttempts >= 4) {
      blocked = true;
      blockedUntil = new Date(nowMs + 24 * 60 * 60 * 1000); // 24 hours
    }

    const recorded = await recordLoginFailure(this.db, ip, blockedUntil, nowMs);

    // Asynchronously dispatch email alert (never block or fail the auth response)
    void this.dispatchAlertEmail({
      ip,
      email: details.email,
      userAgent: details.userAgent,
      attempts: recorded.failedAttempts,
      blocked,
      blockedUntil: recorded.blockedUntil,
    }).catch((err) => {
      console.error('[LoginSecurityService] Unhandled error dispatching alert email:', err);
    });

    return {
      blocked,
      attempts: recorded.failedAttempts,
      blockedUntil: recorded.blockedUntil,
    };
  }

  /**
   * Reset failed attempt counter for an IP upon successful authentication.
   */
  async handleSuccessfulLogin(ip: string): Promise<void> {
    if (!ip || ip === 'unknown') return;
    try {
      await resetLoginIpAttempt(this.db, ip);
    } catch (err) {
      console.error('[LoginSecurityService] Failed to reset login IP attempt on success:', err);
    }
  }

  /**
   * Dispatch security alert email to admin and optionally the targeted user.
   */
  private async dispatchAlertEmail(data: {
    ip: string;
    email: string;
    userAgent: string;
    attempts: number;
    blocked: boolean;
    blockedUntil: Date | null;
  }): Promise<void> {
    const recipients = new Set<string>();
    if (this.adminAlertEmail) {
      recipients.add(this.adminAlertEmail.trim().toLowerCase());
    }

    // Check if the targeted email corresponds to a real registered user
    try {
      const targetedUser = await findUserByEmail(this.db, data.email);
      if (targetedUser) {
        recipients.add(targetedUser.email.trim().toLowerCase());
      }
    } catch {
      // Ignore user lookup error
    }

    const recipientList = Array.from(recipients);
    if (recipientList.length === 0) return;

    if (!this.resendApiKey) {
      console.warn('[LoginSecurityService] RESEND_API_KEY not configured. Security alert details:');
      console.warn(`[LoginSecurityService] Target: ${data.email} | IP: ${data.ip} | Attempts: ${data.attempts} | Blocked: ${data.blocked}`);
      return;
    }

    const brandName = this.resendFrom.includes('<') ? this.resendFrom.split('<')[0]!.trim() : 'Tradex';
    const now = new Date(this.now());
    const utcTime = now.toUTCString();
    const istTime = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';

    const subject = data.blocked
      ? `[${brandName} Security Alert] IP Address Blocked: 4 Failed Login Attempts`
      : `[${brandName} Security Alert] Failed Login Attempt (${data.attempts}/3)`;

    const statusHtml = data.blocked
      ? `<span style="color: #ef4444; font-weight: 700;">BLOCKED FOR 24 HOURS</span><br><span style="font-size: 12px; color: #9ca3af;">All login requests from this IP are blocked until ${data.blockedUntil ? data.blockedUntil.toUTCString() : '24 hours from now'}.</span>`
      : `<span style="color: #f59e0b; font-weight: 600;">${Math.max(0, 4 - data.attempts)} attempt(s) remaining</span> before 24-hour IP block.`;

    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; color: #f3f4f6;">
  <div style="max-width: 540px; margin: 40px auto; padding: 32px 24px; background-color: #111827; border: 1px solid #1f2937; border-radius: 12px;">
    <div style="margin-bottom: 24px; border-bottom: 1px solid #1f2937; padding-bottom: 16px;">
      <h2 style="margin: 0 0 6px 0; font-size: 18px; color: #60a5fa; font-weight: 700; letter-spacing: -0.02em;">${brandName} Security</h2>
      <h1 style="margin: 0; font-size: 16px; color: ${data.blocked ? '#ef4444' : '#f59e0b'}; font-weight: 600;">
        ${data.blocked ? 'Security Notice: IP Address Blocked (24 Hours)' : 'Security Notice: Failed Login Attempt Detected'}
      </h1>
    </div>

    <p style="margin: 0 0 16px 0; font-size: 14px; line-height: 1.6; color: #9ca3af;">
      A login attempt with incorrect credentials was detected on the ${brandName} platform.
    </p>

    <div style="background-color: #0f172a; border: 1px solid #1e293b; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tr>
          <td style="padding: 6px 0; color: #64748b; width: 140px;">Attempted Account:</td>
          <td style="padding: 6px 0; color: #f1f5f9; font-weight: 600; font-family: monospace;">${data.email}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Client IP Address:</td>
          <td style="padding: 6px 0; color: #f1f5f9; font-family: monospace;">${data.ip}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Timestamp (UTC):</td>
          <td style="padding: 6px 0; color: #f1f5f9;">${utcTime}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Timestamp (IST):</td>
          <td style="padding: 6px 0; color: #f1f5f9;">${istTime}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b;">Failed Attempts:</td>
          <td style="padding: 6px 0; color: #f1f5f9; font-weight: 600;">${data.attempts} of 4 maximum</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b; vertical-align: top;">Action Taken:</td>
          <td style="padding: 6px 0; color: #f1f5f9;">${statusHtml}</td>
        </tr>
        <tr>
          <td style="padding: 6px 0; color: #64748b; vertical-align: top;">Device / Agent:</td>
          <td style="padding: 6px 0; color: #94a3b8; font-size: 11px; word-break: break-all;">${data.userAgent || 'Not reported'}</td>
        </tr>
      </table>
    </div>

    <p style="margin: 0 0 12px 0; font-size: 13px; line-height: 1.5; color: #9ca3af;">
      If you did not perform this login attempt, please review your account credentials and system security settings immediately.
    </p>

    <hr style="border: none; border-top: 1px solid #1f2937; margin: 24px 0;" />
    <p style="margin: 0; font-size: 11px; line-height: 1.5; color: #4b5563;">
      This automated security alert was dispatched by ${brandName} protective monitoring.
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
          to: recipientList,
          subject,
          html,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[LoginSecurityService] Resend API error (${res.status}): ${errText}`);

        if (!this.resendFrom.includes('onboarding@resend.dev') && (res.status === 403 || errText.includes('not verified'))) {
          console.warn('[LoginSecurityService] Retrying with onboarding@resend.dev fallback...');
          const fallbackRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.resendApiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: `${brandName} <onboarding@resend.dev>`,
              to: recipientList,
              subject,
              html,
            }),
          });

          if (fallbackRes.ok) {
            console.log(`[LoginSecurityService] Security alert email dispatched via fallback to: ${recipientList.join(', ')}`);
            return;
          }
          const fallbackErr = await fallbackRes.text();
          console.error(`[LoginSecurityService] Fallback dispatch failed (${fallbackRes.status}): ${fallbackErr}`);
        }
      } else {
        console.log(`[LoginSecurityService] Security alert email successfully dispatched to: ${recipientList.join(', ')}`);
      }
    } catch (err) {
      console.error('[LoginSecurityService] Failed to send email via Resend:', err);
    }
  }
}
