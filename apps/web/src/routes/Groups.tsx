import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createGroup, DEFAULT_GROUP_NAME, fetchFuturesPositions, fetchGroups, updateGroup } from '../api.ts';
import type { GroupSummary } from '../api.ts';

// The Groups management list (T04.2 surface). Shows every group with its member
// count and per-currency capital, and a create form. Clicking a group opens its
// detail view (/app/groups/:id) for membership management.
//
// Capital is shown PER CURRENCY, never summed across INR and USDT — combining
// them would need an FX rate and be wrong (the money-units discipline).

function formatCapital(group: GroupSummary): string {
  const parts: string[] = [];
  const inr = group.allocatedByCurrency.INR;
  const usdt = group.allocatedByCurrency.USDT;
  if (inr !== '0') parts.push(`₹${minorToMajor(inr, 2)}`);
  if (usdt !== '0') parts.push(`${minorToMajor(usdt, 8)} USDT`);
  return parts.length === 0 ? 'no capital allocated' : parts.join(' + ');
}

function minorToMajor(minor: string, scale: number): string {
  const digits = minor.padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  return `${whole}${frac === '' ? '' : `.${frac}`}`;
}

interface EditGroupModalProps {
  readonly group: { id: string; name: string; description: string };
  readonly onClose: () => void;
}

