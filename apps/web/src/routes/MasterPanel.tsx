import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../auth.tsx';
import { fetchMasterUsers, impersonateUser, revertMasterSession } from '../api.ts';
import type { MasterUserRow } from '../api.ts';
import { Brand } from '../components/Brand.tsx';

export function MasterPanel() {
  const { state, logout, refreshSession } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'owner' | 'trader' | 'viewer'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'disabled'>('all');

  const [selectedUser, setSelectedUser] = useState<MasterUserRow | null>(null);
  const [isImpersonating, setIsImpersonating] = useState(false);
  const [impersonateError, setImpersonateError] = useState<string | null>(null);

  const [isReverting, setIsReverting] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['masterUsers'],
    queryFn: () => fetchMasterUsers(),
    refetchInterval: 15000,
    enabled: state.status === 'authenticated' && Boolean(state.session.isMaster),
  });

  if (state.status === 'anonymous') {
    return <Navigate to="/login" replace />;
  }

  if (state.status === 'authenticated' && !state.session.isMaster) {
    if (state.session.impersonating) {
      return (
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--text)' }}>
          <div style={{ textAlign: 'center', maxWidth: 440, padding: 32, background: 'var(--card-bg, #151b28)', border: '1px solid var(--line, #243046)', borderRadius: 14 }}>
            <h3 style={{ margin: '0 0 12px', fontSize: 18, fontWeight: 700 }}>Impersonated Session Active</h3>
            <p style={{ margin: '0 0 24px', color: 'var(--muted, #94a3b8)', fontSize: 13.5, lineHeight: 1.5 }}>
              You are currently viewing workspace as <strong>{state.session.email}</strong>.
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              <button
                type="button"
                className="btn primary"
                disabled={isReverting}
                onClick={async () => {
                  setIsReverting(true);
                  try {
                    await revertMasterSession();
                    await refreshSession();
                    queryClient.clear();
                  } finally {
                    setIsReverting(false);
                  }
                }}
              >
                {isReverting ? 'Returning...' : 'Return to Master Panel'}
              </button>
              <button
                type="button"
                className="btn secondary"
                onClick={() => navigate('/app')}
              >
                Go to Workspace
              </button>
            </div>
          </div>
        </div>
      );
    }
    return <Navigate to="/app" replace />;
  }

  const users = data?.users ?? [];

  const filteredUsers = users.filter((u) => {
    if (roleFilter !== 'all' && u.role !== roleFilter) return false;
    if (statusFilter === 'active' && u.disabledAt !== null) return false;
    if (statusFilter === 'disabled' && u.disabledAt === null) return false;

    if (search.trim()) {
      const q = search.toLowerCase().trim();
      const matchEmail = u.email.toLowerCase().includes(q);
      const matchTenant = u.tenantName.toLowerCase().includes(q);
      const matchTenantId = u.tenantId.toLowerCase().includes(q);
      return matchEmail || matchTenant || matchTenantId;
    }
    return true;
  });

  const totalUsers = users.length;
  const uniqueWorkspaces = new Set(users.map((u) => u.tenantId)).size;
  const totalAccounts = users.reduce((acc, u) => acc + u.accountCount, 0);
  const activeUsersCount = users.filter((u) => u.disabledAt === null).length;

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const handleConfirmImpersonate = async () => {
    if (!selectedUser) return;
    setIsImpersonating(true);
    setImpersonateError(null);
    try {
      const res = await impersonateUser(selectedUser.userId);
      await refreshSession();
      queryClient.clear();
      navigate(res.dest || '/app', { replace: true });
    } catch (err) {
      setImpersonateError(err instanceof Error ? err.message : 'Failed to switch user account');
      setIsImpersonating(false);
    }
  };

  const formatDate = (isoString: string | null): string => {
    if (!isoString) return 'Never';
    try {
      const d = new Date(isoString);
      return d.toLocaleDateString('en-IN', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return isoString;
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Top Header Bar */}
      <header
        style={{
          borderBottom: '1px solid var(--line)',
          background: 'var(--panel)',
          padding: '14px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <Brand to="/app/master" size="md" />
          <div
            style={{
              height: '24px',
              width: '1px',
              background: 'var(--line)',
            }}
          />
          <div>
            <div style={{ fontSize: '15px', fontWeight: 700, letterSpacing: '-0.01em' }}>
              Master Administration Desk
            </div>
            <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
              Platform Super-Admin &amp; Tenant User Management
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div
            style={{
              padding: '6px 12px',
              background: 'rgba(76, 141, 255, 0.12)',
              border: '1px solid rgba(76, 141, 255, 0.3)',
              borderRadius: '999px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              fontSize: '12.5px',
            }}
          >
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: '#4c8dff',
                boxShadow: '0 0 8px #4c8dff',
              }}
            />
            <span style={{ color: 'var(--text-dim)' }}>Operator:</span>
            <strong style={{ color: '#8fb6ff' }}>
              {state.status === 'authenticated' ? state.session.email : 'dgnix.com@gmail.com'}
            </strong>
          </div>

          <button
            type="button"
            onClick={() => refetch()}
            style={{
              padding: '7px 14px',
              background: 'var(--panel-2)',
              border: '1px solid var(--line)',
              borderRadius: '6px',
              color: 'var(--text)',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 500,
            }}
          >
            Refresh
          </button>

          <button
            type="button"
            onClick={handleLogout}
            style={{
              padding: '7px 14px',
              background: 'rgba(240, 85, 90, 0.12)',
              border: '1px solid rgba(240, 85, 90, 0.3)',
              borderRadius: '6px',
              color: '#f0555a',
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: 600,
            }}
          >
            Sign Out
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main style={{ maxWidth: '1400px', margin: '0 auto', padding: '28px 24px' }}>
        {/* Metric Cards */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
            gap: '16px',
            marginBottom: '28px',
          }}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: '12px',
              padding: '18px 20px',
            }}
          >
            <div style={{ fontSize: '12.5px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Total Workspaces
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, marginTop: '6px', color: '#8fb6ff' }}>
              {uniqueWorkspaces}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
              Active platform tenants
            </div>
          </div>

          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: '12px',
              padding: '18px 20px',
            }}
          >
            <div style={{ fontSize: '12.5px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Registered Users
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, marginTop: '6px', color: 'var(--text)' }}>
              {totalUsers}
            </div>
            <div style={{ fontSize: '12px', color: '#4bb563', marginTop: '4px' }}>
              {activeUsersCount} active / {totalUsers - activeUsersCount} disabled
            </div>
          </div>

          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: '12px',
              padding: '18px 20px',
            }}
          >
            <div style={{ fontSize: '12.5px', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Connected Exchange Accounts
            </div>
            <div style={{ fontSize: '28px', fontWeight: 800, marginTop: '6px', color: '#7c6bff' }}>
              {totalAccounts}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
              Live accounts trading across tenants
            </div>
          </div>
        </div>

        {/* Filter and Search Controls */}
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: '12px 12px 0 0',
            padding: '16px 20px',
            display: 'flex',
            flexWrap: 'wrap',
            gap: '14px',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', gap: '12px', flex: '1', minWidth: '280px', maxWidth: '480px' }}>
            <input
              type="text"
              placeholder="Search by user email or workspace name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{
                width: '100%',
                padding: '9px 14px',
                background: 'var(--bg-2)',
                border: '1px solid var(--line)',
                borderRadius: '8px',
                color: 'var(--text)',
                fontSize: '13.5px',
                outline: 'none',
              }}
            />
          </div>

          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', color: 'var(--muted)' }}>Role:</span>
              <select
                value={roleFilter}
                onChange={(e) => setRoleFilter(e.target.value as typeof roleFilter)}
                style={{
                  padding: '8px 12px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line)',
                  borderRadius: '6px',
                  color: 'var(--text)',
                  fontSize: '13px',
                }}
              >
                <option value="all">All Roles</option>
                <option value="owner">Owner</option>
                <option value="trader">Trader</option>
                <option value="viewer">Viewer</option>
              </select>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '13px', color: 'var(--muted)' }}>Status:</span>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
                style={{
                  padding: '8px 12px',
                  background: 'var(--bg-2)',
                  border: '1px solid var(--line)',
                  borderRadius: '6px',
                  color: 'var(--text)',
                  fontSize: '13px',
                }}
              >
                <option value="all">All Statuses</option>
                <option value="active">Active Only</option>
                <option value="disabled">Disabled Only</option>
              </select>
            </div>

            <span style={{ fontSize: '13px', color: 'var(--muted)', marginLeft: '6px' }}>
              Showing {filteredUsers.length} of {totalUsers}
            </span>
          </div>
        </div>

        {/* Users Table */}
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderTop: 'none',
            borderRadius: '0 0 12px 12px',
            overflowX: 'auto',
          }}
        >
          {isLoading ? (
            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--muted)' }}>
              Loading platform accounts directory...
            </div>
          ) : isError ? (
            <div style={{ padding: '48px', textAlign: 'center', color: '#f0555a' }}>
              Failed to load accounts directory. Verify master permissions and try again.
            </div>
          ) : filteredUsers.length === 0 ? (
            <div style={{ padding: '48px', textAlign: 'center', color: 'var(--muted)' }}>
              No accounts match the specified criteria.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '13.5px' }}>
              <thead>
                <tr style={{ background: 'var(--bg-2)', borderBottom: '1px solid var(--line)' }}>
                  <th style={{ padding: '12px 18px', fontWeight: 600, color: 'var(--muted)', fontSize: '12px' }}>Workspace</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600, color: 'var(--muted)', fontSize: '12px' }}>User Email</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600, color: 'var(--muted)', fontSize: '12px' }}>Role</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600, color: 'var(--muted)', fontSize: '12px' }}>Accounts</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600, color: 'var(--muted)', fontSize: '12px' }}>Status</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600, color: 'var(--muted)', fontSize: '12px' }}>Created</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600, color: 'var(--muted)', fontSize: '12px' }}>Last Login</th>
                  <th style={{ padding: '12px 18px', fontWeight: 600, color: 'var(--muted)', fontSize: '12px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.map((user) => {
                  const isCurrentMaster = user.isMaster || user.email === 'dgnix.com@gmail.com';
                  const isDisabled = user.disabledAt !== null;

                  return (
                    <tr
                      key={user.userId}
                      style={{
                        borderBottom: '1px solid var(--line)',
                        background: 'transparent',
                        transition: 'background 0.15s ease',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(255, 255, 255, 0.02)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'transparent';
                      }}
                    >
                      <td style={{ padding: '14px 18px', verticalAlign: 'middle' }}>
                        <div style={{ fontWeight: 600, color: 'var(--text)' }}>
                          {user.tenantName}
                        </div>
                        <div style={{ fontSize: '11.5px', color: 'var(--muted)', fontFamily: 'monospace', marginTop: '2px' }}>
                          ID: {user.tenantId.slice(0, 8)}... | {user.valuationCurrency}
                        </div>
                      </td>

                      <td style={{ padding: '14px 18px', verticalAlign: 'middle' }}>
                        <div style={{ fontWeight: 500, color: 'var(--text)' }}>
                          {user.email}
                        </div>
                        {user.totpEnabled && (
                          <span
                            style={{
                              fontSize: '11px',
                              color: '#4bb563',
                              display: 'inline-block',
                              marginTop: '2px',
                            }}
                          >
                            2FA Enabled
                          </span>
                        )}
                      </td>

                      <td style={{ padding: '14px 18px', verticalAlign: 'middle' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '3px 9px',
                            borderRadius: '999px',
                            fontSize: '11.5px',
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            background:
                              user.role === 'owner'
                                ? 'rgba(76, 141, 255, 0.15)'
                                : user.role === 'trader'
                                ? 'rgba(124, 107, 255, 0.15)'
                                : 'rgba(139, 149, 166, 0.15)',
                            color:
                              user.role === 'owner'
                                ? '#8fb6ff'
                                : user.role === 'trader'
                                ? '#b9a8ff'
                                : '#8b95a6',
                            border: `1px solid ${
                              user.role === 'owner'
                                ? 'rgba(76, 141, 255, 0.3)'
                                : user.role === 'trader'
                                ? 'rgba(124, 107, 255, 0.3)'
                                : 'rgba(139, 149, 166, 0.3)'
                            }`,
                          }}
                        >
                          {user.role}
                        </span>
                      </td>

                      <td style={{ padding: '14px 18px', verticalAlign: 'middle' }}>
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '3px 9px',
                            borderRadius: '6px',
                            fontSize: '12px',
                            fontWeight: 600,
                            background: user.accountCount > 0 ? 'rgba(75, 181, 99, 0.12)' : 'rgba(139, 149, 166, 0.1)',
                            color: user.accountCount > 0 ? '#4bb563' : 'var(--muted)',
                            border: `1px solid ${user.accountCount > 0 ? 'rgba(75, 181, 99, 0.3)' : 'rgba(139, 149, 166, 0.2)'}`,
                          }}
                        >
                          {user.accountCount} {user.accountCount === 1 ? 'Account' : 'Accounts'}
                        </span>
                      </td>

                      <td style={{ padding: '14px 18px', verticalAlign: 'middle' }}>
                        {isDisabled ? (
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '3px 8px',
                              borderRadius: '4px',
                              fontSize: '11.5px',
                              fontWeight: 600,
                              background: 'rgba(240, 85, 90, 0.15)',
                              color: '#f0555a',
                            }}
                          >
                            Disabled
                          </span>
                        ) : (
                          <span
                            style={{
                              display: 'inline-block',
                              padding: '3px 8px',
                              borderRadius: '4px',
                              fontSize: '11.5px',
                              fontWeight: 600,
                              background: 'rgba(75, 181, 99, 0.15)',
                              color: '#4bb563',
                            }}
                          >
                            Active
                          </span>
                        )}
                      </td>

                      <td style={{ padding: '14px 18px', verticalAlign: 'middle', fontSize: '12.5px', color: 'var(--muted)' }}>
                        {formatDate(user.userCreatedAt)}
                      </td>

                      <td style={{ padding: '14px 18px', verticalAlign: 'middle', fontSize: '12.5px', color: 'var(--muted)' }}>
                        {formatDate(user.lastLoginAt)}
                      </td>

                      <td style={{ padding: '14px 18px', verticalAlign: 'middle', textAlign: 'right' }}>
                        {isCurrentMaster ? (
                          <span
                            style={{
                              fontSize: '12px',
                              color: 'var(--muted)',
                              fontStyle: 'italic',
                              padding: '6px 12px',
                            }}
                          >
                            Master Root
                          </span>
                        ) : isDisabled ? (
                          <span
                            style={{
                              fontSize: '12px',
                              color: 'var(--faint)',
                              padding: '6px 12px',
                            }}
                          >
                            Inaccessible
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedUser(user);
                              setImpersonateError(null);
                            }}
                            style={{
                              padding: '7px 15px',
                              background: 'linear-gradient(135deg, #4c8dff 0%, #7c6bff 100%)',
                              border: 'none',
                              borderRadius: '6px',
                              color: '#ffffff',
                              fontSize: '12.5px',
                              fontWeight: 600,
                              cursor: 'pointer',
                              boxShadow: '0 2px 6px rgba(76, 141, 255, 0.25)',
                              transition: 'opacity 0.15s ease',
                            }}
                            onMouseEnter={(e) => {
                              e.currentTarget.style.opacity = '0.9';
                            }}
                            onMouseLeave={(e) => {
                              e.currentTarget.style.opacity = '1';
                            }}
                          >
                            Login as User
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </main>

      {/* Confirmation Modal */}
      {selectedUser && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.75)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
            padding: '20px',
          }}
          onClick={() => {
            if (!isImpersonating) setSelectedUser(null);
          }}
        >
          <div
            style={{
              background: 'var(--panel)',
              border: '1px solid var(--line-strong)',
              borderRadius: '14px',
              maxWidth: '520px',
              width: '100%',
              padding: '24px',
              boxShadow: 'var(--shadow-lg)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ fontSize: '18px', fontWeight: 700, marginBottom: '10px' }}>
              Confirm User Account Impersonation
            </div>

            <p style={{ color: 'var(--text-dim)', fontSize: '14px', lineHeight: '1.6', margin: '0 0 20px' }}>
              You are about to securely access workspace{' '}
              <strong style={{ color: 'var(--text)' }}>{selectedUser.tenantName}</strong> as user{' '}
              <strong style={{ color: '#8fb6ff' }}>{selectedUser.email}</strong>.
            </p>

            {impersonateError && (
              <div
                style={{
                  background: 'rgba(240, 85, 90, 0.15)',
                  border: '1px solid rgba(240, 85, 90, 0.3)',
                  borderRadius: '6px',
                  padding: '10px 14px',
                  fontSize: '13px',
                  color: '#f0555a',
                  marginBottom: '16px',
                }}
              >
                {impersonateError}
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
              <button
                type="button"
                disabled={isImpersonating}
                onClick={() => setSelectedUser(null)}
                style={{
                  padding: '9px 18px',
                  background: 'transparent',
                  border: '1px solid var(--line)',
                  borderRadius: '6px',
                  color: 'var(--text-dim)',
                  cursor: 'pointer',
                  fontSize: '13.5px',
                  fontWeight: 500,
                }}
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={isImpersonating}
                onClick={handleConfirmImpersonate}
                style={{
                  padding: '9px 20px',
                  background: 'linear-gradient(135deg, #4c8dff 0%, #7c6bff 100%)',
                  border: 'none',
                  borderRadius: '6px',
                  color: '#ffffff',
                  cursor: isImpersonating ? 'wait' : 'pointer',
                  fontSize: '13.5px',
                  fontWeight: 600,
                  opacity: isImpersonating ? 0.7 : 1,
                }}
              >
                {isImpersonating ? 'Switching Session...' : 'Confirm & Login as User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
