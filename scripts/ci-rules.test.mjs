// Every CI rule must fire on a deliberately-violating fixture, and the clean
// fixture set must produce nothing. A rule nobody has seen fail is a rule
// nobody knows works — plan/phase-00 T00.2 acceptance criterion.

import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RULES, runRules } from './ci-rules.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, '__fixtures__');
const clean = join(fixtures, 'clean');

describe('ci-rules', () => {
  const found = runRules(fixtures);
  const ids = new Set(found.map((v) => v.ruleId));

  it('fires every rule at least once against the fixtures', () => {
    for (const rule of RULES) {
      expect(ids, `rule ${rule.id} never fired — its fixture is missing or the rule is broken`).toContain(rule.id);
    }
  });

  it('reports file and line for each violation', () => {
    for (const v of found) {
      expect(v.file).toMatch(/\.ts$/);
      expect(v.line).toBeGreaterThan(0);
      expect(v.why.length).toBeGreaterThan(10);
    }
  });

  it('does not fire on a clean fixture', () => {
    expect(runRules(clean)).toEqual([]);
  });

  it('does not fire on prose in a comment', () => {
    // The stripComments pass exists so a doc comment mentioning `: number`
    // or `.expose()` cannot fail the build.
    const violations = runRules(clean);
    expect(violations).toHaveLength(0);
  });
});
