import type { FuturesInstrument } from './futures-adapter.js';

export type LeverageTier = FuturesInstrument['leverageTiers'][number];

/** Missing or malformed venue limits never imply permission to use 100x. */
export function maxInstrumentLeverage(tiers: readonly LeverageTier[] | undefined, notional?: string): number {
  if (!tiers?.length) return 0;
  const decimal = (v: string): bigint | null => {
    if (!/^\d+(?:\.\d{1,18})?$/.test(v)) return null;
    const [whole = '0', fraction = ''] = v.split('.');
    return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
  };
  const amount = notional === undefined ? null : decimal(notional);
  if (notional !== undefined && (amount === null || amount < 0n)) return 0;
  let max = 0;
  for (const tier of tiers) {
    const threshold = decimal(tier.upToNotional);
    if (threshold === null || threshold <= 0n || !Number.isSafeInteger(tier.maxLeverage) || tier.maxLeverage < 1) return 0;
    if (amount === null || amount <= threshold) max = Math.max(max, tier.maxLeverage);
  }
  return max;
}
