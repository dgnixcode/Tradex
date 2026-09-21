import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveTicker } from '../hooks/useLiveTicker.ts';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { DEFAULT_GROUP_NAME, fetchAccountList, fetchAssets, fetchGroups, fetchKillSwitchStatus, fetchMarketPrice, previewTrade, syncAccount } from '../api.ts';
import type { AccountListItem, GroupSummary, PlanRequest } from '../api.ts';
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

interface TradeProtectionModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly asset: string;
  readonly quoteCurrency: string;
  readonly side: Side;
  readonly orderType: OrderType;
  readonly slTpRefPrice: string;
  readonly slTpRefNum: number;
  readonly hasRef: boolean;
  readonly slTpMode: SlTpMode;
  readonly setSlTpMode: (mode: SlTpMode) => void;
  readonly enableSl: boolean;
  readonly setEnableSl: (e: boolean) => void;
  readonly enableTp: boolean;
  readonly setEnableTp: (e: boolean) => void;
  readonly stopLossPrice: string;
  readonly setStopLossPrice: (p: string) => void;
  readonly takeProfitPrice: string;
  readonly setTakeProfitPrice: (p: string) => void;
  readonly slPercent: string;
  readonly setSlPercent: (p: string) => void;
  readonly tpPercent: string;
  readonly setTpPercent: (p: string) => void;
  readonly trailingStopLoss: boolean;
  readonly setTrailingStopLoss: (t: boolean) => void;
  readonly trailingDistancePercent: string;
  readonly setTrailingDistancePercent: (d: string) => void;
  readonly trailingStepPercent: string;
  readonly setTrailingStepPercent: (s: string) => void;
  readonly onClearAll: () => void;
}

