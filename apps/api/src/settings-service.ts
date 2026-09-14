// Settings service — workspace-level preferences that survive a session.
//
// Currently one action: rename the workspace. The rename is presentational (it
// changes what the customer sees in the header and on their audit rows' after
// state); it does not change any money, permission, or route. Every write here
// carries an audit row: who renamed it, from what to what.

import { insertAuditEvent, renameWorkspace, TenantRepoError } from '@tradex/db';
import type { DB } from '@tradex/db';
import type { Kysely } from 'kysely';

export class SettingsServiceError extends Error {
  override readonly name = 'SettingsServiceError';
  constructor(message: string, readonly reason: 'no_change' | 'bad_input' | 'not_found') {
    super(message);
  }
}

export interface SettingsActor {
  readonly userId: string;
  readonly tenantId: string;
  readonly process: string;
}

export class SettingsService {
  constructor(private readonly deps: { readonly db: Kysely<DB> }) {}

  async renameWorkspace(actor: SettingsActor, newName: string, atMs?: number): Promise<{ oldName: string; newName: string }> {
    const at = new Date(atMs ?? Date.now());
    try {
      const { oldName } = await renameWorkspace(this.deps.db, actor.tenantId, newName);
      const trimmed = newName.trim();
      await insertAuditEvent(this.deps.db, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        actorProcess: actor.process,
        action: 'settings.workspace_rename',
        subjectType: 'tenant',
        subjectId: actor.tenantId,
        before: { name: oldName },
        after: { name: trimmed },
        occurredAt: at,
      });
      return { oldName, newName: trimmed };
    } catch (e) {
      if (e instanceof TenantRepoError) {
        if (/unchanged/.test(e.message)) throw new SettingsServiceError(e.message, 'no_change');
        if (/not found/.test(e.message)) throw new SettingsServiceError(e.message, 'not_found');
        throw new SettingsServiceError(e.message, 'bad_input');
      }
      throw e;
    }
  }
}
