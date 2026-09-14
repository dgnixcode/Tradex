import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWorkspace, renameWorkspace, stepUp } from '../api.ts';
import type { ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';

// The Settings page — workspace-level preferences that survive a session.
//
// One field for now: the workspace name (what the customer sees in the header
// and on their audit rows). Rename is an owner + fresh-2FA action, so a viewer
// or trader sees a friendly explainer instead of the form, and even an owner
// with a stale re-auth is asked for a code before the rename lands. Every
// change is a server-side audit row (Audit → Workspace rename).

export function Settings() {
  const qc = useQueryClient();
  const workspace = useQuery({ queryKey: ['workspace'], queryFn: fetchWorkspace });
  const { state } = useAuth();
  const role = state.status === 'authenticated' ? state.session.role : '';
  const totpEnabled = state.status === 'authenticated' ? state.session.totpEnabled : false;
  const isOwner = role === 'owner';

  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  useEffect(() => {
    if (workspace.data !== undefined && name === '') setName(workspace.data.name);
  }, [workspace.data, name]);

  const rename = useMutation({
    mutationFn: (n: string) => renameWorkspace(n),
    onSuccess: (r) => {
      setStatus({ kind: 'ok', message: `Renamed to "${r.newName}".` });
      setCode('');
      setNeedsCode(false);
      void qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: (e) => {
      const err = e as ApiError;
      // 403 with a reauth code from the server → prompt for a fresh code.
      if (err.status === 403 && /reauth|second factor|two-factor/i.test(err.message)) {
        setNeedsCode(true);
        setStatus({ kind: 'err', message: 'Enter a code from your authenticator, then save again.' });
        return;
      }
      setStatus({ kind: 'err', message: err.message ?? 'could not save' });
    },
  });

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setStatus(null);
    const clean = name.trim();
    if (clean === '') { setStatus({ kind: 'err', message: 'workspace name is required' }); return; }
    if (workspace.data !== undefined && clean === workspace.data.name) {
      setStatus({ kind: 'err', message: 'nothing changed' });
      return;
    }
    // If we prompted for a code, satisfy step-up first, then retry the rename.
    if (needsCode) {
      try { await stepUp(code.trim()); } catch (err) {
        const ae = err as ApiError;
        setStatus({ kind: 'err', message: ae.message ?? 'that code was not accepted' });
        return;
      }
    }
    rename.mutate(clean);
  };

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Settings</h2>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        Workspace preferences. Every change is written to your audit trail.
      </p>

      {workspace.isLoading && <p className="muted">Loading…</p>}
      {workspace.isError && <div className="error">{(workspace.error as Error).message}</div>}

      {workspace.isSuccess && workspace.data !== undefined && (
        <>
          <section style={{ marginBottom: 24 }}>
            <h3 style={{ marginTop: 0 }}>Workspace</h3>
            <p className="muted" style={{ marginTop: -4, marginBottom: 12, fontSize: 12.5 }}>
              This is the name shown in the header and on your audit rows.
            </p>

            {!isOwner ? (
              <div className="muted" style={{ fontSize: 13 }}>
                Only an owner may rename the workspace. Current name: <strong>{workspace.data.name}</strong>.
              </div>
            ) : (
              <>
                {!totpEnabled && (
                  // Enrolment is optional, so this is advice rather than a block.
                  // The server allows the rename; it just cannot ask for a fresh
                  // code from someone who has no second factor to give.
                  <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
                    Two-factor authentication is not enrolled. It is optional, but recommended before
                    owner actions — <Link to="/app/security">enrol in Security &amp; 2FA</Link>.
                  </div>
                )}
                <form className="add-member-form" onSubmit={submit}>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Workspace name"
                  aria-label="Workspace name"
                  maxLength={120}
                />
                {needsCode && (
                  <input
                    inputMode="numeric"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="6-digit code"
                    aria-label="Verification code"
                    style={{ width: 130 }}
                  />
                )}
                <button
                  className="btn"
                  type="submit"
                  disabled={rename.isPending || name.trim() === '' || name.trim() === workspace.data.name}
                >
                  {rename.isPending ? 'Saving…' : 'Save'}
                </button>
              </form>
              </>
            )}
            {status !== null && (
              <div
                style={{ marginTop: 10, fontSize: 13, color: status.kind === 'ok' ? 'var(--ok)' : 'var(--danger)' }}
              >
                {status.message}
              </div>
            )}
          </section>

          <section>
            <h3 style={{ marginTop: 0 }}>Security</h3>
            <p className="muted" style={{ marginTop: -4, marginBottom: 8, fontSize: 12.5 }}>
              Two-factor authentication is optional. When enrolled, owner actions like renaming the
              workspace, changing limits, and connecting an account additionally require a fresh code.
            </p>
            <Link to="/app/security" className="btn btn-sm secondary">Go to Security &amp; 2FA</Link>
          </section>
        </>
      )}
    </div>
  );
}
