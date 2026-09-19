import { useState } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth.tsx';
import { revertMasterSession } from './api.ts';
import { AppSidebar } from './components/AppSidebar.tsx';
import { Brand } from './components/Brand.tsx';
import { GlobalPositionAlerts } from './components/GlobalPositionAlerts.tsx';

// The authenticated panel shell with thin sidebar and responsive mobile layout.
export function App() {
  const { state, logout, refreshSession } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const onLogout = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  const onRevertMaster = async () => {
    try {
      await revertMasterSession();
      await refreshSession();
      navigate('/app/master', { replace: true });
    } catch {
      // Revert failure
    }
  };

  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace state={{ from: location.pathname, expired: true }} />;
  }

  if (state.status === 'authenticated' && state.session.isMaster && !state.session.impersonating) {
    return <Navigate to="/app/master" replace />;
  }

  const role = state.status === 'authenticated' ? state.session.role : '';
  const pathname = location.pathname;

  // Primary bottom navigation items for mobile
  const bottomNavItems = [
    {
      label: 'Trade',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      ),
      to: '/app',
      active: pathname === '/app' || pathname.startsWith('/app/trades'),
    },
    {
      label: 'Positions',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="20" x2="18" y2="10" />
          <line x1="12" y1="20" x2="12" y2="4" />
          <line x1="6" y1="20" x2="6" y2="14" />
        </svg>
      ),
      to: '/app/positions',
      active: pathname.startsWith('/app/positions'),
    },
    {
      label: 'Orders',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
          <line x1="9" y1="12" x2="15" y2="12" />
          <line x1="9" y1="16" x2="13" y2="16" />
        </svg>
      ),
      to: '/app/activity',
      active: pathname.startsWith('/app/activity'),
    },
    {
      label: 'Accounts',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      ),
      to: '/app/accounts',
      active: pathname.startsWith('/app/accounts'),
    },
    {
      label: 'More',
      icon: (
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="3" y1="12" x2="21" y2="12" />
          <line x1="3" y1="6" x2="21" y2="6" />
          <line x1="3" y1="18" x2="21" y2="18" />
        </svg>
      ),
      action: () => setMenuOpen(true),
      active: menuOpen,
    },
  ];

  return (
    <div className="panel-dark">
      {/* Mobile Top Header (<= 860px) */}
      <header className="panel-mobile-header">
        <button
          type="button"
          className="mobile-header-btn"
          onClick={() => setMenuOpen((o) => !o)}
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={menuOpen}
        >
          <span style={{ fontSize: 20, lineHeight: 1 }}>{menuOpen ? '✕' : '☰'}</span>
        </button>

        <div className="mobile-header-brand">
          <Brand to="/app" size="sm" />
        </div>

        <div className="mobile-header-actions">
          <span
            className="mobile-status-pill"
            title="Desk status: Active"
          >
            <span className="mobile-status-dot" />
            <span className="mobile-status-text">Live</span>
          </span>
          <button
            type="button"
            className="mobile-header-exit"
            onClick={onLogout}
            title={`Signed in as ${role} · Exit`}
            aria-label="Log out"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="app-layout">
        <AppSidebar
          role={role}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          onLogout={onLogout}
          impersonating={state.status === 'authenticated' && Boolean(state.session.impersonating)}
          onRevertMaster={onRevertMaster}
        />
        <main className="app-main">
          <GlobalPositionAlerts />
          <div className="app-content">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar (<= 860px) */}
      <nav className="panel-mobile-bottom-nav" aria-label="Mobile Navigation">
        {bottomNavItems.map((item) => {
          if (item.to) {
            return (
              <Link
                key={item.label}
                to={item.to}
                className={`mobile-bottom-tab${item.active ? ' active' : ''}`}
                onClick={() => setMenuOpen(false)}
              >
                <span className="mobile-tab-icon">{item.icon}</span>
                <span className="mobile-tab-label">{item.label}</span>
              </Link>
            );
          }
          return (
            <button
              key={item.label}
              type="button"
              className={`mobile-bottom-tab${item.active ? ' active' : ''}`}
              onClick={item.action}
              aria-label="Open full menu"
            >
              <span className="mobile-tab-icon">{item.icon}</span>
              <span className="mobile-tab-label">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
