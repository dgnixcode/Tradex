// 13-support-no-decrypt — plan/phase-13 T13.5.
//
// There must be NO route a support action (or anything else) can call that
// decrypts a stored key: the plaintext path ends at the signer, which nothing in
// the running API/web surfaces imports. This is a code search over every API and
// web source file — if a support route is ever added that reaches a decrypt, this
// turns red before it ships.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const FORBIDDEN = [
  /\bopenCredential\b/,
  /\bopenWithDek\b/,
  /\bunwrapDek\b/,
  /\.expose\s*\(/,
  /\bdecrypt\s*\(/,
  /@tradex\/signer/,
  /\/api\/sign\b/,
  /\bprocess\.sign\b/,
];

function collect(dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) collect(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

export async function run(assert) {
  const files = [
    ...collect(join(root, 'apps', 'api', 'src'), []),
    ...collect(join(root, 'apps', 'web', 'src'), []),
  ].filter((f) => !/\.test\.ts$/.test(f));
  assert(files.length > 0, 'no API/web source to scan — the check is vacuous');

  const hits = [];
  for (const file of files) {
    const code = stripComments(readFileSync(file, 'utf8'));
    const rel = file.slice(root.length + 1).replace(/\\/g, '/');
    for (const pat of FORBIDDEN) {
      if (pat.test(code)) hits.push(`${rel} matches ${pat}`);
    }
  }
  assert(hits.length === 0,
    `a route can reach a decrypt path: ${hits.join('; ')} — support tooling must have no decrypt to grant`);
}
