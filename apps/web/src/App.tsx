import { useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from './auth.tsx';
import { AppSidebar } from './components/AppSidebar.tsx';
import { AppTopbar } from './components/AppTopbar.tsx';

// The authenticated panel shell. Renders ONLY inside the guarded area (mounted
// under RequireAuth), so it can assume a session. It owns the light sidebar +
// topbar layout and the mobile sidebar-open state (shared between the topbar's
// menu button and the sidebar itself). The section title is derived from the
// route, so each screen names itself in the bar.
export function App() {
  const { state, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  const onLogout = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  const role = state.status === 'authenticated' ? state.session.role : '';
  let title = 'New group trade';
  if (pathname.startsWith('/app/trades')) title = 'Confirm trade';
  else if (pathname.startsWith('/app/groups/')) title = 'Group';
  else if (pathname.startsWith('/app/groups')) title = 'Groups';
  else if (pathname.startsWith('/app/accounts/connect')) title = 'Connect account';
  else if (pathname.startsWith('/app/accounts')) title = 'Accounts';
  else if (pathname.startsWith('/app/positions')) title = 'Positions';
  else if (pathname.startsWith('/app/trading')) title = 'Desk controls';
  else if (pathname.startsWith('/app/security')) title = 'Security';
  else if (pathname.startsWith('/app/audit')) title = 'Audit';

  return (
    <div className="panel-light">
      <div className="app-layout">
        <AppSidebar
          role={role}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          onLogout={onLogout}
        />
        <div className="app-main">
          <AppTopbar title={title} role={role} onMenu={() => setMenuOpen(true)} />
          <div className="app-content">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
