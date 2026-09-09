import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createGroup, fetchGroups } from '../api.ts';
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

export function Groups() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const groups = useQuery({ queryKey: ['groups'], queryFn: fetchGroups });

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

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
    <div className="panel">
      <h2>Groups</h2>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        Named subsets of your accounts. A group trade fans out across its enabled members.
      </p>

      {/* create form */}
      <form
        onSubmit={(e) => { e.preventDefault(); if (name.trim() !== '') create.mutate(); }}
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
          <p className="empty-ico">🗂</p>
          <p>No groups yet.</p>
          <p className="muted">Create one above, then add accounts to it.</p>
        </div>
      )}

      {groups.isSuccess && groups.data.length > 0 && (
        <div className="group-grid">
          {groups.data.map((g) => (
            <Link key={g.id} to={`/app/groups/${g.id}`} className="group-card">
              <div className="group-card-head">
                <span className="group-card-name">{g.name}</span>
                <span className="group-card-count">{g.enabledCount} of {g.memberCount} enabled</span>
              </div>
              {g.description !== null && <p className="muted group-card-desc">{g.description}</p>}
              <div className="group-card-cap">{formatCapital(g)}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
