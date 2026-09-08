import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { fetchSession, login as apiLogin, logout as apiLogout, signup as apiSignup } from './api.ts';
import type { LoginInput, SessionInfo, SignupInput } from './api.ts';

// The client-side auth model. It mirrors, never replaces, the server's decision:
// the httpOnly session cookie is the real credential (the browser cannot read it),
// and this context only tracks whether the server currently accepts it, so the UI
// can route between the public pages and the gated panel. Every protected API call
// is still authorised server-side regardless of what this context believes.

type AuthState =
  | { readonly status: 'loading' }
  | { readonly status: 'anonymous' }
  | { readonly status: 'authenticated'; readonly session: SessionInfo };

interface AuthContextValue {
  readonly state: AuthState;
  /** Log in and refresh the session. Rejects (with the ApiError) on failure. */
  login: (input: LoginInput) => Promise<void>;
  /** Create a workspace + owner and refresh the session. Rejects on failure. */
  signup: (input: SignupInput) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  // On first load, ask the server whether the cookie we may already hold is live.
  // This is what makes a refresh keep you logged in without a login form.
  useEffect(() => {
    let cancelled = false;
    void fetchSession()
      .then((session) => {
        if (cancelled) return;
        setState(session === null ? { status: 'anonymous' } : { status: 'authenticated', session });
      })
      .catch(() => { if (!cancelled) setState({ status: 'anonymous' }); });
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (input: LoginInput) => {
    await apiLogin(input);
    // The cookie is set; read the session back so the context reflects the role.
    const session = await fetchSession();
    setState(session === null ? { status: 'anonymous' } : { status: 'authenticated', session });
  }, []);

  const signup = useCallback(async (input: SignupInput) => {
    await apiSignup(input);
    // Signup sets the session cookie too; read it back so the context reflects
    // the new owner and the app routes them straight in.
    const session = await fetchSession();
    setState(session === null ? { status: 'anonymous' } : { status: 'authenticated', session });
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo<AuthContextValue>(() => ({ state, login, signup, logout }), [state, login, signup, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
}

/**
 * Gate a subtree behind a live session. While the session is being resolved it
 * shows a neutral placeholder (so a refresh does not flash the login page); with
 * no session it redirects to /login, remembering where the user was headed so
 * login can send them back.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const location = useLocation();

  if (state.status === 'loading') {
    return <div className="panel muted">Checking your session…</div>;
  }
  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}
