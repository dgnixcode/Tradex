import { useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from './auth.tsx';
import { AppSidebar } from './components/AppSidebar.tsx';

// The authenticated panel shell with thin sidebar and full height trading terminal.
export function App() {
  const { state, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const onLogout = async () => {
    await logout();
    navigate('/', { replace: true });
  };

  const role = state.status === 'authenticated' ? state.session.role : '';

  return (
    <div className="panel-dark">
      <div className="app-layout">
        <AppSidebar
          role={role}
          open={menuOpen}
          onClose={() => setMenuOpen(false)}
          onLogout={onLogout}
        />
        <div className="app-main">
          <div className="app-content">
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
