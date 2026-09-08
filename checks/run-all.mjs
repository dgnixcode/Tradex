// Check-script runner — plan/phase-00, and the convention from 18-testing-correctness-program.md F8.
//
// A "check" is a standalone runnable script that prints its own assertion count.
// The point is that during an incident you can run one file in isolation and
// read the output, without a test framework in the way. Each phase's definition
// of done cites a check name and an assertion count, so "done" is a command.
//
// Usage:  node checks/run-all.mjs [nameFilter]

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

const files = readdirSync(here)
  .filter((f) => f.endsWith('.check.mjs'))
  .filter((f) => (filter ? f.includes(filter) : true))
  .sort();

if (files.length === 0) {
  console.log(filter ? `no checks match "${filter}"` : 'no checks defined yet');
  process.exit(0);
}

let totalAssertions = 0;
let failed = 0;

for (const file of files) {
  const mod = await import(pathToFileURL(join(here, file)).href);
  if (typeof mod.run !== 'function') {
    console.error(`FAIL ${file} — must export an async function \`run(assert)\``);
    failed += 1;
    continue;
  }
  let count = 0;
  const assert = (condition, message) => {
    count += 1;
    if (!condition) throw new Error(`assertion ${count} failed: ${message}`);
  };
  try {
    await mod.run(assert);
    totalAssertions += count;
    console.log(`PASS ${file.replace('.check.mjs', '')} — ${count} assertions`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${file.replace('.check.mjs', '')} — after ${count} assertions`);
    console.error(`     ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(
  failed === 0
    ? `\nALL CHECKS PASS — ${files.length} checks, ${totalAssertions} assertions`
    : `\nCHECKS FAILED — ${failed} of ${files.length}`,
);
process.exit(failed === 0 ? 0 : 1);
