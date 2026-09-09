// 06-resolve-ladder — plan/phase-06 T06.6 (12 F3).
//
// The ladder's decision logic, tested without sleeping (the schedule is injected
// as gaps). The load-bearing rule: a not-found within the trust delay (2s) is
// RETRIED, not believed — trusting it too early is how a duplicate order happens.

import { resolveLadder } from '../apps/api/dist/index.js';

const ORDER = { id: '10', statusRaw: 'open' };
// Gaps so the third step is past the 2s trust delay: 0 + 1000 + 3000 = 4000ms.
const THREE = [0, 1000, 3000];

/** A resolve stub returning a fixed sequence of results. */
function seq(answers) {
  let i = 0;
  return async () => { const a = answers[Math.min(i, answers.length - 1)]; i += 1; return a; };
}

export async function run(assert) {
  // The order landed → first rung says placed.
  const landed = await resolveLadder('c', seq([{ ok: true, order: ORDER }]), { stepGapsMs: THREE });
  assert(landed.state === 'placed' && landed.exchangeOrderId === '10', 'a found order must resolve as placed');

  // Not-found early (ignored), then it appears → placed, not a false negative.
  const late = await resolveLadder('c', seq([
    { ok: true, order: null },   // elapsed 0 — not trusted
    { ok: true, order: null },   // elapsed 1000 — still under the 2s trust delay
    { ok: true, order: ORDER },  // elapsed 4000 — now found
  ]), { stepGapsMs: THREE });
  assert(late.state === 'placed', 'an order that appears late must still resolve as placed (never a false negative)');

  // Early not-founds are NOT trusted; a not-found after the trust delay is.
  const absent = await resolveLadder('c', seq([
    { ok: true, order: null },   // elapsed 0 — must not conclude
    { ok: true, order: null },   // elapsed 1000 — still under 2s, must not conclude
    { ok: true, order: null },   // elapsed 4000 — past the trust delay → not_found
  ]), { stepGapsMs: THREE });
  assert(absent.state === 'not_found', 'a not-found only after the trust delay may be believed');

  // If every rung stays under the trust delay the schedule can only exhaust → needs_human.
  const stuck = await resolveLadder('c', seq([{ ok: true, order: null }]), { stepGapsMs: [0, 0, 0] });
  assert(stuck.state === 'needs_human', 'a never-answering venue must end in needs_human, not a guess');

  // A venue error on a rung keeps trying rather than giving up.
  const errThenFound = await resolveLadder('c', seq([{ ok: false }, { ok: false }, { ok: true, order: ORDER }]), { stepGapsMs: THREE });
  assert(errThenFound.state === 'placed', 'a venue error mid-ladder must keep trying');

  // The DEFAULT schedule (250ms/1s/3s/8s/20s) crosses the trust delay on rung 3,
  // so a persistent not-found there is believed → not_found, not a guess.
  const exhausted = await resolveLadder('c', seq([{ ok: true, order: null }]));
  assert(exhausted.state === 'not_found', 'a persistent not-found across the default schedule must be believed');

  // needs_human is for a venue that keeps ERRORING — no answer is ever available
  // to trust or distrust, so the only honest end is needs_human.
  const erroring = await resolveLadder('c', seq([{ ok: false }]));
  assert(erroring.state === 'needs_human', 'a venue that only errors must end in needs_human, not a guess');

  // The trust delay is what distinguishes early from late: with gaps that never
  // cross 2s even at the last rung, a not-found never becomes trusted.
  const neverTrusted = await resolveLadder('c', seq([{ ok: true, order: null }]), { stepGapsMs: [0, 0, 0, 0, 0] });
  assert(neverTrusted.state === 'needs_human', 'not-founds that never outlive the trust delay must not be believed');
}
