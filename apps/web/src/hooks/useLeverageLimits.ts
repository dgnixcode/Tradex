import { useQuery } from '@tanstack/react-query';
import { maxInstrumentLeverage } from '@tradex/exchange';
import { fetchFuturesInstrument, type FuturesPositionRow } from '../api.ts';

export function positionNotional(position: FuturesPositionRow): string {
  const value = Number(position.quantity) * Math.max(Number(position.avgEntryPrice), Number(position.markPrice));
  return Number.isFinite(value) && value > 0 ? value.toFixed(18) : 'invalid';
}

export function useLeverageLimits(pair: string, marginCurrency: 'INR' | 'USDT', positions?: readonly FuturesPositionRow[]) {
  const query = useQuery({
    queryKey: ['futures-instrument', pair, marginCurrency],
    queryFn: () => fetchFuturesInstrument(pair, marginCurrency),
    enabled: /^B-[A-Z0-9]+_(USDT|INR)$/.test(pair),
    staleTime: 30_000, retry: 1,
  });
  const tiers = query.isError ? undefined : query.data?.leverageTiers;
  const maxLeverage = positions?.length
    ? Math.min(...positions.map((p) => maxInstrumentLeverage(tiers, positionNotional(p))))
    : maxInstrumentLeverage(tiers);
  return { maxLeverage, query, message: maxLeverage > 0 ? `Max ${maxLeverage}×` : query.isPending ? 'Checking leverage limits…' : 'Leverage limits unavailable. Refresh to retry.' };
}

/** Round up so the resulting required margin cannot exceed the chosen budget. */
export function leverageForBalance(notional: number, currentMargin: number, freeBalance: number, percent: number, max: number): number | null {
  if (![notional, currentMargin, freeBalance, percent, max].every(Number.isFinite) || notional <= 0 || currentMargin <= 0 || freeBalance <= 0 || percent < 0 || percent > 100 || max < 1) return null;
  const target = Math.max(1, Math.ceil(notional / (currentMargin + freeBalance * percent / 100)));
  return target <= max ? target : null;
}

/**
 * Compute target leverage from a bidirectional centered slider (-100..+100):
 * - Center (0): current leverage
 * - Left (< 0): reduce leverage below current leverage down to 1x
 * - Right (> 0): increase leverage above current leverage up to maxLeverage
 */
export function computeCenteredLeverage(
  sliderVal: number,
  currentLev: number,
  maxLeverage: number,
  _notional?: number,
  _currentMargin?: number,
  _freeBalance?: number,
): string {
  if (!Number.isFinite(sliderVal) || sliderVal === 0 || !Number.isFinite(currentLev) || currentLev <= 0) {
    return String(currentLev > 0 ? currentLev : 1);
  }
  if (sliderVal > 0) {
    // Sliding RIGHT: increase leverage up to maxLeverage
    const range = maxLeverage - currentLev;
    if (range <= 0) return String(currentLev);
    const fraction = sliderVal / 100;
    const rawTarget = currentLev + fraction * range;
    const step = range <= 3 ? 0.1 : range <= 10 ? 0.5 : 1;
    const rounded = Math.min(maxLeverage, Math.max(currentLev, Math.round(rawTarget / step) * step));
    const formatted = rounded.toFixed(step === 0.1 ? 1 : 1);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
  } else {
    // Sliding LEFT: reduce leverage down to 1x
    const range = currentLev - 1;
    if (range <= 0) return '1';
    const fraction = Math.abs(sliderVal) / 100;
    const rawTarget = currentLev - fraction * range;
    const step = range <= 3 ? 0.1 : range <= 10 ? 0.5 : 1;
    const rounded = Math.max(1, Math.min(currentLev, Math.round(rawTarget / step) * step));
    const formatted = rounded.toFixed(step === 0.1 ? 1 : 1);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
  }
}

/**
 * Compute the slider knob position (-100..+100) from the target leverage:
 * - 0 = currentLev
 * - > 0 = right (higher leverage, 0..+100)
 * - < 0 = left (lower leverage, -100..0)
 */
export function computeSliderValueFromLeverage(
  targetLevNum: number,
  currentLev: number,
  maxLeverage: number,
  _notional?: number,
  _currentMargin?: number,
  _freeBalance?: number,
): number {
  if (!Number.isFinite(targetLevNum) || targetLevNum <= 0) return 0;
  if (Math.abs(targetLevNum - currentLev) < 0.001) return 0;
  if (targetLevNum > currentLev) {
    const range = maxLeverage - currentLev;
    if (range <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round(((targetLevNum - currentLev) / range) * 100)));
  } else {
    // targetLevNum < currentLev: left side (-100..0)
    const range = currentLev - 1;
    if (range <= 0) return 0;
    return -Math.min(100, Math.max(0, Math.round(((currentLev - targetLevNum) / range) * 100)));
  }
}
