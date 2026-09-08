import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { ApiError } from '../api.ts';

// The login page. Public, and the only way into the panel. A two-panel split: a
// branded aside that states what the platform does, and the form card. On
// success the server sets an httpOnly session cookie and this navigates into the
// gated panel (back to wherever the user was headed, if they were redirected
// here). A `totp_required` response reveals the second-factor field rather than
// treating it as a hard failure.

interface FromState { readonly from?: string }

export function Login() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const dest = (location.state as FromState | null)?.from ?? '/app';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === 'authenticated') return <Navigate to={dest} replace />;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login({ email, password, ...(needsTotp && totpCode !== '' ? { totpCode } : {}) });
      navigate(dest, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'totp_required') {
        setNeedsTotp(true);
        setError('Enter the 6-digit code from your authenticator app.');
      } else if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-split auth-light">
      <aside className="auth-aside">
        <Link to="/" className="brand">Tradex</Link>
        <div>
          <p className="auth-aside-quote">
            One order across <span className="grad">every account</span> — checked before it moves a rupee.
          </p>
          <ul className="auth-aside-points">
            <li>Percentage sizing, per account</li>
            <li>Twelve safety gates before every leg</li>
            <li>Preview matches the plan, exactly</li>
            <li>Exact-decimal money, never floating point</li>
          </ul>
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>Preview &amp; dry-run · no orders are sent</span>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <Link to="/" className="brand">Tradex</Link>
          <h2>Welcome back</h2>
          <p className="sub">Log in to your trading desk.</p>

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
              />
            </div>

            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            {needsTotp && (
              <div className="field">
                <label htmlFor="totp">Authentication code</label>
                <input
                  id="totp"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="6-digit code"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                />
              </div>
            )}

            {error !== null && <div className={needsTotp ? 'hint' : 'error'}>{error}</div>}

            <button className="btn btn-lg" type="submit" disabled={busy}>
              {busy ? 'Signing in…' : 'Log in'}
            </button>
          </form>

          <p className="auth-alt muted">Need an account? <Link to="/signup">Create one</Link></p>

          <div className="demo-hint">
            Demo access: <code>demo@tradex.local</code> / <code>tradex-demo-123</code>
            <br />Run <code>npm run db:seed</code> first if the login is not recognised.
          </div>

          <p className="auth-back muted"><Link to="/">← Back to home</Link></p>
        </div>
      </main>
    </div>
  );
}
