// The signer PROCESS — the one thing that decrypts a customer's API secret.
//
// ARCHITECTURE X12: "No plaintext credential exists outside the signer". That is
// not a slogan; it is the reason a stolen database dump is not a stolen set of
// exchange keys. The DEK is wrapped by a KMS the API process cannot reach, and
// only this process holds the unwrap right.
//
// `apps/api/server.mjs` refuses to send to the real venue unless TRADEX_SIGNER_URL
// is set, precisely so that this split cannot be forgotten. Running the signer
// in-process is fine against the sandbox — those credentials are invented — but
// against real money it would put a live secret in the web-facing process.
//
// WHAT THIS DOES NOT DO: it never returns the secret. There is no method that
// could. It returns the public apiKey and a hex HMAC over the exact bytes it was
// handed, and it writes the decrypt audit row BEFORE returning (an unaccountable
// decrypt is indistinguishable from an exfiltration).
//
//   POST /sign   { tenantId, credentialId, payload, algorithm, reason, actorProcess }
//             -> { apiKey, signature, keyVersion }
//   GET  /healthz -> 200 when it can reach its database
//
// Run:  npm run signer      (needs DATABASE_URL and the KMS root key)

import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { forTenant, readPlatformFlags } from '../../packages/db/dist/index.js';
import { LocalKms } from '../../packages/crypto/dist/index.js';
import { Signer } from './dist/index.js';

function isMutation(reason, payloadStr) {
  if (typeof reason === 'string' && /(order|trade|exit|cancel|protection|leverage|adjust|tpsl|mutation)/i.test(reason)) {
    if (/(list\s+orders|read\s+orders|order\s+history|test\s+order\s+history)/i.test(reason)) {
      return false;
    }
    return true;
  }
  if (typeof payloadStr === 'string') {
    try {
      const p = JSON.parse(payloadStr);
      if (p.total_quantity !== undefined || p.order_type !== undefined) return true;
      if (p.stop_loss_trigger !== undefined || p.take_profit_trigger !== undefined || p.stop_loss_price !== undefined || p.take_profit_price !== undefined) return true;
      if (p.leverage !== undefined) return true;
    } catch {
      if (/("total_quantity"|"order_type"|"stop_loss_trigger"|"take_profit_trigger"|"stop_loss_price"|"take_profit_price")/i.test(payloadStr)) {
        return true;
      }
    }
  }
  return false;
}

const PORT = Number(process.env['SIGNER_PORT'] ?? 8098);
const url = process.env['DATABASE_URL'];
if (url === undefined || url === '') {
  console.error('DATABASE_URL is not set — the signer cannot reach the credentials it must open.');
  process.exit(1);
}

/**
 * A shared secret between the API and the signer.
 *
 * Optional, because on a private network the topology is the control. Set it and
 * every request must carry it: an unauthenticated signer is a decryption oracle
 * for anything that can reach the port, which is a worse failure than the one the
 * process split is defending against.
 */
const TOKEN = process.env['TRADEX_SIGNER_TOKEN'];

const pool = new pg.Pool({ connectionString: url, max: 5 });
const db = new Kysely({ dialect: new PostgresDialect({ pool }) });

/**
 * The KMS. `allowInProduction` is a DELIBERATE, RECORDED choice: without a managed
 * KMS the root key lives in an environment variable, so anyone holding that
 * variable plus a database dump can open every credential. See
 * docs/ops/go-live-gates.md before flipping this.
 */
const kms = new LocalKms({ allowInProduction: process.env['NODE_ENV'] === 'production' });
if (kms.keyId === 'local-kms:ephemeral') {
  console.error(
    'The KMS root key is EPHEMERAL. Every credential sealed in this process would be\n'
    + 'unrecoverable on restart. Set TRADEX_LOCAL_ROOT_KEY to a stable value and restart.',
  );
  process.exit(1);
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const tokenOk = (req) => {
  if (TOKEN === undefined || TOKEN === '') return true;
  const given = req.headers['x-tradex-signer-token'];
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
};

const server = createServer((req, res) => {
  void (async () => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        await db.selectFrom('tenant').select('id').limit(1).execute();
        json(res, 200, { ok: true, kms: kms.keyId });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/sign') {
        json(res, 404, { message: 'not found' });
        return;
      }
      if (!tokenOk(req)) {
        json(res, 403, { message: 'bad or missing signer token' });
        return;
      }
      const body = JSON.parse(await readBody(req));
      const { tenantId, credentialId, payload, algorithm, reason, actorProcess } = body ?? {};
      if (typeof tenantId !== 'string' || typeof credentialId !== 'string') {
        json(res, 400, { message: 'tenantId and credentialId are required' });
        return;
      }

      // Emergency Kill Switch Check:
      // If the platform kill switch is engaged, refuse to sign any order placement,
      // position exit, adjustment, or TP/SL mutation. Only read-only requests may be signed.
      const platform = await readPlatformFlags(db);
      const killSwitchActive = platform.killSwitch || platform.mode === 'read_only' || process.env['TRADEX_KILL_SWITCH'] === '1';
      if (killSwitchActive && isMutation(reason, payload)) {
        console.warn(`[signer] REFUSED signature: Kill Switch is active (reason: ${reason})`);
        json(res, 403, {
          ok: false,
          refused: true,
          code: 'KILL_SWITCH_ACTIVE',
          message: `The Signer refused to sign: Emergency Kill Switch is ACTIVE (${platform.modeReason ?? 'Platform in read-only mode'}). No trading or position mutations are allowed.`,
        });
        return;
      }

      const result = await new Signer({ tdb: forTenant(db, tenantId), kms }).sign({
        credentialId,
        payload,
        algorithm,
        reason,
        actorProcess,
      });
      // Deliberately NOT logged with the payload: its length and the credential are
      // enough to audit, and the bytes are the customer's order.
      console.log(`[signer] ${actorProcess ?? '?'} signed ${String(payload).length} bytes for credential ${credentialId}`);
      json(res, 200, result);
    } catch (e) {
      // A refusal (revoked credential, pending validation, bad algorithm) is the
      // caller's problem to report, not an internal error.
      json(res, 400, { message: e instanceof Error ? e.message : String(e) });
    }
  })();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Tradex signer listening on http://127.0.0.1:${PORT} (kms: ${kms.keyId})`);
  console.log(`  token: ${TOKEN === undefined || TOKEN === '' ? 'NONE — set TRADEX_SIGNER_TOKEN' : 'required on every request'}`);
});

const shutdown = () => { server.close(() => { void db.destroy().then(() => process.exit(0)); }); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
