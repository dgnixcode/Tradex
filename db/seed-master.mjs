// Standalone seed / provisioning script for Master Account.
//
// Usage: node --env-file-if-exists=.env db/seed-master.mjs [optionalPassword]

import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { hashPassword } from '../packages/auth/dist/index.js';

const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set — see .env');
  process.exit(1);
}

const MASTER_EMAIL = 'dgnix.com@gmail.com';
const MASTER_TENANT_ID = 'de11a000-0000-4000-8000-000000000000';

function generateSecurePassword(length = 24) {
  const charset = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%&*+=-';
  const bytes = randomBytes(length);
  let result = '';
  for (let i = 0; i < length; i++) {
    result += charset[bytes[i] % charset.length];
  }
  return result;
}

const plainPassword = process.env['MASTER_PASSWORD'] || process.argv[2] || generateSecurePassword(24);

const pool = new pg.Pool({ connectionString: url, max: 2 });

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ensure master tenant exists
    await client.query(
      `INSERT INTO tenant (id, name, valuation_currency)
       VALUES ($1, 'Platform Administration', 'USDT')
       ON CONFLICT (id) DO UPDATE SET name = 'Platform Administration'`,
      [MASTER_TENANT_ID],
    );

    // 2. Ensure tenant_limit exists for master tenant
    await client.query(
      `INSERT INTO tenant_limit (tenant_id)
       VALUES ($1)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [MASTER_TENANT_ID],
    );

    // 3. Hash password
    const passwordHash = await hashPassword(plainPassword);

    // 4. Upsert app_user for master account
    const existing = await client.query(
      `SELECT id FROM app_user WHERE email = $1`,
      [MASTER_EMAIL],
    );

    let userId;
    if (existing.rows.length > 0) {
      userId = existing.rows[0].id;
      await client.query(
        `UPDATE app_user
         SET password_hash = $1, is_master = true, role = 'owner', disabled_at = NULL
         WHERE id = $2`,
        [passwordHash, userId],
      );
    } else {
      const res = await client.query(
        `INSERT INTO app_user (tenant_id, email, password_hash, role, is_master)
         VALUES ($1, $2, $3, 'owner', true)
         RETURNING id`,
        [MASTER_TENANT_ID, MASTER_EMAIL, passwordHash],
      );
      userId = res.rows[0].id;
    }

    await client.query('COMMIT');

    console.log('========================================================');
    console.log('Master Account Provisioned Successfully');
    console.log('========================================================');
    console.log(`Email:       ${MASTER_EMAIL}`);
    console.log(`Password:    ${plainPassword}`);
    console.log(`User ID:     ${userId}`);
    console.log(`Tenant ID:   ${MASTER_TENANT_ID}`);
    console.log(`Role:        owner`);
    console.log(`Is Master:   true`);
    console.log(`Login URL:   /login`);
    console.log(`Master View: /app/master`);
    console.log('========================================================');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Failed to seed master account:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
