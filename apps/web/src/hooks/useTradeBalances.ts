import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchGroup, syncAccount } from '../api.ts';

type TargetKind = 'group' | 'account';
type RefreshState = { key: string; pending: boolean; error: string | null };

/** Refresh exact enabled members, including the cross-group Default membership. */
export async function refreshTradeBalances(kind: TargetKind, id: string): Promise<void> {
  const ids = kind === 'account' ? [id] : (await fetchGroup(id)).members
    .filter((member) => member.enabled && member.status === 'active').map((member) => member.accountId);
  for (let i = 0; i < ids.length; i += 8) {
    const results = await Promise.allSettled(ids.slice(i, i + 8).map((accountId) => syncAccount(accountId)));
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('Some exchange balances could not be refreshed. Retry refresh or review for a fresh server check.');
    }
  }
}

/** Selection changes and manual refresh share one path. Old completions cannot
 * clear the current target's spinner or replace its error state. */
export function useTradeBalances(kind: TargetKind, id: string, reload: () => Promise<unknown>) {
  const key = id ? `${kind}:${id}` : '';
  const currentKey = useRef(key);
  currentKey.current = key;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  const generation = useRef(0);
  const inFlight = useRef<{ key: string; promise: Promise<unknown> } | null>(null);
  const [state, setState] = useState<RefreshState>({ key: '', pending: false, error: null });

  const refresh = useCallback(async () => {
    if (!id || currentKey.current !== key) return;
    const request = ++generation.current;
    setState({ key, pending: true, error: null });
    // Reuse an in-flight read for the same selection (also React StrictMode).
    if (inFlight.current?.key !== key) {
      inFlight.current = { key, promise: refreshTradeBalances(kind, id).then(() => reloadRef.current()) };
    }
    const operation = inFlight.current;
    try {
      await operation.promise;
      if (generation.current === request && currentKey.current === key) setState({ key, pending: false, error: null });
    } catch {
      if (generation.current === request && currentKey.current === key) {
        setState({ key, pending: false, error: 'Balance refresh failed. Displayed funds may be old; Review will check the exchange again.' });
      }
    } finally {
      if (inFlight.current === operation) inFlight.current = null;
    }
  }, [id, key, kind]);

  useEffect(() => {
    void refresh();
    return () => { generation.current++; };
  }, [refresh]);

  return {
    refresh,
    pending: !!key && (state.key !== key || state.pending),
    error: state.key === key ? state.error : null,
  };
}
