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
    <div className="auth-split auth-light">
      <aside className="auth-aside">
        <Brand to="/" />
        <div>
          <p className="auth-aside-quote">
            Secure recovery for <span className="grad">your trading desk</span>.
          </p>
          <ul className="auth-aside-points">
            <li>Single-use cryptographic reset tokens</li>
            <li>Time-bounded 15-minute validity window</li>
            <li>Active sessions automatically revoked upon reset</li>
            <li>Zero exposure of unhashed credentials</li>
          </ul>
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>Preview &amp; dry-run · no orders are sent</span>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <Brand to="/" />
          <h2>Choose a new password</h2>
          <p className="sub">
            {success
              ? 'Your password has been changed.'
              : 'Enter a strong password of at least 12 characters.'}
          </p>

          {!token.trim() ? (
            <div style={{ marginTop: '20px' }}>
              <div className="error" style={{ marginBottom: '20px' }}>
                Invalid or missing reset token in the link.
              </div>
              <Link to="/forgot-password" className="btn btn-lg" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
                Request new reset link
              </Link>
            </div>
          ) : success ? (
            <div style={{ marginTop: '20px' }}>
              <div
                style={{
                  padding: '16px',
                  borderRadius: 'var(--radius, 8px)',
                  background: 'rgba(34, 197, 94, 0.1)',
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  color: '#16a34a',
                  fontSize: '14px',
                  lineHeight: '1.5',
                  marginBottom: '24px',
                }}
              >
                <strong>Password updated successfully!</strong>
                <p style={{ margin: '8px 0 0 0', color: 'var(--text-dim)' }}>
                  All previous sessions have been logged out. You can now log in with your new credentials.
                </p>
              </div>

              <Link to="/login" className="btn btn-lg" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
                Log in now
              </Link>
            </div>
          ) : (
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="new-password">New password</label>
                <input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="At least 12 characters"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  autoFocus
                />
                {tooShort && (
                  <span className="hint" style={{ color: 'var(--loss)', display: 'block', marginTop: '4px', fontSize: '12.5px' }}>
                    {MIN_PASSWORD - newPassword.length} more character{MIN_PASSWORD - newPassword.length === 1 ? '' : 's'} needed
                  </span>
                )}
              </div>

              <div className="field">
                <label htmlFor="confirm-password">Confirm new password</label>
                <input
                  id="confirm-password"
                  type="password"
                  autoComplete="new-password"
                  placeholder="Repeat new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
                {mismatch && (
                  <span className="hint" style={{ color: 'var(--loss)', display: 'block', marginTop: '4px', fontSize: '12.5px' }}>
                    Passwords do not match
                  </span>
                )}
              </div>

              {error !== null && <div className="error" style={{ marginBottom: '16px' }}>{error}</div>}

              <button className="btn btn-lg" type="submit" disabled={busy || tooShort || mismatch}>
                {busy ? 'Updating password…' : 'Save new password'}
              </button>
            </form>
          )}

          <p className="auth-alt muted">
            Remember your password? <Link to="/login">Log in</Link>
          </p>

          <p className="auth-back muted">
            <Link to="/">← Back to home</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
