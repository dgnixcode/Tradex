// 15-hard-exit-service — the `hardExit` orchestrator itself.
//
// `15-hard-exit` proves the R1 DANGER at the venue level: a stale SL left behind
// after an exit fires and opens an opposite position. This check covers the
// service that makes that sequence unskippable — which had NO coverage at all
// until now, and is the only thing standing between the Exit button and R1.
//
// It also pins the fix that made the button work at all: every port method takes
// an actor. An earlier signature carried only venue ids, so the composition root
// could not know whose credential to sign with, and the route could only ever
// answer "futures execution is not configured in this build".
//
// No database: hardExit is pure orchestration over an injected port.

import { hardExit } from '../apps/api/dist/index.js';

const ACTOR = { tenantId: 'tenant-1', accountId: 'account-1' };
const POSITION = 'pos-1';

/** A port that records every call, with per-scenario overrides. */
function fakePort(over = {}) {
  const calls = [];
  const base = {
    calls,
    listUntriggeredConditionals: async (actor, positionId) => {
      calls.push(['listUntriggeredConditionals', actor, positionId]);
      return [];
    },
    cancelOrder: async (actor, venueOrderId) => {
      calls.push(['cancelOrder', actor, venueOrderId]);
      return { ok: true };
    },
    exitPosition: async (actor, positionId) => {
      calls.push(['exitPosition', actor, positionId]);
      return { ok: true, venueGroupId: 'grp-1' };
    },
    listPositions: async (actor, margin) => {
      calls.push(['listPositions', actor, margin]);
      return [{ venuePositionId: POSITION, pair: 'B-BTC_USDT', marginCurrency: 'USDT', activePos: '0' }];
    },
    ...over,
  };
  return base;
}

const req = (over = {}) => ({ actor: ACTOR, venuePositionId: POSITION, marginCurrency: 'USDT', ...over });

