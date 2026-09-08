// Tenant scoping is the choke point that prevents the one unrecoverable
// failure in this product (RISK-REGISTER R15). These tests compile queries to
// SQL without a database, which is exactly the right level: the property under
// test is what the generated SQL says, not what Postgres does with it.

import { describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './schema.js';
import { GLOBAL_TABLES, TENANT_SCOPED_TABLES, isTenantScoped } from './schema.js';
import { TenancyError, TenantContext, forTenant } from './tenant-scope.js';

// compile() never touches the driver, so a placeholder pool is honest here.
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: {} as never }) });

const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

describe('a tenant context cannot be empty', () => {
  it('rejects an empty or blank tenant id', () => {
    expect(() => new TenantContext('')).toThrow(TenancyError);
    expect(() => new TenantContext('   ')).toThrow(/non-empty tenant id/);
    // @ts-expect-error — guarding the runtime as well as the type
    expect(() => new TenantContext(undefined)).toThrow(TenancyError);
  });

  it('accepts a real id', () => {
    expect(new TenantContext(TENANT_A).tenantId).toBe(TENANT_A);
  });
});

describe('every scoped query carries the tenant predicate', () => {
  const t = forTenant(db, TENANT_A);

  it('applies it to selectFrom on every tenant-scoped table', () => {
    for (const table of TENANT_SCOPED_TABLES) {
      const { sql, parameters } = t.selectFrom(table).selectAll().compile();
      expect(sql, `${table} select is missing the tenant predicate`).toContain('"tenant_id" = $1');
      expect(parameters[0]).toBe(TENANT_A);
    }
  });

  it('makes byId a composite lookup, never id alone', () => {
    const { sql, parameters } = t.byId('app_user', 'user-1').compile();
    expect(sql).toContain('"tenant_id" = $1');
    expect(sql).toContain('"id" = $2');
    expect(parameters).toEqual([TENANT_A, 'user-1']);
  });

  it('applies it to updateTable', () => {
    const { sql, parameters } = t.updateTable('tenant_limit').set({ trading_paused: true }).compile();
    expect(sql).toContain('"tenant_id" = ');
    expect(parameters).toContain(TENANT_A);
  });

  it('applies it to deleteFrom', () => {
    const { sql, parameters } = t.deleteFrom('app_user').compile();
    expect(sql).toContain('"tenant_id" = $1');
    expect(parameters[0]).toBe(TENANT_A);
  });

  it('forces tenant_id on insert even when the caller omits it', () => {
    const { sql, parameters } = t
      .insertInto('app_user', { email: 'a@b.co', password_hash: 'x', role: 'owner' })
      .compile();
    expect(sql).toContain('"tenant_id"');
    expect(parameters).toContain(TENANT_A);
  });
});

describe('the layer refuses the mistakes that cause leaks', () => {
  const a = forTenant(db, TENANT_A);

  it('refuses an insert that names a different tenant', () => {
    expect(() =>
      a.insertInto('app_user', { tenant_id: TENANT_B, email: 'x@y.co', password_hash: 'h', role: 'viewer' }),
    ).toThrow(/refusing to insert/);
  });

  it('allows an insert that names the same tenant redundantly', () => {
    expect(() =>
      a.insertInto('app_user', { tenant_id: TENANT_A, email: 'x@y.co', password_hash: 'h', role: 'viewer' }),
    ).not.toThrow();
  });

  it('refuses byId with an empty id', () => {
    expect(() => a.byId('app_user', '')).toThrow(/non-empty id/);
  });

  it('refuses a table that is not tenant-scoped', () => {
    for (const table of GLOBAL_TABLES) {
      // @ts-expect-error — the type already forbids it; the runtime must too
      expect(() => a.selectFrom(table), `${table} should not be reachable`).toThrow(/not a tenant-scoped table/);
    }
  });

  it('refuses to update or delete audit_event, which is append-only', () => {
    expect(() => a.updateTable('audit_event')).toThrow(/append-only/);
    expect(() => a.deleteFrom('audit_event')).toThrow(/append-only/);
  });
});

describe('two tenants cannot see each other', () => {
  it('produces different parameters for the same query shape', () => {
    const qa = forTenant(db, TENANT_A).selectFrom('app_user').selectAll().compile();
    const qb = forTenant(db, TENANT_B).selectFrom('app_user').selectAll().compile();
    expect(qa.sql).toBe(qb.sql);
    expect(qa.parameters[0]).toBe(TENANT_A);
    expect(qb.parameters[0]).toBe(TENANT_B);
    expect(qa.parameters[0]).not.toBe(qb.parameters[0]);
  });

  it('never emits a scoped query without a tenant parameter', () => {
    for (const table of TENANT_SCOPED_TABLES) {
      const { parameters } = forTenant(db, TENANT_A).selectFrom(table).selectAll().compile();
      expect(parameters.length, `${table} produced an unparameterised query`).toBeGreaterThan(0);
    }
  });
});

describe('the scoped-table registry is honest', () => {
  it('classifies every known table exactly once', () => {
    for (const t of TENANT_SCOPED_TABLES) expect(isTenantScoped(t)).toBe(true);
    for (const t of GLOBAL_TABLES) expect(isTenantScoped(t)).toBe(false);
  });

  it('has no overlap between scoped and global', () => {
    const overlap = TENANT_SCOPED_TABLES.filter((t) => (GLOBAL_TABLES as readonly string[]).includes(t));
    expect(overlap).toEqual([]);
  });
});
