// 07-no-mark-to-market — plan/phase-07, the §6a boundary as a structural check.
//
// The books must never value a holding at a CURRENT market price: no unrealised
// P&L, no mark-to-market, no equity/valuation path. That is the read/display
// boundary (rescoped 2026-09-05). This is a source-scan invariant: the ledger,
// sizing and API code must not reference a valuation vocabulary at all — if a
// future phase reverses §6a it has to ADD that vocabulary on purpose.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const SCAN = [
  'packages/ledger/src',
  'packages/sizing/src',
  'apps/api/src',
];

const FORBIDDEN = [
  /\bunrealised_pnl\b/i,
  /\bunrealized_pnl\b/i,
  /\bmark.?to.?market\b/i,
  /\bmark_price\b/i,
  /\bequity_snapshot\b/i,
  /\bportfolio_value\b/i,
];

export async function run(assert) {
  let scanned = 0;
  const hits = [];
  for (const dir of SCAN) {
    const base = join(root, dir);
    let names;
    try { names = readdirSync(base); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      scanned += 1;
      const src = stripComments(readFileSync(join(base, name), 'utf8'));
      for (const pat of FORBIDDEN) {
        if (pat.test(src)) hits.push(`${dir}/${name} matches ${pat}`);
      }
    }
  }
  assert(scanned > 0, 'no source scanned — the scan is vacuous');
  assert(hits.length === 0, `a valuation/mark-to-market path exists: ${hits.join('; ')}`);
  // And the positive half: the fold really does realise P&L (the allowed kind).
  const fold = readFileSync(join(root, 'packages/ledger/src/fold.ts'), 'utf8');
  assert(/realised/.test(fold), 'fold.ts no longer computes realised P&L — the scan is testing the wrong file');
}
