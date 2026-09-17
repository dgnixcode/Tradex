import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { requestPasswordReset, ApiError } from '../api.ts';
import { Brand } from '../components/Brand.tsx';

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
    <div className="auth-split auth-dark">
      <aside className="auth-aside">
        <Brand to="/" size="lg" />
        <div>
          <p className="auth-aside-quote">
            Cryptographic recovery for <span className="grad">your trading desk</span>.
          </p>
          <ul className="auth-aside-points">
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Single-use cryptographic tokens</strong> sent directly to your registered inbox</span>
            </li>
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Time-bounded 15-minute window</strong> to prevent link reuse</span>
            </li>
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Automatic session revocation</strong> across all existing devices</span>
            </li>
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Zero exposure</strong> of unhashed API secrets or credentials</span>
            </li>
          </ul>
        </div>

        <div className="auth-system-badge">
          <span className="auth-status-pulse" />
          <span>Security Protocol: Active · TLS Encrypted</span>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-brand">
            <Brand to="/" size="md" />
          </div>

          <h2>Reset password</h2>
          <p className="sub">
            {sent
              ? 'Recovery instructions have been dispatched.'
              : 'Enter your registered email address and we will send you a password reset link.'}
          </p>

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

              <p className="auth-alt" style={{ marginTop: '16px' }}>
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

          <p className="auth-footer-links">
            Remember your password? <Link to="/login">Sign in</Link>
          </p>

          <p className="auth-home-link">
            <Link to="/">← Back to Aza WealthKare</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
