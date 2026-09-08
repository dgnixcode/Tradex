// 00-tenant-isolation — plan/phase-00 T00.4/T00.5.
//
// PostgreSQL is not installed on this machine, so this check validates the
// migration SQL statically rather than by applying it. That turns out to be
// worth having regardless of a database: the failures it catches are the ones a
// green test suite would not notice.
//
// The most valuable assertion is the cross-reference in section 2: any table
// that carries `tenant_id` but is missing from TENANT_SCOPED_TABLES is reachable
// through an unscoped query, which is exactly how a cross-tenant leak happens
// (RISK-REGISTER R15).

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GLOBAL_TABLES, TENANT_SCOPED_TABLES } from '../packages/db/dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'db', 'migrations');

const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const sqlByFile = new Map(files.map((f) => [f, readFileSync(join(migrationsDir, f), 'utf8')]));

/**
 * Strip SQL comments before scanning for forbidden types.
 *
 * Without this the check tests prose, not schema. Migration 003's comment
 * contains the words "a real run", and `/\breal\b/` fired on it — a failure that
 * says D01 was violated when nothing was declared at all. The inverse is worse:
 * an actual `double precision` column sitting inside a comment-heavy file is the
 * thing we want caught, and it only stays caught if the scan is aimed at code.
 *
 * Dollar-quoted bodies ($$ ... $$) are kept: plpgsql there is real code and a
 * `--` inside it is a genuine comment, so line-comment stripping applies
 * uniformly. Nothing here declares a column type inside a string literal.
 */
const stripSqlComments = (sql) => sql
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/--[^\n]*/g, ' ');

const codeByFile = new Map([...sqlByFile].map(([f, sql]) => [f, stripSqlComments(sql)]));
const allSql = [...sqlByFile.values()].join('\n');
/** Comment-free, for assertions about what the schema DECLARES. */
const allCode = [...codeByFile.values()].join('\n');

/** Extract `CREATE TABLE <name> ( ... )` bodies, tolerating PARTITION clauses. */
function parseTables(sql) {
  const out = new Map();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    let depth = 1;
    let i = re.lastIndex;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth += 1;
      else if (sql[i] === ')') depth -= 1;
      i += 1;
    }
    const body = sql.slice(re.lastIndex, i - 1);
    const tail = sql.slice(i, sql.indexOf(';', i) + 1);
    out.set(name, { body, tail });
  }
  return out;
}

