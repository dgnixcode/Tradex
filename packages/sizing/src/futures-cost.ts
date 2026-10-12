import { scaledFromString } from '@tradex/money';

export interface FuturesCost {
  readonly leverage: string;
  /** Fraction of notional, before GST (e.g. 0.0006 for a 0.06% taker fee). */
  readonly takerFeeRate: string;
}
const UNIT = 10n ** 18n;
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
function feeFactor(cost: FuturesCost): bigint {
  const leverage = BigInt(cost.leverage);
  const fee = scaledFromString(cost.takerFeeRate, 18).v;
  if (leverage < 1n || leverage > 200n || fee < 0n || fee >= UNIT) throw new Error('Invalid futures cost rules');
  // GST is charged on the trading fee, not on margin. Round the reserve upward.
  return UNIT + ceil(leverage * fee * 118n, 100n);
}
/** Budget is already leverage-scaled. Keep 1% margin headroom and entry fees. */
export function futuresSpendableNotional(budgetMinor: bigint, cost: FuturesCost): bigint {
  return budgetMinor * 99n * UNIT / (100n * feeFactor(cost));
}
/** Compare against leverage-scaled free collateral without flooring costs. */
export function futuresRequiredLeveragedMinor(notionalMinor: bigint, cost: FuturesCost): bigint {
  return ceil(notionalMinor * feeFactor(cost), UNIT);
}
