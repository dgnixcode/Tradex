import { useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth.tsx';
import { AppSidebar } from './components/AppSidebar.tsx';
import { Brand } from './components/Brand.tsx';

// The authenticated panel shell with thin sidebar and responsive mobile layout.
export function App() {
  const { state, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const onLogout = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  const role = state.status === 'authenticated' ? state.session.role : '';
  const pathname = location.pathname;

  // Primary bottom navigation items for mobile
  const bottomNavItems = [
    { label: 'Trade', icon: '⚡', to: '/app', active: pathname === '/app' || pathname.startsWith('/app/trades') },
    { label: 'Positions', icon: '📊', to: '/app/positions', active: pathname.startsWith('/app/positions') },
    { label: 'Orders', icon: '📋', to: '/app/activity', active: pathname.startsWith('/app/activity') },
    { label: 'Accounts', icon: '🔗', to: '/app/accounts', active: pathname.startsWith('/app/accounts') },
    { label: 'More', icon: '☰', action: () => setMenuOpen(true), active: menuOpen },
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
            🚪
          </button>
        </div>
      </header>

      <div className="app-layout">
        <AppSidebar
          role={role}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          onLogout={onLogout}
        />
        <main className="app-main">
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
