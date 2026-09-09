// 12-no-market-price — plan/phase-12, the §6a boundary for the metrics surfaces.
//
// A metric or screen must never consume a CURRENT market price. The metrics
// module and the analytics service read OUR records only. This scans those files
// for a price/valuation vocabulary (mirrors 07-no-mark-to-market) AND asserts the
// metric input type declares no price-shaped fact, so the boundary cannot be
// crossed by naming something else.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const FILES = [
  'packages/metrics/src/index.ts',
  'apps/api/src/analytics.ts',
  'packages/db/src/analytics-repo.ts',
];

// Valuation / current-price vocabulary — including the venue packages that exist
// only to fetch one, and any call that would reach for a live price.
const FORBIDDEN = [
  /\bunrealised_pnl\b/i, /\bunrealized_pnl\b/i,
  /\bmark.?to.?market\b/i, /\bmark_price\b/i, /\bequity_snapshot\b/i, /\bportfolio_value\b/i,
  /@tradex\/exchange(?!-coindcx\b)/,
  /\bgetOrderBook\b/, /\bticker\b/i, /\bmark\b/i,
];

export async function run(assert) {
  const scanned = [];
  const hits = [];
  for (const file of FILES) {
    const full = join(root, file);
    let src;
    try { src = readFileSync(full, 'utf8'); } catch { continue; }
    scanned.push(file);
    const code = stripComments(src);
    for (const pat of FORBIDDEN) {
      if (pat.test(code)) hits.push(`${file} matches ${pat}`);
    }
  }
  assert(scanned.length === 3, `scanned ${scanned.length}/3 analytics files — the scan is not vacuous`);

  // The metric INPUT type declares minor-unit facts only — no price-shaped field.
  const metricsSrc = readFileSync(join(root, 'packages/metrics/src/index.ts'), 'utf8');
  const factBlock = /interface MetricFacts \{[\s\S]*?\}/.exec(metricsSrc)?.[0] ?? '';
  assert(factBlock !== '', 'the MetricFacts interface must exist to be checked');
  assert(!/price/i.test(factBlock) && !/value/i.test(factBlock) && !/rate/i.test(factBlock),
    'MetricFacts must not carry a price/value/rate-shaped input');

  // The module never imports anything but itself (no venue, no clock, no IO).
  const imports = metricsSrc.split('\n').filter((l) => /^\s*import /.test(stripComments(l)));
  assert(imports.length === 0, `@tradex/metrics must be import-free, found: ${imports.join('; ')}`);

  assert(hits.length === 0, `a valuation/current-price path exists in the analytics surface: ${hits.join('; ')}`);
}
