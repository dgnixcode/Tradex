import { useEffect, useMemo, useState } from 'react';
import { useLiveTicker } from '../hooks/useLiveTicker.ts';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { fetchAssets, fetchGroups, fetchMarketPrice, previewTrade } from '../api.ts';
import type { AssetOption, GroupSummary, PlanRequest } from '../api.ts';

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
      <div style={{ display: 'flex', gap: 8 }}>
        {options.map((o) => {
          const active = o.value === value;
          const colour = o.tone === 'long' ? 'var(--ok)' : o.tone === 'short' ? 'var(--danger)' : undefined;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={active}
              className="btn"
              style={{
                flex: 1,
                ...(colour !== undefined
                  ? active
                    // Chosen: filled, so it reads as a state.
                    ? { background: colour, color: '#fff', border: '1px solid transparent' }
                    // Not chosen: outlined in its own colour, so the MEANING is
                    // still visible without being the current selection.
                    : { background: 'transparent', color: colour, border: `1px solid ${colour}` }
                  : active
                    ? {}
                    : { background: 'transparent', color: 'var(--muted)', border: '1px solid var(--line)' }),
              }}
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
  const groups = useQuery({ queryKey: ['groups'], queryFn: fetchGroups });
  const assets = useQuery({ queryKey: ['assets'], queryFn: fetchAssets });

  const [groupId, setGroupId] = useState('');
  const [asset, setAsset] = useState('');
  const [side, setSide] = useState<Side>('buy');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [limitPrice, setLimitPrice] = useState('');

  // Futures shape — every field required except the two conditionals + reduceOnly.
  const [leverage, setLeverage] = useState('5');
  const [marginCurrency, setMarginCurrency] = useState<MarginCurrency>('USDT');
  const [quoteCurrency, setQuoteCurrency] = useState<MarginCurrency>('USDT');
  const [positionMarginType, setPositionMarginType] = useState<PositionMarginType>('isolated');
  const [percent, setPercent] = useState('');
  const [quantity, setQuantity] = useState('');
  const [sizingMode, setSizingMode] = useState<'percent' | 'quantity'>('percent');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [takeProfitPrice, setTakeProfitPrice] = useState('');
  const [trailingStopLoss, setTrailingStopLoss] = useState(false);
  const [trailingDistancePercent, setTrailingDistancePercent] = useState('5');
  const [trailingStepPercent, setTrailingStepPercent] = useState('1');
  const [fetchingPrice, setFetchingPrice] = useState(false);

  // SL/TP percentage mode state — one toggle controls both fields.
  const [slTpMode, setSlTpMode] = useState<SlTpMode>('percent');
  const [slPercent, setSlPercent] = useState('');
  const [tpPercent, setTpPercent] = useState('');
  // Stores the latest market price for use as SL/TP reference on market orders.
  const [marketRefPrice, setMarketRefPrice] = useState('');
  const [usdtInrRate, setUsdtInrRate] = useState<number | null>(null);

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

  // Auto-fill the limit price when switching to limit order type or changing asset/currency/side.
  // Uses best ask for buy (you buy at the ask), best bid for sell (you sell at the bid).
  useEffect(() => {
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
    window.alert('submitPreview called! sizingMode=' + sizingMode + ', percent=' + percent);
    console.log('[submitPreview] called', { sizingMode, percent, quantity, sizingRefPrice, marginCurrency, quoteCurrency, groupId, asset, side, leverage });
    // Backend expects percentBp, so convert from quantity if needed
    let finalPercentBp: number;
    if (sizingMode === 'quantity') {
      // Convert quantity → percent before submitting
      if (!selectedGroup || !leverageValid || sizingRefPrice === '') { console.log('[submitPreview] bail: quantity guard'); return; }
      const allocatedMinor = selectedGroup.allocatedByCurrency[marginCurrency];
      if (allocatedMinor === '0') { console.log('[submitPreview] bail: allocatedMinor is 0'); return; }
      const scale = marginCurrency === 'INR' ? 2 : 8;
      const allocatedMajor = Number(allocatedMinor) / Math.pow(10, scale);
      const notional = Number(quantity) * Number(sizingRefPrice);
      let margin = notional / Number(leverage);
      if (quoteCurrency === 'USDT' && marginCurrency === 'INR' && usdtInrRate) {
        margin = margin * usdtInrRate;
      }
      const pct = (margin / allocatedMajor) * 100;
      finalPercentBp = Math.round(pct * 100);
    } else {
      finalPercentBp = Math.round(Number(percent) * 100);
    }
    const req: PlanRequest = {
      groupId,
      createdBy: '',
      asset,
      side,
      orderType,
      sizingMode: 'pct_allocated',
      percentBp: finalPercentBp,
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
    console.log('[submitPreview] calling preview.mutate with:', req);
    preview.mutate(req);
  };

  return (
    <div className="panel">
      <h2>New futures trade</h2>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        A perpetual-futures order sized across every enabled account in the group. Leverage, margin currency,
        and any attached SL/TP travel with every leg.
      </p>

      <div className="field">
        <label htmlFor="group">Group</label>
        <select id="group" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
          <option value="">Select a group…</option>
          {groups.data?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name} — {g.enabledCount} account{g.enabledCount === 1 ? '' : 's'}
            </option>
          ))}
        </select>
        {selectedGroup !== undefined && (
          <div className="hint">
            Combined allocated capital: {formatCapital(selectedGroup)}
          </div>
        )}
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
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 12px', borderRadius: 8, fontSize: 12.5,
          background: 'var(--panel-bg, #fafafa)',
          border: '1px solid var(--line)',
          marginBottom: 6,
        }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%',
            background: liveTicker.connected ? '#22c55e' : 'var(--text-dim)',
            display: 'inline-block', flexShrink: 0,
            animation: liveTicker.connected ? 'pulse 2s ease-in-out infinite' : 'none',
          }} />
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>
            {liveTicker.connected ? 'Live' : 'Connecting…'}
          </span>
          {liveTicker.bestBid !== null && (
            <span style={{ color: 'var(--text-dim)' }}>
              Bid <strong style={{ color: 'var(--text)' }}>{liveTicker.bestBid}</strong>
            </span>
          )}
          {liveTicker.bestAsk !== null && (
            <span style={{ color: 'var(--text-dim)' }}>
              Ask <strong style={{ color: 'var(--text)' }}>{liveTicker.bestAsk}</strong>
            </span>
          )}
          {liveTicker.updatedAtMs !== null && (
            <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)' }}>
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

      <div className="row">
        <Choice
          label="Trade pair quote"
          value={quoteCurrency}
          onChange={setQuoteCurrency}
          hint="Picks which market to trade on."
          options={[
            { value: 'INR' as MarginCurrency, label: 'INR' },
            { value: 'USDT' as MarginCurrency, label: 'USDT' },
          ]}
        />
        <Choice
          label="Funding wallet"
          value={marginCurrency}
          onChange={setMarginCurrency}
          hint="Picks which wallet to size and fund from."
          options={[
            { value: 'INR' as MarginCurrency, label: 'INR' },
            { value: 'USDT' as MarginCurrency, label: 'USDT' },
          ]}
        />
        <div className="field">
          <label htmlFor="mt">Margin mode</label>
          <select
            id="mt"
            value={effectiveMarginType}
            onChange={(e) => setPositionMarginType(e.target.value as PositionMarginType)}
          >
            <option value="isolated">Isolated</option>
            {/* Cross is USDT-only per venue (research/03 F4) + schema CHECK. */}
            {marginCurrency === 'USDT' && <option value="crossed">Crossed</option>}
          </select>
        </div>
        <div className="field">
          <label htmlFor="lev">Leverage</label>
          {/* A stepper AND a free-text field. The buttons make the common case one
              click and put the bounds in reach; the input keeps the exact value
              typeable, because a trader who wants 37× should not have to click 36
              times. Both write the same state, so neither can drift from the other. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              className="btn secondary"
              aria-label="Decrease leverage"
              disabled={leverageAtMin}
              style={{ padding: '4px 12px', fontSize: 16, lineHeight: 1 }}
              onClick={() => bumpLeverage(-1)}
            >
              −
            </button>
            <input
              id="lev"
              inputMode="decimal"
              value={leverage}
              placeholder="5"
              style={{ flex: 1, textAlign: 'center' }}
              onChange={(e) => setLeverage(e.target.value)}
            />
            <button
              type="button"
              className="btn secondary"
              aria-label="Increase leverage"
              disabled={leverageAtMax}
              style={{ padding: '4px 12px', fontSize: 16, lineHeight: 1 }}
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
                  // DELIBERATELY NOT `btn ghost`: that class is transparent with
                  // `--text-dim`, which on this panel rendered as near-invisible
                  // text. Every colour here is stated outright, so the control
                  // reads on any theme rather than depending on what it inherits.
                  className="btn btn-sm"
                  style={{
                    flex: 1,
                    padding: '4px 0',
                    fontSize: 11.5,
                    fontWeight: active ? 600 : 500,
                    // Selected: filled and bordered in the accent, so it reads as a
                    // state. Unselected: a visible outline on the panel's own
                    // background, so the SET of choices is legible before choosing.
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--text)' : 'var(--text-dim)',
                    border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
                    borderRadius: 'var(--radius-pill)',
                  }}
                  onClick={() => setLeverage(String(v))}
                >
                  {v}×
                </button>
              );
            })}
          </div>
          <div className="hint">
            1× to {MAX_LEVERAGE}× here; the market&rsquo;s own per-tier max is enforced server-side.
          </div>
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
                background: sizingMode === "percent" ? "var(--accent-soft)" : "transparent",
                color: sizingMode === "percent" ? "var(--text)" : "var(--text-dim)",
                border: `1px solid ${sizingMode === "percent" ? "var(--accent)" : "var(--line)"}`,
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
                background: sizingMode === "quantity" ? "var(--accent-soft)" : "transparent",
                color: sizingMode === "quantity" ? "var(--text)" : "var(--text-dim)",
                border: `1px solid ${sizingMode === "quantity" ? "var(--accent)" : "var(--line)"}`,
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
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
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
                      padding: '4px 0',
                      fontSize: 11.5,
                      fontWeight: active ? 600 : 500,
                      background: active ? 'var(--accent-soft)' : 'transparent',
                      color: active ? 'var(--text)' : 'var(--text-dim)',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
                      borderRadius: 'var(--radius-pill)',
                    }}
                    onClick={() => setPercent(String(v))}
                  >
                    {v}%
                  </button>
                );
              })}
            </div>
            <div className="hint">
              {percentValid && leverageValid
                ? `${percent}% × ${leverage}× = ${(Number(percent) * Number(leverage)).toFixed(0)}% of allocated as notional exposure.`
                : "Percent of the group's allocated capital is used as margin; notional = margin × leverage."}
            </div>
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
            <div className="hint">
              {quantityValid && leverageValid && sizingRefPrice !== ""
                ? `${quantity} ${asset} @ ${sizingRefPrice} = notional ${(Number(quantity) * Number(sizingRefPrice)).toFixed(2)} ${quoteCurrency}`
                : `Direct quantity in ${asset || "the selected asset"}. Wait for market price or switch to limit order to see notional.`}
            </div>
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
                  background: slTpMode === 'percent' ? 'var(--accent-soft)' : 'transparent',
                  color: slTpMode === 'percent' ? 'var(--text)' : 'var(--text-dim)',
                  border: `1px solid ${slTpMode === 'percent' ? 'var(--accent)' : 'var(--line)'}`,
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
                  background: slTpMode === 'price' ? 'var(--accent-soft)' : 'transparent',
                  color: slTpMode === 'price' ? 'var(--text)' : 'var(--text-dim)',
                  border: `1px solid ${slTpMode === 'price' ? 'var(--accent)' : 'var(--line)'}`,
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
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
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
                            flex: 1, padding: '4px 0', fontSize: 11.5, fontWeight: active ? 600 : 500,
                            background: active ? 'var(--accent-soft)' : 'transparent',
                            color: active ? 'var(--text)' : 'var(--text-dim)',
                            border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
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
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
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
                            flex: 1, padding: '4px 0', fontSize: 11.5, fontWeight: active ? 600 : 500,
                            background: active ? 'var(--accent-soft)' : 'transparent',
                            color: active ? 'var(--text)' : 'var(--text-dim)',
                            border: `1px solid ${active ? 'var(--accent)' : 'var(--line)'}`,
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

      <button className="btn" disabled={!canPreview || preview.isPending} onClick={submitPreview}>
        {preview.isPending ? 'Previewing…' : `Preview ${accountCount} account${accountCount === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}

function formatCapital(group: GroupSummary): string {
  const parts: string[] = [];
  const inr = group.allocatedByCurrency.INR;
  const usdt = group.allocatedByCurrency.USDT;
  if (inr !== '0') parts.push(`₹${minorToMajor(inr, 2)}`);
  if (usdt !== '0') parts.push(`${minorToMajor(usdt, 8)} USDT`);
  return parts.length === 0 ? 'none allocated' : parts.join(' + ');
}

function minorToMajor(minor: string, scale: number): string {
  if (scale === 0) return minor;
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}
