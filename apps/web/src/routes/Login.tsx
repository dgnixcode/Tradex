import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { ApiError } from '../api.ts';
import { Brand } from '../components/Brand.tsx';

// The login page. Public, and the primary gateway into the panel. A two-panel split:
// an institutional dark branded aside detailing non-custodial execution and protection,
// and a glassmorphic form card with one-tap demo login, password visibility toggle,
// and TOTP second-factor support.

interface FromState { readonly from?: string }

export function Login() {
  const { state, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const dest = (location.state as FromState | null)?.from ?? '/app';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [needsTotp, setNeedsTotp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === 'authenticated') return <Navigate to={dest} replace />;

  const handleFillDemo = () => {
    setEmail('demo@tradex.local');
    setPassword('tradex-demo-123');
    setError(null);
  };

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
    <div className="auth-split auth-dark">
      <aside className="auth-aside">
        <Brand to="/" size="lg" />
        <div>
          <p className="auth-aside-quote">
            Institutional algorithmic execution across <span className="grad">your trading accounts</span>.
          </p>
          <ul className="auth-aside-points">
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Non-custodial API architecture</strong> — funds remain securely in your custody</span>
            </li>
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>100% Principal protection</strong> backed by automated risk gates</span>
            </li>
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Sub-second multi-pair execution</strong> calibrated for crypto alpha</span>
            </li>
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Exact-decimal accounting</strong> with zero floating-point drift</span>
            </li>
          </ul>
        </div>

        <div className="auth-system-badge">
          <span className="auth-status-pulse" />
          <span>Core Execution Engine: Operational · 99.99% Uptime</span>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-brand">
            <Brand to="/" size="md" />
          </div>

          <h2>Welcome back</h2>
          <p className="sub">Sign in to access your trading desk &amp; live algorithmic positions.</p>

          {error !== null && (
            <div className={needsTotp ? 'auth-hint-alert' : 'auth-error-alert'}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
              <span>{error}</span>
            </div>
          )}

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
                />
              </div>
            </div>

            <div className="auth-field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '7px' }}>
                <label htmlFor="password" style={{ marginBottom: 0 }}>Password</label>
                <Link to="/forgot-password" style={{ fontSize: '12.5px', color: '#34d399', textDecoration: 'none' }}>
                  Forgot password?
                </Link>
              </div>
              <div className="auth-input-wrap has-toggle">
                <span className="auth-input-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </span>
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="auth-pw-toggle"
                  onClick={() => setShowPassword(!showPassword)}
                  title={showPassword ? 'Hide password' : 'Show password'}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? (
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
            </div>

            {needsTotp && (
              <div className="auth-field">
                <label htmlFor="totp">Two-Factor Authentication Code</label>
                <div className="auth-input-wrap">
                  <span className="auth-input-icon">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                    </svg>
                  </span>
                  <input
                    id="totp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6-digit authentication code"
                    value={totpCode}
                    onChange={(e) => setTotpCode(e.target.value)}
                    autoFocus
                  />
                </div>
              </div>
            )}

            <button className="auth-btn-submit" type="submit" disabled={busy}>
              {busy ? (
                'Signing in…'
              ) : (
                'Sign In to Trading Desk →'
              )}
            </button>
          </form>

          <div className="auth-demo-card">
            <div className="auth-demo-card-head">
              <span className="auth-demo-pill-tag">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                One-Tap Demo Access
              </span>
              <button
                type="button"
                className="auth-demo-fill-btn"
                onClick={handleFillDemo}
              >
                Auto-Fill Demo
              </button>
            </div>
            <div className="auth-demo-card-body">
              Instant evaluation credentials: <code>demo@tradex.local</code> · <code>tradex-demo-123</code>
            </div>
          </div>

          <p className="auth-footer-links">
            Don&rsquo;t have an account? <Link to="/signup">Register now</Link>
          </p>

          <p className="auth-home-link">
            <Link to="/">← Back to Aza WealthKare</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
