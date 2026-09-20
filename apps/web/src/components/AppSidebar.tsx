import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Brand } from './Brand.tsx';

interface NavItem {
  readonly label: string;
  readonly icon: ReactNode;
  readonly to?: string;
  readonly soon?: boolean;
  readonly match?: (path: string) => boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  {
    label: 'Trade',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    ),
    to: '/app',
    match: (p) => p === '/app' || p.startsWith('/app/trades'),
  },
  {
    label: 'Orders',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
        <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        <line x1="9" y1="12" x2="15" y2="12" />
        <line x1="9" y1="16" x2="13" y2="16" />
      </svg>
    ),
    to: '/app/activity',
    match: (p) => p.startsWith('/app/activity'),
  },
  {
    label: 'Positions',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
      </svg>
    ),
    to: '/app/positions',
    match: (p) => p.startsWith('/app/positions'),
  },
  {
    label: 'Analytics',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 3v18h18" />
        <path d="M18 17l-5-5-4 4-4-4" />
        <circle cx="18" cy="17" r="1.5" />
        <circle cx="13" cy="12" r="1.5" />
        <circle cx="9" cy="16" r="1.5" />
        <circle cx="5" cy="12" r="1.5" />
      </svg>
    ),
    to: '/app/analytics',
    match: (p) => p.startsWith('/app/analytics'),
  },
  {
    label: 'Accounts',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    to: '/app/accounts',
    match: (p) => p.startsWith('/app/accounts'),
  },
  {
    label: 'Groups',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polygon points="12 2 2 7 12 12 22 7 12 2" />
        <polyline points="2 17 12 22 22 17" />
        <polyline points="2 12 12 17 22 12" />
      </svg>
    ),
    to: '/app/groups',
    match: (p) => p.startsWith('/app/groups'),
  },
  {
    label: 'Inquiries',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
        <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      </svg>
    ),
    to: '/app/inquiries',
    match: (p) => p.startsWith('/app/inquiries'),
  },
  {
    label: 'Reports',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
        <polyline points="17 6 23 6 23 12" />
      </svg>
    ),
    to: '/app/report',
    match: (p) => p.startsWith('/app/report'),
  },
  {
    label: 'Audit',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="16" y1="13" x2="8" y2="13" />
        <line x1="16" y1="17" x2="8" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    ),
    to: '/app/audit',
    match: (p) => p.startsWith('/app/audit'),
  },
  {
    label: 'Security',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      </svg>
    ),
    to: '/app/security',
    match: (p) => p.startsWith('/app/security'),
  },
  {
    label: 'Settings',
    icon: (
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
    to: '/app/settings',
    match: (p) => p.startsWith('/app/settings'),
  },
];

interface Props {
  readonly role: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onLogout: () => void;
  readonly impersonating?: boolean;
  readonly onRevertMaster?: () => void;
}

export function AppSidebar({ role, open, onClose, onLogout, impersonating, onRevertMaster }: Props) {
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
        <div className="sidebar-brand-wrapper desktop-only">
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
          {impersonating && (
            <button
              type="button"
              className="thin-logout-btn"
              style={{
                marginBottom: '8px',
                color: '#8fb6ff',
                borderColor: 'rgba(143, 182, 255, 0.3)',
                background: 'rgba(76, 141, 255, 0.08)',
              }}
              title="Return to Master Panel"
              onClick={() => {
                onClose();
                onRevertMaster?.();
              }}
            >
              <span className="thin-sb-ico">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                  <polyline points="10 17 15 12 10 7" />
                  <line x1="15" y1="12" x2="3" y2="12" />
                </svg>
              </span>
              <span className="logout-text">Master Desk</span>
            </button>
          )}
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
            <span className="thin-sb-ico">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </span>
            <span className="logout-text">Exit</span>
          </button>
        </div>
      </aside>
    </>
  );
}
