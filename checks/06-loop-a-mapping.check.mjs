// 06-loop-a-mapping — plan/phase-06 T06.7.
//
// Reconciler Loop A must fold the venue's drifting status literals into our
// canonical OrderState. Invariant R10 is the point: an UNRECOGNISED status
// becomes 'unknown' and NEVER throws — a throwing reconciler stops behind it and
// a stuck order goes silent.

import { mapVenueOrderState, isCanonicalOrderState } from '../packages/exchange/dist/index.js';

export async function run(assert) {
  // Each recognised literal → its canonical state.
  const cases = [
    ['acked', 'acked'], ['acknowledged', 'acked'], ['new', 'acked'],
    ['open', 'open'], ['active', 'open'],
    ['partially_filled', 'partially_filled'], ['partial', 'partially_filled'],
    ['filled', 'filled'], ['complete', 'filled'],
    ['cancelled', 'cancelled'], ['canceled', 'cancelled'], ['CANCELLED', 'cancelled'], ['Cancelled', 'cancelled'],
    ['partially cancelled', 'partially_cancelled'],
    ['rejected', 'rejected'], ['failed', 'rejected'],
  ];
  for (const [raw, want] of cases) {
    const r = mapVenueOrderState(raw);
    assert(r.state === want && r.recognized === true,
      `'${raw}' should map to ${want}, got ${r.state} (recognized ${r.recognized})`);
  }

  // Whitespace and case are noise.
  const spaced = mapVenueOrderState('  PARTIALLY FILLED  ');
  assert(spaced.state === 'partially_filled' && spaced.recognized, 'whitespace + case must be normalised');

  // R10: an unrecognised string is 'unknown' + recognized:false, and NEVER throws.
  const unknowns = ['queued', 'waiting', 'partially-cancelled', 'closed', 'booked', '', '!!', 'FOO_BAR'];
  for (const raw of unknowns) {
    let r = null;
    let threw = false;
    try { r = mapVenueOrderState(raw); } catch { threw = true; }
    assert(!threw, `mapping '${JSON.stringify(raw)}' must never throw (R10)`);
    assert(r !== null && r.state === 'unknown' && r.recognized === false,
      `'${JSON.stringify(raw)}' must become unknown+unrecognized, got ${JSON.stringify(r)}`);
  }

  // A hostile/long literal also resolves to unknown without throwing.
  const hostile = 'x'.repeat(10_000);
  assert(mapVenueOrderState(hostile).state === 'unknown', 'a 10k-char literal must be unknown, not a crash');

  // Every mapped target is a canonical state (the table is closed).
  for (const [, want] of cases) assert(isCanonicalOrderState(want), `${want} is not a canonical OrderState`);
}
