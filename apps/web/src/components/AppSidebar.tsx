import { Link, useLocation } from 'react-router-dom';
import { Brand } from './Brand.tsx';

interface NavItem {
  readonly label: string;
  readonly icon: string;
  readonly to?: string;
  readonly soon?: boolean;
  readonly match?: (path: string) => boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { label: 'Trade', icon: '⚡', to: '/app', match: (p) => p === '/app' || p.startsWith('/app/trades') },
  { label: 'Orders', icon: '📋', to: '/app/activity', match: (p) => p.startsWith('/app/activity') },
  { label: 'Positions', icon: '📊', to: '/app/positions', match: (p) => p.startsWith('/app/positions') },
  { label: 'Accounts', icon: '🔗', to: '/app/accounts', match: (p) => p.startsWith('/app/accounts') },
  { label: 'Groups', icon: '🗂', to: '/app/groups', match: (p) => p.startsWith('/app/groups') },
  { label: 'Inquiries', icon: '📥', to: '/app/inquiries', match: (p) => p.startsWith('/app/inquiries') },
  { label: 'Controls', icon: '🛑', to: '/app/trading', match: (p) => p.startsWith('/app/trading') },
  { label: 'Reports', icon: '📈', to: '/app/report', match: (p) => p.startsWith('/app/report') },
  { label: 'Audit', icon: '🧾', to: '/app/audit', match: (p) => p.startsWith('/app/audit') },
  { label: 'Security', icon: '🔐', to: '/app/security', match: (p) => p.startsWith('/app/security') },
  { label: 'Settings', icon: '⚙️', to: '/app/settings', match: (p) => p.startsWith('/app/settings') },
];

interface Props {
  readonly role: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onLogout: () => void;
}

export function AppSidebar({ role, open, onClose, onLogout }: Props) {
  const { pathname } = useLocation();

  return (
    <>
      {open && <div className="app-sidebar-scrim" onClick={onClose} />}
      <aside className={`app-sidebar thin-sidebar${open ? ' open' : ''}`}>
        {/* Mobile Drawer Header (<= 860px) */}
        <div className="sidebar-drawer-header">
          <Brand to="/app" onClick={onClose} size="sm" />
          <button
            type="button"
            className="sidebar-close-btn"
            onClick={onClose}
            aria-label="Close menu"
          >
            ✕
          </button>
        </div>

        {/* Desktop Brand Icon (> 860px) */}
        <div className="sidebar-brand-wrapper desktop-only" style={{ padding: '8px 0 16px', display: 'flex', justifyContent: 'center' }}>
          <Brand to="/app" onClick={onClose} showName={false} size="sm" />
        </div>

        {/* Navigation Items */}
        <nav className="thin-nav">
          {NAV_ITEMS.map((item) => {
            if (item.to !== undefined) {
              const active = item.match?.(pathname) ?? pathname === item.to;
              return (
                <Link
                  key={item.label}
                  to={item.to}
                  title={item.label}
                  className={`thin-sb-link${active ? ' active' : ''}`}
                  onClick={onClose}
                >
                  <span className="thin-sb-ico">{item.icon}</span>
                  <span className="thin-sb-label">{item.label}</span>
                </Link>
              );
            }
            return (
              <div
                key={item.label}
                title={`${item.label} (coming soon)`}
                className="thin-sb-link disabled"
                aria-disabled="true"
              >
                <span className="thin-sb-ico">{item.icon}</span>
                <span className="thin-sb-label">{item.label}</span>
              </div>
            );
          })}
        </nav>

        {/* Footer Logout */}
        <div className="thin-sidebar-foot">
          <div className="drawer-role-badge">
            <span className="drawer-role-label">Role</span>
            <span className="drawer-role-value">{role || 'Authorized'}</span>
          </div>
          <button
            type="button"
            className="thin-logout-btn"
            title={`Signed in as ${role} · Click to Log out`}
            onClick={() => {
              onClose();
              onLogout();
            }}
          >
            <span style={{ fontSize: 16 }}>🚪</span>
            <span className="logout-text">Exit</span>
          </button>
        </div>
      </aside>
    </>
  );
}