function TradeProtectionModal({
  isOpen,
  onClose,
  asset,
  quoteCurrency,
  side,
  orderType,
  slTpRefPrice,
  slTpRefNum,
  hasRef,
  slTpMode,
  setSlTpMode,
  enableSl,
  setEnableSl,
  enableTp,
  setEnableTp,
  stopLossPrice,
  setStopLossPrice,
  takeProfitPrice,
  setTakeProfitPrice,
  slPercent,
  setSlPercent,
  tpPercent,
  setTpPercent,
  trailingStopLoss,
  setTrailingStopLoss,
  trailingDistancePercent,
  setTrailingDistancePercent,
  trailingStepPercent,
  setTrailingStepPercent,
  onClearAll,
}: TradeProtectionModalProps) {
  if (!isOpen) return null;

  const currentPreset = (enableSl && enableTp)
    ? 'both'
    : (!enableSl && enableTp)
      ? 'tp_only'
      : (enableSl && !enableTp)
        ? 'sl_only'
        : 'none';

  const selectPreset = (preset: 'both' | 'tp_only' | 'sl_only' | 'none') => {
    if (preset === 'both') {
      setEnableSl(true);
      setEnableTp(true);
      if (slTpMode === 'percent') {
        if (!slPercent || Number(slPercent) <= 0) setSlPercent('5');
        if (!tpPercent || Number(tpPercent) <= 0) setTpPercent('10');
      }
    } else if (preset === 'tp_only') {
      setEnableSl(false);
      setEnableTp(true);
      setStopLossPrice('');
      setSlPercent('');
      setTrailingStopLoss(false);
      if (slTpMode === 'percent' && (!tpPercent || Number(tpPercent) <= 0)) {
        setTpPercent('10');
      }
    } else if (preset === 'sl_only') {
      setEnableSl(true);
      setEnableTp(false);
      setTakeProfitPrice('');
      setTpPercent('');
      if (slTpMode === 'percent' && (!slPercent || Number(slPercent) <= 0)) {
        setSlPercent('5');
      }
    } else {
      setEnableSl(false);
      setEnableTp(false);
      onClearAll();
    }
  };

  return (
    <div className="position-modal-overlay" onClick={onClose}>
      <div
        className="position-modal"
        style={{ maxWidth: 470, width: '100%', background: '#0e1015' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="position-modal-header" style={{ padding: '14px 18px' }}>
          <div>
            <h3 className="position-modal-title" style={{ fontSize: 15, fontWeight: 700 }}>
              Take Profit &amp; Stop Loss
            </h3>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 2 }}>
              {asset}/{quoteCurrency} • <span style={{ color: side === 'buy' ? '#10b981' : '#ef4444', fontWeight: 600 }}>{side === 'buy' ? 'Long' : 'Short'}</span> • {orderType === 'limit' ? 'Limit' : 'Market'} • Ref Price: <strong style={{ color: '#ffffff' }}>{slTpRefPrice || '---'}</strong>
            </div>
          </div>
          <button type="button" className="position-modal-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="position-modal-body" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Quick presets bar */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Protection Strategy
            </span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4, background: '#08090c', border: '1px solid #1f232b', borderRadius: 6, padding: 3 }}>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={currentPreset === 'both'}
                style={{
                  padding: '4px 6px',
                  fontSize: 11,
                  fontWeight: currentPreset === 'both' ? 700 : 500,
                  background: currentPreset === 'both' ? '#ffffff' : 'transparent',
                  color: currentPreset === 'both' ? '#000000' : '#9ca3af',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
                onClick={() => selectPreset('both')}
              >
                Both SL &amp; TP
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={currentPreset === 'tp_only'}
                style={{
                  padding: '4px 6px',
                  fontSize: 11,
                  fontWeight: currentPreset === 'tp_only' ? 700 : 500,
                  background: currentPreset === 'tp_only' ? '#10b981' : 'transparent',
                  color: currentPreset === 'tp_only' ? '#000000' : '#9ca3af',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
                onClick={() => selectPreset('tp_only')}
              >
                TP Only
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={currentPreset === 'sl_only'}
                style={{
                  padding: '4px 6px',
                  fontSize: 11,
                  fontWeight: currentPreset === 'sl_only' ? 700 : 500,
                  background: currentPreset === 'sl_only' ? '#ef4444' : 'transparent',
                  color: currentPreset === 'sl_only' ? '#ffffff' : '#9ca3af',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
                onClick={() => selectPreset('sl_only')}
              >
                SL Only
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={currentPreset === 'none'}
                style={{
                  padding: '4px 6px',
                  fontSize: 11,
                  fontWeight: currentPreset === 'none' ? 700 : 500,
                  background: currentPreset === 'none' ? '#2a2e39' : 'transparent',
                  color: currentPreset === 'none' ? '#ffffff' : '#6b7280',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                  textAlign: 'center',
                }}
                onClick={() => selectPreset('none')}
              >
                Clear All
              </button>
            </div>
          </div>

          {/* Mode toggle */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 2 }}>
            <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)' }}>Input Mode</span>
            <div style={{ display: 'flex', background: '#08090c', border: '1px solid #1f232b', borderRadius: 6, padding: 2, gap: 2 }}>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={slTpMode === 'percent'}
                style={{
                  padding: '3px 12px',
                  fontSize: 11.5,
                  fontWeight: slTpMode === 'percent' ? 700 : 500,
                  background: slTpMode === 'percent' ? '#ffffff' : 'transparent',
                  color: slTpMode === 'percent' ? '#000000' : '#9ca3af',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
                onClick={() => setSlTpMode('percent')}
              >
                Percentage (%)
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={slTpMode === 'price'}
                style={{
                  padding: '3px 12px',
                  fontSize: 11.5,
                  fontWeight: slTpMode === 'price' ? 700 : 500,
                  background: slTpMode === 'price' ? '#ffffff' : 'transparent',
                  color: slTpMode === 'price' ? '#000000' : '#9ca3af',
                  border: 'none',
                  borderRadius: 4,
                  cursor: 'pointer',
                }}
                onClick={() => setSlTpMode('price')}
              >
                Price
              </button>
            </div>
          </div>

          {/* Stop Loss Card */}
          <div style={{
            background: '#12141a',
            border: `1px solid ${enableSl ? 'rgba(239, 68, 68, 0.3)' : '#1f232b'}`,
            borderRadius: 8,
            padding: 12,
            opacity: enableSl ? 1 : 0.6,
            transition: 'opacity 0.15s ease',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={enableSl}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setEnableSl(checked);
                    if (checked && slTpMode === 'percent' && (!slPercent || Number(slPercent) <= 0)) {
                      setSlPercent('5');
                    }
                  }}
                  style={{ width: 14, height: 14, cursor: 'pointer' }}
                />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: enableSl ? '#f87171' : 'var(--muted)' }}>Stop Loss</span>
                <span style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: enableSl ? 'rgba(239, 68, 68, 0.15)' : '#1f232b',
                  color: enableSl ? '#f87171' : '#6b7280',
                  border: `1px solid ${enableSl ? 'rgba(239, 68, 68, 0.3)' : '#2a2e39'}`,
                  textTransform: 'uppercase',
                }}>
                  {enableSl ? 'Active' : 'Disabled'}
                </span>
              </label>

              {enableSl && (
                <select
                  value={trailingStopLoss ? 'trailing' : 'fixed'}
                  onChange={(e) => setTrailingStopLoss(e.target.value === 'trailing')}
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, background: '#08090c', border: '1px solid #222631' }}
                >
                  <option value="fixed">Fixed SL</option>
                  <option value="trailing">Trailing SL</option>
                </select>
              )}
            </div>

            {!enableSl ? (
              <div style={{ fontSize: 11.5, color: '#6b7280', padding: '6px 0', fontStyle: 'italic' }}>
                Stop Loss is disabled. No stop-loss order will be placed. Check the box above to enable.
              </div>
            ) : trailingStopLoss ? (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 4 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Distance (%)</div>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={trailingDistancePercent}
                    onChange={(e) => setTrailingDistancePercent(e.target.value)}
                    placeholder="5"
                    style={{ width: '100%', padding: '6px 10px', fontSize: 12 }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>Step (%)</div>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={trailingStepPercent}
                    onChange={(e) => setTrailingStepPercent(e.target.value)}
                    placeholder="1"
                    style={{ width: '100%', padding: '6px 10px', fontSize: 12 }}
                  />
                </div>
              </div>
            ) : slTpMode === 'price' ? (
              <div>
                <input
                  id="modal-sl-price"
                  inputMode="decimal"
                  value={stopLossPrice}
                  placeholder="Trigger Price, e.g. 80000"
                  onChange={(e) => {
                    const v = e.target.value;
                    setStopLossPrice(v);
                  }}
                  style={{ width: '100%', padding: '6px 10px', fontSize: 12 }}
                />
                {stopLossPrice !== '' && Number(stopLossPrice) <= 0 && (
                  <div style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>
                    Trigger price must be greater than 0.
                  </div>
                )}
                {stopLossPrice !== '' && Number(stopLossPrice) > 0 && hasRef && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    ≈ {priceToPercent(slTpRefNum, Number(stopLossPrice), side, 'sl').toFixed(2)}% from entry
                  </div>
                )}
              </div>
            ) : (
              <div>
                <input
                  id="modal-sl-pct"
                  inputMode="decimal"
                  value={slPercent}
                  placeholder="Distance %, e.g. 5"
                  disabled={!hasRef}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./, '$1');
                    if (v === '' || Number(v) <= 100) setSlPercent(v);
                  }}
                  style={{ width: '100%', padding: '6px 10px', fontSize: 12 }}
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
                          flex: 1,
                          padding: '3px 0',
                          fontSize: 11,
                          fontWeight: active ? 700 : 500,
                          background: active ? '#ffffff' : '#08090c',
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
                {slPercent !== '' && Number(slPercent) <= 0 && (
                  <div style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>
                    Distance % must be greater than 0%. Entering 0% would cause an immediate stop-out.
                  </div>
                )}
                {hasRef && slPercent !== '' && Number(slPercent) > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    ≈ {percentToPrice(slTpRefNum, Number(slPercent), side, 'sl').toFixed(2)} trigger price
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Take Profit Card */}
          <div style={{
            background: '#12141a',
            border: `1px solid ${enableTp ? 'rgba(52, 211, 153, 0.3)' : '#1f232b'}`,
            borderRadius: 8,
            padding: 12,
            opacity: enableTp ? 1 : 0.6,
            transition: 'opacity 0.15s ease',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={enableTp}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setEnableTp(checked);
                    if (checked && slTpMode === 'percent' && (!tpPercent || Number(tpPercent) <= 0)) {
                      setTpPercent('10');
                    }
                  }}
                  style={{ width: 14, height: 14, cursor: 'pointer' }}
                />
                <span style={{ fontSize: 12.5, fontWeight: 700, color: enableTp ? '#34d399' : 'var(--muted)' }}>Take Profit</span>
                <span style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: enableTp ? 'rgba(52, 211, 153, 0.15)' : '#1f232b',
                  color: enableTp ? '#34d399' : '#6b7280',
                  border: `1px solid ${enableTp ? 'rgba(52, 211, 153, 0.3)' : '#2a2e39'}`,
                  textTransform: 'uppercase',
                }}>
                  {enableTp ? 'Active' : 'Disabled'}
                </span>
              </label>
            </div>

            {!enableTp ? (
              <div style={{ fontSize: 11.5, color: '#6b7280', padding: '6px 0', fontStyle: 'italic' }}>
                Take Profit is disabled. No take-profit order will be placed. Check the box above to enable.
              </div>
            ) : slTpMode === 'price' ? (
              <div>
                <input
                  id="modal-tp-price"
                  inputMode="decimal"
                  value={takeProfitPrice}
                  placeholder="Target Price, e.g. 92000"
                  onChange={(e) => {
                    const v = e.target.value;
                    setTakeProfitPrice(v);
                  }}
                  style={{ width: '100%', padding: '6px 10px', fontSize: 12 }}
                />
                {takeProfitPrice !== '' && Number(takeProfitPrice) <= 0 && (
                  <div style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>
                    Target price must be greater than 0.
                  </div>
                )}
                {takeProfitPrice !== '' && Number(takeProfitPrice) > 0 && hasRef && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    ≈ {priceToPercent(slTpRefNum, Number(takeProfitPrice), side, 'tp').toFixed(2)}% from entry
                  </div>
                )}
              </div>
            ) : (
              <div>
                <input
                  id="modal-tp-pct"
                  inputMode="decimal"
                  value={tpPercent}
                  placeholder="Target %, e.g. 10"
                  disabled={!hasRef}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./, '$1');
                    if (v === '' || Number(v) <= 100) setTpPercent(v);
                  }}
                  style={{ width: '100%', padding: '6px 10px', fontSize: 12 }}
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
                          flex: 1,
                          padding: '3px 0',
                          fontSize: 11,
                          fontWeight: active ? 700 : 500,
                          background: active ? '#ffffff' : '#08090c',
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
                {tpPercent !== '' && Number(tpPercent) <= 0 && (
                  <div style={{ fontSize: 11, color: '#f87171', marginTop: 4 }}>
                    Target % must be greater than 0%.
                  </div>
                )}
                {hasRef && tpPercent !== '' && Number(tpPercent) > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
                    ≈ {percentToPrice(slTpRefNum, Number(tpPercent), side, 'tp').toFixed(2)} trigger price
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Footer actions */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
            <button
              type="button"
              className="btn secondary btn-sm"
              onClick={onClearAll}
              style={{ padding: '6px 14px', fontSize: 12 }}
            >
              Clear All
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={onClose}
              style={{
                padding: '6px 20px',
                fontSize: 12,
                fontWeight: 700,
                background: '#ffffff',
                color: '#000000',
                borderRadius: 6,
              }}
            >
              Save Protection
            </button>
          </div>
        </div>
      </div>
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
  const accounts = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccountList,
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

  const [targetType, setTargetType] = useState<'group' | 'account'>(() => draft.targetType || 'group');
  const [groupId, setGroupId] = useState<string>(() => draft.groupId || '');
  const [accountId, setAccountId] = useState<string>(() => draft.accountId || '');
  const [accountSearch, setAccountSearch] = useState<string>('');
  const [isAccountPickerOpen, setIsAccountPickerOpen] = useState<boolean>(false);
  const [highlightedAccountIndex, setHighlightedAccountIndex] = useState<number>(0);
  const accountPickerRef = useRef<HTMLDivElement>(null);
  const accountSearchInputRef = useRef<HTMLInputElement>(null);
  const [isSyncingAccount, setIsSyncingAccount] = useState<boolean>(false);
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
  const [enableSl, setEnableSl] = useState<boolean>(() => {
    if (typeof draft.enableSl === 'boolean') return draft.enableSl;
    return Boolean(draft.stopLossPrice || draft.slPercent || draft.trailingStopLoss);
  });
  const [enableTp, setEnableTp] = useState<boolean>(() => {
    if (typeof draft.enableTp === 'boolean') return draft.enableTp;
    return Boolean(draft.takeProfitPrice || draft.tpPercent);
  });
  const [stopLossPrice, setStopLossPrice] = useState<string>(() => draft.stopLossPrice || '');
  const [takeProfitPrice, setTakeProfitPrice] = useState<string>(() => draft.takeProfitPrice || '');
  const [trailingStopLoss, setTrailingStopLoss] = useState<boolean>(() => draft.trailingStopLoss ?? false);

  const killSwitchQuery = useQuery({
    queryKey: ['kill-switch'],
    queryFn: fetchKillSwitchStatus,
    refetchInterval: 3000,
  });
  const isHalted = Boolean(killSwitchQuery.data?.active);
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
  const [showProtectionModal, setShowProtectionModal] = useState(false);

  const clearAllProtection = (): void => {
    setEnableSl(false);
    setEnableTp(false);
    setStopLossPrice('');
    setTakeProfitPrice('');
    setSlPercent('');
    setTpPercent('');
    setTrailingStopLoss(false);
  };

  // Persist all ticket inputs to localStorage so going to preview and returning pre-fills everything
  useEffect(() => {
    try {
      localStorage.setItem('tradex_ticket_draft', JSON.stringify({
        targetType,
        groupId,
        accountId,
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
        enableSl,
        enableTp,
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
    targetType,
    groupId,
    accountId,
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
    enableSl,
    enableTp,
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

  const activeAccounts = useMemo(() => {
    return accounts.data?.filter((a) => a.status === 'active') ?? [];
  }, [accounts.data]);

  const filteredAccounts = useMemo(() => {
    if (!accountSearch.trim()) return activeAccounts;
    const q = accountSearch.toLowerCase().trim();
    return activeAccounts.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        `#${a.serialNo}`.includes(q) ||
        String(a.serialNo).includes(q) ||
        (a.groupName && a.groupName.toLowerCase().includes(q)),
    );
  }, [activeAccounts, accountSearch]);

  const selectedAccount: AccountListItem | undefined = useMemo(
    () => activeAccounts.find((a) => a.id === accountId),
    [activeAccounts, accountId],
  );

  const handleSelectAccount = (id: string): void => {
    setAccountId(id);
    setIsAccountPickerOpen(false);
    setAccountSearch('');
    // Immediately sync the selected account's fresh balance from CoinDCX
    setIsSyncingAccount(true);
    syncAccount(id)
      .then(() => {
        void accounts.refetch();
        void groups.refetch();
      })
      .catch((err) => {
        console.warn('account balance sync on selection encountered error:', err);
      })
      .finally(() => {
        setIsSyncingAccount(false);
      });
  };

  // Auto-select first active account if in account mode and no account selected
  useEffect(() => {
    if (targetType === 'account' && activeAccounts.length > 0) {
      if (!accountId || !activeAccounts.some((a) => a.id === accountId)) {
        setAccountId(activeAccounts[0].id);
      }
    }
  }, [targetType, activeAccounts, accountId]);

  // Close account picker when clicking outside
  useEffect(() => {
    if (!isAccountPickerOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (accountPickerRef.current && !accountPickerRef.current.contains(e.target as Node)) {
        setIsAccountPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isAccountPickerOpen]);

  // Focus search input when account picker opens
  useEffect(() => {
    if (isAccountPickerOpen) {
      const timer = setTimeout(() => {
        accountSearchInputRef.current?.focus();
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [isAccountPickerOpen]);

  // Reset highlighted index when search query changes
  useEffect(() => {
    setHighlightedAccountIndex(0);
  }, [accountSearch]);

  const selectedGroup: GroupSummary | undefined = useMemo(
    () => groups.data?.find((g) => g.id === groupId),
    [groups.data, groupId],
  );

  const availableCapitalMinor = useMemo(() => {
    if (targetType === 'account') {
      if (!selectedAccount) return '0';
      return (
        selectedAccount.balancesByCurrency?.[marginCurrency] ??
        (selectedAccount.allocatedCurrency === marginCurrency ? (selectedAccount.allocatedCapitalMinor || '0') : '0')
      );
    }
    return selectedGroup?.allocatedByCurrency[marginCurrency] ?? '0';
  }, [targetType, selectedAccount, selectedGroup, marginCurrency]);

  const formattedAvailableCapital = useMemo(() => {
    if (targetType === 'group' && !selectedGroup) return null;
    if (targetType === 'account' && !selectedAccount) return null;
    const scale = marginCurrency === 'INR' ? 2 : 8;
    const major = Number(minorToMajor(availableCapitalMinor, scale));
    return marginCurrency === 'INR'
      ? `₹${major.toLocaleString('en-IN')}`
      : `${major.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} USDT`;
  }, [targetType, selectedGroup, selectedAccount, availableCapitalMinor, marginCurrency]);

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
    onSuccess: (result) => {
      void accounts.refetch();
      void groups.refetch();
      navigate(`/app/trades/${result.groupTradeId}`);
    },
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
    const hasTarget = targetType === 'account' ? Boolean(selectedAccount) : Boolean(selectedGroup);
    if (!hasTarget || !percentValid || !leverageValid || sizingRefPrice === '') return;
    if (availableCapitalMinor === '0') return;

    const scale = marginCurrency === 'INR' ? 2 : 8;
    const allocatedMajor = Number(availableCapitalMinor) / Math.pow(10, scale);
    let margin = allocatedMajor * (Number(percent) / 100);
    if (quoteCurrency === 'USDT' && marginCurrency === 'INR' && usdtInrRate) {
      margin = margin / usdtInrRate;
    }
    const notional = margin * Number(leverage);
    const qty = notional / Number(sizingRefPrice);
    setQuantity(qty.toFixed(8).replace(/\.?0+$/, ''));
  };

  const convertQuantityToPercent = (): void => {
    const hasTarget = targetType === 'account' ? Boolean(selectedAccount) : Boolean(selectedGroup);
    if (!hasTarget || !leverageValid || sizingRefPrice === '' || quantity === '') return;
    if (availableCapitalMinor === '0') return;

    const scale = marginCurrency === 'INR' ? 2 : 8;
    const allocatedMajor = Number(availableCapitalMinor) / Math.pow(10, scale);
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

  const accountCount = targetType === 'account'
    ? (selectedAccount ? 1 : 0)
    : (selectedGroup?.enabledCount ?? 0);
  const targetValid = targetType === 'account'
    ? (accountId !== '' && Boolean(selectedAccount))
    : (groupId !== '' && accountCount > 0);

  const leverageValid = /^\d+(\.\d+)?$/.test(leverage)
    && Number(leverage) >= 1 && Number(leverage) <= MAX_LEVERAGE;
  const percentValid = /^\d+(\.\d+)?$/.test(percent) && Number(percent) > 0 && Number(percent) <= 100;
  const quantityValid = /^\d+(\.\d+)?$/.test(quantity) && Number(quantity) > 0;
  const priceOk = (p: string): boolean => p === '' || (/^\d+(\.\d+)?$/.test(p) && Number(p) > 0);

  // The reference price for SL/TP percentage calculation:
  // limit orders use the limit price, market orders use the last-fetched market price.
  const slTpRefPrice: string = orderType === 'limit' ? limitPrice : marketRefPrice;
  const slTpRefNum = Number(slTpRefPrice);
  const hasRef = slTpRefPrice !== '' && Number.isFinite(slTpRefNum) && slTpRefNum > 0;

  // Validate a SL/TP percent string: 0 < pct <= 100, decimal format.
  const pctOk = (p: string): boolean => p === '' || (/^\d+(\.\d+)?$/.test(p) && Number(p) > 0 && Number(p) <= 100);

  // Compute the effective absolute SL/TP prices (for validation + submission).
  const effectiveSlPrice: string = enableSl
    ? (slTpMode === 'percent' && slPercent !== '' && Number(slPercent) > 0 && hasRef
        ? percentToPrice(slTpRefNum, Number(slPercent), side, 'sl').toFixed(8).replace(/\.?0+$/, '')
        : (stopLossPrice !== '' && Number(stopLossPrice) > 0 ? stopLossPrice : ''))
    : '';
  const effectiveTpPrice: string = enableTp
    ? (slTpMode === 'percent' && tpPercent !== '' && Number(tpPercent) > 0 && hasRef
        ? percentToPrice(slTpRefNum, Number(tpPercent), side, 'tp').toFixed(8).replace(/\.?0+$/, '')
        : (takeProfitPrice !== '' && Number(takeProfitPrice) > 0 ? takeProfitPrice : ''))
    : '';

  const sizeValid = sizingMode === 'percent' ? percentValid : quantityValid;

  const slValid = !enableSl || (
    trailingStopLoss
      ? (/^\d+(\.\d+)?$/.test(trailingDistancePercent) && Number(trailingDistancePercent) > 0)
      : (slTpMode === 'price' ? (stopLossPrice !== '' && priceOk(stopLossPrice)) : (slPercent !== '' && pctOk(slPercent)))
  );
  const tpValid = !enableTp || (
    slTpMode === 'price' ? (takeProfitPrice !== '' && priceOk(takeProfitPrice)) : (tpPercent !== '' && pctOk(tpPercent))
  );

  const canPreview =
    !isHalted
    && targetValid && asset !== ''
    && leverageValid && sizeValid
    && (orderType !== 'limit' || (limitPrice !== '' && priceOk(limitPrice)))
    && slValid && tpValid;

  const defaultGroup = useMemo(() => {
    return groups.data?.find((g) => g.name === DEFAULT_GROUP_NAME) || groups.data?.[0];
  }, [groups.data]);

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

    const effectiveGroupId = targetType === 'account'
      ? (selectedAccount?.groupId || groupId || defaultGroup?.id || '')
      : groupId;

    const req: PlanRequest = {
      groupId: effectiveGroupId,
      ...(targetType === 'account' && selectedAccount ? {
        accountId: selectedAccount.id,
        accountIds: [selectedAccount.id],
      } : {}),
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
      ...(enableSl && effectiveSlPrice !== '' ? { stopLossPrice: effectiveSlPrice } : {}),
      ...(enableTp && effectiveTpPrice !== '' ? { takeProfitPrice: effectiveTpPrice } : {}),
      ...(enableSl && trailingStopLoss ? { 
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
            {isHalted && (
              <div
                style={{
                  backgroundColor: 'rgba(239, 68, 68, 0.12)',
                  border: '1px solid var(--danger)',
                  borderRadius: 6,
                  padding: '10px 14px',
                  marginBottom: 14,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12.5,
                  color: 'var(--danger)',
                  fontWeight: 600,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--danger)', display: 'inline-block' }} />
                <span>EMERGENCY KILL SWITCH ACTIVE: Order placement is locked across all groups (Read-Only Mode).</span>
              </div>
            )}
      {/* Target Mode Segmented Switch: Group Trade vs Single Account */}
      <div style={{ marginBottom: 12 }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          background: '#0e1014',
          border: '1px solid #1f232b',
          borderRadius: 8,
          padding: 3,
          gap: 4,
        }}>
          <button
            type="button"
            className="btn ghost btn-sm"
            onClick={() => setTargetType('group')}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: targetType === 'group' ? 700 : 500,
              background: targetType === 'group' ? '#1f242f' : 'transparent',
              color: targetType === 'group' ? '#ffffff' : '#9ca3af',
              border: targetType === 'group' ? '1px solid #374151' : '1px solid transparent',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            <span>Group Trade</span>
            <span style={{
              fontSize: 10.5,
              padding: '1px 6px',
              borderRadius: 10,
              background: targetType === 'group' ? '#374151' : '#14171f',
              color: targetType === 'group' ? '#f3f4f6' : '#6b7280',
            }}>
              {groups.data?.length ?? 0}
            </span>
          </button>
          <button
            type="button"
            className="btn ghost btn-sm"
            onClick={() => setTargetType('account')}
            style={{
              padding: '6px 12px',
              fontSize: 12,
              fontWeight: targetType === 'account' ? 700 : 500,
              background: targetType === 'account' ? '#1f242f' : 'transparent',
              color: targetType === 'account' ? '#ffffff' : '#9ca3af',
              border: targetType === 'account' ? '1px solid #374151' : '1px solid transparent',
              borderRadius: 6,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              cursor: 'pointer',
              transition: 'all 0.15s ease',
            }}
          >
            <span>Single Account</span>
            <span style={{
              fontSize: 10.5,
              padding: '1px 6px',
              borderRadius: 10,
              background: targetType === 'account' ? '#374151' : '#14171f',
              color: targetType === 'account' ? '#f3f4f6' : '#6b7280',
            }}>
              {activeAccounts.length}
            </span>
          </button>
        </div>
      </div>

      {targetType === 'group' ? (
        <div className="field">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <label htmlFor="group" style={{ margin: 0 }}>Target Group</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>Funding:</span>
              <button
                type="button"
                className="btn ghost btn-sm"
                style={{
                  padding: '1px 5px',
                  height: 20,
                  minHeight: 'unset',
                  fontSize: 11,
                  cursor: 'pointer',
                  opacity: groups.isFetching || accounts.isFetching ? 0.5 : 0.8,
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
                onClick={() => {
                  void groups.refetch();
                  void accounts.refetch();
                }}
                disabled={groups.isFetching || accounts.isFetching}
                title="Refresh balances from database"
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: groups.isFetching || accounts.isFetching ? 'spin 1s linear infinite' : 'none' }}>
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
          {selectedGroup && formattedAvailableCapital && (
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: 4,
              fontSize: 11,
              color: '#9ca3af',
            }}>
              <span>Group Available Capital:</span>
              <span style={{ fontWeight: 600, color: '#f3f4f6' }}>{formattedAvailableCapital}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="field">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <label htmlFor="account" style={{ margin: 0 }}>Target Account</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>Funding:</span>
              <button
                type="button"
                className="btn ghost btn-sm"
                style={{
                  padding: '1px 5px',
                  height: 20,
                  minHeight: 'unset',
                  fontSize: 11,
                  cursor: 'pointer',
                  opacity: groups.isFetching || accounts.isFetching ? 0.5 : 0.8,
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
                onClick={() => {
                  void groups.refetch();
                  void accounts.refetch();
                }}
                disabled={groups.isFetching || accounts.isFetching}
                title="Refresh balances from database"
              >
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: groups.isFetching || accounts.isFetching ? 'spin 1s linear infinite' : 'none' }}>
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

          {/* Searchable Account Selector Combobox */}
          <div ref={accountPickerRef} style={{ position: 'relative' }}>
            <button
              type="button"
              id="account-selector-btn"
              onClick={() => setIsAccountPickerOpen((prev) => !prev)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '9px 12px',
                background: '#0e1218',
                border: isAccountPickerOpen ? '1px solid #3b82f6' : '1px solid #1f242b',
                borderRadius: 7,
                color: '#f3f4f6',
                cursor: 'pointer',
                fontSize: 12.5,
                textAlign: 'left',
                transition: 'border-color 0.15s ease, background-color 0.15s ease',
              }}
            >
              {selectedAccount ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, overflow: 'hidden', minWidth: 0 }}>
                  <span style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    backgroundColor: 'var(--success, #22c55e)',
                    flexShrink: 0,
                  }} />
                  <span style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    color: '#93c5fd',
                    background: '#1e293b',
                    padding: '1px 5px',
                    borderRadius: 4,
                    border: '1px solid #334155',
                    flexShrink: 0,
                  }}>
                    #{selectedAccount.serialNo}
                  </span>
                  <span style={{ fontWeight: 600, color: '#f3f4f6', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                    {selectedAccount.name}
                  </span>
                  <span style={{
                    fontSize: 10,
                    padding: '1px 5px',
                    borderRadius: 4,
                    background: '#181b22',
                    color: '#9ca3af',
                    border: '1px solid #282d37',
                    flexShrink: 0,
                  }}>
                    {selectedAccount.groupName || 'Default'}
                  </span>
                </div>
              ) : (
                <span style={{ color: '#6b7280' }}>Select an account…</span>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, marginLeft: 8 }}>
                {selectedAccount && formattedAvailableCapital && (
                  <span style={{ fontSize: 11.5, fontWeight: 700, color: '#34d399' }}>
                    {formattedAvailableCapital}
                  </span>
                )}
                <svg
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  width="14"
                  height="14"
                  style={{
                    color: '#9ca3af',
                    transform: isAccountPickerOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                    transition: 'transform 0.15s ease',
                  }}
                >
                  <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
              </div>
            </button>

            {/* Dropdown Panel */}
            {isAccountPickerOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  right: 0,
                  background: '#0d1117',
                  border: '1px solid #282f3c',
                  borderRadius: 8,
                  boxShadow: '0 12px 30px rgba(0,0,0,0.7)',
                  zIndex: 100,
                  overflow: 'hidden',
                }}
              >
                {/* Search Bar */}
                <div style={{ padding: '8px 10px', borderBottom: '1px solid #1c222d', background: '#0a0d12' }}>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <svg
                      viewBox="0 0 24 24"
                      width="13"
                      height="13"
                      fill="none"
                      stroke="#6b7280"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ position: 'absolute', left: 9, pointerEvents: 'none' }}
                    >
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      ref={accountSearchInputRef}
                      type="text"
                      placeholder="Search accounts by name, #serial, or group…"
                      value={accountSearch}
                      onChange={(e) => {
                        setAccountSearch(e.target.value);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          setIsAccountPickerOpen(false);
                        } else if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setHighlightedAccountIndex((prev) => Math.min(prev + 1, Math.max(0, filteredAccounts.length - 1)));
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setHighlightedAccountIndex((prev) => Math.max(prev - 1, 0));
                        } else if (e.key === 'Enter') {
                          e.preventDefault();
                          const target = filteredAccounts[highlightedAccountIndex] || filteredAccounts[0];
                          if (target) {
                            handleSelectAccount(target.id);
                          }
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '6px 28px 6px 28px',
                        fontSize: 12,
                        background: '#12161f',
                        border: '1px solid #232a37',
                        borderRadius: 6,
                        color: '#f3f4f6',
                        outline: 'none',
                      }}
                    />
                    {accountSearch && (
                      <button
                        type="button"
                        onClick={() => setAccountSearch('')}
                        style={{
                          position: 'absolute',
                          right: 8,
                          background: 'transparent',
                          border: 'none',
                          color: '#9ca3af',
                          cursor: 'pointer',
                          padding: '2px 4px',
                          fontSize: 12,
                          lineHeight: 1,
                        }}
                        title="Clear search"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginTop: 5,
                    fontSize: 10.5,
                    color: '#6b7280',
                    padding: '0 2px',
                  }}>
                    <span>
                      {accountSearch.trim()
                        ? `Found ${filteredAccounts.length} of ${activeAccounts.length} accounts`
                        : `${activeAccounts.length} active account${activeAccounts.length === 1 ? '' : 's'}`}
                    </span>
                    <span style={{ fontSize: 10 }}>Enter to select</span>
                  </div>
                </div>

                {/* Accounts List */}
                <div style={{ maxHeight: 220, overflowY: 'auto' }}>
                  {filteredAccounts.length === 0 ? (
                    <div style={{ padding: '16px 12px', textAlign: 'center', color: '#9ca3af', fontSize: 12 }}>
                      <div>No active accounts match &quot;{accountSearch}&quot;</div>
                      {accountSearch && (
                        <button
                          type="button"
                          className="btn ghost btn-sm"
                          onClick={() => setAccountSearch('')}
                          style={{ marginTop: 6, fontSize: 11, padding: '2px 8px' }}
                        >
                          Clear search
                        </button>
                      )}
                    </div>
                  ) : (
                    filteredAccounts.map((a, idx) => {
                      const isSelected = a.id === accountId;
                      const isHighlighted = idx === highlightedAccountIndex;
                      const balMinor = a.balancesByCurrency?.[marginCurrency] ??
                        (a.allocatedCurrency === marginCurrency ? (a.allocatedCapitalMinor || '0') : '0');
                      const scale = marginCurrency === 'INR' ? 2 : 8;
                      const major = Number(minorToMajor(balMinor, scale));
                      const balDisplay = marginCurrency === 'INR'
                        ? `₹${major.toLocaleString('en-IN')}`
                        : `${major.toFixed(2)} USDT`;

                      return (
                        <div
                          key={a.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => handleSelectAccount(a.id)}
                          onMouseEnter={() => setHighlightedAccountIndex(idx)}
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            padding: '8px 12px',
                            background: isSelected
                              ? '#162235'
                              : isHighlighted
                              ? '#141822'
                              : 'transparent',
                            borderLeft: isSelected ? '3px solid #3b82f6' : '3px solid transparent',
                            cursor: 'pointer',
                            borderBottom: '1px solid #141822',
                            transition: 'background 0.1s ease',
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            <span style={{
                              fontSize: 10,
                              fontWeight: 700,
                              color: isSelected ? '#93c5fd' : '#9ca3af',
                              background: isSelected ? '#1e293b' : '#14171f',
                              padding: '2px 5px',
                              borderRadius: 4,
                              border: '1px solid #282d37',
                              flexShrink: 0,
                            }}>
                              #{a.serialNo}
                            </span>
                            <div style={{ minWidth: 0 }}>
                              <div style={{
                                fontWeight: isSelected ? 700 : 500,
                                color: isSelected ? '#ffffff' : '#e5e7eb',
                                fontSize: 12,
                                whiteSpace: 'nowrap',
                                textOverflow: 'ellipsis',
                                overflow: 'hidden',
                              }}>
                                {a.name}
                              </div>
                              <div style={{ fontSize: 10, color: '#6b7280' }}>
                                {a.groupName || 'Default (All Accounts)'}
                              </div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'right', flexShrink: 0 }}>
                            <div>
                              <div style={{
                                fontSize: 11.5,
                                fontWeight: 600,
                                color: isSelected ? '#34d399' : '#d1d5db',
                              }}>
                                {balDisplay}
                              </div>
                              <div style={{ fontSize: 9.5, color: '#6b7280' }}>Free Capital</div>
                            </div>
                            {isSelected && (
                              <svg viewBox="0 0 20 20" fill="#3b82f6" width="15" height="15">
                                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                              </svg>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* Hidden native select for accessibility / form compatibility */}
            <select
              id="account"
              value={accountId}
              onChange={(e) => handleSelectAccount(e.target.value)}
              style={{ display: 'none' }}
              tabIndex={-1}
              aria-hidden="true"
            >
              {activeAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  #{a.serialNo} · {a.name}
                </option>
              ))}
            </select>
          </div>

          {selectedAccount && (
            <div style={{
              marginTop: 6,
              padding: '8px 10px',
              background: '#090a0d',
              border: '1px solid #1f232b',
              borderRadius: 6,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontSize: 11,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  backgroundColor: 'var(--success, #22c55e)',
                  display: 'inline-block',
                }} />
                <span style={{ fontWeight: 600, color: '#f3f4f6' }}>
                  #{selectedAccount.serialNo} {selectedAccount.name}
                </span>
                <span style={{
                  fontSize: 10,
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: '#181b22',
                  color: '#9ca3af',
                  border: '1px solid #282d37',
                }}>
                  {selectedAccount.groupName || 'Default (All Accounts)'}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {isSyncingAccount && (
                  <span style={{ fontSize: 10, color: '#38bdf8', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite' }}>
                      <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                    </svg>
                    Syncing…
                  </span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ color: '#9ca3af' }}>Free:</span>
                  <span style={{ fontWeight: 700, color: '#ffffff' }}>
                    {formattedAvailableCapital}
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

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
          padding: '5px 10px', borderRadius: 6, fontSize: 11.5,
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
            <span style={{ marginLeft: 'auto', fontSize: 10.5, color: '#6b7280' }}>
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
              style={{ whiteSpace: 'nowrap', padding: '0 10px', fontSize: 12 }}
              onClick={() => fetchAndSetPrice()}
              title="Fetch the current market price"
            >
              {fetchingPrice ? '⟳' : '↻'} Live price
            </button>
          </div>
        </div>
      )}

      {/* ── Leverage & Margin Mode Side-by-Side ── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
        {/* Leverage */}
        <div className="field" style={{ margin: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <label htmlFor="lev" style={{ margin: 0 }}>Leverage</label>
            <span style={{ fontSize: 10.5, color: 'var(--muted)' }}>Max {MAX_LEVERAGE}×</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className="btn secondary"
              aria-label="Decrease leverage"
              disabled={leverageAtMin}
              style={{ padding: '3px 8px', fontSize: 13, lineHeight: 1 }}
              onClick={() => bumpLeverage(-1)}
            >
              −
            </button>
            <input
              id="lev"
              inputMode="decimal"
              value={leverage}
              placeholder="5"
              style={{ flex: 1, minWidth: 0, textAlign: 'center', fontWeight: 600, padding: '4px 6px', fontSize: 13 }}
              onChange={(e) => setLeverage(e.target.value)}
            />
            <button
              type="button"
              className="btn secondary"
              aria-label="Increase leverage"
              disabled={leverageAtMax}
              style={{ padding: '3px 8px', fontSize: 13, lineHeight: 1 }}
              onClick={() => bumpLeverage(1)}
            >
              +
            </button>
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
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
                    padding: '2px 0',
                    fontSize: 10.5,
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

        {/* Margin mode */}
        <div className="field" style={{ margin: 0 }}>
          <label style={{ marginBottom: 4 }}>Margin mode</label>
          <div style={{ display: 'flex', gap: 4 }}>
            {[
              { value: 'isolated' as PositionMarginType, label: 'Isolated' },
              ...(marginCurrency === 'USDT' ? [{ value: 'crossed' as PositionMarginType, label: 'Crossed' }] : []),
            ].map((o) => {
              const active = effectiveMarginType === o.value;
              return (
                <button
                  key={o.value}
                  type="button"
                  aria-pressed={active}
                  className="btn"
                  style={{
                    flex: 1,
                    padding: '6px 8px',
                    fontSize: 12,
                    borderRadius: 6,
                    cursor: 'pointer',
                    background: active ? '#ffffff' : '#111318',
                    color: active ? '#000000' : '#9ca3af',
                    border: `1px solid ${active ? '#ffffff' : '#222631'}`,
                    fontWeight: active ? 700 : 500,
                  }}
                  onClick={() => setPositionMarginType(o.value)}
                >
                  {o.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Size Field (With Available Capital in Header) ── */}
      <div className="field">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <label htmlFor="size" style={{ margin: 0 }}>Size</label>
            <div style={{ display: 'flex', background: '#0e1014', border: '1px solid #1f232b', borderRadius: 4, padding: 2, gap: 2 }}>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={sizingMode === 'quantity'}
                style={{
                  padding: '1px 8px',
                  fontSize: 10.5,
                  fontWeight: sizingMode === 'quantity' ? 700 : 500,
                  background: sizingMode === 'quantity' ? '#ffffff' : 'transparent',
                  color: sizingMode === 'quantity' ? '#000000' : '#9ca3af',
                  border: 'none',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
                onClick={() => switchSizingMode('quantity')}
              >
                Qty
              </button>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={sizingMode === 'percent'}
                style={{
                  padding: '1px 8px',
                  fontSize: 10.5,
                  fontWeight: sizingMode === 'percent' ? 700 : 500,
                  background: sizingMode === 'percent' ? '#ffffff' : 'transparent',
                  color: sizingMode === 'percent' ? '#000000' : '#9ca3af',
                  border: 'none',
                  borderRadius: 3,
                  cursor: 'pointer',
                }}
                onClick={() => switchSizingMode('percent')}
              >
                %
              </button>
            </div>
          </div>
          {formattedAvailableCapital && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
              <span style={{ color: '#6b7280' }}>Avail:</span>
              <strong style={{ color: '#f3f4f6' }}>{formattedAvailableCapital}</strong>
            </div>
          )}
        </div>

        {sizingMode === 'percent' ? (
          <>
            <input
              id="size"
              inputMode="decimal"
              value={percent}
              placeholder="e.g. 20"
              onChange={(e) => handlePercentChange(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
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
                      padding: '2px 0',
                      fontSize: 10.5,
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
            {percentValid && leverageValid && (targetType === 'account' ? Boolean(selectedAccount) : Boolean(selectedGroup)) && (() => {
              const scale = marginCurrency === 'INR' ? 2 : 8;
              const allocatedMajor = Number(availableCapitalMinor) / Math.pow(10, scale);
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
                    marginTop: 6, padding: '6px 8px', borderRadius: 6,
                    background: '#0e1014', border: '1px solid #1f232b',
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 9.5, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Margin ({percent}%)</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#f3f4f6' }}>{fmtMargin}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 9.5, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Notional ({leverage}x)</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#f3f4f6' }}>{fmtNotional}</span>
                    </div>
                    {sizingRefPrice !== '' && Number(sizingRefPrice) > 0 && Number(leverage) > 0 && effectiveMarginType === 'isolated' && (() => {
                      const refP = Number(sizingRefPrice);
                      const lev = Number(leverage);
                      const liqP = side === 'buy'
                        ? refP * (1 - 1 / lev)
                        : refP * (1 + 1 / lev);
                      const fmtLiq = liqP > 0
                        ? liqP.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
                        : '0.00';
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: '1 / -1', borderTop: '1px solid #1f232b', paddingTop: 6, marginTop: 2 }}>
                          <span style={{ fontSize: 9.5, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Est. Liq. Price (Isolated)</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#f87171' }}>~{fmtLiq} {quoteCurrency}</span>
                        </div>
                      );
                    })()}
                  </div>
                  {notionalInUsdt > 0 && notionalInUsdt < 5 && (
                    <div style={{
                      marginTop: 4, padding: '4px 6px', borderRadius: 4,
                      background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)',
                      color: '#f87171', fontSize: 10.5, display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      <span>Order value (~{notionalInUsdt.toFixed(2)} USDT) is below the exchange minimum of 5 USDT.</span>
                    </div>
                  )}
                </>
              );
            })()}
          </>
        ) : (
          <>
            <input
              id="size"
              inputMode="decimal"
              value={quantity}
              placeholder={`e.g. 0.5 ${asset || 'BTC'}`}
              onChange={(e) => handleQuantityChange(e.target.value)}
            />
            {quantityValid && leverageValid && sizingRefPrice !== '' && (() => {
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
                    marginTop: 6, padding: '6px 8px', borderRadius: 6,
                    background: '#0e1014', border: '1px solid #1f232b',
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 9.5, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Notional</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#f3f4f6' }}>{fmtNotional}</span>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ fontSize: 9.5, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Est. Margin</span>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#f3f4f6' }}>{fmtMargin}</span>
                    </div>
                    {Number(sizingRefPrice) > 0 && Number(leverage) > 0 && effectiveMarginType === 'isolated' && (() => {
                      const refP = Number(sizingRefPrice);
                      const lev = Number(leverage);
                      const liqP = side === 'buy'
                        ? refP * (1 - 1 / lev)
                        : refP * (1 + 1 / lev);
                      const fmtLiq = liqP > 0
                        ? liqP.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
                        : '0.00';
                      return (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, gridColumn: '1 / -1', borderTop: '1px solid #1f232b', paddingTop: 6, marginTop: 2 }}>
                          <span style={{ fontSize: 9.5, fontWeight: 600, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Est. Liq. Price (Isolated)</span>
                          <span style={{ fontSize: 12, fontWeight: 700, color: '#f87171' }}>~{fmtLiq} {quoteCurrency}</span>
                        </div>
                      );
                    })()}
                  </div>
                  {notionalAmt > 0 && notionalAmt < 5 && (
                    <div style={{
                      marginTop: 4, padding: '4px 6px', borderRadius: 4,
                      background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.25)',
                      color: '#f87171', fontSize: 10.5, display: 'flex', alignItems: 'center', gap: 6,
                    }}>
                      <span>Order value (~{notionalAmt.toFixed(2)} USDT) is below the exchange minimum of 5 USDT.</span>
                    </div>
                  )}
                </>
              );
            })()}
          </>
        )}
      </div>

      {/* ── TP / SL Protection Modal Trigger ── */}
      <div className="field" style={{ marginTop: 2, marginBottom: 8 }}>
        {(() => {
          const hasSl = Boolean(enableSl && (trailingStopLoss || (slTpMode === 'percent' ? (slPercent !== '' && Number(slPercent) > 0) : (stopLossPrice !== '' && Number(stopLossPrice) > 0))));
          const hasTp = Boolean(enableTp && (slTpMode === 'percent' ? (tpPercent !== '' && Number(tpPercent) > 0) : (takeProfitPrice !== '' && Number(takeProfitPrice) > 0)));
          const hasProtection = hasSl || hasTp;

          if (!hasProtection) {
            return (
              <button
                type="button"
                className="btn secondary"
                onClick={() => setShowProtectionModal(true)}
                style={{
                  width: '100%',
                  padding: '8px 12px',
                  fontSize: 12,
                  fontWeight: 600,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  background: '#0e1014',
                  border: '1px dashed #2d3340',
                  borderRadius: 6,
                  color: '#9ca3af',
                  cursor: 'pointer',
                }}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  Take Profit &amp; Stop Loss
                </span>
                <span style={{ fontSize: 11, color: '#6b7280' }}>+ Set (Optional)</span>
              </button>
            );
          }

          return (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '7px 10px',
              background: hasSl && hasTp ? 'rgba(59, 130, 246, 0.08)' : hasTp ? 'rgba(16, 185, 129, 0.08)' : 'rgba(239, 68, 68, 0.08)',
              border: `1px solid ${hasSl && hasTp ? 'rgba(59, 130, 246, 0.25)' : hasTp ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)'}`,
              borderRadius: 6,
              fontSize: 11.5,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, color: hasSl && hasTp ? '#93c5fd' : hasTp ? '#6ee7b7' : '#fca5a5', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                  {hasSl && hasTp ? 'TP & SL:' : hasTp ? 'Take Profit Only:' : 'Stop Loss Only:'}
                </span>
                {trailingStopLoss ? (
                  <span style={{ color: '#f87171', fontWeight: 600 }}>TSL: {trailingDistancePercent}%</span>
                ) : (
                  hasSl && (
                    <span style={{ color: '#f87171', fontWeight: 600 }}>
                      SL: {slTpMode === 'percent' ? `${slPercent}% (≈ ${effectiveSlPrice})` : stopLossPrice}
                    </span>
                  )
                )}
                {hasTp && (
                  <span style={{ color: '#34d399', fontWeight: 600 }}>
                    TP: {slTpMode === 'percent' ? `${tpPercent}% (≈ ${effectiveTpPrice})` : takeProfitPrice}
                  </span>
                )}
                {!hasSl && hasTp && (
                  <span style={{ color: '#6b7280', fontSize: 10.5 }}>(No SL)</span>
                )}
                {hasSl && !hasTp && (
                  <span style={{ color: '#6b7280', fontSize: 10.5 }}>(No TP)</span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={() => setShowProtectionModal(true)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#ffffff',
                    fontSize: 11,
                    fontWeight: 600,
                    textDecoration: 'underline',
                    cursor: 'pointer',
                    padding: 0,
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={clearAllProtection}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#9ca3af',
                    fontSize: 11,
                    cursor: 'pointer',
                    padding: 0,
                  }}
                  title="Clear TP and SL"
                >
                  &times;
                </button>
              </div>
            </div>
          );
        })()}
      </div>

      {preview.isError && (
        <div className="error" style={{ marginBottom: 6 }}>{(preview.error as Error).message}</div>
      )}

      <button
        className="btn"
        disabled={!canPreview || preview.isPending}
        onClick={submitPreview}
        style={{
          width: '100%',
          padding: '10px',
          fontSize: 13.5,
          fontWeight: 700,
          background: '#ffffff',
          color: '#000000',
          border: '1px solid #ffffff',
          borderRadius: 6,
          cursor: !canPreview || preview.isPending ? 'not-allowed' : 'pointer',
          opacity: !canPreview || preview.isPending ? 0.5 : 1,
          marginTop: 4,
          boxShadow: '0 2px 10px rgba(255, 255, 255, 0.1)',
        }}
      >
        {isHalted
          ? 'Trading Halted (Kill Switch Active)'
          : preview.isPending
            ? 'Syncing balances & planning…'
            : targetType === 'account'
              ? `Preview Trade · #${selectedAccount?.serialNo ?? ''} ${selectedAccount?.name ?? 'Account'}`
              : `Preview ${accountCount} account${accountCount === 1 ? '' : 's'}`}
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

      <TradeProtectionModal
        isOpen={showProtectionModal}
        onClose={() => setShowProtectionModal(false)}
        asset={asset}
        quoteCurrency={quoteCurrency}
        side={side}
        orderType={orderType}
        slTpRefPrice={slTpRefPrice}
        slTpRefNum={slTpRefNum}
        hasRef={hasRef}
        slTpMode={slTpMode}
        setSlTpMode={setSlTpMode}
        enableSl={enableSl}
        setEnableSl={setEnableSl}
        enableTp={enableTp}
        setEnableTp={setEnableTp}
        stopLossPrice={stopLossPrice}
        setStopLossPrice={setStopLossPrice}
        takeProfitPrice={takeProfitPrice}
        setTakeProfitPrice={setTakeProfitPrice}
        slPercent={slPercent}
        setSlPercent={setSlPercent}
        tpPercent={tpPercent}
        setTpPercent={setTpPercent}
        trailingStopLoss={trailingStopLoss}
        setTrailingStopLoss={setTrailingStopLoss}
        trailingDistancePercent={trailingDistancePercent}
        setTrailingDistancePercent={setTrailingDistancePercent}
        trailingStepPercent={trailingStepPercent}
        setTrailingStepPercent={setTrailingStepPercent}
        onClearAll={clearAllProtection}
      />
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