export async function run(assert) {
  // Every assertion below is a claim about what the migrations DECLARE, so all
  // of them read the comment-free text. Scanning raw SQL makes the check fire on
  // English: 003's comment contains "a real run" and 004's explains why there are
  // no down migrations, and both were false positives before this.
  const tables = parseTables(allCode);

  // -------------------------------------------------- 1. the files themselves
  assert(files.length >= 2, `expected at least two migration files, found ${files.length}`);
  assert(files[0].startsWith('001_'), 'migrations must be zero-padded and ordered; the first is not 001_');
  for (const f of files) {
    assert(/^\d{3}_[a-z0-9_]+\.sql$/.test(f), `migration filename is not NNN_snake_case.sql: ${f}`);
  }
  for (const [f, sql] of codeByFile) {
    assert(/BEGIN;/.test(sql), `${f} does not open a transaction`);
    assert(/COMMIT;/.test(sql), `${f} does not commit`);
    assert(!/\bDOWN\b|-- *rollback/i.test(sql), `${f} appears to contain a down migration; migrations are forward-only`);
  }

  // ------------------------------------- 2. the tenant-scoping cross-reference
  const withTenantId = [...tables.entries()]
    .filter(([, t]) => /\btenant_id\b/.test(t.body))
    .map(([name]) => name);

  assert(withTenantId.length > 0, 'no table in the migrations carries tenant_id — the parser is broken');

  const registry = new Set(TENANT_SCOPED_TABLES);
  for (const name of withTenantId) {
    assert(
      registry.has(name),
      `table "${name}" has a tenant_id column but is NOT in TENANT_SCOPED_TABLES — it is reachable unscoped`,
    );
  }
  for (const name of TENANT_SCOPED_TABLES) {
    assert(
      tables.has(name),
      `TENANT_SCOPED_TABLES lists "${name}" but no migration creates it`,
    );
  }
  const globals = new Set(GLOBAL_TABLES);
  for (const name of withTenantId) {
    assert(!globals.has(name), `"${name}" is listed as global but carries tenant_id`);
  }

  // ------------------------------------------------------ 3. money-type safety
  // Asserted against comment-free SQL: this is a claim about what the schema
  // DECLARES, not about what the migrations talk about.
  const badTypes = allCode.match(/\b(float\d*|double\s+precision|real|money)\b/gi);
  assert(badTypes === null,
    `a floating-point or money column type appears in the migrations (${badTypes?.join(', ')})`
      + ' — DECISIONS.md D01 forbids it');
  // A numeric COLUMN with no precision invites mixed-scale bugs, so declarations
  // must always say (38,0). A `::numeric` CAST is the opposite case and is
  // deliberately allowed: migration 005 range-checks its `venue_decimal` columns
  // with `max_price::numeric >= min_price::numeric`, and a cast to *bare* numeric
  // is exactly right there because Postgres gives it unlimited precision. Pinning
  // that cast to numeric(38,18) would be the version that silently truncates a
  // venue decimal carrying 18 places. So the lookbehind excludes casts and
  // nothing else — a declaration is still caught.
  const bareNumeric = allCode.match(/(?<!::)\bnumeric\b(?!\s*\()/gi);
  assert(bareNumeric === null,
    `numeric without explicit precision found (${bareNumeric?.length}) — implicit scale invites mixed-scale bugs`);
  // The narrowing above must not have disarmed the rule.
  assert(/(?<!::)\bnumeric\b(?!\s*\()/i.test('amount_minor numeric NOT NULL'),
    'the bare-numeric scan no longer catches an undeclared-precision column');
  assert(!/(?<!::)\bnumeric\b(?!\s*\()/i.test('CHECK (max_price::numeric >= min_price::numeric)'),
    'the bare-numeric scan still fires on a comparison cast');
  assert(/(?<!::)\bnumeric\b(?!\s*\()/i.test('rate numeric, note the cast x::numeric'),
    'the bare-numeric scan must still catch a declaration sitting beside a cast');

  // The stripper itself has to work, or this whole section silently passes.
  assert(!/\breal\b/.test(stripSqlComments('a -- a real column\nb')), 'line comments are not stripped');
  assert(!/\bdouble\b/.test(stripSqlComments('a /* double\nprecision */ b')), 'block comments are not stripped');
  assert(/\bfloat\d*\b/.test(stripSqlComments('x float8 y')), 'the stripper removed code, not just comments');
  assert(/\breal\b/i.test(allSql), 'expected the word "real" in a migration comment, which is what makes the'
    + ' stripper load-bearing — if this fails, remove it and scan the raw SQL');
  assert(!/\breal\b/i.test(allCode), 'the stripper left a commented "real" behind');
  for (const [name, t] of tables) {
    for (const m of t.body.matchAll(/(\w+)\s+numeric\((\d+),(\d+)\)/gi)) {
      assert(m[2] === '38' && m[3] === '0',
        `${name}.${m[1]} is numeric(${m[2]},${m[3]}); money columns are numeric(38,0) minor units`);
    }
  }

  // ----------------------------------------------------- 4. required constraints
  const tenant = tables.get('tenant');
  assert(tenant !== undefined, 'migration 001 does not create the tenant table');
  assert(/valuation_currency[\s\S]*?CHECK[\s\S]*?'INR'[\s\S]*?'USDT'/i.test(tenant.body),
    'tenant.valuation_currency has no CHECK constraining it to INR/USDT');
  assert(/kyc_status[\s\S]*?CHECK/i.test(tenant.body),
    'tenant.kyc_status has no CHECK — the KYC-capable requirement from 15 F5');

  const appUser = tables.get('app_user');
  assert(appUser !== undefined, 'migration 001 does not create app_user');
  assert(/UNIQUE\s*\(\s*email\s*\)/i.test(appUser.body), 'app_user.email is not UNIQUE');
  assert(/role\s+text\s+NOT\s+NULL\s+CHECK[\s\S]*?'owner'[\s\S]*?'trader'[\s\S]*?'viewer'/i.test(appUser.body),
    'app_user.role does not CHECK the owner/trader/viewer matrix from 19 F4');
  assert(/totp_secret_ct/.test(appUser.body), 'app_user has no encrypted TOTP column');
  assert(!/exchange_password|exchange_2fa/i.test(allCode),
    'a column looks like it stores the customer exchange password or 2FA seed — 07 F10 forbids it');

  const limits = tables.get('tenant_limit');
  assert(limits !== undefined, 'migration 001 does not create tenant_limit');
  for (const col of ['max_order_notional_minor', 'max_daily_notional_minor', 'trading_paused']) {
    assert(new RegExp(col).test(limits.body), `tenant_limit is missing ${col} — the caps and kill switch (phase 05)`);
  }

  const platform = tables.get('platform_state');
  assert(platform !== undefined, 'migration 001 does not create platform_state');
  assert(/CHECK\s*\(\s*id\s*=\s*'singleton'\s*\)/i.test(platform.body),
    'platform_state is not constrained to a single row');
  assert(/global_kill_switch/.test(platform.body), 'platform_state has no global kill switch');
  assert(/mode[\s\S]*?CHECK[\s\S]*?'normal'[\s\S]*?'cancel_only'[\s\S]*?'read_only'/i.test(platform.body),
    'platform_state.mode does not CHECK the three degraded modes from 22 F7');

  // -------------------------------------------------------- 5. the audit trail
  const audit = tables.get('audit_event');
  assert(audit !== undefined, 'migration 001 does not create audit_event');
  assert(/PARTITION\s+BY\s+RANGE\s*\(\s*occurred_at\s*\)/i.test(audit.tail),
    'audit_event is not partitioned by occurred_at — 22 F5 requires it from day one, not retrofitted');
  assert(/PRIMARY\s+KEY\s*\(\s*id\s*,\s*occurred_at\s*\)/i.test(audit.body),
    'audit_event primary key must include the partition key occurred_at');
  assert(/ensure_audit_partition/.test(allCode), 'no partition-maintenance function exists');
  assert(/PARTITION\s+OF\s+audit_event\s+DEFAULT/i.test(allCode),
    'no DEFAULT partition — an audit write would fail outright if the scheduler fell behind');
  assert(!/TTL|DROP\s+PARTITION/i.test(allCode),
    'something looks like it deletes audit rows; retention is 5 years (CoinDCX clause 6.6 and PMLA)');

  // ------------------------------------------- 6. the scoping layer agrees
  // Both directions were asserted in section 2; this pins the counts so that
  // adding a table without updating either side fails here.
  assert(withTenantId.length === TENANT_SCOPED_TABLES.length,
    `${withTenantId.length} tables carry tenant_id but the registry lists ${TENANT_SCOPED_TABLES.length}`);
}
