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