function EditGroupModal({ group, onClose }: EditGroupModalProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(group.name);
  const [description, setDescription] = useState(group.description);
  const [error, setError] = useState<string | null>(null);

  const update = useMutation({
    mutationFn: () => updateGroup(group.id, {
      name: name.trim(),
      description: description.trim() === '' ? null : description.trim(),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
      void queryClient.invalidateQueries({ queryKey: ['accounts'] });
      void queryClient.invalidateQueries({ queryKey: ['group', group.id] });
      onClose();
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : 'Failed to update group');
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Group name cannot be blank.');
      return;
    }
    if (trimmed.toLowerCase() === DEFAULT_GROUP_NAME.toLowerCase()) {
      setError(`"${DEFAULT_GROUP_NAME}" is reserved for the system master group.`);
      return;
    }
    update.mutate();
  };

  return (
    <div className="position-modal-overlay" onClick={onClose}>
      <div className="position-modal" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <div className="position-modal-header">
          <h3 className="position-modal-title">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
            Edit Strategy Group
          </h3>
          <button type="button" className="position-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '20px 24px' }}>
          <div className="field" style={{ marginBottom: 16 }}>
            <label htmlFor="edit-group-name" style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13.5 }}>
              Group Name <span style={{ color: 'var(--danger)' }}>*</span>
            </label>
            <input
              id="edit-group-name"
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Scalping Accounts, VIP Desk"
              style={{ width: '100%', boxSizing: 'border-box' }}
              disabled={update.isPending}
            />
          </div>

          <div className="field" style={{ marginBottom: 20 }}>
            <label htmlFor="edit-group-desc" style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13.5 }}>
              Description <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(Optional)</span>
            </label>
            <input
              id="edit-group-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Systematic momentum trading portfolio"
              style={{ width: '100%', boxSizing: 'border-box' }}
              disabled={update.isPending}
            />
          </div>

          {error !== null && (
            <div className="error" style={{ marginBottom: 16, fontSize: 13 }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
            <button
              type="button"
              className="btn secondary"
              onClick={onClose}
              disabled={update.isPending}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn"
              disabled={update.isPending || name.trim() === ''}
            >
              {update.isPending ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function Groups() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const groups = useQuery({ queryKey: ['groups'], queryFn: fetchGroups });
  const positions = useQuery({ queryKey: ['futures-positions'], queryFn: fetchFuturesPositions, refetchInterval: 3000 });

  // Map each group name to active coins / pairs traded by its accounts
  const groupCoinsMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const v of positions.data?.views ?? []) {
      if (v.groupName) {
        const set = map.get(v.groupName) ?? new Set<string>();
        const asset = v.pair.replace(/^[A-Z]-/, '').replace(/_.*$/, '');
        set.add(asset.toLowerCase());
        set.add(v.pair.toLowerCase());
        map.set(v.groupName, set);
      }
    }
    return map;
  }, [positions.data]);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [editingGroup, setEditingGroup] = useState<{ id: string; name: string; description: string } | null>(null);

  const filteredGroups = useMemo(() => {
    if (!groups.data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return groups.data;
    return groups.data.filter((g) => {
      if (g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q)) return true;
      const coins = groupCoinsMap.get(g.name);
      if (coins && (coins.has(q) || Array.from(coins).some((c) => c.includes(q)))) return true;
      return false;
    });
  }, [groups.data, search, groupCoinsMap]);

  const create = useMutation({
    mutationFn: () => createGroup(name, description),
    onSuccess: (result) => {
      setName('');
      setDescription('');
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ['groups'] });
      navigate(`/app/groups/${result.id}`);
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'could not create the group'),
  });

  return (
    <div className="panel full-width-page">
      <h2>Groups</h2>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        Named subsets of your accounts. A group trade fans out across its enabled members.
      </p>

      {/* create form */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim().toLowerCase() === DEFAULT_GROUP_NAME.toLowerCase()) {
            setError(`"${DEFAULT_GROUP_NAME}" is reserved for the system master group.`);
            return;
          }
          if (name.trim() !== '') create.mutate();
        }}
        className="create-group-form"
      >
        <input
          aria-label="Group name"
          placeholder="New group name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={create.isPending}
        />
        <input
          aria-label="Description"
          placeholder="Optional description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={create.isPending}
        />
        <button className="btn" type="submit" disabled={create.isPending || name.trim() === ''}>
          {create.isPending ? 'Creating…' : 'Create group'}
        </button>
      </form>
      {error !== null && <div className="error" style={{ marginTop: 8 }}>{error}</div>}

      {groups.isLoading && <p className="muted">Loading groups…</p>}
      {groups.isError && <div className="error">{(groups.error as Error).message}</div>}

      {groups.isSuccess && groups.data.length === 0 && (
        <div className="empty-state">
          <p>No groups yet.</p>
          <p className="muted">Create one above, then add accounts to it.</p>
        </div>
      )}

      {groups.isSuccess && groups.data.length > 0 && (
        <>
          {/* Groups Toolbar */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 24, marginBottom: 12, flexWrap: 'wrap' }}>
            <div className={`tradex-search-bar ${search.trim() !== '' ? 'has-query' : ''}`} style={{ minWidth: 260, maxWidth: 360 }}>
              <svg
                className="tradex-search-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                placeholder="Search groups or coins (e.g. BTC, Scalping)..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="tradex-search-input"
                aria-label="Search groups or coins"
              />
              {search.trim() !== '' && (
                <button
                  type="button"
                  className="tradex-search-clear"
                  onClick={() => setSearch('')}
                  title="Clear search"
                  aria-label="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
            <div className="muted" style={{ fontSize: '12.5px' }}>
              {search.trim() !== ''
                ? `Showing ${filteredGroups.length} of ${groups.data.length} group${groups.data.length === 1 ? '' : 's'}`
                : `${groups.data.length} strategy group${groups.data.length === 1 ? '' : 's'}`}
            </div>
          </div>

          {filteredGroups.length === 0 ? (
            <div className="empty-state" style={{ padding: '36px 16px', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: '14.5px', fontWeight: 600 }}>No groups or coins match "{search}"</p>
              <p className="muted" style={{ margin: '6px 0 14px', fontSize: '13px' }}>Try searching by coin symbol (e.g. BTC, ETH) or group name.</p>
              <button type="button" className="btn secondary btn-sm" onClick={() => setSearch('')}>
                Clear search
              </button>
            </div>
          ) : (
            <div className="group-grid" style={{ marginTop: 8 }}>
              {filteredGroups.map((g) => {
                const isDefault = g.name === DEFAULT_GROUP_NAME;
                return (
                  <div
                    key={g.id}
                    className="group-card"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      ...(isDefault ? { borderColor: 'rgba(59, 130, 246, 0.4)', background: 'linear-gradient(180deg, rgba(59, 130, 246, 0.04) 0%, rgba(17, 19, 24, 1) 100%)' } : {})
                    }}
                  >
                    <div>
                      <div className="group-card-head">
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <Link to={`/app/groups/${g.id}`} className="group-card-name" style={{ textDecoration: 'none' }}>
                            {g.name}
                          </Link>
                          {isDefault ? (
                            <span className="badge" style={{ fontSize: 10, background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)' }}>
                              Master Desk
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn ghost btn-sm"
                              style={{
                                fontSize: 11,
                                padding: '2px 7px',
                                color: 'var(--muted)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                borderRadius: 4,
                              }}
                              onClick={() => setEditingGroup({ id: g.id, name: g.name, description: g.description ?? '' })}
                              title="Edit group name and description"
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                              </svg>
                              Edit
                            </button>
                          )}
                        </div>
                        <span className="group-card-count">{g.enabledCount} of {g.memberCount} enabled</span>
                      </div>

                      {(() => {
                        const coinsForGroup = groupCoinsMap.get(g.name);
                        const coinList = coinsForGroup
                          ? Array.from(coinsForGroup).filter((c) => !c.includes('-') && !c.includes('_')).map((c) => c.toUpperCase())
                          : [];
                        if (coinList.length === 0) return null;
                        return (
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6, marginBottom: 2 }}>
                            {coinList.map((coin) => (
                              <span key={coin} className="badge" style={{ fontSize: 10, padding: '1px 6px', background: 'rgba(245, 158, 11, 0.12)', color: '#fbbf24', border: '1px solid rgba(245, 158, 11, 0.25)' }}>
                                {coin}
                              </span>
                            ))}
                          </div>
                        );
                      })()}

                      {isDefault ? (
                        <p className="muted group-card-desc">Master system group containing all connected accounts for whole-desk execution.</p>
                      ) : (
                        g.description !== null && g.description.trim() !== '' && (
                          <p className="muted group-card-desc">{g.description}</p>
                        )
                      )}

                      <div className="group-card-cap">{formatCapital(g)}</div>
                    </div>

                    <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <Link
                          to={`/app/groups/${g.id}`}
                          style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          Members →
                        </Link>
                        <span className="muted">·</span>
                        <Link
                          to={`/app/groups/${g.id}/analytics`}
                          style={{ fontSize: 12.5, fontWeight: 600, color: '#3b82f6', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        >
                          Analytics ↗
                        </Link>
                      </div>
                      {!isDefault && (
                        <button
                          type="button"
                          className="btn secondary btn-sm"
                          style={{ fontSize: 11.5, padding: '3px 8px' }}
                          onClick={() => setEditingGroup({ id: g.id, name: g.name, description: g.description ?? '' })}
                        >
                          Rename
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Edit Group Modal */}
      {editingGroup !== null && (
        <EditGroupModal
          group={editingGroup}
          onClose={() => setEditingGroup(null)}
        />
      )}
    </div>
  );
}
