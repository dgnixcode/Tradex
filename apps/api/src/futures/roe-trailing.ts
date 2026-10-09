const SCALE = 10n ** 18n;
const decimal = (value: string): bigint => {
  if (value.length > 80 || !/^\d+(\.\d{1,18})?$/.test(value)) throw new Error('Invalid ROE trailing decimal');
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
};
const plain = (value: bigint): string => {
  const digits = value.toString().padStart(19, '0');
  const fraction = digits.slice(-18).replace(/0+$/, '');
  return `${digits.slice(0, -18)}${fraction ? `.${fraction}` : ''}`;
};

/** Price span corresponding to 100% unrealised P&L / current position margin.
 * Actual collateral handles added margin and leverage without multiplying P&L
 * twice. INR collateral on USDT contracts uses the position's settlement rate. */
export function roePositionBasis(position: {
  activePos: string; lockedMarginMinor: string | null; marginCurrency: string;
  pair: string; settlementCurrencyAvgPrice: string | null; avgEntryPrice: string | null;
}) {
  const quantity = decimal(position.activePos.replace(/^-/, ''));
  const margin = position.lockedMarginMinor;
  const entry = decimal(position.avgEntryPrice ?? '0');
  if (!quantity || !entry || !margin || !/^\d{1,80}$/.test(margin) || BigInt(margin) <= 0n) throw new Error('Current quantity, entry and position margin are required for ROE trailing');
  if (!['INR', 'USDT'].includes(position.marginCurrency)) throw new Error('Unsupported ROE margin currency');
  const quote = position.pair.endsWith('_USDT') ? 'USDT' : position.pair.endsWith('_INR') ? 'INR' : null;
  if (!quote || (position.marginCurrency === 'USDT' && quote !== 'USDT')) throw new Error('Unsupported ROE contract quote');
  const fx = position.marginCurrency === 'INR' && quote === 'USDT' ? decimal(position.settlementCurrencyAvgPrice ?? '0') : SCALE;
  if (fx <= 0n) throw new Error('Position settlement rate is required for INR ROE trailing');
  return {
    numerator: BigInt(margin) * SCALE * SCALE * SCALE,
    denominator: (10n ** BigInt(position.marginCurrency === 'INR' ? 2 : 8)) * quantity * fx,
    key: [position.pair, position.activePos.startsWith('-') ? 'short' : 'long', quantity, BigInt(margin), position.marginCurrency, fx, entry].join(':'),
  };
}

/** Recheck fresh venue protection and mark before cancelling the existing SL. */
export function canReplaceRoeStop(position: { activePos: string; markPrice: string | null; stopLossTrigger: string | null }, target: string, expected: string): boolean {
  try {
    const live = decimal(position.markPrice ?? '0'), prior = decimal(position.stopLossTrigger ?? '0');
    const next = decimal(target);
    return live > 0n && prior > 0n && prior === decimal(expected)
      && (position.activePos.startsWith('-') ? next < prior && next > live : next > prior && next < live);
  } catch { return false; }
}

/** Each full step is an additional percentage point of favourable ROE since the
 * last successful update. Move the existing stop by that price delta, preserving
 * its chosen gap. Reversals never loosen it; venue ticks can require more steps. */
export function roeTrailingTarget(args: {
  live: string; extreme: string; current: string; anchor: string; short: boolean;
  stepBp: string; tick: string; basis: ReturnType<typeof roePositionBasis>;
}) {
  const live = decimal(args.live), old = decimal(args.extreme), current = decimal(args.current);
  const anchor = decimal(args.anchor), tick = decimal(args.tick), step = BigInt(args.stepBp);
  if (live <= 0n || current <= 0n || anchor <= 0n || tick <= 0n || step < 1n || step > 10_000n) throw new Error('Invalid ROE trailing configuration');
  const extreme = args.short ? (live < old ? live : old) : (live > old ? live : old);
  const advance = args.short ? anchor - extreme : extreme - anchor;
  const numerator = args.basis.numerator * step;
  const denominator = args.basis.denominator * 10_000n;
  if (advance <= 0n || advance * denominator < numerator) return { extreme: plain(extreme), anchor: plain(anchor), stop: null };
  const steps = advance * denominator / numerator;
  const delta = steps * numerator / denominator;
  const raw = args.short ? current - delta : current + delta;
  if (raw <= 0n) return { extreme: plain(extreme), anchor: plain(anchor), stop: null };
  const target = (args.short ? (raw + tick - 1n) / tick : raw / tick) * tick;
  const improves = args.short ? target < current && target > live : target > current && target < live;
  if (!improves) return { extreme: plain(extreme), anchor: plain(anchor), stop: null };
  // Consume only the stop advance actually achieved after tick rounding.
  const moved = args.short ? current - target : target - current;
  return { extreme: plain(extreme), anchor: plain(args.short ? anchor - moved : anchor + moved), stop: plain(target) };
}
