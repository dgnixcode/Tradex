// Negative control for the phase-03 definition of done — plan/phase-03 T03.9.
//
//   "The property suite passes over all 999 markets and FAILS on a deliberate
//    rounding flip."
//
// The second half of that sentence is a claim about the SUITE, and the only way to
// establish it is to break the code and watch the suite complain. A test that has
// never been seen to fail is a test nobody knows works.
//
// So this script patches the compiled `floorQuantity` to round half UP instead of
// flooring, runs the property suite against it, and reports whether the suite
// noticed. The original file is restored unconditionally, including on failure.
//
// Usage:  node scripts/prove-rounding-flip.mjs
// Exit 0 = the suite caught the flip. Exit 1 = it did not, which is a real defect
// in the suite even though every check is green.
//
// This is not part of `npm run verify`: it deliberately corrupts build output, so
// running it concurrently with anything else would be confusing. Run it after a
// build, on its own.

import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const target = 'packages/sizing/dist/rounding.js';
const backup = 'packages/sizing/dist/rounding.js.original';

const ORIGINAL = `export function floorQuantity(rawQty, rules) {
    const stepped = floorToStep(rawQty, nat(rules.quantityStep));
    return floorToPlaces(stepped, rules.quantityPrecision);
}`;

/**
 * Round half up, at the market's step. Written with plain BigInt so it cannot
 * throw on the scales money does not support (11, and 13 to 17) — a crash would
 * "fail" the suite for the wrong reason and prove nothing.
 */
const FLIPPED = `export function floorQuantity(rawQty, rules) {
    const st = nat(rules.quantityStep);
    const sc = rawQty.scale > st.scale ? rawQty.scale : st.scale;
    const av = rawQty.v * 10n ** BigInt(sc - rawQty.scale);
    const sv = st.v * 10n ** BigInt(sc - st.scale);
    let units = av / sv;
    if ((av % sv) * 2n >= sv) units += 1n;
    return floorToPlaces({ v: units * sv, scale: sc }, rules.quantityPrecision);
}`;

if (!existsSync(target)) {
  console.error(`${target} does not exist — run \`npm run typecheck\` first.`);
  process.exit(2);
}

const src = readFileSync(target, 'utf8');
if (!src.includes(ORIGINAL)) {
  console.error('Could not find floorQuantity in the compiled output; this script needs updating.');
  console.error('It patches a literal string, so a refactor of rounding.ts breaks it by design —');
  console.error('better a loud failure here than a negative control that silently stops controlling.');
  process.exit(2);
}

/** Runs the suite against the flipped build. The restore is unconditional. */
function runAgainstFlippedBuild() {
  copyFileSync(target, backup);
  try {
    writeFileSync(target, src.replace(ORIGINAL, FLIPPED));
    console.log('floorQuantity patched to ROUND HALF UP. Running the property suite...\n');
    const run = spawnSync(process.execPath, ['checks/run-all.mjs', '03-sizing'], { encoding: 'utf8' });
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    console.log(out.split('\n').filter((l) => l.trim() !== '').join('\n'));
    return {
      caught: /FAIL 03-sizing/.test(out),
      firstFailure: out.split('\n').find((l) => /assertion \d+ failed/.test(l))?.trim() ?? '(none reported)',
    };
  } finally {
    copyFileSync(backup, target);
    unlinkSync(backup);
    console.log('\n      original floorQuantity restored.');
  }
}

const { caught, firstFailure } = runAgainstFlippedBuild();
console.log('');
console.log(caught
  ? `PASS  the property suite CAUGHT the rounding flip.\n      ${firstFailure}`
  : 'FAIL  the suite passed despite the flip — its rounding assertions are not load-bearing.');
process.exit(caught ? 0 : 1);
