import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveTicker } from '../hooks/useLiveTicker.ts';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { DEFAULT_GROUP_NAME, fetchAssets, fetchGroups, fetchMarketPrice, previewTrade } from '../api.ts';
import type { AssetOption, GroupSummary, PlanRequest } from '../api.ts';
import { TradingViewChart } from '../components/TradingViewChart.tsx';
import { WatchlistPanel } from '../components/WatchlistPanel.tsx';

// The futures trade ticket — plan/phase-15 T15.10.
//
// Tradex trades PERPETUAL FUTURES across a group of accounts. Every trade
// carries leverage, a margin currency, a position margin mode, and optionally
// a stop-loss + take-profit + reduce-only. Sizing is always "percent of the
// group's allocated capital" — futures traders think in margin-at-risk, and
// exposing five sizing modes on this screen would have been spot-shaped noise.
//
// Its ONLY action is "Preview N accounts" (T04.7): the customer never sends a
// trade from here. Confirm is a separate screen, and even confirm dry-runs
// under rung 0 unless the composition root wires the execution engine.
//
// The venue's own constraint (research/03 F4): CROSSED margin is USDT-only.
// The schema CHECK enforces the same invariant; this form hides the option
// when INR is selected, so the two enforcements never fight.

type Side = 'buy' | 'sell';
type OrderType = 'market' | 'limit';
type MarginCurrency = 'INR' | 'USDT';
type PositionMarginType = 'isolated' | 'crossed';
type SlTpMode = 'price' | 'percent';

/** The client-side ceiling. The venue enforces a per-tier max on top of this. */
const MAX_LEVERAGE = 100;

/** Common SL percentage distances for quick-select chips. */
const SL_PERCENT_CHIPS = [1, 2, 5, 10] as const;
/** TP chips include wider targets (15%, 20%) since take-profits are typically further out. */
const TP_PERCENT_CHIPS = [1, 2, 5, 10, 15, 20] as const;

/**
 * Compute the absolute trigger price from a percentage offset.
 * - SL on Long / TP on Short → price moves DOWN from reference
 * - TP on Long / SL on Short → price moves UP from reference
 */
function percentToPrice(refPrice: number, pct: number, side: Side, leg: 'sl' | 'tp'): number {
  const down = (side === 'buy' && leg === 'sl') || (side === 'sell' && leg === 'tp');
  return down ? refPrice * (1 - pct / 100) : refPrice * (1 + pct / 100);
}

/** Reverse: compute the percentage distance from entry to trigger price. */
function priceToPercent(refPrice: number, triggerPrice: number, side: Side, leg: 'sl' | 'tp'): number {
  const down = (side === 'buy' && leg === 'sl') || (side === 'sell' && leg === 'tp');
  const pct = down
    ? ((refPrice - triggerPrice) / refPrice) * 100
    : ((triggerPrice - refPrice) / refPrice) * 100;
  return Math.abs(pct);
}

/**
 * A segmented choice — buttons instead of a dropdown.
 *
 * A `<select>` for SIDE is a mistake waiting to happen: "Long" and "Short" sit one
 * keystroke apart in a closed control that shows only the current value, so a
 * wrong pick is invisible until the order is placed. Buttons show every option at
 * once, and `tone` colours them by MEANING — long is green, short is red — so the
 * direction is legible before anything is clicked, not after.
 *
 * `aria-pressed` rather than a visual-only state: the selected button must be
 * announced, or the colour is the only signal and it is the one signal a
 * colour-blind customer cannot read.
 */
