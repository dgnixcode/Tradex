// CI correctness rules — plan/phase-00 T00.2.
//
// These are grep-shaped rules rather than lint plugins on purpose: they must be
// trivially readable during an incident, and they must fail the build rather
// than warn. Each rule cites the research document that requires it.
//
// Usage:  node scripts/ci-rules.mjs [rootDir]
// Exit 0 = clean, exit 1 = violations printed as file:line.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'coverage', 'research', 'plan', '.tmpwork',
]);

/**
 * `test` receives the line and the file's forward-slashed relative path, so a
 * rule can make a narrow, stated exception for a test file without needing a
 * second rule to express it.
 *
 * @typedef {{id:string, why:string, source:string, appliesTo:(p:string)=>boolean, test:(line:string, rel:string)=>boolean}} Rule
 */

/** Path helper that works regardless of platform separator. */
const inDir = (rel, ...parts) => rel.split(sep).join('/').startsWith(parts.join('/'));

/** @type {Rule[]} */
export const RULES = [
  {
    id: 'MONEY-NO-NUMBER',
    why: 'A JS number cannot hold exact money. Use Money/Qty (string- or bigint-backed).',
    source: 'DECISIONS.md D01, DATA-MODEL.md',
    appliesTo: (rel) =>
      (inDir(rel, 'packages/money') || inDir(rel, 'packages/sizing') || inDir(rel, 'packages/ledger')) &&
      /\.ts$/.test(rel) &&
      !/\.test\.ts$/.test(rel) &&
      !/fixtures/.test(rel),
    // Only fires when the identifier is monetary. A loop counter or a string
    // length may legitimately be a number; a price may not. Keeping the rule
    // targeted is what stops it being disabled the first time it is wrong.
    test: (line) =>
      /\b\w*(amount|minor|qty|quantity|price|notional|balance|fee|tds|total|delta|rate|cost|pnl|capital)\w*\s*\??\s*:\s*number\b/i
        .test(stripComments(line)),
  },
  {
    id: 'MONEY-NO-NUMBER-CAST',
    why: 'Number(x) on a money value destroys precision. Go through the decimal wrapper.',
    source: 'DATA-MODEL.md — the pg numeric-as-string trap',
    appliesTo: (rel) =>
      (inDir(rel, 'packages/money') || inDir(rel, 'packages/sizing') || inDir(rel, 'packages/ledger')) &&
      /\.ts$/.test(rel) &&
      !/\.test\.ts$/.test(rel) &&
      !/fixtures/.test(rel),
    test: (line) => /\bNumber\s*\(|\bparseFloat\s*\(/.test(stripComments(line)),
  },
  {
    id: 'NO-PG-TYPE-PARSER',
    why: 'Registering a numeric type parser reintroduces float error into every balance.',
    source: 'DATA-MODEL.md — never convert numeric to number',
    appliesTo: (rel) => /\.(ts|mjs|js)$/.test(rel) && !/fixtures/.test(rel) && !inDir(rel, 'scripts'),
    test: (line) => /setTypeParser\s*\(/.test(stripComments(line)),
  },
  {
    id: 'ADAPTER-BOUNDARY',
    why: 'CoinDCX types must not leak above the adapter — clause 5.2 lets them terminate without notice.',
    source: 'DECISIONS.md D12, 17-architecture-stack.md F4',
    appliesTo: (rel) =>
      /\.ts$/.test(rel) &&
      !inDir(rel, 'packages/exchange-coindcx') &&
      !/fixtures/.test(rel) &&
      !/\.test\.ts$/.test(rel),
    test: (line) => /from\s+['"]@tradex\/exchange-coindcx['"]/.test(stripComments(line)),
  },
  {
    id: 'SIZING-PURE-NO-IO',
    why: 'packages/sizing must be a pure function of its inputs: no I/O, no clock, no randomness.',
    source: 'plan/phase-03 scope and definition of done, 09 F5',
    appliesTo: (rel) => inDir(rel, 'packages/sizing') && /\.ts$/.test(rel),
    // The whole safety argument for sizing is that it is reproducible: the same
    // intent and the same metadata must produce the same quantity in a test, at
    // plan time, and in a replay six months later. A clock read or a database
    // call breaks that silently — the numbers still look plausible.
    //
    // Tests are NOT exempt. A test that reaches for a clock is a test that will
    // pass today and fail at midnight, and there is nothing in this package that
    // legitimately needs one.
    test: (line) => {
      const code = stripComments(line);
      return /\bfrom\s+['"]node:/.test(code)
        || /\brequire\s*\(\s*['"]node:/.test(code)
        || /\bfrom\s+['"](pg|kysely|undici|axios|node-fetch)['"]/.test(code)
        || /\bfetch\s*\(/.test(code)
        || /\bDate\s*\.\s*now\s*\(/.test(code)
        || /\bnew\s+Date\s*\(/.test(code)
        || /\bMath\s*\.\s*random\s*\(/.test(code)
        || /\bprocess\s*\.\s*(env|argv|hrtime)\b/.test(code)
        || /\bperformance\s*\.\s*now\s*\(/.test(code);
    },
  },
  {
    id: 'SIZING-IMPORT-ALLOWLIST',
    why: 'packages/sizing may only import @tradex/money and @tradex/exchange, both of which are pure.',
    source: 'plan/phase-03 definition of done ("zero imports with I/O, CI-enforced")',
    appliesTo: (rel) => inDir(rel, 'packages/sizing') && /\.ts$/.test(rel),
    // SIZING-PURE-NO-IO catches I/O written directly in this package. This rule
    // closes the transitive hole: importing a package that does I/O would make
    // sizing impure without a single banned token appearing in these files. The
    // allowlist is deliberately tiny, so widening it is a decision someone has to
    // make on purpose rather than a dependency that arrives by accident.
    test: (line, rel) => {
      const code = stripComments(line);
      const m = /\bfrom\s+['"]([^'"]+)['"]/.exec(code);
      if (m === null) return false;
      const spec = m[1];
      if (spec.startsWith('.')) return false; // within the package
      // A test file may reach for the runner, and nothing else. SIZING-PURE-NO-IO
      // still applies to tests, so this is not a way in for `pg` or `node:fs`.
      if (spec === 'vitest' && /\.(test|type-test)\.ts$/.test(rel)) return false;
      return spec !== '@tradex/money' && spec !== '@tradex/exchange';
    },
  },
  {
    id: 'SIGNER-ONLY-EXPOSE',
    why: 'Secret.expose() outside the signer means plaintext beyond its boundary.',
    source: '07-api-key-security.md F5/F6',
    appliesTo: (rel) =>
      /\.ts$/.test(rel) &&
      !inDir(rel, 'apps/signer') &&
      !inDir(rel, 'packages/secret') &&
      !inDir(rel, 'packages/crypto') &&
      !/fixtures/.test(rel) &&
      !/\.test\.ts$/.test(rel),
    test: (line) => /\.expose\s*\(/.test(stripComments(line)),
  },
  {
    id: 'WEB-NO-MONEY-MODULE',
    why: 'A component must never compute money — screens only render metric/report objects (invariant N1).',
    source: 'plan/phase-12 T12.1',
    appliesTo: (rel) => inDir(rel, 'apps/web') && /\.(ts|tsx)$/.test(rel),
    // Money arithmetic lives server-side (packages/money + the metric module). A
    // web file importing one of these at runtime would let a screen re-derive a
    // figure, which is exactly the drift N1 forbids. Type-only imports are erased
    // and carry no arithmetic, so only a value import trips this.
    test: (line) => {
      const code = stripComments(line);
      const isTypeOnly = /^\s*import\s+type\b/.test(code);
      if (isTypeOnly) return false;
      return /from\s+['"]@tradex\/(money|sizing|metrics|ledger)['"]/.test(code);
    },
  },
];

/**
 * Strip line comments and block-comment bodies so a rule cannot fire on prose.
 * Deliberately simple: it removes `//…` and `/*…` to end of line. It does not
 * try to parse strings — a false positive is cheaper than a missed violation.
 */
function stripComments(line) {
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*$/, '');
}

function* walk(dir, root = dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full, root);
    else yield { full, rel: relative(root, full) };
  }
}

/** @returns {{ruleId:string, file:string, line:number, text:string, why:string}[]} */
export function runRules(root) {
  const violations = [];
  for (const { full, rel } of walk(root)) {
    const applicable = RULES.filter((r) => r.appliesTo(rel));
    if (applicable.length === 0) continue;
    const lines = readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((text, i) => {
      for (const rule of applicable) {
        if (rule.test(text, rel.split(sep).join('/'))) {
          violations.push({
            ruleId: rule.id,
            file: rel.split(sep).join('/'),
            line: i + 1,
            text: text.trim().slice(0, 120),
            why: rule.why,
          });
        }
      }
    });
  }
  return violations;
}

if (import.meta.url === `file://${process.argv[1]?.split(sep).join('/')}` || process.argv[1]?.endsWith('ci-rules.mjs')) {
  const root = process.argv[2] ?? process.cwd();
  const found = runRules(root);
  if (found.length === 0) {
    console.log(`PASS ci-rules — ${RULES.length} rules, 0 violations`);
    process.exit(0);
  }
  for (const v of found) {
    console.error(`${v.file}:${v.line}  [${v.ruleId}] ${v.text}\n    ${v.why}`);
  }
  console.error(`\nFAIL ci-rules — ${found.length} violation(s)`);
  process.exit(1);
}