export async function run(assert) {
  // ------------------------------------------------ 1. the happy sequence
  const port = fakePort();
  const out = await hardExit(port, req());
  assert(out.exited === true, 'a clean exit did not report exited');
  assert(out.finalActivePos === '0', `the final activePos is ${out.finalActivePos}`);
  assert(out.venueGroupId === 'grp-1', 'the venue group id was not carried through');

  const order = port.calls.map((c) => c[0]);
  assert(order[0] === 'listUntriggeredConditionals',
    `the first thing hardExit does must be to look for conditionals, got ${order[0]}`);
  const exitAt = order.indexOf('exitPosition');
  const verifyAt = order.indexOf('listPositions');
  assert(exitAt > 0 && verifyAt > exitAt,
    `the sequence must be conditionals → exit → verify, got ${order.join(' → ')}`);

  // ------------------------------------------------ 2. the actor reaches EVERY call
  // The regression for the signature fix: a port method called without the actor
  // is a venue call nobody can sign.
  for (const call of port.calls) {
    assert(call[1] !== null && typeof call[1] === 'object' && call[1].accountId === 'account-1',
      `${call[0]} was called without the actor — that call could not be signed`);
  }

  // ------------------------------------------------ 3. a conditional IS cancelled
  let conditionalListed = false;
  const cancelling = fakePort({
    listUntriggeredConditionals: async () => {
      // First call: one leg is live. Second call (the re-check): it is gone.
      if (!conditionalListed) { conditionalListed = true; return [{ venueOrderId: 'ord-sl' }]; }
      return [];
    },
  });
  const withSl = await hardExit(cancelling, req());
  assert(withSl.cancelled.join(',') === 'ord-sl', `expected the SL to be cancelled, got ${JSON.stringify(withSl.cancelled)}`);
  assert(withSl.exited === true, 'the exit should proceed once the conditional is gone');

  // ------------------------------------------------ 4. R1 — a cancel that did not take
  // The venue's cancel returned ok, but the leg is STILL untriggered. Exiting now
  // would leave it live to fire after the position is closed — opening an opposite
  // position with the customer's money. This is the guard that stops it.
  let exitAttempted = false;
  const stuck = fakePort({
    listUntriggeredConditionals: async () => [{ venueOrderId: 'ord-sl' }],
    exitPosition: async () => { exitAttempted = true; return { ok: true }; },
  });
  let refused = null;
  try { await hardExit(stuck, req()); } catch (e) { refused = e; }
  assert(refused !== null, 'a stuck conditional did not stop the exit');
  assert(refused.reason === 'cancel_fatal', `expected cancel_fatal, got ${refused.reason}`);
  assert(exitAttempted === false, 'THE R1 GUARD FAILED: exit was called while a conditional was still live');

  // ------------------------------------------------ 5. a partial cancel is reported
  // A cancel that fails is not automatically fatal on its own — the leg may have
  // already fired at the venue — but if it is STILL listed, step 4 stops us.
  const partial = fakePort({
    listUntriggeredConditionals: async () => [{ venueOrderId: 'ord-a' }, { venueOrderId: 'ord-b' }],
    cancelOrder: async (actor, id) => (id === 'ord-a' ? { ok: true } : { ok: false, message: 'already triggered' }),
  });
  let partialRefused = null;
  try { await hardExit(partial, req()); } catch (e) { partialRefused = e; }
  assert(partialRefused !== null && partialRefused.reason === 'cancel_fatal',
    'a still-live conditional must stop the exit even when another cancelled cleanly');

  // ------------------------------------------------ 6. an exit the venue refused
  const refusedExit = fakePort({
    exitPosition: async () => ({ ok: false, message: 'position not found' }),
  });
  let exitErr = null;
  try { await hardExit(refusedExit, req()); } catch (e) { exitErr = e; }
  assert(exitErr !== null && exitErr.reason === 'exit_refused', `expected exit_refused, got ${exitErr?.reason}`);

  // ------------------------------------------------ 7. not flat after an ok exit
  // The exit call said ok and the position is still open. Reporting success here
  // would tell the customer they are flat while their money is at risk.
  const notFlat = fakePort({
    listPositions: async () => [{ venuePositionId: POSITION, pair: 'B-BTC_USDT', marginCurrency: 'USDT', activePos: '0.001' }],
  });
  let flatErr = null;
  try { await hardExit(notFlat, req({ pollDelays: [5, 5] })); } catch (e) { flatErr = e; }
  assert(flatErr !== null && flatErr.reason === 'position_not_flat', `expected position_not_flat, got ${flatErr?.reason}`);

  // ------------------------------------------------ 8. a position the venue forgot
  // Absent from the list is treated as flat. Noted as the current behaviour rather
  // than asserted as obviously right: the composition root's port throws on an
  // unreadable list, so "absent" here means the read succeeded and omitted it.
  const absent = fakePort({ listPositions: async () => [] });
  const goneOut = await hardExit(absent, req());
  assert(goneOut.exited === true && goneOut.finalActivePos === '0',
    'a position absent from a successful read should read as flat');

  // ------------------------------------------------ 9. position already exited (alreadyClosed: true)
  // When an exit is retried or position was already closed, exitPosition reports alreadyClosed.
  const alreadyClosedPort = fakePort({
    exitPosition: async (_actor, _positionId) => ({ ok: true, alreadyClosed: true }),
  });
  const alreadyOut = await hardExit(alreadyClosedPort, req());
  assert(alreadyOut.exited === true && alreadyOut.alreadyClosed === true,
    'alreadyClosed position should succeed idempotently');

  // ------------------------------------------------ 10. market order settles on retry
  let pollCount = 0;
  const settlingPort = fakePort({
    listPositions: async (_actor, _margin) => {
      pollCount++;
      return [{
        venuePositionId: POSITION,
        pair: 'B-BTC_USDT',
        marginCurrency: 'USDT',
        activePos: pollCount > 1 ? '0' : '1.5',
      }];
    },
  });
  const settledOut = await hardExit(settlingPort, req({ pollDelays: [10, 10] }));
  assert(settledOut.exited === true && settledOut.finalActivePos === '0',
    'position settling to 0 on retry should succeed cleanly');
  assert(pollCount === 2, `expected 2 position polls, got ${pollCount}`);

  console.log('     hardExit: conditionals → exit → verify; R1 guard blocks a stuck SL; actor on every call');
}
