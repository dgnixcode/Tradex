// The tenant-scoping layer — plan/phase-00 T00.4, from 17-architecture-stack.md F5.
//
// The cross-tenant leak is the one unrecoverable failure in this product
// (RISK-REGISTER R15), so tenant scoping is not a convention applied at call
// sites. It is a choke point: you cannot obtain a query builder for a
// tenant-scoped table without a tenant context, and the `where tenant_id = ?`
// clause is added by this layer rather than by whoever is writing the query.
//
// The escalation trap this closes: a query that filters by `child_order.id` and
// joins upward to check the tenant is verifying AFTER the fact. Primary lookups
// must carry the tenant in the WHERE clause, which is why `byId` exists and why
// it is the only lookup helper offered.

import type { DeleteQueryBuilder, InsertQueryBuilder, Kysely, SelectQueryBuilder, UpdateQueryBuilder } from 'kysely';
import type { DB, TenantScopedTable } from './schema.js';
import { isTenantScoped } from './schema.js';

export class TenancyError extends Error {
  override readonly name = 'TenancyError';
}

/** A validated tenant id. Constructing one is the only way to get a scoped db. */
export class TenantContext {
  readonly tenantId: string;

  constructor(tenantId: string) {
    if (typeof tenantId !== 'string' || tenantId.trim() === '') {
      throw new TenancyError(
        'a tenant context requires a non-empty tenant id — refusing to build a query that would read across tenants',
      );
    }
    this.tenantId = tenantId;
  }
}

type ScopedSelect<T extends keyof DB> = SelectQueryBuilder<DB, T, Record<string, never>>;

/**
 * Tenant-scoped tables that actually have an `id` column.
 *
 * `byId` builds `WHERE <table>.id = ?`, so calling it on a table with a
 * composite primary key — `account_balance` is `(account_id, currency)` — used
 * to compile fine and fail at runtime with "column does not exist". Narrowing
 * the parameter turns that into a type error at the call site instead.
 */
export type IdentifiedTable = {
  [K in TenantScopedTable]: 'id' extends keyof DB[K] ? K : never
}[TenantScopedTable];

/**
 * Kysely's builder types do not survive a generic union of table names — the
 * `.where` overloads become an uncallable union. Rather than widen the public
 * API to `any`, the tenant predicate is applied through this minimal shape and
 * the result is cast back to the precise builder type. The cast is confined to
 * one function, and the compiled SQL is asserted in tenant-scope.test.ts, which
 * is the property that actually matters.
 */
interface Whereable {
  where: (lhs: unknown, op: string, rhs: unknown) => unknown;
}

const applyTenant = <R>(builder: unknown, table: string, tenantId: string): R =>
  (builder as Whereable).where(`${table}.tenant_id`, '=', tenantId) as R;


/**
 * A tenant-scoped view of the database. Every method that touches a
 * tenant-scoped table applies the tenant predicate itself.
 */
export class TenantDb {
  readonly tenantId: string;

  constructor(
    private readonly db: Kysely<DB>,
    ctx: TenantContext,
  ) {
    this.tenantId = ctx.tenantId;
  }

  /** SELECT with the tenant predicate already applied. */
  selectFrom<T extends TenantScopedTable>(table: T): ScopedSelect<T> {
    this.assertScoped(table);
    return applyTenant<ScopedSelect<T>>(this.db.selectFrom(table), table, this.tenantId);
  }

  /**
   * The only primary-key lookup offered, and it is composite on purpose. A
   * leaked or guessed id must not be sufficient on its own.
   *
   * Restricted to tables that have an `id`: a composite-key table like
   * `account_balance` has no single id to look up by, and pretending otherwise
   * produced valid TypeScript and invalid SQL.
   */
  byId<T extends IdentifiedTable>(table: T, id: string): ScopedSelect<T> {
    if (typeof id !== 'string' || id.trim() === '') {
      throw new TenancyError(`byId(${table}) requires a non-empty id`);
    }
    return this.selectFrom(table).where(`${table}.id` as never, '=', id as never) as unknown as ScopedSelect<T>;
  }

  /** INSERT with `tenant_id` forced to this context's tenant. */
  insertInto<T extends TenantScopedTable>(
    table: T,
    values: Record<string, unknown> & { tenant_id?: string },
  ): InsertQueryBuilder<DB, T, unknown> {
    this.assertScoped(table);
    if (values.tenant_id !== undefined && values.tenant_id !== this.tenantId) {
      throw new TenancyError(
        `refusing to insert into ${table} with tenant_id ${values.tenant_id} from a context scoped to ${this.tenantId}`,
      );
    }
    return this.db
      .insertInto(table)
      .values({ ...values, tenant_id: this.tenantId } as never) as InsertQueryBuilder<DB, T, unknown>;
  }

  /** UPDATE with the tenant predicate already applied. */
  updateTable<T extends TenantScopedTable>(table: T): UpdateQueryBuilder<DB, T, T, unknown> {
    this.assertScoped(table);
    if (table === 'audit_event') {
      throw new TenancyError('audit_event is append-only — the application role holds INSERT and SELECT only');
    }
    return applyTenant<UpdateQueryBuilder<DB, T, T, unknown>>(this.db.updateTable(table), table, this.tenantId);
  }

  /** DELETE with the tenant predicate already applied. */
  deleteFrom<T extends TenantScopedTable>(table: T): DeleteQueryBuilder<DB, T, unknown> {
    this.assertScoped(table);
    if (table === 'audit_event') {
      throw new TenancyError('audit_event is append-only — deletion is not available to the application');
    }
    return applyTenant<DeleteQueryBuilder<DB, T, unknown>>(this.db.deleteFrom(table), table, this.tenantId);
  }

  private assertScoped(table: string): void {
    if (!isTenantScoped(table)) {
      throw new TenancyError(
        `${table} is not a tenant-scoped table — use the unscoped db for reference data, and add it to TENANT_SCOPED_TABLES if that is wrong`,
      );
    }
  }

  /**
   * Run a set of writes atomically, all still tenant-scoped.
   *
   * The transaction handle is wrapped in a fresh `TenantDb` bound to the same
   * tenant, so a caller cannot accidentally escape the scope by reaching for the
   * raw Kysely `trx` — the choke point holds inside a transaction exactly as it
   * does outside one.
   */
  async transaction<T>(fn: (tx: TenantDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((trx) => fn(new TenantDb(trx, new TenantContext(this.tenantId))));
  }
}

/** The only way to obtain a tenant-scoped db. */
export const forTenant = (db: Kysely<DB>, tenantId: string): TenantDb =>
  new TenantDb(db, new TenantContext(tenantId));
