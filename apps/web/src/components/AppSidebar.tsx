import { Link, useLocation } from 'react-router-dom';

// The authenticated panel's left sidebar. Grouped nav with room for the many
// menus that will land later — today only "Trade" is live; the rest are shown as
// disabled "soon" items so the shape of the product is visible without pretending
// the routes exist. Adding a real menu later is just moving an item from
// SOON into a group with a `to`.

interface NavItem {
  readonly label: string;
  readonly icon: string;
  readonly to?: string;        // present = live route
  readonly soon?: boolean;     // present = disabled placeholder
  readonly match?: (path: string) => boolean;
}

interface NavGroup {
  readonly title: string;
  readonly items: readonly NavItem[];
}

const GROUPS: readonly NavGroup[] = [
  {
    title: 'Trading',
    items: [
      { label: 'Trade', icon: '⚡', to: '/app', match: (p) => p === '/app' || p.startsWith('/app/trades') },
      { label: 'Orders', icon: '📋', soon: true },
      { label: 'Positions', icon: '📊', to: '/app/positions', match: (p) => p.startsWith('/app/positions') },
    ],
  },
  {
    title: 'Manage',
    items: [
      { label: 'Accounts', icon: '🔗', to: '/app/accounts', match: (p) => p.startsWith('/app/accounts') },
      { label: 'Groups', icon: '🗂', to: '/app/groups', match: (p) => p.startsWith('/app/groups') },
      { label: 'Audit', icon: '🧾', to: '/app/audit', match: (p) => p.startsWith('/app/audit') },
      { label: 'Reports', icon: '📈', soon: true },
    ],
  },
  {
    title: 'Workspace',
    items: [
      { label: 'Desk controls', icon: '🛑', to: '/app/trading', match: (p) => p.startsWith('/app/trading') },
      { label: 'Security & 2FA', icon: '🔐', to: '/app/security', match: (p) => p.startsWith('/app/security') },
      { label: 'Settings', icon: '⚙️', soon: true },
      { label: 'Members', icon: '👥', soon: true },
    ],
  },
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
      <aside className={`app-sidebar${open ? ' open' : ''}`}>
        <Link to="/app" className="brand" onClick={onClose}>Tradex</Link>

        {GROUPS.map((group) => (
          <div key={group.title} className="sb-group">
            <div className="sb-group-title">{group.title}</div>
            {group.items.map((item) => {
              if (item.to !== undefined) {
                const active = item.match?.(pathname) ?? pathname === item.to;
                return (
                  <Link
                    key={item.label}
                    to={item.to}
                    className={`sb-link${active ? ' active' : ''}`}
                    onClick={onClose}
                  >
                    <span className="sb-ico">{item.icon}</span>{item.label}
                  </Link>
                );
              }
              return (
                <div key={item.label} className="sb-link disabled" aria-disabled="true">
                  <span className="sb-ico">{item.icon}</span>{item.label}
                  {item.soon === true && <span className="sb-soon">soon</span>}
                </div>
              );
            })}
          </div>
        ))}

        <div className="app-sidebar-foot">
          <span className="who">Signed in · {role}</span>
          <button className="btn secondary btn-sm" onClick={onLogout}>Log out</button>
        </div>
      </aside>
    </>
  );
}
