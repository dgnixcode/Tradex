import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { requestPasswordReset, ApiError } from '../api.ts';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';

export function ForgotPassword() {
  const { state } = useAuth();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (state.status === 'authenticated') return <Navigate to="/app" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await requestPasswordReset(email);
      setSent(true);
      setMessage(res.message);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to send reset link. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="landing landing-dark auth-site-page">
      <MarketingHeader />

      <div className="wm-subpage-hero-wrap">
        <section className="mk-section mk-block" style={{ padding: '24px 0 10px' }}>
          <div className="section-head" style={{ maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
            <span className="kicker">Aza WealthKare Security</span>
            <h1 className="wm-subpage-title">
              Reset Your <span className="wm-grad">Password</span>
            </h1>
            <p className="wm-subpage-sub">
              Cryptographic recovery dispatched directly to your authorized email address.
            </p>
          </div>
        </section>
      </div>

      <section className="mk-section mk-block" style={{ paddingTop: '24px', paddingBottom: '80px' }}>
        <div className="auth-site-grid">
          {/* Left Column: Security Protocols */}
          <div className="auth-site-aside">
            <h3 className="auth-site-aside-title">
              Cryptographic Recovery for <span className="wm-grad">Your Trading Desk</span>
            </h3>
            <p className="auth-site-aside-desc">
              Aza WealthKare implements strict zero-trust credential recovery to prevent unauthorized desk access.
            </p>

            <ul className="auth-site-points">
              <li>
                <span className="auth-site-point-icon">✓</span>
                <div>
                  <strong>Single-Use Cryptographic Tokens</strong>
                  <p>One-time signed reset links sent directly to your registered administrator inbox.</p>
                </div>
              </li>
              <li>
                <span className="auth-site-point-icon">✓</span>
                <div>
                  <strong>Time-Bounded 15-Minute Window</strong>
                  <p>Links automatically expire after 15 minutes to guarantee token freshness.</p>
                </div>
              </li>
              <li>
                <span className="auth-site-point-icon">✓</span>
                <div>
                  <strong>Automatic Session Revocation</strong>
                  <p>All active sessions and refresh tokens across all devices are immediately invalidated.</p>
                </div>
              </li>
              <li>
                <span className="auth-site-point-icon">✓</span>
                <div>
                  <strong>Zero Secret Exposure</strong>
                  <p>API keys and credentials remain cryptographically protected in secure storage.</p>
                </div>
              </li>
            </ul>

            <div className="auth-site-badge">
              <span className="auth-status-pulse" />
              <span>Security Protocol: Active · TLS Encrypted</span>
            </div>
          </div>

          {/* Right Column: Recovery Form Card */}
          <div className="auth-site-card-wrap">
            <div className="auth-site-card">
              <div className="auth-card-head">
                <h2>Account Recovery</h2>
                <p className="sub">
                  {sent
                    ? 'Recovery instructions have been dispatched.'
                    : 'Enter your registered email address and we will send you a password reset link.'}
                </p>
              </div>

              {sent ? (
                <div>
                  <div className="auth-success-card">
                    <div className="auth-success-icon">
                      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                    <h3 className="auth-success-title">Email Dispatched</h3>
                    <p className="auth-success-desc">
                      {message || `If an account exists for ${email}, a password reset link has been dispatched.`}
                    </p>
                    <p className="auth-success-notice">
                      The link expires in 15 minutes. Check your spam folder if you do not see it in a few minutes.
                    </p>
                  </div>

                  <Link to="/login" className="auth-btn-submit" style={{ textDecoration: 'none', display: 'flex' }}>
                    Return to Sign In
                  </Link>

                  <p style={{ marginTop: '16px', textAlign: 'center', fontSize: '13px', color: '#94a3b8' }}>
                    Didn&rsquo;t receive the email?{' '}
                    <button
                      type="button"
                      onClick={() => { setSent(false); setMessage(null); }}
                      style={{ background: 'none', border: 'none', color: '#34d399', cursor: 'pointer', padding: 0, font: 'inherit', textDecoration: 'underline' }}
                    >
                      Try another email
                    </button>
                  </p>
                </div>
              ) : (
                <form onSubmit={submit}>
                  <div className="auth-field">
                    <label htmlFor="email">Email address</label>
                    <div className="auth-input-wrap">
                      <span className="auth-input-icon">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <rect width="20" height="16" x="2" y="4" rx="2" />
                          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                        </svg>
                      </span>
                      <input
                        id="email"
                        type="email"
                        autoComplete="username"
                        placeholder="name@company.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                        autoFocus
                      />
                    </div>
                  </div>

                  {error !== null && (
                    <div className="auth-error-alert">
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <circle cx="12" cy="12" r="10" />
                        <line x1="12" y1="8" x2="12" y2="12" />
                        <line x1="12" y1="16" x2="12.01" y2="16" />
                      </svg>
                      <span>{error}</span>
                    </div>
                  )}

                  <button className="auth-btn-submit" type="submit" disabled={busy}>
                    {busy ? 'Sending recovery link…' : 'Send Recovery Link →'}
                  </button>
                </form>
              )}

              <div className="auth-site-footer-note">
                <span>Remember your password?</span>
                <Link to="/login">Sign in here</Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
