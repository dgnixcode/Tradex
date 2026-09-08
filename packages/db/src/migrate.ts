// Migration runner — plan/phase-00 T00.5.
//
// Forward-only, checksummed, one transaction per file. No down migrations: a
// code rollback must never require a schema rollback (20 F5), so corrections
// ship as new files.
//
// Usage:  node packages/db/dist/migrate.js            # apply pending
//         node packages/db/dist/migrate.js --status   # list without applying

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

export interface MigrationFile {
  readonly version: string;
  readonly path: string;
  readonly sql: string;
  readonly checksum: string;
}

const checksumOf = (sql: string): string =>
  createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 16);

/** Read and order the migration files. Order is lexical, so names are zero-padded. */
export function loadMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), 'utf8');
      return { version: f.replace(/\.sql$/, ''), path: join(dir, f), sql, checksum: checksumOf(sql) };
    });
}

export interface MigrationStatus {
  readonly version: string;
  readonly applied: boolean;
  readonly checksumMatches: boolean | null;
}

const BOOTSTRAP = `
  CREATE TABLE IF NOT EXISTS schema_migration (
    version    text PRIMARY KEY,
    checksum   text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

export async function migrate(
  pool: Pool,
  dir: string,
  opts: { dryRun?: boolean } = {},
): Promise<MigrationStatus[]> {
  const files = loadMigrations(dir);
  await pool.query(BOOTSTRAP);
  const { rows } = await pool.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migration',
  );
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));

  const status: MigrationStatus[] = [];

  for (const file of files) {
    const previous = applied.get(file.version);
    if (previous !== undefined) {
      // An edited migration that has already run is a hard error: environments
      // would silently diverge.
      if (previous !== file.checksum) {
        throw new MigrationError(
          `${file.version} has already been applied but its contents changed ` +
            `(recorded ${previous}, now ${file.checksum}). Migrations are immutable — ship a new one.`,
        );
      }
      status.push({ version: file.version, applied: true, checksumMatches: true });
      continue;
    }
    status.push({ version: file.version, applied: false, checksumMatches: null });
    if (opts.dryRun === true) continue;

    const client = await pool.connect();
    try {
      // The migration file owns its own BEGIN/COMMIT so it can use
      // transaction-incompatible statements where it must.
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migration (version, checksum) VALUES ($1, $2)', [
        file.version,
        file.checksum,
      ]);
      // Report what is true when we return, not what was true on entry. Saying
      // PENDING for a file that just ran successfully reads as a failure.
      status[status.length - 1] = { version: file.version, applied: true, checksumMatches: true };
    } finally {
      client.release();
    }
  }
  return status;
}

/* c8 ignore start — CLI wrapper */
const isCli = process.argv[1]?.endsWith('migrate.js') === true;
if (isCli) {
  const dir = process.env['TRADEX_MIGRATIONS_DIR'] ?? 'db/migrations';
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    console.error('DATABASE_URL is not set. PostgreSQL is required to apply migrations.');
    process.exit(2);
  }
  const pool = new Pool({ connectionString: url });
  const dryRun = process.argv.includes('--status');
  try {
    const result = await migrate(pool, dir, { dryRun });
    for (const s of result) {
      console.log(`${s.applied ? 'applied ' : 'PENDING '} ${s.version}`);
    }
    console.log(dryRun ? '(status only, nothing applied)' : 'migrations up to date');
  } finally {
    await pool.end();
  }
}
/* c8 ignore stop */
