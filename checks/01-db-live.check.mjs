// 01-db-live — plan/phase-00 T00.5, the half that needs a real database.
//
// checks/00-tenant-isolation.check.mjs validates the migration SQL statically.
// This one applies it and asks PostgreSQL whether the constraints, partitions
// and grants actually exist — the things a static read cannot confirm:
//   - that the SQL is valid for this server version at all
//   - that the CHECK constraints reject what they claim to reject
//   - that the partitions were created and route rows correctly
//   - that a cross-tenant query really returns nothing
//
// Skips cleanly with a message when DATABASE_URL is absent, so `npm run checks`
// stays useful on a machine without Postgres.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');

const T1 = '11111111-1111-1111-1111-111111111111';
const T2 = '22222222-2222-2222-2222-222222222222';

/** Run a statement expecting it to be REJECTED, and report which constraint bit. */
async function expectReject(client, assert, sql, params, matcher, what) {
  await client.query('SAVEPOINT probe');
  try {
    await client.query(sql, params);
    await client.query('ROLLBACK TO SAVEPOINT probe');
    assert(false, `${what}: the statement was ACCEPTED but should have been rejected`);
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT probe');
    const msg = String(err.message ?? err);
    assert(matcher.test(msg), `${what}: rejected, but not for the expected reason — ${msg}`);
  }
}

