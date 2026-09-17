import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { ApiError } from '../api.ts';
import { Brand } from '../components/Brand.tsx';

// The signup page. Public, and the second door beside login. It creates a whole
// workspace — a tenant and its owner user — then the server issues a session so
// the new owner lands straight in the panel. No exchange key is asked for here;
// connecting a key is a separate step once inside. Matches the light editorial
// theme of the landing and login so the public surface reads as one system.

const MIN_PASSWORD = 12;

export function Signup() {
  const { state, signup } = useAuth();
  const navigate = useNavigate();

  const [orgName, setOrgName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (state.status === 'authenticated') return <Navigate to="/app" replace />;

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD) {
      setError(`Password must be at least ${MIN_PASSWORD} characters.`);
      return;
    }
    setBusy(true);
    try {
      await signup({ orgName, email, password });
      navigate('/app', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('Something went wrong. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const [showPassword, setShowPassword] = useState(false);

  return (
    <div className="auth-split auth-dark">
      <aside className="auth-aside">
        <Brand to="/" size="lg" />
        <div>
          <p className="auth-aside-quote">
            Your algorithmic desk, <span className="grad">set up in seconds.</span>
          </p>
          <ul className="auth-aside-points">
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Connect your trading accounts</strong> via read/trade restricted API keys</span>
            </li>
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Automated risk management</strong> and 100% capital protection</span>
            </li>
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Transparent real-time telemetry</strong> &amp; weekly performance reports</span>
            </li>
            <li>
              <span className="auth-point-icon">✓</span>
              <span><strong>Zero custody risk</strong> — your funds never leave your personal exchange wallet</span>
            </li>
          </ul>
        </div>

        <div className="auth-system-badge">
          <span className="auth-status-pulse" />
          <span>Onboarding System: Open · Instant Verification</span>
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div className="auth-card-brand">
            <Brand to="/" size="md" />
          </div>

          <h2>Create your workspace</h2>
          <p className="sub">You&rsquo;ll be the owner. No card or exchange key required to begin.</p>

          <form onSubmit={submit}>
            <div className="auth-field">
              <label htmlFor="org">Workspace name</label>
              <div className="auth-input-wrap">
                <span className="auth-input-icon">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect width="16" height="20" x="4" y="2" rx="2" ry="2" />
                    <path d="M9 22v-4h6v4" />
                    <path d="M8 6h.01" />
                    <path d="M16 6h.01" />
                    <path d="M12 6h.01" />
                    <path d="M12 10h.01" />
                    <path d="M12 14h.01" />
                    <path d="M16 10h.01" />
                    <path d="M16 14h.01" />
                    <path d="M8 10h.01" />
                    <path d="M8 14h.01" />
                  </svg>
                </span>
                <input
                  id="org"
                  type="text"
                  autoComplete="organization"
                  placeholder="e.g. Alpha Momentum Desk"
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  required
                />
              </div>
            </div>

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
                  autoComplete="email"
                  placeholder="name@company.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            <div className="auth-field">
              <label htmlFor="password">Password</label>
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
                  autoComplete="new-password"
                  placeholder="At least 12 characters"
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
              <div style={{ marginTop: '6px' }}>
                {tooShort ? (
                  <span style={{ color: '#f87171', fontSize: '12px' }}>
                    {MIN_PASSWORD - password.length} more character{MIN_PASSWORD - password.length === 1 ? '' : 's'} needed.
                  </span>
                ) : (
                  <span style={{ color: '#94a3b8', fontSize: '12px' }}>
                    Use at least 12 characters. Length beats complexity.
                  </span>
                )}
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

            <button className="auth-btn-submit" type="submit" disabled={busy || orgName === '' || email === '' || password === ''}>
              {busy ? 'Creating…' : 'Create Workspace →'}
            </button>
          </form>

          <p className="auth-footer-links">
            Already have an account? <Link to="/login">Log in</Link>
          </p>
          <p className="auth-home-link">
            <Link to="/">← Back to Aza WealthKare</Link>
          </p>
        </div>
      </main>
    </div>
  );
}
