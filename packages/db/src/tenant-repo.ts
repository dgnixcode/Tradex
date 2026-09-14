// Tenant reads and workspace rename — user-facing settings live here.
//
// Signup creates the tenant row (see signup-service.ts); this is the tiny
// after-the-fact surface: read the workspace's name to show in Settings, and
// change it. Nothing here touches money or state that would affect a trade — a
// rename is presentational.

import type { Kysely } from 'kysely';
import type { DB } from './schema.js';

export class TenantRepoError extends Error {
  override readonly name = 'TenantRepoError';
}

export interface WorkspaceInfo {
  readonly tenantId: string;
  readonly name: string;
  readonly valuationCurrency: 'INR' | 'USDT';
  readonly status: 'active' | 'suspended' | 'closed';
}

/**
 * Read the workspace for a tenant. Tenant rows are outside the tenant-scope
 * layer (that layer scopes reads OF a tenant), so this takes the untagged db.
 */
export async function getWorkspace(db: Kysely<DB>, tenantId: string): Promise<WorkspaceInfo | null> {
  const row = await db.selectFrom('tenant')
    .select(['id', 'name', 'valuation_currency', 'status'] as unknown as never)
    .where('id' as never, '=', tenantId as never)
    .executeTakeFirst();
  if (row === undefined) return null;
  const r = row as { id: string; name: string; valuation_currency: 'INR' | 'USDT'; status: WorkspaceInfo['status'] };
  return { tenantId: r.id, name: r.name, valuationCurrency: r.valuation_currency, status: r.status };
}

/**
 * Rename the workspace. Returns the OLD name so the caller can write it into an
 * audit row. Throws when the id does not exist or when nothing changed.
 */
export async function renameWorkspace(db: Kysely<DB>, tenantId: string, newName: string): Promise<{ oldName: string }> {
  const current = await getWorkspace(db, tenantId);
  if (current === null) throw new TenantRepoError(`tenant ${tenantId} was not found`);
  const trimmed = newName.trim();
  if (trimmed === '') throw new TenantRepoError('workspace name must not be empty');
  if (trimmed.length > 120) throw new TenantRepoError('workspace name is too long (max 120 chars)');
  if (trimmed === current.name) throw new TenantRepoError('workspace name is unchanged');
  await db.updateTable('tenant')
    .set({ name: trimmed } as never)
    .where('id' as never, '=', tenantId as never)
    .execute();
  return { oldName: current.name };
}