function Choice<T extends string>({ label, value, options, onChange, hint }: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly {
    readonly value: T;
    readonly label: string;
    readonly tone?: 'long' | 'short' | undefined;
  }[];
  readonly onChange: (next: T) => void;
  readonly hint?: string | undefined;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{ display: 'flex', gap: 6 }}>
        {options.map((o) => {
          const active = o.value === value;
          const isLong = o.tone === 'long';
          const isShort = o.tone === 'short';

          let btnStyle: React.CSSProperties = {
            flex: 1,
            padding: '7px 10px',
            fontSize: 12.5,
            borderRadius: 6,
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          };

          if (isLong) {
            btnStyle = {
              ...btnStyle,
              background: active ? '#10b981' : 'rgba(16, 185, 129, 0.08)',
              color: active ? '#ffffff' : '#10b981',
              border: `1px solid ${active ? '#10b981' : 'rgba(16, 185, 129, 0.3)'}`,
              fontWeight: active ? 700 : 500,
            };
          } else if (isShort) {
            btnStyle = {
              ...btnStyle,
              background: active ? '#ef4444' : 'rgba(239, 68, 68, 0.08)',
              color: active ? '#ffffff' : '#ef4444',
              border: `1px solid ${active ? '#ef4444' : 'rgba(239, 68, 68, 0.3)'}`,
              fontWeight: active ? 700 : 500,
            };
          } else {
            btnStyle = {
              ...btnStyle,
              background: active ? '#ffffff' : '#111318',
              color: active ? '#000000' : '#9ca3af',
              border: `1px solid ${active ? '#ffffff' : '#222631'}`,
              fontWeight: active ? 700 : 500,
            };
          }

          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              className="btn"
              style={btnStyle}
              onClick={() => onChange(o.value)}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {hint !== undefined && <div className="hint">{hint}</div>}
    </div>
  );
}

export function TradeTicket() {
  const navigate = useNavigate();
  const groups = useQuery({
    queryKey: ['groups'],
    queryFn: fetchGroups,
    refetchOnWindowFocus: true,
    staleTime: 5000,
  });
  const assets = useQuery({ queryKey: ['assets'], queryFn: fetchAssets });

  const draft = useMemo(() => {
    try {
      const raw = localStorage.getItem('tradex_ticket_draft');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }, []);

  const [groupId, setGroupId] = useState<string>(() => draft.groupId || '');
  const [asset, setAsset] = useState<string>(() => {
    try {
      return draft.asset || localStorage.getItem('tradex_selected_asset') || 'BTC';
    } catch {
      return 'BTC';
    }
  });
  const [side, setSide] = useState<Side>(() => draft.side || 'buy');
  const [orderType, setOrderType] = useState<OrderType>(() => draft.orderType || 'market');
  const [limitPrice, setLimitPrice] = useState<string>(() => draft.limitPrice || '');
  const [rightPanelTab, setRightPanelTab] = useState<'trade' | 'chart' | 'watchlist'>(() => {
    try {
      const saved = localStorage.getItem('tradex_active_tab');
      return (saved === 'chart' || saved === 'watchlist') ? saved : 'trade';
    } catch {
      return 'trade';
    }
  });

  // Futures shape — every field required except the two conditionals + reduceOnly.
  const [leverage, setLeverage] = useState<string>(() => draft.leverage || '5');
  const [marginCurrency, setMarginCurrency] = useState<MarginCurrency>(() => {
    try {
      return draft.marginCurrency || (localStorage.getItem('tradex_selected_margin') as MarginCurrency) || 'USDT';
    } catch {
      return 'USDT';
    }
  });
  // Futures trade exclusively on USDT pairs.
  const quoteCurrency: MarginCurrency = 'USDT';
  const [positionMarginType, setPositionMarginType] = useState<PositionMarginType>(() => draft.positionMarginType || 'isolated');
  const [percent, setPercent] = useState<string>(() => draft.percent || '');
  const [quantity, setQuantity] = useState<string>(() => draft.quantity || '');
  const [sizingMode, setSizingMode] = useState<'percent' | 'quantity'>(() => draft.sizingMode || 'percent');
  const [stopLossPrice, setStopLossPrice] = useState<string>(() => draft.stopLossPrice || '');
  const [takeProfitPrice, setTakeProfitPrice] = useState<string>(() => draft.takeProfitPrice || '');
  const [trailingStopLoss, setTrailingStopLoss] = useState<boolean>(() => draft.trailingStopLoss ?? false);
  const [trailingDistancePercent, setTrailingDistancePercent] = useState<string>(() => draft.trailingDistancePercent || '5');
  const [trailingStepPercent, setTrailingStepPercent] = useState<string>(() => draft.trailingStepPercent || '1');
  const [fetchingPrice, setFetchingPrice] = useState(false);

  // SL/TP percentage mode state — one toggle controls both fields.
  const [slTpMode, setSlTpMode] = useState<SlTpMode>(() => draft.slTpMode || 'percent');
  const [slPercent, setSlPercent] = useState<string>(() => draft.slPercent || '');
  const [tpPercent, setTpPercent] = useState<string>(() => draft.tpPercent || '');
  // Stores the latest market price for use as SL/TP reference on market orders.
  const [marketRefPrice, setMarketRefPrice] = useState('');
  const [usdtInrRate, setUsdtInrRate] = useState<number | null>(null);

  // Persist all ticket inputs to localStorage so going to preview and returning pre-fills everything
  useEffect(() => {
    try {
      localStorage.setItem('tradex_ticket_draft', JSON.stringify({
        groupId,
        asset,
        side,
        orderType,
        limitPrice,
        marginCurrency,
        positionMarginType,
        leverage,
        sizingMode,
        percent,
        quantity,
        slTpMode,
        stopLossPrice,
        slPercent,
        takeProfitPrice,
        tpPercent,
        trailingStopLoss,
        trailingDistancePercent,
        trailingStepPercent,
      }));
    } catch {}
  }, [
    groupId,
    asset,
    side,
    orderType,
    limitPrice,
    marginCurrency,
    positionMarginType,
    leverage,
    sizingMode,
    percent,
    quantity,
    slTpMode,
    stopLossPrice,
    slPercent,
    takeProfitPrice,
    tpPercent,
    trailingStopLoss,
    trailingDistancePercent,
    trailingStepPercent,
  ]);

  useEffect(() => {
    if (asset) {
      try { localStorage.setItem('tradex_selected_asset', asset); } catch {}
    }
  }, [asset]);

  useEffect(() => {
    if (marginCurrency) {
      try { localStorage.setItem('tradex_selected_margin', marginCurrency); } catch {}
    }
  }, [marginCurrency]);

  useEffect(() => {
    if (rightPanelTab) {
      try { localStorage.setItem('tradex_active_tab', rightPanelTab); } catch {}
    }
  }, [rightPanelTab]);

  useEffect(() => {
    fetchMarketPrice('USDT', 'INR').then(p => {
      const ask = Number(p.bestAsk);
      const bid = Number(p.bestBid);
      if (ask > 0 && bid > 0) setUsdtInrRate((ask + bid) / 2);
      else if (ask > 0) setUsdtInrRate(ask);
      else if (bid > 0) setUsdtInrRate(bid);
    }).catch(() => {});
  }, []);

  // ─── Live WebSocket ticker — streams best bid/ask from CoinDCX every 2-3s ───
  const liveTicker = useLiveTicker(asset, quoteCurrency);

  const selectedGroup: GroupSummary | undefined = useMemo(
    () => groups.data?.find((g) => g.id === groupId),
    [groups.data, groupId],
  );
  const selectedAsset: AssetOption | undefined = useMemo(
    () => assets.data?.find((a) => a.asset === asset),
    [assets.data, asset],
  );

  // Fetch and set the current market price.
  const fetchAndSetPrice = (): void => {
    if (asset === '') return;

    setFetchingPrice(true);
    fetchMarketPrice(asset, quoteCurrency)
      .then((price) => {
        const fill = side === 'buy' ? price.bestAsk : price.bestBid;
        if (fill !== null && fill !== undefined) {
          setLimitPrice(fill);
          // Also store as the SL/TP reference for market orders.
          setMarketRefPrice(fill);
        }
      })
      .catch(() => {
        // Silent failure: auto-fill is a convenience
      })
      .finally(() => setFetchingPrice(false));
  };

  const isFirstMount = useRef(true);

  // Auto-fill the limit price when switching to limit order type or changing asset/currency/side.
  // Uses best ask for buy (you buy at the ask), best bid for sell (you sell at the bid).
  useEffect(() => {
    if (isFirstMount.current) {
      isFirstMount.current = false;
      // If limit price is already pre-filled from draft, do not overwrite on initial load
      if (limitPrice !== '') return;
    }
    if (orderType !== 'limit' || asset === '') return;
    fetchAndSetPrice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderType, asset, quoteCurrency, side]);

  // Keep marketRefPrice continuously synced from the live WebSocket ticker.
  // For market orders this is the only source; for limit orders the user's
  // typed limit price is the reference instead (handled in slTpRefPrice below).
  useEffect(() => {
    const fill = side === 'buy' ? liveTicker.bestAsk : liveTicker.bestBid;
    if (fill !== null) setMarketRefPrice(fill);
  }, [liveTicker.bestAsk, liveTicker.bestBid, side]);

  const preview = useMutation({
    mutationFn: (req: PlanRequest) => previewTrade(req),
    onSuccess: (result) => navigate(`/app/trades/${result.groupTradeId}`),
    onError: (err) => { console.error('preview failed:', err); },
  });

  // Cross margin is USDT-only (research/03 F4). If the operator flips to INR
  // while crossed is selected, snap it back to isolated so the DB CHECK never
  // sees an invalid combination.
  const effectiveMarginType: PositionMarginType =
    marginCurrency === 'INR' && positionMarginType === 'crossed' ? 'isolated' : positionMarginType;

  // Stepping works on the integer part so a typed 2.5 does not produce 3.5 on the
  // next click, and it CLAMPS rather than wrapping — a wrap from 100 to 1 on a
  // stray click is the kind of surprise this control exists to remove.
  const bumpLeverage = (delta: number): void => {
    const n = Number(leverage);
    const base = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
    setLeverage(String(Math.min(MAX_LEVERAGE, Math.max(1, base + delta))));
  };
  const leverageAtMin = Number(leverage) <= 1;
  const leverageAtMax = Number(leverage) >= MAX_LEVERAGE;

  const sizingRefPrice = orderType === 'limit' ? limitPrice : marketRefPrice;

  // Convert between percentage and quantity sizing modes.
  // Conversion needs: allocated capital, leverage, and current price.
  const convertPercentToQuantity = (): void => {
    if (!selectedGroup || !percentValid || !leverageValid || sizingRefPrice === '') return;
    const allocatedMinor = selectedGroup.allocatedByCurrency[marginCurrency];
    if (allocatedMinor === '0') return;

    const scale = marginCurrency === 'INR' ? 2 : 8;
    const allocatedMajor = Number(allocatedMinor) / Math.pow(10, scale);
    let margin = allocatedMajor * (Number(percent) / 100);
    if (quoteCurrency === 'USDT' && marginCurrency === 'INR' && usdtInrRate) {
      margin = margin / usdtInrRate;
    }
    const notional = margin * Number(leverage);
    const qty = notional / Number(sizingRefPrice);
    setQuantity(qty.toFixed(8).replace(/\.?0+$/, ''));
  };

  const convertQuantityToPercent = (): void => {
    if (!selectedGroup || !leverageValid || sizingRefPrice === '' || quantity === '') return;
    const allocatedMinor = selectedGroup.allocatedByCurrency[marginCurrency];
    if (allocatedMinor === '0') return;

    const scale = marginCurrency === 'INR' ? 2 : 8;
    const allocatedMajor = Number(allocatedMinor) / Math.pow(10, scale);
    const notional = Number(quantity) * Number(sizingRefPrice);
    let margin = notional / Number(leverage);
    if (quoteCurrency === 'USDT' && marginCurrency === 'INR' && usdtInrRate) {
      margin = margin * usdtInrRate;
    }
    const pct = (margin / allocatedMajor) * 100;
    setPercent(pct.toFixed(2));
  };

  const switchSizingMode = (mode: 'percent' | 'quantity'): void => {
    if (mode === sizingMode) return;
    if (mode === 'quantity' && percentValid && leverageValid && sizingRefPrice !== '') {
      convertPercentToQuantity();
    } else if (mode === 'percent' && quantity !== '' && leverageValid && sizingRefPrice !== '') {
      convertQuantityToPercent();
    }
    setSizingMode(mode);
  };

  // Only allow numeric input with optional decimal point
  const filterNumeric = (value: string): string => {
    // Allow digits, one decimal point, and filter everything else
    return value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1');
  };

  const handlePercentChange = (value: string): void => {
    const filtered = filterNumeric(value);
    // Prevent values over 100
    if (filtered === '' || (Number(filtered) <= 100)) {
      setPercent(filtered);
    }
  };

  const handleQuantityChange = (value: string): void => {
    setQuantity(filterNumeric(value));
  };

  const accountCount = selectedGroup?.enabledCount ?? 0;
  const leverageValid = /^\d+(\.\d+)?$/.test(leverage)
    && Number(leverage) >= 1 && Number(leverage) <= MAX_LEVERAGE;
  const percentValid = /^\d+(\.\d+)?$/.test(percent) && Number(percent) > 0 && Number(percent) <= 100;
  const quantityValid = /^\d+(\.\d+)?$/.test(quantity) && Number(quantity) > 0;
  const priceOk = (p: string): boolean => p === '' || /^\d+(\.\d+)?$/.test(p);

  // The reference price for SL/TP percentage calculation:
  // limit orders use the limit price, market orders use the last-fetched market price.
  const slTpRefPrice: string = orderType === 'limit' ? limitPrice : marketRefPrice;
  const slTpRefNum = Number(slTpRefPrice);
  const hasRef = slTpRefPrice !== '' && Number.isFinite(slTpRefNum) && slTpRefNum > 0;

  // Validate a SL/TP percent string: 0 < pct <= 100, decimal format.
  const pctOk = (p: string): boolean => p === '' || (/^\d+(\.\d+)?$/.test(p) && Number(p) > 0 && Number(p) <= 100);

  // Compute the effective absolute SL/TP prices (for validation + submission).
  const effectiveSlPrice: string = slTpMode === 'percent' && slPercent !== '' && hasRef
    ? percentToPrice(slTpRefNum, Number(slPercent), side, 'sl').toFixed(8).replace(/\.?0+$/, '')
    : stopLossPrice;
  const effectiveTpPrice: string = slTpMode === 'percent' && tpPercent !== '' && hasRef
    ? percentToPrice(slTpRefNum, Number(tpPercent), side, 'tp').toFixed(8).replace(/\.?0+$/, '')
    : takeProfitPrice;

  const sizeValid = sizingMode === 'percent' ? percentValid : quantityValid;

  const slValid = slTpMode === 'price' ? priceOk(stopLossPrice) : pctOk(slPercent);
  const tpValid = slTpMode === 'price' ? priceOk(takeProfitPrice) : pctOk(tpPercent);

  const canPreview =
    groupId !== '' && asset !== '' && accountCount > 0
    && leverageValid && sizeValid
    && (orderType !== 'limit' || (limitPrice !== '' && priceOk(limitPrice)))
    && slValid && tpValid;

  const submitPreview = (): void => {
    let sizingModeOut: string;
    let percentBpOut: number | undefined;
    let sizingValueOut: string | undefined;

    if (sizingMode === 'quantity') {
      // Send quantity directly — the backend sizes it as base_quantity.
      sizingModeOut = 'base_quantity';
      sizingValueOut = quantity;
    } else {
      sizingModeOut = 'pct_allocated';
      percentBpOut = Math.round(Number(percent) * 100);
    }

    const req: PlanRequest = {
      groupId,
      createdBy: '',
      asset,
      side,
      orderType,
      sizingMode: sizingModeOut as PlanRequest['sizingMode'],
      ...(percentBpOut !== undefined ? { percentBp: percentBpOut } : {}),
      ...(sizingValueOut !== undefined ? { sizingValue: sizingValueOut } : {}),
      ...(orderType === 'limit' ? { limitPrice } : {}),
      isFutures: true,
      leverage,
      marginCurrency,
      quoteCurrency,
      positionMarginType: effectiveMarginType,
      ...(effectiveSlPrice !== '' ? { stopLossPrice: effectiveSlPrice } : {}),
      ...(effectiveTpPrice !== '' ? { takeProfitPrice: effectiveTpPrice } : {}),
      ...(trailingStopLoss ? { 
        trailingStopLoss: true,
        trailingDistanceBp: Math.round(Number(trailingDistancePercent) * 100),
        trailingStepBp: Math.round(Number(trailingStepPercent) * 100),
      } : {}),
    };
    preview.mutate(req);
  };

  return (
    <div className="trading-terminal-layout">
      {/* Left Column: Full-View TradingView Advanced Live Chart */}
      <div className={`trading-chart-col ${rightPanelTab === 'chart' ? 'mobile-chart-active' : 'mobile-chart-hidden'}`}>
        <TradingViewChart
          asset={asset || 'BTC'}
          quoteCurrency={quoteCurrency}
          theme="dark"
          height="100%"
        />
        {/* Mobile floating quick switch to order form */}
        <div className="mobile-chart-cta">
          <button
            type="button"
            className="btn"
            style={{ width: '100%', padding: '12px 16px', fontWeight: 700, fontSize: 13.5, borderRadius: 10 }}
            onClick={() => setRightPanelTab('trade')}
          >
            Place Order for {asset}/{quoteCurrency}
          </button>
        </div>
      </div>

      {/* Right Column: Switcher Tabs + Panel (Trade Order vs Chart vs Watchlist) */}
      <div className={`trading-right-panel ${rightPanelTab === 'chart' ? 'mobile-panel-compact' : ''}`}>
        {/* Switcher Bar */}
        <div className="panel-tab-switcher">
          <button
            type="button"
            className={`panel-tab-btn ${rightPanelTab === 'trade' ? 'active' : ''}`}
            onClick={() => setRightPanelTab('trade')}
          >
            <span>Order</span>
            <span className="panel-tab-asset-pill">{asset}/{quoteCurrency}</span>
          </button>
          <button
            type="button"
            className={`panel-tab-btn mobile-only-tab ${rightPanelTab === 'chart' ? 'active' : ''}`}
            onClick={() => setRightPanelTab('chart')}
          >
            <span>Chart</span>
          </button>
          <button
            type="button"
            className={`panel-tab-btn ${rightPanelTab === 'watchlist' ? 'active' : ''}`}
            onClick={() => setRightPanelTab('watchlist')}
          >
            <span>Watchlist</span>
          </button>
        </div>

        {/* Tab 1: Trade Order Form */}
        <div style={{ display: rightPanelTab === 'trade' ? 'flex' : 'none', flexDirection: 'column', width: '100%' }}>
          <div className="panel trading-ticket-panel">
      <div className="field">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <label htmlFor="group" style={{ margin: 0 }}>Group</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>Funding wallet:</span>
            <button
              type="button"
              className="btn ghost btn-sm"
              style={{
                padding: '1px 5px',
                height: 20,
                minHeight: 'unset',
                fontSize: 11,
                cursor: 'pointer',
                opacity: groups.isFetching ? 0.5 : 0.8,
                display: 'inline-flex',
                alignItems: 'center',
              }}
              onClick={() => void groups.refetch()}
              disabled={groups.isFetching}
              title="Refresh group balances from database"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: groups.isFetching ? 'spin 1s linear infinite' : 'none' }}>
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
            </button>
            <div style={{
              display: 'flex',
              background: '#0e1014',
              border: '1px solid #1f232b',
              borderRadius: 6,
              padding: 2,
              gap: 2,
            }}>
              {(['INR', 'USDT'] as const).map((curr) => {
                const active = marginCurrency === curr;
                return (
                  <button
                    key={curr}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setMarginCurrency(curr)}
                    style={{
                      padding: '2px 10px',
                      fontSize: 11,
                      fontWeight: active ? 700 : 500,
                      background: active ? '#ffffff' : 'transparent',
                      color: active ? '#000000' : '#9ca3af',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {curr}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <select id="group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">Select a group…</option>
          {groups.data?.map((g) => {
            const isDefault = g.name === DEFAULT_GROUP_NAME;
            return (
              <option key={g.id} value={g.id}>
                {g.name} — {g.enabledCount} account{g.enabledCount === 1 ? '' : 's'}{isDefault ? ' (All Accounts)' : ''}
              </option>
            );
          })}
        </select>
        {selectedGroup !== undefined && selectedGroup.name === DEFAULT_GROUP_NAME && (
          <div style={{
            marginTop: 6,
            padding: '6px 10px',
            borderRadius: 6,
            background: 'rgba(59, 130, 246, 0.08)',
            border: '1px solid rgba(59, 130, 246, 0.2)',
            color: '#93c5fd',
            fontSize: 11.5,
            lineHeight: 1.4,
          }}>
            <strong>Master Whole-Desk Trade:</strong> Order fans out to all active accounts. Each account&apos;s open position will be attributed to its assigned strategy group.
          </div>
        )}
        {selectedGroup !== undefined && (() => {
          const inr = selectedGroup.allocatedByCurrency.INR;
          const usdt = selectedGroup.allocatedByCurrency.USDT;
          const hasInr = inr !== '0';
          const hasUsdt = usdt !== '0';
          const inrFormatted = hasInr ? `₹${Number(minorToMajor(inr, 2)).toLocaleString('en-IN')}` : '₹0';
          const usdtFormatted = hasUsdt ? `${Number(minorToMajor(usdt, 8)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT` : '0 USDT';
          return (
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
              marginTop: 8, padding: '6px', borderRadius: 8,
              background: '#0e1014', border: '1px solid #1f232b',
            }}>
              <div
                onClick={() => setMarginCurrency('INR')}
                title="Click to fund from INR wallet"
                style={{
                  display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer',
                  padding: '6px 8px', borderRadius: 6,
                  border: marginCurrency === 'INR' ? '1px solid #ffffff' : '1px solid transparent',
                  background: marginCurrency === 'INR' ? '#161922' : 'transparent',
                  transition: 'all 0.15s ease',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>INR Capital</span>
                  {marginCurrency === 'INR' && <span style={{ fontSize: 8.5, fontWeight: 700, color: '#000000', background: '#ffffff', padding: '1px 4px', borderRadius: 3 }}>FUNDING</span>}
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: hasInr ? '#f3f4f6' : '#4b5563' }}>{inrFormatted}</span>
              </div>
              <div
                onClick={() => setMarginCurrency('USDT')}
                title="Click to fund from USDT wallet"
                style={{
                  display: 'flex', flexDirection: 'column', gap: 2, cursor: 'pointer',
                  padding: '6px 8px', borderRadius: 6,
                  border: marginCurrency === 'USDT' ? '1px solid #ffffff' : '1px solid transparent',
                  background: marginCurrency === 'USDT' ? '#161922' : 'transparent',
                  transition: 'all 0.15s ease',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>USDT Capital</span>
                  {marginCurrency === 'USDT' && <span style={{ fontSize: 8.5, fontWeight: 700, color: '#000000', background: '#ffffff', padding: '1px 4px', borderRadius: 3 }}>FUNDING</span>}
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: hasUsdt ? '#f3f4f6' : '#4b5563' }}>{usdtFormatted}</span>
              </div>
            </div>
          );
        })()}
      </div>

      <div className="field">
        <label htmlFor="asset">Asset</label>
        <input
          id="asset"
          list="asset-list"
          value={asset}
          placeholder="Start typing, e.g. BTC"
          onChange={(e) => setAsset(e.target.value.toUpperCase())}
        />
        <datalist id="asset-list">
          {assets.data?.map((a) => (
            <option key={a.asset} value={a.asset}>{a.quotes.join(' / ')}</option>
          ))}
        </datalist>
        {selectedAsset !== undefined && (
          <div className="hint">Perps trade against {selectedAsset.quotes.join(' and ')} margin</div>
        )}
      </div>

      <div className="row">
        <Choice
          label="Side"
          value={side}
          onChange={setSide}
          options={[
            { value: 'buy' as Side, label: 'Long', tone: 'long' },
            { value: 'sell' as Side, label: 'Short', tone: 'short' },
          ]}
        />
        <Choice
          label="Order type"
          value={orderType}
          onChange={setOrderType}
          options={[
            { value: 'market' as OrderType, label: 'Market' },
            { value: 'limit' as OrderType, label: 'Limit' },
          ]}
        />
      </div>

      {/* ── Live price ticker ── */}
      {asset !== '' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', borderRadius: 8, fontSize: 12,
          background: '#0e1014',
          border: '1px solid #1f232b',
          marginBottom: 8,
          flexWrap: 'wrap',
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: liveTicker.connected ? '#22c55e' : '#6b7280',
            display: 'inline-block', flexShrink: 0,
            animation: liveTicker.connected ? 'pulse 2s ease-in-out infinite' : 'none',
          }} />
          <span style={{ fontWeight: 600, color: '#f3f4f6' }}>
            {liveTicker.connected ? 'Live' : 'Connecting…'}
          </span>
          {liveTicker.bestBid !== null && (
            <span style={{ color: '#9ca3af' }}>
              Bid <strong style={{ color: '#ffffff' }}>{liveTicker.bestBid}</strong>
            </span>
          )}
          {liveTicker.bestAsk !== null && (
            <span style={{ color: '#9ca3af' }}>
              Ask <strong style={{ color: '#ffffff' }}>{liveTicker.bestAsk}</strong>
            </span>
          )}
          {liveTicker.updatedAtMs !== null && (
            <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6b7280' }}>
              {new Date(liveTicker.updatedAtMs).toLocaleTimeString()}
            </span>
          )}
        </div>
      )}
      {orderType === 'limit' && (
        <div className="field">
          <label htmlFor="limit">Limit price</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id="limit"
              inputMode="decimal"
              value={limitPrice}
              placeholder="e.g. 85000"
              style={{ flex: 1 }}
              onChange={(e) => setLimitPrice(e.target.value)}
            />
            <button
              type="button"
              className="btn secondary"
              disabled={fetchingPrice || asset === ''}
              style={{ whiteSpace: 'nowrap', padding: '0 12px' }}
              onClick={() => fetchAndSetPrice()}
              title="Fetch the current market price"
            >
              {fetchingPrice ? '⟳' : '↻'} Live price
            </button>
          </div>
        </div>
      )}

      <Choice
        label="Margin mode"
        value={effectiveMarginType}
        onChange={(v) => setPositionMarginType(v as PositionMarginType)}
        hint={marginCurrency === 'USDT' ? 'Crossed shares collateral across positions; Isolated confines risk.' : 'INR funding uses Isolated margin.'}
        options={
          marginCurrency === 'USDT'
            ? [
                { value: 'isolated' as PositionMarginType, label: 'Isolated' },
                { value: 'crossed' as PositionMarginType, label: 'Crossed' },
              ]
            : [
                { value: 'isolated' as PositionMarginType, label: 'Isolated' },
              ]
        }
      />

      <div className="field" style={{ marginTop: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <label htmlFor="lev" style={{ margin: 0 }}>Leverage</label>
          <span style={{ fontSize: 11, color: 'var(--muted)' }}>Max {MAX_LEVERAGE}×</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className="btn secondary"
            aria-label="Decrease leverage"
            disabled={leverageAtMin}
            style={{ padding: '4px 12px', fontSize: 15, lineHeight: 1 }}
            onClick={() => bumpLeverage(-1)}
          >
            −
          </button>
          <input
            id="lev"
            inputMode="decimal"
            value={leverage}
            placeholder="5"
            style={{ flex: 1, minWidth: 0, textAlign: 'center', fontWeight: 600 }}
            onChange={(e) => setLeverage(e.target.value)}
          />
          <button
            type="button"
            className="btn secondary"
            aria-label="Increase leverage"
            disabled={leverageAtMax}
            style={{ padding: '4px 12px', fontSize: 15, lineHeight: 1 }}
            onClick={() => bumpLeverage(1)}
          >
            +
          </button>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {[1, 5, 10, 20].map((v) => {
            const active = Number(leverage) === v;
            return (
              <button
                key={v}
                type="button"
                aria-pressed={active}
                className="btn btn-sm"
                style={{
                  flex: 1,
                  padding: '4px 0',
                  fontSize: 11,
                  fontWeight: active ? 700 : 500,
                  background: active ? '#ffffff' : '#111318',
                  color: active ? '#000000' : '#9ca3af',
                  border: `1px solid ${active ? '#ffffff' : '#222631'}`,
                  borderRadius: 'var(--radius-pill)',
                }}
                onClick={() => setLeverage(String(v))}
              >
                {v}×
              </button>
            );
          })}
        </div>
      </div>

      <div className="field">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <label htmlFor="size" style={{ margin: 0 }}>Size</label>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              type="button"
              className="btn btn-sm"
              aria-pressed={sizingMode === "percent"}
              style={{
                padding: "2px 10px",
                fontSize: 11,
                fontWeight: sizingMode === "percent" ? 700 : 500,
                background: sizingMode === "percent" ? "#ffffff" : "#111318",
                color: sizingMode === "percent" ? "#000000" : "#9ca3af",
                border: `1px solid ${sizingMode === "percent" ? "#ffffff" : "#222631"}`,
              }}
              onClick={() => switchSizingMode("percent")}
            >
              Percent
            </button>
            <button
              type="button"
              className="btn btn-sm"
              aria-pressed={sizingMode === "quantity"}
              style={{
                padding: "2px 10px",
                fontSize: 11,
                fontWeight: sizingMode === "quantity" ? 700 : 500,
                background: sizingMode === "quantity" ? "#ffffff" : "#111318",
                color: sizingMode === "quantity" ? "#000000" : "#9ca3af",
                border: `1px solid ${sizingMode === "quantity" ? "#ffffff" : "#222631"}`,
              }}
              onClick={() => switchSizingMode("quantity")}
            >
              Quantity
            </button>
          </div>
        </div>
        {sizingMode === "percent" ? (
          <>
            <input
              id="size"
              inputMode="decimal"
              value={percent}
              placeholder="e.g. 20"
              onChange={(e) => handlePercentChange(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
              {[10, 25, 50, 75, 100].map((v) => {
                const active = Number(percent) === v;
                return (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={active}
                    className="btn btn-sm"
                    style={{
                      flex: 1,
                      padding: '3px 0',
                      fontSize: 11,
                      fontWeight: active ? 700 : 500,
                      background: active ? '#ffffff' : '#111318',
                      color: active ? '#000000' : '#9ca3af',
                      border: `1px solid ${active ? '#ffffff' : '#222631'}`,
                      borderRadius: 'var(--radius-pill)',
                    }}
                    onClick={() => setPercent(String(v))}
                  >
                    {v}%
                  </button>
                );
              })}
            </div>
            {/* ── Trading amount summary for percent mode ── */}
            {percentValid && leverageValid && selectedGroup ? (() => {
              const scale = marginCurrency === 'INR' ? 2 : 8;
              const allocatedMajor = Number(selectedGroup.allocatedByCurrency[marginCurrency]) / Math.pow(10, scale);
              const marginAmt = allocatedMajor * (Number(percent) / 100);
              const notionalAmt = marginAmt * Number(leverage);
              const notionalInUsdt = marginCurrency === 'INR'
                ? (usdtInrRate ? notionalAmt / usdtInrRate : notionalAmt / 88)
                : notionalAmt;
              const currSymbol = marginCurrency === 'INR' ? '₹' : '';
              const currSuffix = marginCurrency === 'USDT' ? ' USDT' : '';
              const fmtMargin = marginCurrency === 'INR'
                ? `${currSymbol}${marginAmt.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
                : `${marginAmt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}${currSuffix}`;
              const fmtNotional = marginCurrency === 'INR'
                ? `${currSymbol}${notionalAmt.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
                : `${notionalAmt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}${currSuffix}`;
              return (
                <>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
                    marginTop: 8, padding: '8px 10px', borderRadius: 8,
                    background: '#0e1014', border: '1px solid #1f232b',
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Margin ({percent}%)</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#f3f4f6' }}>{fmtMargin}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Notional ({leverage}×)</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#f3f4f6' }}>{fmtNotional}</span>
                    </div>
                  </div>
                  {notionalInUsdt > 0 && notionalInUsdt < 5 && (
                    <div style={{
                      marginTop: 6, padding: '6px 8px', borderRadius: 6,
                      background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)',
                      color: '#f87171', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      <span>Order value (~{notionalInUsdt.toFixed(2)} USDT) is below the exchange minimum of 5 USDT. Increase size or leverage.</span>
                    </div>
                  )}
                </>
              );
            })() : (
              <div className="hint">
                Percent of the group&rsquo;s allocated capital is used as margin; notional = margin × leverage.
              </div>
            )}
          </>
        ) : (
          <>
            <input
              id="size"
              inputMode="decimal"
              value={quantity}
              placeholder={`e.g. 0.5 ${asset || "BTC"}`}
              onChange={(e) => handleQuantityChange(e.target.value)}
            />
            {/* ── Trading amount summary for quantity mode ── */}
            {quantityValid && leverageValid && sizingRefPrice !== "" ? (() => {
              const notionalAmt = Number(quantity) * Number(sizingRefPrice);
              const marginAmt = notionalAmt / Number(leverage);
              const fmtNotional = `${notionalAmt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT`;
              const fmtMargin = marginCurrency === 'INR' && usdtInrRate
                ? `₹${(marginAmt * usdtInrRate).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
                : `${marginAmt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT`;
              return (
                <>
                  <div style={{
                    display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
                    marginTop: 8, padding: '8px 10px', borderRadius: 8,
                    background: '#0e1014', border: '1px solid #1f232b',
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Notional</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#f3f4f6' }}>{fmtNotional}</span>
                      <span style={{ fontSize: 10, color: '#6b7280' }}>{quantity} {asset} @ {sizingRefPrice}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Est. Margin</span>
                      <span style={{ fontSize: 13, fontWeight: 700, color: '#f3f4f6' }}>{fmtMargin}</span>
                      <span style={{ fontSize: 10, color: '#6b7280' }}>at {leverage}× leverage</span>
                    </div>
                  </div>
                  {notionalAmt > 0 && notionalAmt < 5 && (
                    <div style={{
                      marginTop: 6, padding: '6px 8px', borderRadius: 6,
                      background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)',
                      color: '#f87171', fontSize: 11, display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      <span>Order value (~{notionalAmt.toFixed(2)} USDT) is below the exchange minimum of 5 USDT. Increase quantity.</span>
                    </div>
                  )}
                </>
              );
            })() : (
              <div className="hint">
                Direct quantity in {asset || "the selected asset"}. Wait for market price or switch to limit order to see notional.
              </div>
            )}
          </>
        )}
      </div>

      {/* SL/TP section — only shown after an asset is selected */}
      {asset !== '' && (
        <>
          {/* Single Price / % toggle for both SL and TP */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, marginTop: 4 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              SL / TP mode
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={slTpMode === 'percent'}
                style={{
                  padding: '2px 12px', fontSize: 11,
                  fontWeight: slTpMode === 'percent' ? 700 : 500,
                  background: slTpMode === 'percent' ? '#ffffff' : '#111318',
                  color: slTpMode === 'percent' ? '#000000' : '#9ca3af',
                  border: `1px solid ${slTpMode === 'percent' ? '#ffffff' : '#222631'}`,
                }}
                onClick={() => setSlTpMode('percent')}
              >
                %
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={slTpMode === 'price'}
                style={{
                  padding: '2px 12px', fontSize: 11,
                  fontWeight: slTpMode === 'price' ? 700 : 500,
                  background: slTpMode === 'price' ? '#ffffff' : '#111318',
                  color: slTpMode === 'price' ? '#000000' : '#9ca3af',
                  border: `1px solid ${slTpMode === 'price' ? '#ffffff' : '#222631'}`,
                }}
                onClick={() => setSlTpMode('price')}
              >
                Price
              </button>
            </div>
            {slTpMode === 'percent' && !hasRef && (
              <span style={{ fontSize: 11, color: 'var(--faint)' }}>
                {orderType === 'market' ? 'Fetching price…' : 'Set a limit price first'}
              </span>
            )}
          </div>

          <div className="row">
            {/* ── Stop-loss ── */}
            <div className="field">
              <label htmlFor="sl">Stop-loss (optional)</label>
              {slTpMode === 'price' ? (
                <>
                  <input id="sl" inputMode="decimal" value={stopLossPrice} placeholder="e.g. 80000" onChange={(e) => setStopLossPrice(e.target.value)} />
                  {stopLossPrice !== '' && hasRef && (
                    <div className="hint">
                      ≈ {priceToPercent(slTpRefNum, Number(stopLossPrice), side, 'sl').toFixed(2)}% from entry
                    </div>
                  )}
                </>
              ) : (
                <>
                  <input
                    id="sl"
                    inputMode="decimal"
                    value={slPercent}
                    placeholder="e.g. 5"
                    disabled={!hasRef}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./, '$1');
                      if (v === '' || Number(v) <= 100) setSlPercent(v);
                    }}
                  />
                  <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                    {SL_PERCENT_CHIPS.map((v) => {
                      const active = slPercent !== '' && Number(slPercent) === v;
                      return (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={active}
                          className="btn btn-sm"
                          disabled={!hasRef}
                          style={{
                            flex: 1, padding: '3px 0', fontSize: 11, fontWeight: active ? 700 : 500,
                            background: active ? '#ffffff' : '#111318',
                            color: active ? '#000000' : '#9ca3af',
                            border: `1px solid ${active ? '#ffffff' : '#222631'}`,
                            borderRadius: 'var(--radius-pill)',
                          }}
                          onClick={() => setSlPercent(String(v))}
                        >
                          {v}%
                        </button>
                      );
                    })}
                  </div>
                  {hasRef && slPercent !== '' && pctOk(slPercent) && (
                    <div className="hint">
                      ≈ {percentToPrice(slTpRefNum, Number(slPercent), side, 'sl').toFixed(2)} trigger price
                    </div>
                  )}
                  {hasRef && orderType === 'market' && (
                    <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                      Based on current market price — actual fill may differ.
                    </div>
                  )}
                </>
              )}
                <div style={{ display: 'flex', alignItems: 'center', marginTop: 8 }}>
                  <select
                    id="ticket-tsl-type"
                    value={trailingStopLoss ? 'trailing' : 'fixed'}
                    onChange={(e) => setTrailingStopLoss(e.target.value === 'trailing')}
                    style={{ fontSize: 12, padding: '4px 8px' }}
                  >
                    <option value="fixed">Fixed Stop Loss</option>
                    <option value="trailing">Trailing Stop Loss</option>
                  </select>
                </div>
                {trailingStopLoss && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6, fontSize: 12, alignItems: 'center' }}>
                    <span style={{ color: 'var(--text-dim)' }}>Distance:</span>
                    <input type="text" inputMode="decimal" value={trailingDistancePercent} onChange={(e) => setTrailingDistancePercent(e.target.value)} style={{ width: 40, padding: '2px 4px' }} />
                    <span style={{ color: 'var(--text-dim)' }}>%</span>
                    <span style={{ color: 'var(--text-dim)', marginLeft: 8 }}>Step:</span>
                    <input type="text" inputMode="decimal" value={trailingStepPercent} onChange={(e) => setTrailingStepPercent(e.target.value)} style={{ width: 40, padding: '2px 4px' }} />
                    <span style={{ color: 'var(--text-dim)' }}>%</span>
                  </div>
                )}
            </div>

            {/* ── Take-profit ── */}
            <div className="field">
              <label htmlFor="tp">Take-profit (optional)</label>
              {slTpMode === 'price' ? (
                <>
                  <input id="tp" inputMode="decimal" value={takeProfitPrice} placeholder="e.g. 92000" onChange={(e) => setTakeProfitPrice(e.target.value)} />
                  {takeProfitPrice !== '' && hasRef && (
                    <div className="hint">
                      ≈ {priceToPercent(slTpRefNum, Number(takeProfitPrice), side, 'tp').toFixed(2)}% from entry
                    </div>
                  )}
                </>
              ) : (
                <>
                  <input
                    id="tp"
                    inputMode="decimal"
                    value={tpPercent}
                    placeholder="e.g. 5"
                    disabled={!hasRef}
                    onChange={(e) => {
                      const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./, '$1');
                      if (v === '' || Number(v) <= 100) setTpPercent(v);
                    }}
                  />
                  <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                    {TP_PERCENT_CHIPS.map((v) => {
                      const active = tpPercent !== '' && Number(tpPercent) === v;
                      return (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={active}
                          className="btn btn-sm"
                          disabled={!hasRef}
                          style={{
                            flex: 1, padding: '3px 0', fontSize: 11, fontWeight: active ? 700 : 500,
                            background: active ? '#ffffff' : '#111318',
                            color: active ? '#000000' : '#9ca3af',
                            border: `1px solid ${active ? '#ffffff' : '#222631'}`,
                            borderRadius: 'var(--radius-pill)',
                          }}
                          onClick={() => setTpPercent(String(v))}
                        >
                          {v}%
                        </button>
                      );
                    })}
                  </div>
                  {hasRef && tpPercent !== '' && pctOk(tpPercent) && (
                    <div className="hint">
                      ≈ {percentToPrice(slTpRefNum, Number(tpPercent), side, 'tp').toFixed(2)} trigger price
                    </div>
                  )}
                  {hasRef && orderType === 'market' && (
                    <div style={{ fontSize: 11, color: 'var(--faint)', marginTop: 2 }}>
                      Based on current market price — actual fill may differ.
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}


      {orderType === 'market' && (
        <div className="spread-warning">
          Market orders fill at the current book price. If the spread on the chosen market is wide, a limit order controls the fill price.
        </div>
      )}

      {preview.isError && (
        <div className="error">{(preview.error as Error).message}</div>
      )}

      <button
        className="btn"
        disabled={!canPreview || preview.isPending}
        onClick={submitPreview}
        style={{
          width: '100%',
          padding: '12px',
          fontSize: 14,
          fontWeight: 700,
          background: '#ffffff',
          color: '#000000',
          border: '1px solid #ffffff',
          borderRadius: 8,
          cursor: !canPreview || preview.isPending ? 'not-allowed' : 'pointer',
          opacity: !canPreview || preview.isPending ? 0.5 : 1,
          marginTop: 8,
          boxShadow: '0 2px 10px rgba(255, 255, 255, 0.1)',
        }}
      >
        {preview.isPending ? 'Previewing…' : `Preview ${accountCount} account${accountCount === 1 ? '' : 's'}`}
      </button>
          </div>
        </div>

        {/* Tab 2: Watchlist */}
        <div style={{ display: rightPanelTab === 'watchlist' ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: 480 }}>
          <WatchlistPanel
            selectedAsset={asset || 'BTC'}
            onSelectAsset={(newAsset) => {
              setAsset(newAsset);
            }}
            onOpenTrade={() => setRightPanelTab('trade')}
            allAssets={assets.data}
            quoteCurrency={quoteCurrency}
          />
        </div>
      </div>
    </div>
  );
}


function minorToMajor(minor: string, scale: number): string {
  if (scale === 0) return minor;
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}
