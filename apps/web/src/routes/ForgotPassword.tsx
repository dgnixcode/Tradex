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
          <h2>Reset password</h2>
          <p className="sub">
            {sent
              ? 'Check your inbox for the recovery link.'
              : "Enter your registered email address and we'll send you a password reset link."}
          </p>

          {sent ? (
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
                <strong>Email dispatched:</strong>
                <p style={{ margin: '8px 0 0 0', color: 'var(--text-dim)' }}>
                  {message || 'If an account exists with that email, a password reset link has been sent.'}
                </p>
                <p style={{ margin: '8px 0 0 0', fontSize: '13px', color: 'var(--muted)' }}>
                  The link expires in 15 minutes. Check your spam folder if you do not see it in a few minutes.
                </p>
              </div>

              <Link to="/login" className="btn btn-lg" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
                Back to Login
              </Link>
            </div>
          ) : (
            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>

              {error !== null && <div className="error" style={{ marginBottom: '16px' }}>{error}</div>}

              <button className="btn btn-lg" type="submit" disabled={busy}>
                {busy ? 'Sending link…' : 'Send reset link'}
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
