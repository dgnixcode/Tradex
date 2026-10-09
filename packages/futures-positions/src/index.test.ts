import { describe, it, expect } from 'vitest';
import { buildFuturesView, buildFuturesViews, type FuturesPositionRow } from './index.js';

describe('Futures Positions View', () => {
  const baseRow: FuturesPositionRow = {
    accountId: 'acc-1',
    accountName: 'Alpha Trader',
    pair: 'B-BTC_USDT',
    marginCurrency: 'USDT',
    venuePositionId: 'pos-123',
    activePos: '0.5',
    avgEntryPrice: '60000',
    markPrice: '63000',
    markObservedAtMs: 1726830000000,
    liquidationPrice: '45000',
    leverage: '10',
    lockedMarginMinor: '300000000000',
    stopLossTrigger: '57000',
    takeProfitTrigger: '66000',
    fundingRateBp: 10,
    settlementCurrencyAvgPrice: null,
    groupName: 'Momentum',
    entryTimeMs: 1726820000000,
  };

  it('preserves and propagates entryTimeMs onto the view', () => {
    const view = buildFuturesView(baseRow, 1726830500000);
    expect(view.entryTimeMs).toBe(1726820000000);
    expect(view.side).toBe('long');
    expect(view.quantity).toBe('0.5');
    expect(view.groupName).toBe('Momentum');
  });

  it('handles null entryTimeMs gracefully', () => {
    const rowWithoutEntry: FuturesPositionRow = {
      ...baseRow,
      entryTimeMs: null,
    };
    const view = buildFuturesView(rowWithoutEntry, 1726830500000);
    expect(view.entryTimeMs).toBeNull();
  });

  it('filters out flat activePos = 0 and 0.0 in buildFuturesViews', () => {
    const flatRow1: FuturesPositionRow = {
      ...baseRow,
      venuePositionId: 'pos-flat-1',
      activePos: '0',
    };
    const flatRow2: FuturesPositionRow = {
      ...baseRow,
      venuePositionId: 'pos-flat-2',
      activePos: '0.0',
    };
    const flatRow3: FuturesPositionRow = {
      ...baseRow,
      venuePositionId: 'pos-flat-3',
      activePos: '0.00',
    };
    const spotRow: FuturesPositionRow = {
      ...baseRow,
      venuePositionId: 'pos-spot-1',
      pair: 'BTCUSDT',
      activePos: '0.5',
    };
    const views = buildFuturesViews([baseRow, flatRow1, flatRow2, flatRow3, spotRow], 1726830500000);
    expect(views.length).toBe(1);
    expect(views[0]?.venuePositionId).toBe('pos-123');
  });

  it('preserves and propagates hideFromPositions flag', () => {
    const hiddenRow: FuturesPositionRow = {
      ...baseRow,
      hideFromPositions: true,
    };
    const view = buildFuturesView(hiddenRow, 1726830500000);
    expect(view.hideFromPositions).toBe(true);

    const defaultView = buildFuturesView(baseRow, 1726830500000);
    expect(defaultView.hideFromPositions).toBe(false);
  });
});