export async function run(assert) {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.log('     (skipped: DATABASE_URL not set — see .env.example)');
    assert(true, 'skipped without a database');
    return;
  }

  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const client = await pool.connect();
  try {
    // ------------------------------------------------------------ server itself
    const { rows: v } = await client.query('SHOW server_version_num');
    const major = Math.floor(Number(v[0].server_version_num) / 10000);
    assert(major >= 16, `PostgreSQL 16+ required for this schema, found major version ${major}`);

    // -------------------------------------------------------- apply from scratch
    // A dedicated schema keeps the check repeatable and leaves no residue.
    await client.query('DROP SCHEMA IF EXISTS tradex_check CASCADE');
    await client.query('CREATE SCHEMA tradex_check');
    await client.query('SET search_path TO tradex_check, public');

    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    assert(files.length >= 2, 'expected at least two migration files');
    for (const f of files) {
      const sql = readFileSync(join(migrationsDir, f), 'utf8');
      // The files carry their own BEGIN/COMMIT; strip them so everything runs
      // inside one outer transaction we can roll back.
      const inner = sql.replace(/^\s*BEGIN;\s*$/gim, '').replace(/^\s*COMMIT;\s*$/gim, '');
      await client.query('BEGIN');
      await client.query(inner);
      await client.query('COMMIT');
      assert(true, `${f} applied without error`);
    }

    // ---------------------------------------------------------- tables and shape
    const { rows: tables } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'tradex_check' AND table_type = 'BASE TABLE'`,
    );
    const names = new Set(tables.map((r) => r.table_name));
    for (const t of ['tenant', 'app_user', 'tenant_limit', 'platform_state', 'audit_event', 'schema_migration']) {
      assert(names.has(t), `table ${t} was not created`);
    }

    // Money columns must be numeric(38,0), never a float type.
    const { rows: cols } = await client.query(
      `SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
         FROM information_schema.columns
        WHERE table_schema = 'tradex_check' AND column_name LIKE '%_minor'`,
    );
    assert(cols.length >= 3, `expected at least three *_minor money columns, found ${cols.length}`);
    for (const c of cols) {
      assert(c.data_type === 'numeric', `${c.table_name}.${c.column_name} is ${c.data_type}, expected numeric`);
      assert(Number(c.numeric_precision) === 38 && Number(c.numeric_scale) === 0,
        `${c.table_name}.${c.column_name} is numeric(${c.numeric_precision},${c.numeric_scale}), expected (38,0)`);
    }
    const { rows: floats } = await client.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'tradex_check'
          AND data_type IN ('real','double precision','money')`,
    );
    assert(floats.length === 0, `floating-point columns found: ${floats.map((f) => `${f.table_name}.${f.column_name}`).join(', ')}`);

    // -------------------------------------------------- partitioning is REAL
    const { rows: part } = await client.query(
      `SELECT c.relkind, pg_get_partkeydef(c.oid) AS keydef
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'tradex_check' AND c.relname = 'audit_event'`,
    );
    assert(part.length === 1, 'audit_event not found in pg_class');
    assert(part[0].relkind === 'p', `audit_event relkind is '${part[0].relkind}', expected 'p' (partitioned)`);
    assert(/RANGE \(occurred_at\)/.test(part[0].keydef), `partition key is ${part[0].keydef}`);

    const { rows: parts } = await client.query(
      `SELECT c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = p.relnamespace
        WHERE n.nspname = 'tradex_check' AND p.relname = 'audit_event'`,
    );
    assert(parts.length >= 5, `expected 4 monthly partitions plus a default, found ${parts.length}`);
    assert(parts.some((p) => p.relname === 'audit_event_overflow'), 'the DEFAULT partition is missing');

    // --------------------------------------------- CHECK constraints actually bite
    await client.query('BEGIN');
    await client.query("INSERT INTO tenant (id, name) VALUES ($1, 'Tenant One')", [T1]);
    await client.query("INSERT INTO tenant (id, name) VALUES ($1, 'Tenant Two')", [T2]);
    assert(true, 'two tenants inserted');

    await expectReject(client, assert,
      "INSERT INTO tenant (name, valuation_currency) VALUES ('bad', 'EUR')", [],
      /valuation_currency/, 'tenant.valuation_currency CHECK');

    await expectReject(client, assert,
      "INSERT INTO tenant (name, kyc_status) VALUES ('bad', 'maybe')", [],
      /kyc_status/, 'tenant.kyc_status CHECK');

    await expectReject(client, assert,
      "INSERT INTO tenant (name, status) VALUES ('bad', 'closed')", [],
      /tenant_closed_when_status/, 'tenant closed_at CHECK');

    await client.query(
      `INSERT INTO app_user (tenant_id, email, password_hash, role) VALUES ($1, 'a@t1.co', 'h', 'owner')`, [T1]);
    await expectReject(client, assert,
      `INSERT INTO app_user (tenant_id, email, password_hash, role) VALUES ($1, 'a@t1.co', 'h', 'owner')`, [T2],
      /app_user_email_unique|duplicate key/, 'app_user.email UNIQUE across tenants');
    await expectReject(client, assert,
      `INSERT INTO app_user (tenant_id, email, password_hash, role) VALUES ($1, 'b@t1.co', 'h', 'admin')`, [T1],
      /role/, 'app_user.role CHECK');
    await expectReject(client, assert,
      `INSERT INTO app_user (tenant_id, email, password_hash, role, totp_enabled)
         VALUES ($1, 'c@t1.co', 'h', 'owner', true)`, [T1],
      /app_user_totp_needs_secret/, 'app_user totp_enabled requires a secret');
    await expectReject(client, assert,
      `INSERT INTO app_user (tenant_id, email, password_hash, role)
         VALUES ('33333333-3333-3333-3333-333333333333', 'd@t1.co', 'h', 'owner')`, [],
      /foreign key|violates/, 'app_user.tenant_id foreign key');

    // platform_state is a single row, by constraint not by convention.
    await expectReject(client, assert,
      "INSERT INTO platform_state (id) VALUES ('another')", [],
      /platform_state_id_check|check constraint/, 'platform_state single-row CHECK');
    const { rows: ps } = await client.query('SELECT count(*)::int AS n, mode FROM platform_state GROUP BY mode');
    assert(ps.length === 1 && ps[0].n === 1, 'platform_state should hold exactly one row');
    assert(ps[0].mode === 'normal', `platform_state.mode defaulted to ${ps[0].mode}, expected normal`);

    await expectReject(client, assert,
      "UPDATE platform_state SET mode = 'panic'", [],
      /mode/, 'platform_state.mode CHECK');

    // tenant_limit defaults must match OPEN-QUESTIONS Q9.
    await client.query('INSERT INTO tenant_limit (tenant_id) VALUES ($1)', [T1]);
    const { rows: lim } = await client.query(
      'SELECT max_order_notional_minor, max_daily_notional_minor, max_accounts, trading_paused FROM tenant_limit WHERE tenant_id = $1',
      [T1]);
    assert(lim[0].max_order_notional_minor === '20000000', `per-order cap default is ${lim[0].max_order_notional_minor}, expected 20000000 paise`);
    assert(lim[0].max_daily_notional_minor === '50000000', `per-day cap default is ${lim[0].max_daily_notional_minor}, expected 50000000 paise`);
    assert(lim[0].max_accounts === 100, `max_accounts default is ${lim[0].max_accounts}`);
    assert(lim[0].trading_paused === false, 'trading should not start paused');
    // numeric comes back as a STRING — the trap DATA-MODEL.md warns about.
    assert(typeof lim[0].max_order_notional_minor === 'string',
      'pg returned numeric as a JS number — a type parser has been registered somewhere');

    await expectReject(client, assert,
      'UPDATE tenant_limit SET trading_paused = true WHERE tenant_id = $1', [T1],
      /tenant_limit_paused_at/, 'pausing requires paused_at');

    // ------------------------------------------------- audit rows route to partitions
    // tenant_id is uuid and subject_id is text (deliberately — an audit subject
    // is often a market symbol or a client_order_id, not a uuid). Passing one
    // placeholder for both makes PostgreSQL refuse: "inconsistent types deduced
    // for parameter $1". Two parameters, one value.
    const auditInsert = `INSERT INTO audit_event (tenant_id, actor_process, action, subject_type, subject_id, occurred_at)
         VALUES ($1, 'api', 'tenant.create', 'tenant', $2, now())`;
    await client.query(auditInsert, [T1, T1]);
    await client.query(auditInsert, [T2, T2]);
    const { rows: routed } = await client.query(
      `SELECT tableoid::regclass::text AS part, count(*)::int AS n FROM audit_event GROUP BY 1`);
    assert(routed.length === 1, `audit rows landed in ${routed.length} partitions, expected 1 (the current month)`);
    assert(!routed[0].part.includes('overflow'),
      'audit rows landed in the DEFAULT partition — the monthly partition for today is missing');

    // ------------------------------------------------ a cross-tenant read returns nothing
    const { rows: mine } = await client.query('SELECT count(*)::int AS n FROM audit_event WHERE tenant_id = $1', [T1]);
    assert(mine[0].n === 1, `tenant 1 should see exactly its own audit row, saw ${mine[0].n}`);
    const { rows: theirs } = await client.query(
      'SELECT count(*)::int AS n FROM app_user WHERE tenant_id = $1', [T2]);
    assert(theirs[0].n === 0, 'tenant 2 has no users but a scoped query returned some');

    await client.query('ROLLBACK');

    // ---------------------------------------------------------------------- cleanup
    await client.query('DROP SCHEMA tradex_check CASCADE');
    assert(true, 'check schema dropped, no residue left behind');
  } finally {
    client.release();
    await pool.end();
  }
}
