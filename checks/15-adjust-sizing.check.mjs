// 15-adjust-sizing — the arithmetic that decides whether a partial close reduces
// a position or FLIPS it.
//
// The futures API has no `reduce_only`, so a reducing order is an ordinary
// opposite-side order and one sized above `abs(active_pos)` closes the position
// and opens the opposite one (research/04: "the worst case in this document").
// Nothing else in the system stands between a percentage and that outcome.
//
// Pure — no database, no venue. Every case is arithmetic.

import { planAdjustment } from '../apps/api/dist/index.js';

const base = {
  direction: 'reduce',
  activePos: '0.001',
  percentBp: 5000,
  quantityIncrement: '0.00001',
  minQuantity: '0.00001',
  minNotional: '100',
  price: '8500000',
};

export async function run(assert) {
  // ------------------------------------------------ 1. a plain half
  const half = planAdjustment(base);
  assert(half.ok === true, `a 50% reduce was refused: ${half.ok === false ? half.detail : ''}`);
  assert(half.quantity === '0.0005', `50% of 0.001 came out as ${half.quantity}`);
  assert(half.side === 'sell', `reducing a LONG must sell, got ${half.side}`);
  assert(half.isFull === false, 'a half close was marked as a full close');

  // ------------------------------------------------ 2. ROUNDS DOWN, NEVER UP
  // The whole point. 0.00123 at 50% is 0.000615; with a step of 0.0001 the floor
  // is 0.0006 and the ceiling is 0.0007. Rounding up is a step towards exceeding
  // the position, and exceeding the position on a venue with no reduce_only does
  // not fail — it reverses it.
  const down = planAdjustment({ ...base, activePos: '0.00123', percentBp: 5000, quantityIncrement: '0.0001' });
  assert(down.ok === true, `the rounding case was refused: ${down.ok === false ? down.detail : ''}`);
  assert(down.quantity === '0.0006',
    `expected a FLOOR to 0.0006, got ${down.quantity} — rounding up is how this flips a position`);

  // And the result can never exceed the position, whatever the step does.
  // minNotional is zeroed here because this loop is testing the CLAMP, not the
  // notional floor: at these sizes a 1% slice is worth less than the venue's
  // minimum and is correctly refused for a different reason.
  for (const pct of [100, 2500, 5000, 9999, 10_000]) {
    const plan = planAdjustment({ ...base, percentBp: pct, minNotional: '0' });
    assert(plan.ok === true, `${pct / 100}% was refused with a zero notional floor`);
    assert(Number(plan.quantity) <= 0.001,
      `${pct / 100}% produced ${plan.quantity}, which is MORE than the 0.001 position`);
  }

  // ------------------------------------------------ 3. 100% is a full close
  const full = planAdjustment({ ...base, percentBp: 10_000 });
  assert(full.ok === true && full.isFull === true,
    '100% must be flagged as the whole position so the caller promotes it to positions/exit');
  assert(full.quantity === '0.001', `a full close sized as ${full.quantity}`);

  // ------------------------------------------------ 4. A SHORT REDUCES BY BUYING
  // The side comes from the venue's sign, never from what the caller asked for.
  // Getting this backwards doubles the position instead of halving it.
  const shortHalf = planAdjustment({ ...base, activePos: '-0.5', percentBp: 5000, minNotional: '0' });
  assert(shortHalf.ok === true, 'reducing a short was refused');
  assert(shortHalf.side === 'buy', `reducing a SHORT must buy, got ${shortHalf.side}`);
  assert(shortHalf.quantity === '0.25', `half of a 0.5 short came out as ${shortHalf.quantity}`);

  // The sign is a property of the position, not of the request.
  const longIncrease = planAdjustment({ ...base, direction: 'increase', percentBp: 5000 });
  assert(longIncrease.ok === true && longIncrease.side === 'buy', 'adding to a long must buy');
  const shortIncrease = planAdjustment({ ...base, direction: 'increase', activePos: '-0.5', percentBp: 5000, minNotional: '0' });
  assert(shortIncrease.ok === true && shortIncrease.side === 'sell', 'adding to a short must sell');

  // ------------------------------------------------ 5. FLOORS REFUSE, NEVER NUDGE
  // Clearing a minimum by rounding the size UP is the same mistake as rounding up
  // to a step. Both are refused with a reason the customer can act on.
  const tooSmall = planAdjustment({ ...base, percentBp: 1 });   // 0.01% of 0.001 = 0.0000001
  assert(tooSmall.ok === false && tooSmall.code === 'below_step',
    `a sub-step slice must be refused, got ${tooSmall.ok === false ? tooSmall.code : tooSmall.quantity}`);

  const belowMin = planAdjustment({ ...base, percentBp: 100, minQuantity: '0.0005' });
  assert(belowMin.ok === false && belowMin.code === 'below_min_quantity',
    `a below-minimum slice must be refused, got ${belowMin.ok === false ? belowMin.code : belowMin.quantity}`);

  const belowNotional = planAdjustment({ ...base, percentBp: 1000, minNotional: '100000' });
  assert(belowNotional.ok === false && belowNotional.code === 'below_min_notional',
    `a below-minimum-notional slice must be refused, got ${belowNotional.ok === false ? belowNotional.code : belowNotional.quantity}`);

  // The refusal must not carry a size at all — a caller that found one anyway
  // could send it.
  assert(belowMin.quantity === undefined && belowNotional.quantity === undefined,
    'a refused plan must not carry a quantity');

  // ------------------------------------------------ 6. nothing to adjust
  const flat = planAdjustment({ ...base, activePos: '0' });
  assert(flat.ok === false && flat.code === 'no_position',
    'a flat position must be refused — "increase from flat" is opening a position, not adjusting one');

  // A zero step means the venue gave no quantization rule. Guessing one is how you
  // land off-step or oversized, so it refuses.
  const noStep = planAdjustment({ ...base, quantityIncrement: '0' });
  assert(noStep.ok === false && noStep.code === 'no_step', 'a zero quantity_increment must be refused');

  // ------------------------------------------------ 7. the percentage is validated
  for (const bad of [0, -1, 10_001, 2.5]) {
    const plan = planAdjustment({ ...base, percentBp: bad });
    assert(plan.ok === false && plan.code === 'bad_percent',
      `percentBp ${bad} should be refused, got ${plan.ok === false ? plan.code : plan.quantity}`);
  }

  // ------------------------------------------------ 8. the arithmetic is exact
  // A float would be one rounding error away from the wrong side of a position.
  const exact = planAdjustment({
    ...base, activePos: '0.3', percentBp: 3333, quantityIncrement: '0.00000001', minNotional: '0',
  });
  assert(exact.ok === true && exact.quantity === '0.09999',
    `33.33% of 0.3 should be exactly 0.09999, got ${exact.quantity}`);

  console.log('     adjust sizing: floors to the step, clamps to the position, refuses below floors, side from the sign');
}
