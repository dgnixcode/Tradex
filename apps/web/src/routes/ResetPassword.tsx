import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { completePasswordReset, ApiError } from '../api.ts';
import { Brand } from '../components/Brand.tsx';

const MIN_PASSWORD = 12;

export function ResetPassword() {
  const { state } = useAuth();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.status === 'authenticated') return <Navigate to="/app" replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!token.trim()) {
      setError('Missing or invalid reset token. Please request a new password reset link.');
      return;
    }

    if (newPassword.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters long.`);
      return;
    }

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match. Please ensure both fields are identical.');
      return;
    }

    setBusy(true);
    try {
      await completePasswordReset(token.trim(), newPassword);
      setSuccess(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Failed to reset password. The link may have expired.');
      }
    } finally {
      setBusy(false);
    }
  };

  const tooShort = newPassword.length > 0 && newPassword.length < MIN_PASSWORD;
  const mismatch = confirmPassword.length > 0 && newPassword !== confirmPassword;

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

          <h2>Choose a new password</h2>
          <p className="sub">
            {success
              ? 'Your password has been changed.'
              : 'Enter a strong password of at least 12 characters.'}
          </p>

          {!token.trim() ? (
            <div>
              <div className="auth-error-alert" style={{ marginBottom: '20px' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
                <span>Invalid or missing reset token. Please request a new link.</span>
              </div>
              <Link to="/forgot-password" className="auth-btn-submit" style={{ textDecoration: 'none', display: 'flex' }}>
                Request new reset link
              </Link>
            </div>
          ) : success ? (
            <div>
              <div className="auth-success-card">
                <div className="auth-success-icon">
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h3 className="auth-success-title">Password Updated Successfully</h3>
                <p className="auth-success-desc">
                  All previous sessions have been logged out. You can now log in to your trading desk with your new credentials.
                </p>
              </div>

              <Link to="/login" className="auth-btn-submit" style={{ textDecoration: 'none', display: 'flex' }}>
                Log in to Trading Desk
              </Link>
            </div>
          ) : (
            <form onSubmit={submit}>
              <div className="auth-field">
                <label htmlFor="new-password">New password</label>
                <div className="auth-input-wrap has-toggle">
                  <span className="auth-input-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  <input
                    id="new-password"
                    type={showNew ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="At least 12 characters"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    autoFocus
                  />
                  <button
                    type="button"
                    className="auth-pw-toggle"
                    onClick={() => setShowNew(!showNew)}
                    title={showNew ? 'Hide password' : 'Show password'}
                    aria-label={showNew ? 'Hide password' : 'Show password'}
                  >
                    {showNew ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                        <line x1="2" y1="2" x2="22" y2="22" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
                {tooShort && (
                  <span style={{ color: '#f87171', display: 'block', marginTop: '6px', fontSize: '12px' }}>
                    {MIN_PASSWORD - newPassword.length} more character{MIN_PASSWORD - newPassword.length === 1 ? '' : 's'} needed
                  </span>
                )}
              </div>

              <div className="auth-field">
                <label htmlFor="confirm-password">Confirm new password</label>
                <div className="auth-input-wrap has-toggle">
                  <span className="auth-input-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </span>
                  <input
                    id="confirm-password"
                    type={showConfirm ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Repeat new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="auth-pw-toggle"
                    onClick={() => setShowConfirm(!showConfirm)}
                    title={showConfirm ? 'Hide password' : 'Show password'}
                    aria-label={showConfirm ? 'Hide password' : 'Show password'}
                  >
                    {showConfirm ? (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                        <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                        <line x1="2" y1="2" x2="22" y2="22" />
                      </svg>
                    ) : (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    )}
                  </button>
                </div>
                {mismatch && (
                  <span style={{ color: '#f87171', display: 'block', marginTop: '6px', fontSize: '12px' }}>
                    Passwords do not match
                  </span>
                )}
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

              <button className="auth-btn-submit" type="submit" disabled={busy || tooShort || mismatch}>
                {busy ? 'Updating password…' : 'Save New Password & Sign In →'}
              </button>
            </form>
          )}

          <p className="auth-footer-links">
            Remember your password? <Link to="/login">Log in</Link>
          </p>

          <p className="auth-home-link">
            <Link to="/">← Back to Aza WealthKare</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
