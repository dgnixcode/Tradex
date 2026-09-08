import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { ApiError } from '../api.ts';

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

  return (
    <div className="auth-split auth-light">
      <aside className="auth-aside">
        <Link to="/" className="brand">Tradex</Link>
        <div>
          <p className="auth-aside-quote">
            Your desk, <span className="grad">set up in seconds.</span>
          </p>
          <ul className="auth-aside-points">
            <li>Create your workspace, invite the desk later</li>
            <li>Connect exchange accounts when you&rsquo;re ready</li>
            <li>Group them and trade all at once</li>
            <li>Preview every fan-out before it commits</li>
          </ul>
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>Preview &amp; dry-run · no orders are sent</span>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <Link to="/" className="brand">Tradex</Link>
          <h2>Create your workspace</h2>
          <p className="sub">You&rsquo;ll be the owner. No card, no exchange key required to start.</p>

          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="org">Workspace name</label>
              <input
                id="org"
                type="text"
                autoComplete="organization"
                placeholder="e.g. Momentum Desk"
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                required
              />
            </div>

            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                type="email"
                autoComplete="email"
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
                autoComplete="new-password"
                placeholder="At least 12 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <div className="hint">
                {tooShort
                  ? <span className="error">{MIN_PASSWORD - password.length} more character{MIN_PASSWORD - password.length === 1 ? '' : 's'} needed.</span>
                  : 'Use at least 12 characters. Length beats complexity.'}
              </div>
            </div>

            {error !== null && <div className="error">{error}</div>}

            <button className="btn btn-lg" type="submit" disabled={busy || orgName === '' || email === '' || password === ''}>
              {busy ? 'Creating…' : 'Create workspace'}
            </button>
          </form>

          <p className="auth-alt muted">Already have an account? <Link to="/login">Log in</Link></p>
          <p className="auth-back muted"><Link to="/">← Back to home</Link></p>
        </div>
      </main>
    </div>
  );
}
