// 04-no-ticker-pricing — plan/phase-04 T04.10.
//
// A market order's execution price MUST come from the order book, never the
// ticker: `01` verified the ticker is CDN-cached and stale by an unknown amount,
// so pricing an order from it would size against a price that belonged to an
// earlier request. This is a source-scan invariant, not a runtime test — the
// safest way to guarantee "no pricing path reads ticker" is to prove no pricing
// module imports or references a ticker read at all.
//
// The scan is aimed at the pricing and planning code specifically. The adapter
// is allowed to expose a ticker (a future phase may display it); what must never
// happen is the PRICING path calling it. So this asserts the two files that
// decide an order's price — pricing.ts and planning-service.ts — contain no
// reference to a ticker endpoint or mapper.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Strip line and block comments so a comment mentioning "ticker" is not a hit. */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

const PRICING_FILES = [
  'packages/sizing/src/pricing.ts',
  'packages/sizing/src/gates.ts',
  'apps/api/src/planning-service.ts',
];

// Anything that would mean "read the ticker": the endpoint path, the mapper name,
// the fixture, or the word as an identifier.
const TICKER_PATTERNS = [
  /\bticker\b/i,
  /exchange\/ticker/i,
  /mapTicker/,
  /\/ticker/i,
];

export async function run(assert) {
  for (const rel of PRICING_FILES) {
    const raw = readFileSync(join(root, rel), 'utf8');
    const code = stripComments(raw);
    for (const pat of TICKER_PATTERNS) {
      assert(!pat.test(code), `${rel} references a ticker (${pat}) in code — pricing must read the order book only (T04.10)`);
    }
  }

  // The positive half: the pricing module DOES read the book. If this ever stops
  // being true the file was gutted and the negative assertions above are hollow.
  const pricing = readFileSync(join(root, 'packages/sizing/src/pricing.ts'), 'utf8');
  assert(/asks\b/.test(pricing) && /bids\b/.test(pricing), 'pricing.ts no longer reads book sides — the ticker ban is now vacuous');
  assert(/touchPrice/.test(pricing), 'pricing.ts no longer exposes touchPrice — the book price source is gone');

  // The comment scanner must actually strip, or a commented "ticker" would pass
  // the ban for the wrong reason.
  assert(!/\bticker\b/i.test(stripComments('// uses the ticker here')), 'the comment stripper does not remove line comments');
  assert(/\bticker\b/i.test(stripComments('const x = ticker')), 'the comment stripper removed real code');
}
