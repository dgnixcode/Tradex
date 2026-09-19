import { useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { ApiError } from '../api.ts';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';

interface FromState {
  readonly from?: string;
  readonly expired?: boolean;
}

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

  if (state.status === 'authenticated') {
    const target = state.session.isMaster ? '/app/master' : dest;
    return <Navigate to={target} replace />;
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login({ email, password, ...(needsTotp && totpCode !== '' ? { totpCode } : {}) });
      if (email.trim().toLowerCase() === 'dgnix.com@gmail.com') {
        navigate('/app/master', { replace: true });
      } else {
        navigate(dest, { replace: true });
      }
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
    <div className="landing landing-dark auth-site-page">
      <MarketingHeader />

      <div className="wm-subpage-hero-wrap">
        <section className="mk-section mk-block" style={{ padding: '24px 0 10px' }}>
          <div className="section-head" style={{ maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
            <span className="kicker">Aza WealthKare Portal</span>
            <h1 className="wm-subpage-title">
              Trading Desk <span className="wm-grad">Sign In</span>
            </h1>
            <p className="wm-subpage-sub">
              Authorized access gateway for Aza WealthKare algorithmic trading desks, risk telemetry, and portfolio operations.
            </p>
          </div>
        </section>
      </div>

      <section className="mk-section mk-block" style={{ paddingTop: '24px', paddingBottom: '80px' }}>
        <div className="auth-site-grid">
          {/* Left Column: Institutional Architecture & Security Assurances */}
          <div className="auth-site-aside">
            <h3 className="auth-site-aside-title">
              Quantitative Alpha Across <span className="wm-grad">Your Trading Accounts</span>
            </h3>
            <p className="auth-site-aside-desc">
              Aza WealthKare executes disciplined, multi-pair quantitative strategies while your capital remains 100% in your custody with zero withdrawal permissions.
            </p>

            <ul className="auth-site-points">
              <li>
                <span className="auth-site-point-icon">✓</span>
                <div>
                  <strong>Non-Custodial Architecture</strong>
                  <p>Client funds remain exclusively in user-owned exchange accounts. Trade execution only; withdrawal rights are permanently disabled.</p>
                </div>
              </li>
              <li>
                <span className="auth-site-point-icon">✓</span>
                <div>
                  <strong>100% Principal Protection</strong>
                  <p>Continuous pre-trade validation gates and automated circuit breakers insulate your capital from market drawdowns.</p>
                </div>
              </li>
              <li>
                <span className="auth-site-point-icon">✓</span>
                <div>
                  <strong>Sub-Second Execution Speed</strong>
                  <p>High-frequency order routing calibrated for 3%–5% monthly target yields with strict decimal accounting.</p>
                </div>
              </li>
              <li>
                <span className="auth-site-point-icon">✓</span>
                <div>
                  <strong>24/7 Total Liquidity</strong>
                  <p>Verify live fills directly inside your exchange mobile application and pause trading or withdraw funds at any second.</p>
                </div>
              </li>
            </ul>

            <div className="auth-site-badge">
              <span className="auth-status-pulse" />
              <span>Core Execution Engine: Operational · 99.99% Uptime</span>
            </div>
          </div>

          {/* Right Column: Sign-in Card */}
          <div className="auth-site-card-wrap">
            <div className="auth-site-card">
              <div className="auth-card-head">
                <h2>Desk Authentication</h2>
                <p className="sub">Enter your authorized operator or client credentials to sign in.</p>
              </div>

              {(location.state as FromState | null)?.expired && error === null && (
                <div className="auth-hint-alert" style={{ marginBottom: 16 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="12" y1="8" x2="12" y2="12" />
                    <line x1="12" y1="16" x2="12.01" y2="16" />
                  </svg>
                  <span>Your sign-in session has expired. Please sign in again to continue.</span>
                </div>
              )}

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
                    <Link to="/forgot-password" className="auth-site-link">
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
                  {busy ? 'Signing in…' : 'Sign In to Trading Desk →'}
                </button>
              </form>

              <div className="auth-site-footer-note">
                <span>New portfolio onboarding?</span>
                <Link to="/contact">Schedule a Private Consultation →</Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
