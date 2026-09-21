import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  adjustFuturesPosition, exitFuturesPosition, fetchAccounts, fetchFuturesPositions,
  fetchFuturesPrices, fetchKillSwitchStatus, refreshFuturesPositions, setFuturesProtection, setTrailingProtection,
  syncAccount, updateFuturesPositionLeverage,
} from '../api.js';
import type { AccountListItem, FuturesPositionRow } from '../api.ts';
import { useLivePrices } from '../useLivePrices.ts';

// The Positions page — modern UI/UX overhaul.
//
// Key improvements:
//   1. Group Name visibility: Every position links to its Account Group (e.g. "Momentum").
//   2. Real-money Safety: Accidental clicks eliminated by replacing direct "Close" buttons
//      with a full-featured "Manage" modal with two-step exit confirmation.
//   3. High-Density Visibility: Cards are expanded by default so all metrics are readable immediately.
//   4. High-Scale Account Handling: Groups with 100+ accounts feature account search and smart
//      pagination ("Show all N accounts") preventing overwhelming scroll length.
//   5. Live 3s Real-Time Marks, Margins, and ROE % throughout.

/* ─── helpers ─── */

export function quoteScaleOf(quote: 'INR' | 'USDT'): number {
  return quote === 'INR' ? 2 : 8;
}

export function fmtMinor(minor: string, quote: 'INR' | 'USDT', maxDecimals = 2): string {
  const scale = quoteScaleOf(quote);
  const neg = minor.startsWith('-');
  const digits = neg ? minor.slice(1) : minor;

  if (scale > maxDecimals) {
    const diff = scale - maxDecimals;
    const divisor = 10n ** BigInt(diff);
    const half = divisor / 2n;
    const rounded = (BigInt(digits) + half) / divisor;
    const padded = String(rounded).padStart(maxDecimals + 1, '0');
    const whole = padded.slice(0, -maxDecimals);
    const frac = padded.slice(-maxDecimals);
    const body = `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
    const sign = neg ? '−' : '';
    return quote === 'INR' ? `${sign}₹${body}` : `${sign}${body} ${quote}`;
  }

  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, -scale);
  const frac = padded.slice(-scale);
  const body = scale === 0
    ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    : `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${frac}`;
  const sign = neg ? '−' : '';
  return quote === 'INR' ? `${sign}₹${body}` : `${sign}${body} ${quote}`;
}

export function pnlClass(minor: string | null): string {
  if (minor === null) return '';
  if (minor.startsWith('-')) return 'pnl-loss';
  if (minor === '0' || minor === '') return '';
  return 'pnl-profit';
}

export function pnlText(minor: string | null, quote: 'INR' | 'USDT'): string {
  if (minor === null || minor === '') return '—';
  if (minor === '0') return fmtMinor(minor, quote);
  if (minor.startsWith('-')) return fmtMinor(minor, quote);
  return `+${fmtMinor(minor, quote)}`;
}

export function bufferColor(bp: number | null): string | undefined {
  if (bp === null) return undefined;
  if (bp < 200) return 'var(--danger)';
  if (bp < 1000) return '#c48a00';
  return 'var(--ok)';
}

/** Add two minor-unit strings. Works for both positive and negative values. */
export function addMinors(a: string, b: string): string {
  return String(BigInt(a) + BigInt(b));
}

/** Calculate proportional minor units (e.g. 25% of 6952663) using basis points */
export function calcProportionalMinor(minor: string | null, pct: number): string | null {
  if (minor === null || minor === '' || minor === '0' || !Number.isFinite(pct) || pct <= 0) return null;
  try {
    const b = BigInt(minor);
    const bp = BigInt(Math.round(pct * 100));
    return String((b * bp) / 10000n);
  } catch {
    return null;
  }
}

export function calcRoePct(p: { avgEntryPrice: string | null; markPrice: string | null; leverage: string | null; side: 'long' | 'short' | 'flat' }): number | null {
  if (p.avgEntryPrice === null || p.markPrice === null || p.side === 'flat') return null;
  const entry = Number(p.avgEntryPrice);
  const mark = Number(p.markPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(mark) || entry <= 0) return null;
  const lev = p.leverage !== null && Number(p.leverage) > 0 ? Number(p.leverage) : 1;
  const dir = p.side === 'short' ? -1 : 1;
  const pct = ((mark - entry) / entry) * 100 * lev * dir;
  return Number.isFinite(pct) ? pct : null;
}

export function roeText(pct: number | null): string {
  if (pct === null) return '';
  const sign = pct >= 0 ? '+' : '';
  return ` (${sign}${pct.toFixed(2)}%)`;
}

/** Formats decimal price strings cleanly (e.g. 267.81665000000004 -> 267.82) */
export function fmtPrice(priceStr: string | null | undefined): string {
  if (!priceStr || priceStr === '0' || priceStr === '') return '—';
  const n = Number(priceStr);
  if (!Number.isFinite(n)) return priceStr;
  if (n >= 1) {
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
}

/** Formats epoch timestamp into clean date string and relative time (e.g. "20 Sep, 17:29" and "2h ago") */
export function fmtEntryTime(ms: number | null | undefined): { dateStr: string; relStr: string } | null {
  if (!ms || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const now = Date.now();
  const diffSec = Math.max(0, Math.floor((now - ms) / 1000));
  let relStr = '';
  if (diffSec < 60) relStr = 'just now';
  else if (diffSec < 3600) relStr = `${Math.floor(diffSec / 60)}m ago`;
  else if (diffSec < 86400) relStr = `${Math.floor(diffSec / 3600)}h ago`;
  else relStr = `${Math.floor(diffSec / 86400)}d ago`;

  const day = d.getDate();
  const month = d.toLocaleString('en-US', { month: 'short' });
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr = `${day} ${month}, ${time}`;
  return { dateStr, relStr };
}

function pctToTrigger(refPrice: number, pct: number, side: 'long' | 'short', leg: 'sl' | 'tp'): number {
  const down = (side === 'long' && leg === 'sl') || (side === 'short' && leg === 'tp');
  return down ? refPrice * (1 - pct / 100) : refPrice * (1 + pct / 100);
}

function triggerToPct(refPrice: number, triggerPrice: number, side: 'long' | 'short', leg: 'sl' | 'tp'): number {
  const down = (side === 'long' && leg === 'sl') || (side === 'short' && leg === 'tp');
  const pct = down
    ? ((refPrice - triggerPrice) / refPrice) * 100
    : ((triggerPrice - refPrice) / refPrice) * 100;
  return Math.abs(pct);
}

export interface EstimatedTpSl {
  readonly hasTp: boolean;
  readonly hasSl: boolean;
  readonly tpPriceText: string;
  readonly slPriceText: string;
  readonly tpEstPnlText: string | null;
  readonly slEstPnlText: string | null;
  readonly tpEstRoeText: string | null;
  readonly slEstRoeText: string | null;
  readonly tpEstPnlNum: number | null;
  readonly slEstPnlNum: number | null;
}

export function calcEstimatedTpSl(p: FuturesPositionRow): EstimatedTpSl {
  const hasSl = p.stopLossTrigger !== null && p.stopLossTrigger !== '0' && p.stopLossTrigger !== '0.0' && Number(p.stopLossTrigger) > 0;
  const hasTp = p.takeProfitTrigger !== null && p.takeProfitTrigger !== '0' && p.takeProfitTrigger !== '0.0' && Number(p.takeProfitTrigger) > 0;

  let tpEstPnlText: string | null = null;
  let slEstPnlText: string | null = null;
  let tpEstRoeText: string | null = null;
  let slEstRoeText: string | null = null;
  let tpEstPnlNum: number | null = null;
  let slEstPnlNum: number | null = null;

  const entry = Number(p.avgEntryPrice);
  const qty = Number(p.quantity);
  const validEntry = Number.isFinite(entry) && entry > 0;
  const validQty = Number.isFinite(qty) && qty > 0;
  const lev = p.leverage !== null && Number(p.leverage) > 0 ? Number(p.leverage) : 1;
  const isLong = p.side === 'long';
  const isShort = p.side === 'short';

  // For INR-margined positions on USDT-quoted contracts (e.g. B-BCH_USDT), convert USDT PnL to INR.
  // CoinDCX records the USDT->INR peg at entry in settlementCurrencyAvgPrice (typically ~100-103).
  const isUsdtContractWithInrMargin = p.marginCurrency === 'INR' && (p.pair.endsWith('_USDT') || p.pair.includes('USDT'));
  const fxPeg = isUsdtContractWithInrMargin
    ? (p.settlementCurrencyAvgPrice && Number(p.settlementCurrencyAvgPrice) > 0 ? Number(p.settlementCurrencyAvgPrice) : 100)
    : 1;

  if (hasTp && validEntry && validQty && (isLong || isShort)) {
    const tp = Number(p.takeProfitTrigger);
    if (Number.isFinite(tp) && tp > 0) {
      const priceDiff = isLong ? (tp - entry) : (entry - tp);
      const estPnl = priceDiff * qty * fxPeg;
      tpEstPnlNum = estPnl;
      const dir = isShort ? -1 : 1;
      const roePct = ((tp - entry) / entry) * 100 * lev * dir;

      const sign = estPnl > 0 ? '+' : estPnl < 0 ? '−' : '';
      const absVal = Math.abs(estPnl).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      tpEstPnlText = p.marginCurrency === 'INR' ? `${sign}₹${absVal}` : `${sign}${absVal} USDT`;
      if (Number.isFinite(roePct)) {
        const roeSign = roePct >= 0 ? '+' : '';
        tpEstRoeText = `(${roeSign}${roePct.toFixed(1)}%)`;
      }
    }
  }

  if (hasSl && validEntry && validQty && (isLong || isShort)) {
    const sl = Number(p.stopLossTrigger);
    if (Number.isFinite(sl) && sl > 0) {
      const priceDiff = isLong ? (sl - entry) : (entry - sl);
      const estPnl = priceDiff * qty * fxPeg;
      slEstPnlNum = estPnl;
      const dir = isShort ? -1 : 1;
      const roePct = ((sl - entry) / entry) * 100 * lev * dir;

      const sign = estPnl > 0 ? '+' : estPnl < 0 ? '−' : '';
      const absVal = Math.abs(estPnl).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      slEstPnlText = p.marginCurrency === 'INR' ? `${sign}₹${absVal}` : `${sign}${absVal} USDT`;
      if (Number.isFinite(roePct)) {
        const roeSign = roePct >= 0 ? '+' : '';
        slEstRoeText = `(${roeSign}${roePct.toFixed(1)}%)`;
      }
    }
  }

  return {
    hasTp,
    hasSl,
    tpPriceText: fmtPrice(p.takeProfitTrigger),
    slPriceText: fmtPrice(p.stopLossTrigger),
    tpEstPnlText,
    slEstPnlText,
    tpEstRoeText,
    slEstRoeText,
    tpEstPnlNum,
    slEstPnlNum,
  };
}

/**
 * Execute an async worker over items concurrently with a bounded pool size,
 * ensuring high throughput while keeping the UI responsive.
 */
export async function mapConcurrent<T>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  const cap = Math.min(items.length, Math.max(1, concurrency));
  let nextIdx = 0;

  const worker = async () => {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      const item = items[idx]!;
      await fn(item, idx);
    }
  };

  const workers = Array.from({ length: cap }, () => worker());
  await Promise.all(workers);
}

/* ─── grouped position type ─── */

export interface PositionGroup {
  key: string;
  /** e.g. "BTC" */
  asset: string;
  pair: string;
  side: 'long' | 'short' | 'flat';
  marginCurrency: 'INR' | 'USDT';
  /** Sum of all account quantities. */
  totalQty: number;
  /** Aggregated margin in minor units. */
  totalMarginMinor: string | null;
  /** Aggregated unrealised PnL in minor units. */
  totalPnlMinor: string | null;
  /** Earliest entry time among positions in this group. */
  entryTimeMs: number | null;
  /** Per-account positions in this group. */
  positions: FuturesPositionRow[];
  /** Unique group names across positions in this instrument. */
  groupNames: string[];
}

export function buildGroups(rows: readonly FuturesPositionRow[]): PositionGroup[] {
  const map = new Map<string, PositionGroup>();
  for (const p of rows) {
    const key = `${p.pair}|${p.side}|${p.marginCurrency}`;
    let g = map.get(key);
    if (g === undefined) {
      // Extract the asset name from the pair (e.g., "B-BTC_USDT" → "BTC")
      const asset = p.pair.replace(/^[A-Z]-/, '').replace(/_.*$/, '');
      g = {
        key,
        asset,
        pair: p.pair,
        side: p.side,
        marginCurrency: p.marginCurrency,
        totalQty: 0,
        totalMarginMinor: null,
        totalPnlMinor: null,
        entryTimeMs: null,
        positions: [],
        groupNames: [],
      };
      map.set(key, g);
    }
    g.positions.push(p);
    g.totalQty += Number(p.quantity);
    if (p.entryTimeMs && Number.isFinite(p.entryTimeMs)) {
      g.entryTimeMs = g.entryTimeMs === null ? p.entryTimeMs : Math.min(g.entryTimeMs, p.entryTimeMs);
    }
    if (p.groupName && !g.groupNames.includes(p.groupName)) {
      g.groupNames.push(p.groupName);
    }
    if (p.lockedMarginMinor !== null && p.lockedMarginMinor !== '' && p.lockedMarginMinor !== '0') {
      g.totalMarginMinor = g.totalMarginMinor === null
        ? p.lockedMarginMinor
        : addMinors(g.totalMarginMinor, p.lockedMarginMinor);
    }
    if (p.unrealisedPnlMinor !== null) {
      g.totalPnlMinor = g.totalPnlMinor === null
        ? p.unrealisedPnlMinor
        : addMinors(g.totalPnlMinor, p.unrealisedPnlMinor);
    }
  }
  return Array.from(map.values());
}

export function calcGroupRoePct(group: PositionGroup): number | null {
  const totalWeight = group.positions.reduce((acc, pos) => acc + Number(pos.quantity), 0);
  if (totalWeight <= 0) return null;
  const weightedRoeSum = group.positions.reduce((acc, pos) => {
    const r = calcRoePct(pos);
    return r !== null ? acc + r * Number(pos.quantity) : acc;
  }, 0);
  return weightedRoeSum / totalWeight;
}

/* ─── per-account row inside a group card ─── */

function AccountRow({
  p,
  onManage,
  onQuickExit,
  isHalted,
}: {
  readonly p: FuturesPositionRow;
  readonly onManage: (position: FuturesPositionRow) => void;
  readonly onQuickExit: (position: FuturesPositionRow) => void;
  readonly isHalted?: boolean | undefined;
}) {
  const roe = calcRoePct(p);
  const tpSl = calcEstimatedTpSl(p);
  const entryTime = fmtEntryTime(p.entryTimeMs);

  return (
    <tr>
      <td>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <Link
            to={`/app/accounts/${p.accountId}`}
            className="pos-account-link"
            title={`View account details for ${p.accountName}`}
          >
            <span>{p.accountName}</span>
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pos-account-link-icon">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </Link>
          <div style={{ fontSize: 11, color: '#94a3b8', display: 'inline-flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
            {p.groupName || 'Ungrouped'}
            {p.hideFromPositions && (
              <span
                style={{
                  fontSize: 9.5,
                  padding: '1px 5px',
                  borderRadius: 3,
                  background: 'rgba(239, 68, 68, 0.18)',
                  color: '#fca5a5',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  fontWeight: 600,
                }}
              >
                Hidden
              </span>
            )}
          </div>
        </div>
      </td>
      <td className="mono" style={{ textAlign: 'right', color: '#f8fafc', fontWeight: 600 }}>{p.quantity}</td>
      <td>
        {p.leverage === null ? (
          <span className="muted">—</span>
        ) : (
          <span className="pos-lev-pill">{p.leverage}×</span>
        )}
      </td>
      <td className="mono" style={{ textAlign: 'right' }}>
        {p.lockedMarginMinor && p.lockedMarginMinor !== '0' ? (
          <span style={{ color: '#e2e8f0', fontWeight: 600 }}>
            {fmtMinor(p.lockedMarginMinor, p.marginCurrency)}
          </span>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="mono" style={{ textAlign: 'right', color: '#94a3b8', fontWeight: 600 }}>{fmtPrice(p.avgEntryPrice)}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {entryTime ? (
          <div>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#cbd5e1', display: 'block' }}>{entryTime.dateStr}</span>
            <span style={{ fontSize: 10.5, color: '#64748b', display: 'block', marginTop: 1 }}>{entryTime.relStr}</span>
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td className="mono" style={{ textAlign: 'right' }}>
        <span style={{ color: '#facc15', fontWeight: 700, fontSize: 14.5, display: 'block' }}>
          {fmtPrice(p.liquidationPrice)}
        </span>
        {p.liqBufferBp !== null && (
          <span style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#ca8a04', marginTop: 1 }}>
            {(p.liqBufferBp / 100).toFixed(1)}% buf
          </span>
        )}
      </td>
      <td className="mono" style={{ textAlign: 'right' }}>
        <div style={{
          fontSize: 14.5,
          fontWeight: 700,
          color: (p.unrealisedPnlMinor && p.unrealisedPnlMinor.startsWith('-'))
            ? '#ef4444'
            : (p.unrealisedPnlMinor && p.unrealisedPnlMinor !== '0' && p.unrealisedPnlMinor !== '')
              ? '#10b981'
              : 'var(--text-dim)',
        }}>
          {pnlText(p.unrealisedPnlMinor, p.marginCurrency)}
        </div>
        {roe !== null && (
          <div style={{
            fontSize: 12.5,
            fontWeight: 700,
            marginTop: 2,
            color: roe < 0 ? '#ef4444' : '#10b981',
          }}>
            {roeText(roe).trim()}
          </div>
        )}
      </td>
      <td>
        {!tpSl.hasSl && !tpSl.hasTp ? (
          <span className="muted" style={{ fontSize: 11.5 }}>none</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {tpSl.hasTp && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
                <span className="badge planned" style={{ fontSize: 9.5, padding: '1px 5px', fontWeight: 700 }}>
                  TP {tpSl.tpPriceText}
                </span>
                {tpSl.tpEstPnlText && (
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: (tpSl.tpEstPnlNum ?? 0) >= 0 ? '#10b981' : '#ef4444', whiteSpace: 'nowrap' }}>
                    {tpSl.tpEstPnlText} {tpSl.tpEstRoeText}
                  </span>
                )}
              </div>
            )}
            {tpSl.hasSl && (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
                <span className="badge skipped" style={{ fontSize: 9.5, padding: '1px 5px', fontWeight: 700 }}>
                  SL {tpSl.slPriceText}
                </span>
                {tpSl.slEstPnlText && (
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: (tpSl.slEstPnlNum ?? 0) <= 0 ? '#ef4444' : '#10b981', whiteSpace: 'nowrap' }}>
                    {tpSl.slEstPnlText} {tpSl.slEstRoeText}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </td>
      <td style={{ textAlign: 'center', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <button
            type="button"
            className="btn btn-sm secondary"
            style={{
              fontSize: 11.5,
              padding: '3px 10px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontWeight: 600,
            }}
            onClick={() => onManage(p)}
          >
            Manage
          </button>
          <button
            type="button"
            className="btn btn-sm quick-exit-btn"
            disabled={isHalted}
            style={{
              fontSize: 11.5,
              padding: '3px 8px',
              borderRadius: 'var(--radius-sm)',
              opacity: isHalted ? 0.4 : 1,
              cursor: isHalted ? 'not-allowed' : 'pointer',
            }}
            onClick={() => onQuickExit(p)}
            title={isHalted ? 'Emergency Kill Switch is ACTIVE (Read-Only Mode)' : `Quick exit position for ${p.accountName}`}
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Exit
          </button>
        </div>
      </td>
    </tr>
  );
}

/* ─── per-account mobile position card (<= 768px) ─── */

function AccountMobileCard({
  p,
  onManage,
  onQuickExit,
  isHalted,
}: {
  readonly p: FuturesPositionRow;
  readonly onManage: (position: FuturesPositionRow) => void;
  readonly onQuickExit: (position: FuturesPositionRow) => void;
  readonly isHalted?: boolean | undefined;
}) {
  const roe = calcRoePct(p);
  const tpSl = calcEstimatedTpSl(p);
  const sideColor = p.side === 'long' ? 'var(--ok)' : p.side === 'short' ? 'var(--danger)' : 'var(--text-dim)';
  const entryTime = fmtEntryTime(p.entryTimeMs);

  return (
    <div className="pos-mobile-card">
      <div className="pos-mobile-card-top">
        <div>
          <Link
            to={`/app/accounts/${p.accountId}`}
            className="pos-account-link"
            style={{ fontSize: 14, fontWeight: 700 }}
            title={`View account details for ${p.accountName}`}
          >
            <span>{p.accountName}</span>
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="pos-account-link-icon">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </Link>
          <div className="pos-mobile-grp-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span>{p.groupName || 'Ungrouped'}</span>
            {p.hideFromPositions && (
              <span
                style={{
                  fontSize: 9,
                  padding: '1px 4px',
                  borderRadius: 3,
                  background: 'rgba(239, 68, 68, 0.2)',
                  color: '#fca5a5',
                  border: '1px solid rgba(239, 68, 68, 0.35)',
                  fontWeight: 600,
                }}
              >
                Hidden
              </span>
            )}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{
            fontSize: 16,
            fontWeight: 800,
            color: (p.unrealisedPnlMinor && p.unrealisedPnlMinor.startsWith('-'))
              ? '#ef4444'
              : (p.unrealisedPnlMinor && p.unrealisedPnlMinor !== '0')
                ? '#10b981'
                : 'var(--text-dim)',
          }}>
            {pnlText(p.unrealisedPnlMinor, p.marginCurrency)}
          </div>
          {roe !== null && (
            <span
              className="pos-mobile-roe-pill"
              style={{
                fontSize: 12.5,
                fontWeight: 700,
                color: roe >= 0 ? '#10b981' : '#ef4444',
                background: roe >= 0 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                border: `1px solid ${roe >= 0 ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              }}
            >
              {roeText(roe).trim()}
            </span>
          )}
        </div>
      </div>

      <div className="pos-mobile-grid">
        <div className="pos-mobile-cell">
          <span className="pos-mobile-label">Side / Lev</span>
          <span className="pos-mobile-val" style={{ color: sideColor, fontWeight: 700 }}>
            {p.side.toUpperCase()} {p.leverage ? `${p.leverage}×` : ''}
          </span>
        </div>
        <div className="pos-mobile-cell">
          <span className="pos-mobile-label">Margin</span>
          <span className="pos-mobile-val mono">
            {p.lockedMarginMinor && p.lockedMarginMinor !== '0' ? fmtMinor(p.lockedMarginMinor, p.marginCurrency) : '—'}
          </span>
        </div>
        <div className="pos-mobile-cell">
          <span className="pos-mobile-label">Qty</span>
          <span className="pos-mobile-val mono" style={{ color: '#f8fafc', fontWeight: 600 }}>{p.quantity}</span>
        </div>
        <div className="pos-mobile-cell">
          <span className="pos-mobile-label">Entry Price</span>
          <span className="pos-mobile-val mono" style={{ color: '#94a3b8', fontWeight: 600 }}>{fmtPrice(p.avgEntryPrice)}</span>
        </div>
        <div className="pos-mobile-cell">
          <span className="pos-mobile-label">Entry Time</span>
          <span className="pos-mobile-val" style={{ fontSize: 11.5, color: '#cbd5e1' }}>
            {entryTime ? `${entryTime.dateStr} (${entryTime.relStr})` : '—'}
          </span>
        </div>
        <div className="pos-mobile-cell">
          <span className="pos-mobile-label">Liq Price</span>
          <span className="pos-mobile-val mono" style={{ color: '#facc15', fontWeight: 700, fontSize: 14 }}>
            {fmtPrice(p.liquidationPrice)}
          </span>
          {p.liqBufferBp !== null && (
            <span style={{ fontSize: 10.5, fontWeight: 600, color: '#ca8a04', display: 'block' }}>
              {(p.liqBufferBp / 100).toFixed(1)}% buf
            </span>
          )}
        </div>
      </div>

      <div className="pos-mobile-card-foot">
        <div className="pos-mobile-prot" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>TP/SL:</span>
          {!tpSl.hasSl && !tpSl.hasTp ? (
            <span className="muted" style={{ fontSize: 11 }}>None</span>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {tpSl.hasTp && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span className="badge planned" style={{ fontSize: 9.5, padding: '1px 5px', fontWeight: 700 }}>
                    TP {tpSl.tpPriceText}
                  </span>
                  {tpSl.tpEstPnlText && (
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: (tpSl.tpEstPnlNum ?? 0) >= 0 ? '#10b981' : '#ef4444' }}>
                      {tpSl.tpEstPnlText} {tpSl.tpEstRoeText}
                    </span>
                  )}
                </div>
              )}
              {tpSl.hasSl && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                  <span className="badge skipped" style={{ fontSize: 9.5, padding: '1px 5px', fontWeight: 700 }}>
                    SL {tpSl.slPriceText}
                  </span>
                  {tpSl.slEstPnlText && (
                    <span style={{ fontSize: 10.5, fontWeight: 600, color: (tpSl.slEstPnlNum ?? 0) <= 0 ? '#ef4444' : '#10b981' }}>
                      {tpSl.slEstPnlText} {tpSl.slEstRoeText}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="btn btn-sm secondary"
            style={{ flex: 1, padding: '8px', fontSize: 12, fontWeight: 700, borderRadius: 8 }}
            onClick={() => onManage(p)}
          >
            Manage Position
          </button>
          <button
            type="button"
            className="btn btn-sm quick-exit-btn"
            disabled={isHalted}
            style={{
              flex: 1,
              padding: '8px',
              fontSize: 12,
              fontWeight: 700,
              borderRadius: 8,
              justifyContent: 'center',
              opacity: isHalted ? 0.4 : 1,
              cursor: isHalted ? 'not-allowed' : 'pointer',
            }}
            onClick={() => onQuickExit(p)}
            title={isHalted ? 'Emergency Kill Switch is ACTIVE (Read-Only Mode)' : undefined}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Quick Exit
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── group card with high-scale account handling ─── */

function GroupCard({
  group,
  collapsed,
  onToggle,
  onManage,
  onManageGroup,
  onQuickExit,
  onQuickExitGroup,
  isHalted,
}: {
  readonly group: PositionGroup;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly onManage: (position: FuturesPositionRow) => void;
  readonly onManageGroup: (group: PositionGroup) => void;
  readonly onQuickExit: (position: FuturesPositionRow) => void;
  readonly onQuickExitGroup: (group: PositionGroup) => void;
  readonly isHalted?: boolean | undefined;
}) {
  const [accountSearch, setAccountSearch] = useState('');

  const sideColor = group.side === 'long' ? 'var(--ok)' : group.side === 'short' ? 'var(--danger)' : 'var(--text-dim)';
  const totalWeight = group.positions.reduce((acc, pos) => acc + Number(pos.quantity), 0);
  const weightedRoeSum = group.positions.reduce((acc, pos) => {
    const r = calcRoePct(pos);
    return r !== null ? acc + r * Number(pos.quantity) : acc;
  }, 0);
  const groupRoe = totalWeight > 0 ? weightedRoeSum / totalWeight : null;

  // Filter accounts within this group if search term provided
  const filteredPositions = useMemo(() => {
    if (!accountSearch.trim()) return group.positions;
    const q = accountSearch.toLowerCase().trim();
    return group.positions.filter((p) =>
      p.accountName.toLowerCase().includes(q) ||
      (p.groupName && p.groupName.toLowerCase().includes(q)),
    );
  }, [group.positions, accountSearch]);

  // Query real-time prices streaming from CoinDCX WebSocket/SSE
  const pricesQuery = useQuery({
    queryKey: ['futures-prices'],
    queryFn: fetchFuturesPrices,
    staleTime: 2000,
  });
  const pricesData = pricesQuery.data;

  const livePriceItem = pricesData?.prices?.[group.pair] ?? (group.asset ? pricesData?.prices?.[`B-${group.asset.toUpperCase()}_USDT`] : undefined);
  const currentPrice = livePriceItem?.markPrice || livePriceItem?.lastPrice || group.positions[0]?.markPrice;
  const changePct = livePriceItem?.priceChangePercent;
  const hasChange = typeof changePct === 'number' && Number.isFinite(changePct);
  const isPos = hasChange && changePct >= 0;
  const isNeg = hasChange && changePct < 0;

  const groupTitle = group.groupNames.length === 1
    ? group.groupNames[0]
    : group.groupNames.length > 1
      ? `${group.groupNames.slice(0, 2).join(', ')}${group.groupNames.length > 2 ? ` (+${group.groupNames.length - 2})` : ''}`
      : 'Ungrouped';

  const pnlNum = Number(group.totalPnlMinor ?? 0);
  const statusClass = pnlNum > 0 ? 'profit-group' : pnlNum < 0 ? 'loss-group' : 'flat-group';

  return (
    <div className={`position-card ${statusClass}`}>
      <div className="position-card-header" onClick={onToggle}>
        {/* Asset + Side */}
        <span className="asset-pill">{group.asset}</span>
        <span
          className="badge"
          style={{
            color: sideColor,
            borderColor: sideColor,
            background: group.side === 'long' ? 'rgba(75,181,99,0.12)' : group.side === 'short' ? 'rgba(240,85,90,0.12)' : 'transparent',
            fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
          }}
        >
          {group.side}
        </span>
        <span className="card-meta" style={{ fontWeight: 600 }}>{group.marginCurrency}</span>

        {/* Group Name badge */}
        <span className="group-badge" title={group.groupNames.join(', ')}>
          {groupTitle}
        </span>

        {/* Aggregated stats */}
        <span className="card-meta" style={{ marginLeft: 6 }}>
          Qty <strong style={{ color: 'var(--text)' }}>{group.totalQty.toFixed(4).replace(/\.?0+$/, '')}</strong>
        </span>
        {group.totalMarginMinor !== null && (
          <span className="card-meta">
            Margin <strong style={{ color: 'var(--text)' }}>{fmtMinor(group.totalMarginMinor, group.marginCurrency)}</strong>
          </span>
        )}
        <span className="card-meta">
          {group.positions.length} account{group.positions.length > 1 ? 's' : ''}
        </span>
        {currentPrice && (
          <span
            className={`card-meta group-mark-chip${isPos ? ' chip-pos' : isNeg ? ' chip-neg' : ''}`}
            title={`Live ${group.asset} Market Price${hasChange ? ` · 24h Change: ${isPos ? '+' : ''}${changePct.toFixed(2)}%` : ''}`}
          >
            <span className="live-pulse-dot" />
            <span style={{ fontSize: 11, color: isPos ? '#6ee7b7' : isNeg ? '#fca5a5' : '#94a3b8', fontWeight: 600 }}>Live</span>
            <strong style={{ color: isPos ? '#10b981' : isNeg ? '#ef4444' : '#38bdf8', fontSize: 13, fontWeight: 700 }}>
              {fmtPrice(currentPrice)}
            </strong>
            {hasChange && (
              <span style={{ fontSize: 11.5, fontWeight: 700, color: isPos ? '#10b981' : '#ef4444', marginLeft: 2 }}>
                {isPos ? `+${changePct.toFixed(2)}%` : `${changePct.toFixed(2)}%`}
              </span>
            )}
          </span>
        )}

        {/* Right side: PnL, ROE, Manage Group button, Quick Exit, and Expand */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                fontSize: 17,
                fontWeight: 800,
                color: pnlNum > 0 ? '#10b981' : pnlNum < 0 ? '#ef4444' : 'var(--text-dim)',
              }}
            >
              {pnlText(group.totalPnlMinor, group.marginCurrency)}
            </span>
            {groupRoe !== null && (
              <span
                style={{
                  fontSize: 12.5,
                  fontWeight: 700,
                  padding: '2px 8px',
                  borderRadius: 4,
                  background: groupRoe >= 0 ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  color: groupRoe >= 0 ? '#10b981' : '#ef4444',
                  border: `1px solid ${groupRoe >= 0 ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                }}
              >
                {roeText(groupRoe).trim()}
              </span>
            )}
          </div>

          <button
            type="button"
            className="btn btn-sm"
            style={{
              padding: '5px 12px',
              fontSize: 12,
              background: 'rgba(124, 107, 255, 0.18)',
              color: '#c4b5fd',
              border: '1px solid rgba(124, 107, 255, 0.4)',
              fontWeight: 700,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
            onClick={(e) => {
              e.stopPropagation();
              onManageGroup(group);
            }}
            title="Manage this position across all accounts in the group"
          >
            Manage Group
          </button>

          <button
            type="button"
            className="btn btn-sm quick-exit-btn"
            disabled={isHalted}
            style={{
              padding: '5px 12px',
              fontSize: 12,
              fontWeight: 700,
              borderRadius: 'var(--radius-sm)',
              opacity: isHalted ? 0.4 : 1,
              cursor: isHalted ? 'not-allowed' : 'pointer',
            }}
            onClick={(e) => {
              e.stopPropagation();
              onQuickExitGroup(group);
            }}
            title={isHalted ? 'Emergency Kill Switch is ACTIVE (Read-Only Mode)' : 'Quick exit all positions in this group'}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Quick Exit
          </button>

          <span className={`expand-icon ${!collapsed ? 'open' : ''}`}>▼</span>
        </div>
      </div>

      {!collapsed && (
        <div className="position-card-body">
          {/* Sub-header with account filter bar & count (shown if > 2 accounts) */}
          {group.positions.length > 2 && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '8px 14px',
                background: 'rgba(0, 0, 0, 0.25)',
                borderBottom: '1px solid var(--line)',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  Showing <strong style={{ color: 'var(--text)' }}>{filteredPositions.length}</strong> of {group.positions.length} accounts in this trade
                </span>
                {group.positions.length > 5 && (
                  <span style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface-3)', padding: '1px 6px', borderRadius: 4 }}>
                    Scrollable table
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="text"
                  className="card-account-search"
                  placeholder="Filter accounts…"
                  value={accountSearch}
                  onChange={(e) => setAccountSearch(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ width: 190 }}
                />
                {accountSearch && (
                  <button
                    type="button"
                    className="btn btn-sm secondary"
                    style={{ padding: '2px 8px', fontSize: 11 }}
                    onClick={(e) => { e.stopPropagation(); setAccountSearch(''); }}
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Desktop Table View (> 768px) */}
          <div className="table-scroll-container desktop-pos-table">
            <table>
              <thead>
                <tr>
                  <th>Account & Group</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th>Lev</th>
                  <th style={{ textAlign: 'right' }}>Margin</th>
                  <th style={{ textAlign: 'right' }}>Entry Price</th>
                  <th>Entry Time</th>
                  <th style={{ textAlign: 'right' }}>Liquidation</th>
                  <th style={{ textAlign: 'right' }}>PnL (ROE)</th>
                  <th>TP/SL</th>
                  <th style={{ textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filteredPositions.map((p) => (
                  <AccountRow
                    key={`${p.accountId}-${p.pair}-${p.marginCurrency}`}
                    p={p}
                    onManage={onManage}
                    onQuickExit={onQuickExit}
                    isHalted={isHalted}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile Position Cards (<= 768px) */}
          <div className="mobile-pos-cards">
            {filteredPositions.map((p) => (
              <AccountMobileCard
                key={`mobile-${p.accountId}-${p.pair}-${p.marginCurrency}`}
                p={p}
                onManage={onManage}
                onQuickExit={onQuickExit}
                isHalted={isHalted}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Position Management Modal (Zero Accidental Exits) ─── */

const SL_PCT_CHIPS = [1, 2, 5, 10] as const;
const TP_PCT_CHIPS = [2, 5, 10, 15, 20, 30] as const;
const REDUCE_PCT_CHIPS = [10, 25, 50, 75] as const;
const INCREASE_PCT_CHIPS = [25, 50, 100] as const;
const LEVERAGE_PRESET_CHIPS = [2, 3, 4, 5, 10, 20, 25, 50] as const;

export interface PositionManageModalProps {
  readonly position: FuturesPositionRow;
  readonly onClose: () => void;
  readonly onExit: (id: string, marginCurrency: 'INR' | 'USDT') => void;
  readonly onAdjust: (id: string, direction: 'reduce' | 'increase', percentBp?: number, quantity?: string) => void;
  readonly onProtection: (args: { id: string; slp?: string | undefined; tpp?: string | undefined; trailing?: boolean | undefined }) => void;
  readonly isExiting: boolean;
  readonly isAdjusting: boolean;
  readonly isProtecting: boolean;
  readonly isHalted?: boolean | undefined;
}

export function PositionManageModal({
  position,
  onClose,
  onExit,
  onAdjust,
  onProtection,
  isExiting,
  isAdjusting,
  isProtecting,
  isHalted,
}: PositionManageModalProps) {
  const [activeTab, setActiveTab] = useState<'protection' | 'partial' | 'increase' | 'leverage' | 'close'>('protection');
  const [confirmExit, setConfirmExit] = useState(false);

  const qc = useQueryClient();

  // Query accounts for this account's free balance (single fetch on modal open — no 3s interval!)
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
    refetchInterval: false,
    staleTime: 60_000,
  });

  const matchedAccount = useMemo(() => {
    if (!accountsQuery.data) return null;
    return accountsQuery.data.find(
      (a) => a.id === position.accountId || a.name.trim().toLowerCase() === position.accountName.trim().toLowerCase(),
    ) ?? null;
  }, [accountsQuery.data, position.accountId, position.accountName]);

  const accountFreeCashMinor = matchedAccount
    ? (matchedAccount.balancesByCurrency?.[position.marginCurrency] ??
       (matchedAccount.allocatedCurrency === position.marginCurrency ? matchedAccount.allocatedCapitalMinor : '0'))
    : null;

  const [isSyncingBalance, setIsSyncingBalance] = useState(false);
  const handleSyncBalance = async () => {
    if (!position.accountId) return;
    setIsSyncingBalance(true);
    try {
      await syncAccount(position.accountId);
      await Promise.all([
        accountsQuery.refetch(),
        qc.invalidateQueries({ queryKey: ['futures-positions'] }),
      ]);
    } catch (err) {
      console.error('Failed to sync account balance', err);
    } finally {
      setIsSyncingBalance(false);
    }
  };

  // Auto-sync live exchange balance on modal mount
  useEffect(() => {
    void handleSyncBalance();
  }, [position.accountId]);

  const isRefreshing = isSyncingBalance || accountsQuery.isFetching;

  // Partial close / reduce state
  const [reducePct, setReducePct] = useState<number>(25);
  const [customReduceInput, setCustomReduceInput] = useState<string>('');
  const isCustomReduce = customReduceInput !== '' && Number(customReduceInput) === reducePct;

  // Increase / add state
  const [increaseSizingMode, setIncreaseSizingMode] = useState<'percent' | 'quantity'>('percent');
  const [increasePct, setIncreasePct] = useState<number>(25);
  const [customIncreaseInput, setCustomIncreaseInput] = useState<string>('');
  const isCustomIncrease = customIncreaseInput !== '' && Number(customIncreaseInput) === increasePct;
  const [increaseQtyInput, setIncreaseQtyInput] = useState<string>('');

  // Protection state
  const initSl = position.stopLossTrigger && position.stopLossTrigger !== '0' && Number(position.stopLossTrigger) > 0 ? position.stopLossTrigger : '';
  const initTp = position.takeProfitTrigger && position.takeProfitTrigger !== '0' && Number(position.takeProfitTrigger) > 0 ? position.takeProfitTrigger : '';
  const [enableSl, setEnableSl] = useState<boolean>(() => Boolean(initSl));
  const [enableTp, setEnableTp] = useState<boolean>(() => Boolean(initTp));
  const [sl, setSl] = useState(initSl);
  const [tp, setTp] = useState(initTp);
  const [slTpMode, setSlTpMode] = useState<'percent' | 'price'>('percent');
  const [slPct, setSlPct] = useState('');
  const [tpPct, setTpPct] = useState('');
  const [trailing, setTrailing] = useState(false);

  const currentProtectionPreset = (enableSl && enableTp)
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
        if (!slPct || Number(slPct) <= 0) setSlPct('5');
        if (!tpPct || Number(tpPct) <= 0) setTpPct('10');
      }
    } else if (preset === 'tp_only') {
      setEnableSl(false);
      setEnableTp(true);
      setSl('');
      setSlPct('');
      setTrailing(false);
      if (slTpMode === 'percent' && (!tpPct || Number(tpPct) <= 0)) {
        setTpPct('10');
      }
    } else if (preset === 'sl_only') {
      setEnableSl(true);
      setEnableTp(false);
      setTp('');
      setTpPct('');
      if (slTpMode === 'percent' && (!slPct || Number(slPct) <= 0)) {
        setSlPct('5');
      }
    } else {
      setEnableSl(false);
      setEnableTp(false);
      setSl('');
      setTp('');
      setSlPct('');
      setTpPct('');
      setTrailing(false);
    }
  };

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExiting && !isAdjusting && !isProtecting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isExiting, isAdjusting, isProtecting]);

  const roe = calcRoePct(position);
  const refPrice = position.avgEntryPrice !== null ? Number(position.avgEntryPrice) : NaN;
  const hasRef = Number.isFinite(refPrice) && refPrice > 0;
  const sideOk = position.side === 'long' || position.side === 'short';

  const effectiveSl = enableSl
    ? (slTpMode === 'percent' && slPct !== '' && Number(slPct) > 0 && hasRef && sideOk
        ? pctToTrigger(refPrice, Number(slPct), position.side as 'long' | 'short', 'sl').toFixed(8).replace(/\.?0+$/, '')
        : (sl.trim() !== '' && Number(sl) > 0 ? sl.trim() : ''))
    : '';
  const effectiveTp = enableTp
    ? (slTpMode === 'percent' && tpPct !== '' && Number(tpPct) > 0 && hasRef && sideOk
        ? pctToTrigger(refPrice, Number(tpPct), position.side as 'long' | 'short', 'tp').toFixed(8).replace(/\.?0+$/, '')
        : (tp.trim() !== '' && Number(tp) > 0 ? tp.trim() : ''))
    : '';

  const validPositive = /^\d+(\.\d+)?$/;
  const slValid = !enableSl || (
    slTpMode === 'price'
      ? (sl.trim() !== '' && validPositive.test(sl) && Number(sl) > 0)
      : (slPct.trim() !== '' && validPositive.test(slPct) && Number(slPct) > 0 && Number(slPct) <= 100)
  );
  const tpValid = !enableTp || (
    slTpMode === 'price'
      ? (tp.trim() !== '' && validPositive.test(tp) && Number(tp) > 0)
      : (tpPct.trim() !== '' && validPositive.test(tpPct) && Number(tpPct) > 0 && Number(tpPct) <= 100)
  );

  const isSlActive = enableSl && (
    slTpMode === 'price'
      ? (sl.trim() !== '' && Number(sl) > 0)
      : (slPct.trim() !== '' && Number(slPct) > 0)
  );
  const isTpActive = enableTp && (
    slTpMode === 'price'
      ? (tp.trim() !== '' && Number(tp) > 0)
      : (tpPct.trim() !== '' && Number(tpPct) > 0)
  );
  const canSaveProtection = (isSlActive || isTpActive) && slValid && tpValid;

  const sideBadgeColor = position.side === 'long' ? 'var(--ok)' : 'var(--danger)';
  const totalQty = Number(position.quantity);
  const reduceQty = (totalQty * reducePct / 100).toFixed(4);
  const remainQty = Math.max(0, totalQty - Number(reduceQty)).toFixed(4);
  const reduceMarginMinor = calcProportionalMinor(position.lockedMarginMinor, reducePct);

  // Sizing math for Increase based on Available Free Balance or explicit Quantity
  const quoteScale = quoteScaleOf(position.marginCurrency);
  const freeBalanceMajor = accountFreeCashMinor !== null ? Number(accountFreeCashMinor) / (10 ** quoteScale) : 0;
  const lockedMarginMajor = position.lockedMarginMinor !== null && position.lockedMarginMinor !== ''
    ? Number(position.lockedMarginMinor) / (10 ** quoteScale)
    : 0;

  const marginPerUnit = useMemo(() => {
    if (totalQty > 0 && lockedMarginMajor > 0) {
      return lockedMarginMajor / totalQty;
    }
    const mark = position.markPrice ? Number(position.markPrice) : (position.avgEntryPrice ? Number(position.avgEntryPrice) : 0);
    const lev = position.leverage ? Number(position.leverage) : 1;
    if (mark > 0 && lev > 0) {
      return mark / lev;
    }
    return 0;
  }, [totalQty, lockedMarginMajor, position.markPrice, position.avgEntryPrice, position.leverage]);

  const { calculatedAddQty, calculatedAddMarginMajor, calculatedAddMarginMinor, effectiveSliderPct, isOverBudget } = useMemo(() => {
    if (increaseSizingMode === 'percent') {
      const targetMarginMajor = freeBalanceMajor * (increasePct / 100);
      const qty = marginPerUnit > 0 ? targetMarginMajor / marginPerUnit : 0;
      const qtyStr = qty > 0 ? (qty >= 1 ? qty.toFixed(2) : qty.toFixed(4)).replace(/\.?0+$/, '') : '0';
      const marginMinor = BigInt(Math.max(0, Math.round(targetMarginMajor * (10 ** quoteScale)))).toString();
      const overBudget = targetMarginMajor > freeBalanceMajor + 0.0001;
      return {
        calculatedAddQty: qtyStr,
        calculatedAddMarginMajor: targetMarginMajor,
        calculatedAddMarginMinor: marginMinor,
        effectiveSliderPct: increasePct,
        isOverBudget: overBudget,
      };
    } else {
      const parsedQty = parseFloat(increaseQtyInput);
      const qtyNum = (!isNaN(parsedQty) && parsedQty > 0) ? parsedQty : 0;
      const targetMarginMajor = qtyNum * marginPerUnit;
      const marginMinor = BigInt(Math.max(0, Math.round(targetMarginMajor * (10 ** quoteScale)))).toString();
      const pctOfBalance = freeBalanceMajor > 0 ? (targetMarginMajor / freeBalanceMajor) * 100 : 0;
      const overBudget = freeBalanceMajor > 0 ? targetMarginMajor > freeBalanceMajor + 0.0001 : qtyNum > 0;
      return {
        calculatedAddQty: qtyNum > 0 ? (qtyNum >= 1 ? qtyNum.toFixed(2) : qtyNum.toFixed(4)).replace(/\.?0+$/, '') : '0',
        calculatedAddMarginMajor: targetMarginMajor,
        calculatedAddMarginMinor: marginMinor,
        effectiveSliderPct: Math.min(100, Math.max(0, Math.round(pctOfBalance))),
        isOverBudget: overBudget,
      };
    }
  }, [increaseSizingMode, increasePct, increaseQtyInput, freeBalanceMajor, marginPerUnit, quoteScale]);

  const newTotalQty = useMemo(() => {
    const addNum = parseFloat(calculatedAddQty) || 0;
    return (totalQty + addNum).toFixed(4).replace(/\.?0+$/, '');
  }, [totalQty, calculatedAddQty]);

  const handleSliderChange = (newPct: number) => {
    setIncreasePct(newPct);
    if (increaseSizingMode === 'quantity') {
      const targetMarginMajor = freeBalanceMajor * (newPct / 100);
      const qty = marginPerUnit > 0 ? targetMarginMajor / marginPerUnit : 0;
      const qtyStr = qty > 0 ? (qty >= 1 ? qty.toFixed(2) : qty.toFixed(4)).replace(/\.?0+$/, '') : '';
      setIncreaseQtyInput(qtyStr);
    }
  };

  const handleQuantityInputChange = (val: string) => {
    const sanitized = val.replace(/[^\d.]/g, '');
    setIncreaseQtyInput(sanitized);
    const num = parseFloat(sanitized);
    if (!isNaN(num) && num > 0 && freeBalanceMajor > 0 && marginPerUnit > 0) {
      const reqMargin = num * marginPerUnit;
      const pct = Math.min(100, Math.max(0, Math.round((reqMargin / freeBalanceMajor) * 100)));
      setIncreasePct(pct);
    }
  };

  const toggleSizingMode = (mode: 'percent' | 'quantity') => {
    if (mode === increaseSizingMode) return;
    setIncreaseSizingMode(mode);
    if (mode === 'quantity') {
      if (calculatedAddQty && Number(calculatedAddQty) > 0) {
        setIncreaseQtyInput(calculatedAddQty);
      }
    } else {
      if (effectiveSliderPct > 0) {
        setIncreasePct(effectiveSliderPct);
      }
    }
  };

  // Adjust Leverage State & Calculations
  const currentLev = position.leverage !== null && Number(position.leverage) > 0 ? Number(position.leverage) : 1;
  const [targetLeverage, setTargetLeverage] = useState<string>(() => String(currentLev));
  const [isUpdatingLeverage, setIsUpdatingLeverage] = useState(false);
  const [leverageMsg, setLeverageMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const targetLevNum = Number(targetLeverage);
  const isTargetLevValid = !Number.isNaN(targetLevNum) && targetLevNum >= 1 && targetLevNum <= 100;

  const posMarkPrice = position.markPrice ? Number(position.markPrice) : (position.avgEntryPrice ? Number(position.avgEntryPrice) : 0);
  const posEntryPrice = position.avgEntryPrice ? Number(position.avgEntryPrice) : posMarkPrice;
  const posNotionalMajor = totalQty * posMarkPrice;

  const currentMarginMajor = posNotionalMajor > 0 && currentLev > 0 ? posNotionalMajor / currentLev : lockedMarginMajor;
  const newMarginMajor = isTargetLevValid && targetLevNum > 0 ? posNotionalMajor / targetLevNum : 0;
  const marginDeltaMajor = newMarginMajor - currentMarginMajor;

  const isLevShortfall = marginDeltaMajor > 0 && freeBalanceMajor < marginDeltaMajor;
  const levShortfallMajor = isLevShortfall ? (marginDeltaMajor - freeBalanceMajor) : 0;

  const estNewLiqPrice = useMemo(() => {
    if (!isTargetLevValid || targetLevNum <= 0 || posEntryPrice <= 0) return null;
    const mmr = 0.005;
    if (position.side === 'long') {
      const p = posEntryPrice * (1 - (1 / targetLevNum) + mmr);
      return p > 0 ? (posEntryPrice < 1 ? p.toFixed(6) : p.toFixed(2)) : '0';
    } else if (position.side === 'short') {
      const p = posEntryPrice * (1 + (1 / targetLevNum) - mmr);
      return p > 0 ? (posEntryPrice < 1 ? p.toFixed(6) : p.toFixed(2)) : '0';
    }
    return null;
  }, [isTargetLevValid, targetLevNum, posEntryPrice, position.side]);

  const handleExecuteAdjustLeverage = async () => {
    if (!isTargetLevValid || targetLevNum === currentLev || isLevShortfall || isUpdatingLeverage || isHalted) return;
    setIsUpdatingLeverage(true);
    setLeverageMsg(null);
    try {
      const res = await updateFuturesPositionLeverage(position.venuePositionId, targetLeverage);
      setLeverageMsg({
        kind: 'ok',
        text: `Successfully adjusted leverage to ${res.newLeverage || targetLeverage}×.`,
      });
      await Promise.all([
        handleSyncBalance(),
        qc.invalidateQueries({ queryKey: ['futures-positions'] }),
      ]);
      setTimeout(() => {
        onClose();
      }, 1400);
    } catch (err) {
      setLeverageMsg({
        kind: 'err',
        text: (err as Error).message || 'Failed to update leverage on the exchange.',
      });
    } finally {
      setIsUpdatingLeverage(false);
    }
  };

  return (
    <div className="position-modal-overlay" onClick={onClose}>
      <div className="position-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="position-modal-header">
          <div>
            <h3 className="position-modal-title">
              <span>{position.pair}</span>
              <span
                className="badge"
                style={{
                  color: sideBadgeColor,
                  borderColor: sideBadgeColor,
                  background: position.side === 'long' ? 'rgba(75,181,99,0.12)' : 'rgba(240,85,90,0.12)',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                }}
              >
                {position.side} {position.leverage ? `${position.leverage}×` : ''}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-dim)', fontWeight: 400 }}>
                ({position.marginCurrency})
              </span>
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                {position.accountName}
              </span>
              <span className="group-badge">
                {position.groupName || 'Ungrouped'}
              </span>
            </div>
          </div>
          <button type="button" className="position-modal-close" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>

        {isHalted && (
          <div
            style={{
              backgroundColor: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid var(--danger)',
              borderRadius: 6,
              padding: '10px 14px',
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12.5,
              color: 'var(--danger)',
              fontWeight: 600,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--danger)', display: 'inline-block' }} />
            <span>EMERGENCY KILL SWITCH ACTIVE: Modifications, adjustments, and exits are strictly locked.</span>
          </div>
        )}

        {/* Live Metrics Header Card */}
        <div className="position-modal-metrics">
          <div className="modal-metric-card">
            <span className="modal-metric-label">Unrealised PnL</span>
            <span
              className="modal-metric-value"
              style={{
                fontSize: 16,
                fontWeight: 800,
                color: (position.unrealisedPnlMinor && position.unrealisedPnlMinor.startsWith('-'))
                  ? '#ef4444'
                  : (position.unrealisedPnlMinor && position.unrealisedPnlMinor !== '0')
                    ? '#10b981'
                    : 'var(--text-dim)',
              }}
            >
              {pnlText(position.unrealisedPnlMinor, position.marginCurrency)}
              {roe !== null && (
                <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 6, color: roe >= 0 ? '#10b981' : '#ef4444' }}>
                  {roeText(roe).trim()}
                </span>
              )}
            </span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Position Size</span>
            <span className="modal-metric-value">{position.quantity}</span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Margin Invested</span>
            <span className="modal-metric-value">
              {position.lockedMarginMinor ? fmtMinor(position.lockedMarginMinor, position.marginCurrency) : '—'}
            </span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Entry Price</span>
            <span className="modal-metric-value">{fmtPrice(position.avgEntryPrice)}</span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Live Price</span>
            <span className="modal-metric-value" style={{ color: 'var(--accent)' }}>
              {fmtPrice(position.markPrice)}
            </span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Liquidation Price</span>
            <span className="modal-metric-value" style={{ color: '#facc15', fontWeight: 700, fontSize: 15 }}>
              {fmtPrice(position.liquidationPrice)}
              {position.liqBufferBp !== null && (
                <span style={{ fontSize: 11, color: '#ca8a04', fontWeight: 600, display: 'block' }}>
                  {(position.liqBufferBp / 100).toFixed(1)}% buffer
                </span>
              )}
            </span>
          </div>
        </div>

        {/* Action Tabs */}
        <div className="position-modal-tabs">
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'protection' ? 'active' : ''}`}
            onClick={() => setActiveTab('protection')}
          >
            SL / TP Protection
          </button>
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'partial' ? 'active' : ''}`}
            onClick={() => setActiveTab('partial')}
          >
            Partial Exit
          </button>
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'increase' ? 'active' : ''}`}
            onClick={() => setActiveTab('increase')}
          >
            Add / Increase
          </button>
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'leverage' ? 'active' : ''}`}
            onClick={() => setActiveTab('leverage')}
          >
            Adjust Leverage
          </button>
          <button
            type="button"
            className={`position-modal-tab danger-tab ${activeTab === 'close' ? 'active' : ''}`}
            onClick={() => { setActiveTab('close'); setConfirmExit(false); }}
          >
            Close Position
          </button>
        </div>

        {/* Tab Body */}
        <div className="position-modal-body">
          {/* ── Tab 1: SL/TP Protection ── */}
          {activeTab === 'protection' && (
            <div>
              {/* Strategy Presets Bar */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Protection Strategy
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--panel-2)', padding: '2px 4px', borderRadius: 'var(--radius-pill)', border: '1px solid var(--line)' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        padding: '2px 10px', fontSize: 11,
                        background: slTpMode === 'percent' ? 'var(--accent)' : 'transparent',
                        color: slTpMode === 'percent' ? '#000000' : 'var(--muted)',
                        fontWeight: slTpMode === 'percent' ? 700 : 400,
                        border: 'none',
                      }}
                      onClick={() => setSlTpMode('percent')}
                    >
                      % Percent
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        padding: '2px 10px', fontSize: 11,
                        background: slTpMode === 'price' ? 'var(--accent)' : 'transparent',
                        color: slTpMode === 'price' ? '#000000' : 'var(--muted)',
                        fontWeight: slTpMode === 'price' ? 700 : 400,
                        border: 'none',
                      }}
                      onClick={() => setSlTpMode('price')}
                    >
                      Exact Price
                    </button>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, background: 'var(--surface-3)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: 3 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-pressed={currentProtectionPreset === 'both'}
                    style={{
                      padding: '4px 6px',
                      fontSize: 11,
                      fontWeight: currentProtectionPreset === 'both' ? 700 : 500,
                      background: currentProtectionPreset === 'both' ? '#ffffff' : 'transparent',
                      color: currentProtectionPreset === 'both' ? '#000000' : 'var(--muted)',
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
                    aria-pressed={currentProtectionPreset === 'tp_only'}
                    style={{
                      padding: '4px 6px',
                      fontSize: 11,
                      fontWeight: currentProtectionPreset === 'tp_only' ? 700 : 500,
                      background: currentProtectionPreset === 'tp_only' ? '#10b981' : 'transparent',
                      color: currentProtectionPreset === 'tp_only' ? '#000000' : 'var(--muted)',
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
                    aria-pressed={currentProtectionPreset === 'sl_only'}
                    style={{
                      padding: '4px 6px',
                      fontSize: 11,
                      fontWeight: currentProtectionPreset === 'sl_only' ? 700 : 500,
                      background: currentProtectionPreset === 'sl_only' ? '#ef4444' : 'transparent',
                      color: currentProtectionPreset === 'sl_only' ? '#ffffff' : 'var(--muted)',
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
                    aria-pressed={currentProtectionPreset === 'none'}
                    style={{
                      padding: '4px 6px',
                      fontSize: 11,
                      fontWeight: currentProtectionPreset === 'none' ? 700 : 500,
                      background: currentProtectionPreset === 'none' ? 'var(--panel-2)' : 'transparent',
                      color: currentProtectionPreset === 'none' ? '#ffffff' : 'var(--text-dim)',
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

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                {/* Stop Loss Card */}
                <div style={{
                  background: 'var(--panel-2)',
                  border: `1px solid ${enableSl ? 'rgba(239, 68, 68, 0.3)' : 'var(--line)'}`,
                  borderRadius: 'var(--radius)',
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
                          if (checked && slTpMode === 'percent' && (!slPct || Number(slPct) <= 0)) {
                            setSlPct('5');
                          }
                        }}
                        style={{ width: 14, height: 14, cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: enableSl ? '#f87171' : 'var(--muted)' }}>
                        Stop Loss
                      </span>
                      <span style={{
                        fontSize: 9.5,
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: enableSl ? 'rgba(239, 68, 68, 0.15)' : 'var(--surface-3)',
                        color: enableSl ? '#f87171' : 'var(--text-dim)',
                        border: `1px solid ${enableSl ? 'rgba(239, 68, 68, 0.3)' : 'var(--line)'}`,
                        textTransform: 'uppercase',
                      }}>
                        {enableSl ? 'Active' : 'Disabled'}
                      </span>
                    </label>
                  </div>

                  {!enableSl ? (
                    <div style={{ fontSize: 11.5, color: 'var(--text-dim)', padding: '6px 0', fontStyle: 'italic' }}>
                      Stop Loss is disabled. No stop-loss order will be placed. Check the box above or select SL Only / Both to enable.
                    </div>
                  ) : slTpMode === 'price' ? (
                    <>
                      <input
                        id="modal-sl"
                        inputMode="decimal"
                        value={sl}
                        onChange={(e) => setSl(e.target.value)}
                        placeholder="Trigger Price, e.g. 80000"
                        style={{ marginTop: 4, width: '100%' }}
                      />
                      {sl !== '' && Number(sl) <= 0 && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Trigger price must be greater than 0.
                        </div>
                      )}
                      {sl !== '' && Number(sl) > 0 && hasRef && sideOk && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          ≈ {triggerToPct(refPrice, Number(sl), position.side as 'long' | 'short', 'sl').toFixed(2)}% loss from entry
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <input
                        id="modal-sl"
                        inputMode="decimal"
                        value={slPct}
                        placeholder="Distance %, e.g. 5"
                        onChange={(e) => setSlPct(e.target.value.replace(/[^\d.]/g, ''))}
                        style={{ marginTop: 4, width: '100%' }}
                      />
                      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                        {SL_PCT_CHIPS.map((v) => (
                          <button
                            key={v}
                            type="button"
                            className="btn btn-sm secondary"
                            style={{
                              flex: 1, padding: '3px 0', fontSize: 11,
                              background: slPct === String(v) ? 'var(--danger)' : 'var(--surface-3)',
                              color: slPct === String(v) ? '#fff' : 'var(--text-dim)',
                              borderColor: slPct === String(v) ? 'var(--danger)' : 'var(--line)',
                            }}
                            onClick={() => setSlPct(String(v))}
                          >
                            {v}%
                          </button>
                        ))}
                      </div>
                      {slPct !== '' && Number(slPct) <= 0 && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Distance % must be greater than 0%. Entering 0% would trigger an immediate exit at market price.
                        </div>
                      )}
                      {hasRef && sideOk && slPct !== '' && Number(slPct) > 0 && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Target Price: {fmtPrice(String(pctToTrigger(refPrice, Number(slPct), position.side as 'long' | 'short', 'sl')))}
                        </div>
                      )}
                    </>
                  )}

                  {enableSl && (
                    <div style={{ display: 'flex', alignItems: 'center', marginTop: 10, gap: 6 }}>
                      <input
                        type="checkbox"
                        id="modal-trailing"
                        checked={trailing}
                        onChange={(e) => setTrailing(e.target.checked)}
                        style={{ width: 14, height: 14, cursor: 'pointer' }}
                      />
                      <label htmlFor="modal-trailing" style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}>
                        Auto-Trailing SL (1% step)
                      </label>
                    </div>
                  )}
                </div>

                {/* Take Profit Card */}
                <div style={{
                  background: 'var(--panel-2)',
                  border: `1px solid ${enableTp ? 'rgba(52, 211, 153, 0.3)' : 'var(--line)'}`,
                  borderRadius: 'var(--radius)',
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
                          if (checked && slTpMode === 'percent' && (!tpPct || Number(tpPct) <= 0)) {
                            setTpPct('10');
                          }
                        }}
                        style={{ width: 14, height: 14, cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: enableTp ? '#34d399' : 'var(--muted)' }}>
                        Take Profit
                      </span>
                      <span style={{
                        fontSize: 9.5,
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: enableTp ? 'rgba(52, 211, 153, 0.15)' : 'var(--surface-3)',
                        color: enableTp ? '#34d399' : 'var(--text-dim)',
                        border: `1px solid ${enableTp ? 'rgba(52, 211, 153, 0.3)' : 'var(--line)'}`,
                        textTransform: 'uppercase',
                      }}>
                        {enableTp ? 'Active' : 'Disabled'}
                      </span>
                    </label>
                  </div>

                  {!enableTp ? (
                    <div style={{ fontSize: 11.5, color: 'var(--text-dim)', padding: '6px 0', fontStyle: 'italic' }}>
                      Take Profit is disabled. No take-profit order will be placed. Check the box above or select TP Only / Both to enable.
                    </div>
                  ) : slTpMode === 'price' ? (
                    <>
                      <input
                        id="modal-tp"
                        inputMode="decimal"
                        value={tp}
                        onChange={(e) => setTp(e.target.value)}
                        placeholder="Target Price, e.g. 92000"
                        style={{ marginTop: 4, width: '100%' }}
                      />
                      {tp !== '' && Number(tp) <= 0 && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Target price must be greater than 0.
                        </div>
                      )}
                      {tp !== '' && Number(tp) > 0 && hasRef && sideOk && (
                        <div className="hint" style={{ color: 'var(--ok)', fontSize: 11, marginTop: 4 }}>
                          ≈ {triggerToPct(refPrice, Number(tp), position.side as 'long' | 'short', 'tp').toFixed(2)}% gain from entry
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <input
                        id="modal-tp"
                        inputMode="decimal"
                        value={tpPct}
                        placeholder="Target %, e.g. 10"
                        onChange={(e) => setTpPct(e.target.value.replace(/[^\d.]/g, ''))}
                        style={{ marginTop: 4, width: '100%' }}
                      />
                      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                        {TP_PCT_CHIPS.map((v) => (
                          <button
                            key={v}
                            type="button"
                            className="btn btn-sm secondary"
                            style={{
                              flex: 1, padding: '3px 0', fontSize: 11,
                              background: tpPct === String(v) ? 'var(--ok)' : 'var(--surface-3)',
                              color: tpPct === String(v) ? '#000000' : 'var(--text-dim)',
                              borderColor: tpPct === String(v) ? 'var(--ok)' : 'var(--line)',
                              fontWeight: tpPct === String(v) ? 700 : 500,
                            }}
                            onClick={() => setTpPct(String(v))}
                          >
                            {v}%
                          </button>
                        ))}
                      </div>
                      {tpPct !== '' && Number(tpPct) <= 0 && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Target % must be greater than 0%.
                        </div>
                      )}
                      {hasRef && sideOk && tpPct !== '' && Number(tpPct) > 0 && (
                        <div className="hint" style={{ color: 'var(--ok)', fontSize: 11, marginTop: 4 }}>
                          Target Price: {fmtPrice(String(pctToTrigger(refPrice, Number(tpPct), position.side as 'long' | 'short', 'tp')))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 20 }}>
                <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isProtecting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!canSaveProtection || isProtecting || isHalted}
                  onClick={() => onProtection({
                    id: position.venuePositionId,
                    slp: (enableSl && effectiveSl) ? effectiveSl : undefined,
                    tpp: (enableTp && effectiveTp) ? effectiveTp : undefined,
                    trailing: enableSl ? trailing : false,
                  })}
                >
                  {isProtecting
                    ? 'Updating Protection…'
                    : (!enableSl && !enableTp)
                      ? 'Select TP or SL Strategy'
                      : (enableTp && !enableSl)
                        ? 'Save Take Profit'
                        : (enableSl && !enableTp)
                          ? 'Save Stop Loss'
                          : 'Save Protection Rules'}
                </button>
              </div>
            </div>
          )}

          {/* ── Tab 2: Partial Exit ── */}
          {activeTab === 'partial' && (
            <div>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Safely scale out of this position by selling a portion at current market. The remainder stays open with your current leverage and protection.
              </p>

              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>Select percentage to close:</span>
                  <strong style={{ fontSize: 14, color: '#f59e0b' }}>−{reducePct}%</strong>
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  {REDUCE_PCT_CHIPS.map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      className="btn btn-sm secondary"
                      style={{
                        flex: 1,
                        minWidth: 50,
                        padding: '6px 0',
                        fontSize: 12,
                        background: reducePct === pct && !isCustomReduce ? '#f59e0b' : 'var(--surface-3)',
                        color: reducePct === pct && !isCustomReduce ? '#000000' : 'var(--text-dim)',
                        borderColor: reducePct === pct && !isCustomReduce ? '#f59e0b' : 'var(--line)',
                        fontWeight: reducePct === pct && !isCustomReduce ? 700 : 500,
                      }}
                      onClick={() => {
                        setReducePct(pct);
                        setCustomReduceInput('');
                      }}
                    >
                      −{pct}%
                    </button>
                  ))}

                  {/* Custom % Input */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1.3, minWidth: 100 }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Custom %"
                      value={customReduceInput}
                      onChange={(e) => {
                        const val = e.target.value.replace(/[^\d.]/g, '');
                        setCustomReduceInput(val);
                        const num = parseFloat(val);
                        if (!isNaN(num) && num > 0 && num < 100) {
                          setReducePct(num);
                        }
                      }}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        fontSize: 12,
                        background: isCustomReduce ? 'rgba(245, 158, 11, 0.15)' : 'var(--surface-3)',
                        borderColor: isCustomReduce ? '#f59e0b' : 'var(--line)',
                        color: isCustomReduce ? '#f59e0b' : 'var(--text)',
                        fontWeight: isCustomReduce ? 700 : 400,
                        textAlign: 'center',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>%</span>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', paddingTop: 10, borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Selling Size: </span>
                    <strong style={{ color: '#f59e0b' }}>{reduceQty}</strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Remaining Size: </span>
                    <strong style={{ color: 'var(--text)' }}>{remainQty}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Est. Margin Released: </span>
                    <strong style={{ color: '#f59e0b' }}>
                      {reduceMarginMinor ? fmtMinor(reduceMarginMinor, position.marginCurrency) : '—'}
                    </strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Est. Margin Remaining: </span>
                    <span style={{ color: 'var(--text)' }}>
                      {position.lockedMarginMinor && reduceMarginMinor
                        ? fmtMinor(String(BigInt(position.lockedMarginMinor) - BigInt(reduceMarginMinor)), position.marginCurrency)
                        : '—'}
                    </span>
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isAdjusting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{
                    background: '#f59e0b',
                    color: '#000000',
                    fontWeight: 700,
                    border: 'none',
                  }}
                  disabled={isAdjusting || isHalted || reducePct <= 0 || reducePct >= 100}
                  onClick={() => onAdjust(position.venuePositionId, 'reduce', Math.round(reducePct * 100))}
                >
                  {isAdjusting ? 'Executing Partial Exit…' : `Close ${reducePct}% (${reduceQty} ${position.pair.split('_')[0].replace(/^[A-Z]-/, '')})`}
                </button>
              </div>
            </div>
          )}

          {/* ── Tab 3: Add / Increase ── */}
          {activeTab === 'increase' && (
            <div>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Add more size to this existing position at current market price using account available free balance.
              </p>

              {/* Account Free Cash Card with Live Sync Button */}
              <div
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius)',
                  padding: '10px 14px',
                  marginBottom: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                      Available Free Balance ({position.accountName})
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 16, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
                      {accountFreeCashMinor !== null ? fmtMinor(accountFreeCashMinor, position.marginCurrency) : '—'}
                    </strong>
                    <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                      • {position.groupName || 'Ungrouped'}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  className="btn btn-sm secondary"
                  onClick={() => void handleSyncBalance()}
                  disabled={isRefreshing}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '4px 10px',
                    fontSize: 11.5,
                    whiteSpace: 'nowrap',
                  }}
                  title="Sync live account balance from exchange"
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: isRefreshing ? 'spin 1s linear infinite' : 'none' }}>
                    <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                  </svg>
                  {isRefreshing ? 'Syncing…' : 'Sync Balance'}
                </button>
              </div>

              {/* Sizing Controls Card */}
              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 16 }}>
                {/* Mode Selector Toggle */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Sizing Mode
                  </span>
                  <div style={{ display: 'flex', gap: 4, background: 'var(--surface-3)', padding: 3, borderRadius: 'var(--radius-pill)', border: '1px solid var(--line)' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        padding: '2px 10px',
                        fontSize: 11,
                        background: increaseSizingMode === 'percent' ? 'var(--ok)' : 'transparent',
                        color: increaseSizingMode === 'percent' ? '#000000' : 'var(--muted)',
                        fontWeight: increaseSizingMode === 'percent' ? 700 : 500,
                        border: 'none',
                        borderRadius: 'var(--radius-pill)',
                        cursor: 'pointer',
                      }}
                      onClick={() => toggleSizingMode('percent')}
                    >
                      % of Free Balance
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        padding: '2px 10px',
                        fontSize: 11,
                        background: increaseSizingMode === 'quantity' ? 'var(--ok)' : 'transparent',
                        color: increaseSizingMode === 'quantity' ? '#000000' : 'var(--muted)',
                        fontWeight: increaseSizingMode === 'quantity' ? 700 : 500,
                        border: 'none',
                        borderRadius: 'var(--radius-pill)',
                        cursor: 'pointer',
                      }}
                      onClick={() => toggleSizingMode('quantity')}
                    >
                      Exact Quantity
                    </button>
                  </div>
                </div>

                {/* Sizing Input Area */}
                {increaseSizingMode === 'percent' ? (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>Allocate from available balance:</span>
                      <strong style={{ fontSize: 14, color: 'var(--ok)' }}>{increasePct}%</strong>
                    </div>

                    {/* Quick % Chips */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                      {INCREASE_PCT_CHIPS.map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          className="btn btn-sm secondary"
                          style={{
                            flex: 1,
                            minWidth: 54,
                            padding: '6px 0',
                            fontSize: 12,
                            background: increasePct === pct && !isCustomIncrease ? 'var(--ok)' : 'var(--surface-3)',
                            color: increasePct === pct && !isCustomIncrease ? '#000000' : 'var(--text-dim)',
                            borderColor: increasePct === pct && !isCustomIncrease ? 'var(--ok)' : 'var(--line)',
                            fontWeight: increasePct === pct && !isCustomIncrease ? 700 : 500,
                          }}
                          onClick={() => {
                            setIncreasePct(pct);
                            setCustomIncreaseInput('');
                          }}
                        >
                          +{pct}%
                        </button>
                      ))}

                      {/* Custom % Field */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1.3, minWidth: 100 }}>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="Custom %"
                          value={customIncreaseInput}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^\d.]/g, '');
                            setCustomIncreaseInput(val);
                            const num = parseFloat(val);
                            if (!isNaN(num) && num >= 0 && num <= 100) {
                              setIncreasePct(num);
                            }
                          }}
                          style={{
                            width: '100%',
                            padding: '6px 8px',
                            fontSize: 12,
                            background: isCustomIncrease ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface-3)',
                            borderColor: isCustomIncrease ? 'var(--ok)' : 'var(--line)',
                            color: isCustomIncrease ? 'var(--ok)' : 'var(--text)',
                            fontWeight: isCustomIncrease ? 700 : 400,
                            textAlign: 'center',
                            borderRadius: 'var(--radius-sm)',
                          }}
                        />
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>%</span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <label htmlFor="increase-qty-input" style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                        Quantity to add:
                      </label>
                      <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                        ≈ {effectiveSliderPct}% of available balance
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        id="increase-qty-input"
                        type="text"
                        inputMode="decimal"
                        placeholder="e.g. 0.05"
                        value={increaseQtyInput}
                        onChange={(e) => handleQuantityInputChange(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '8px 12px',
                          fontSize: 13,
                          background: 'var(--surface-3)',
                          borderColor: isOverBudget ? 'var(--danger)' : 'var(--line)',
                          borderRadius: 'var(--radius-sm)',
                          color: 'var(--text)',
                          fontWeight: 600,
                        }}
                      />
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {position.pair.split('_')[0].replace(/^[A-Z]-/, '')}
                      </span>
                    </div>

                    {/* Quick % Chips in Quantity mode */}
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      {INCREASE_PCT_CHIPS.map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          className="btn btn-sm secondary"
                          style={{
                            flex: 1,
                            padding: '4px 0',
                            fontSize: 11,
                            background: effectiveSliderPct === pct ? 'var(--ok)' : 'var(--surface-3)',
                            color: effectiveSliderPct === pct ? '#000000' : 'var(--text-dim)',
                            borderColor: effectiveSliderPct === pct ? 'var(--ok)' : 'var(--line)',
                            fontWeight: effectiveSliderPct === pct ? 700 : 500,
                          }}
                          onClick={() => {
                            handleSliderChange(pct);
                          }}
                        >
                          +{pct}%
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Interactive 0% to 100% Range Slider */}
                <div style={{ margin: '14px 0 10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, fontSize: 11.5, color: 'var(--muted)' }}>
                    <span>0% (Min)</span>
                    <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                      Slide: {effectiveSliderPct}% ({calculatedAddQty} {position.pair.split('_')[0].replace(/^[A-Z]-/, '')})
                    </span>
                    <span>100% (Max Free Balance)</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={effectiveSliderPct}
                    onChange={(e) => handleSliderChange(Number(e.target.value))}
                    style={{
                      width: '100%',
                      cursor: 'pointer',
                      accentColor: isOverBudget ? 'var(--danger)' : 'var(--ok)',
                    }}
                  />
                </div>

                {/* Financial Breakdown Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', paddingTop: 12, borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Adding Size: </span>
                    <strong style={{ color: 'var(--ok)' }}>+{calculatedAddQty}</strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Estimated Margin Needed: </span>
                    <strong style={{ color: isOverBudget ? 'var(--danger)' : 'var(--ok)' }}>
                      {fmtMinor(calculatedAddMarginMinor, position.marginCurrency)}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Current Position Size: </span>
                    <span style={{ color: 'var(--text)' }}>{totalQty}</span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>New Total Size: </span>
                    <strong style={{ color: 'var(--text)' }}>{newTotalQty}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Current Locked Margin: </span>
                    <span style={{ color: 'var(--text)' }}>
                      {position.lockedMarginMinor ? fmtMinor(position.lockedMarginMinor, position.marginCurrency) : '—'}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>New Est. Total Margin: </span>
                    <strong style={{ color: 'var(--text)' }}>
                      {fmtMinor(addMinors(position.lockedMarginMinor || '0', calculatedAddMarginMinor), position.marginCurrency)}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Remaining Free Cash: </span>
                    <span style={{ color: isOverBudget ? 'var(--danger)' : 'var(--text)', fontWeight: isOverBudget ? 700 : 400 }}>
                      {freeBalanceMajor >= calculatedAddMarginMajor
                        ? fmtMinor(BigInt(Math.max(0, Math.round((freeBalanceMajor - calculatedAddMarginMajor) * (10 ** quoteScale)))).toString(), position.marginCurrency)
                        : `${fmtMinor(BigInt(Math.round((calculatedAddMarginMajor - freeBalanceMajor) * (10 ** quoteScale))).toString(), position.marginCurrency)} (Deficit)`}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Leverage: </span>
                    <span style={{ color: 'var(--text)' }}>{position.leverage ? `${position.leverage}x` : '1x'}</span>
                  </div>
                </div>

                {/* Warning if requested funds exceed available free cash */}
                {isOverBudget && (
                  <div
                    style={{
                      marginTop: 12,
                      padding: '8px 12px',
                      background: 'rgba(240, 85, 90, 0.12)',
                      border: '1px solid var(--danger)',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: 12,
                      color: 'var(--danger)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <span>
                      Estimated margin needed ({fmtMinor(calculatedAddMarginMinor, position.marginCurrency)}) exceeds available free balance in {position.accountName} ({accountFreeCashMinor !== null ? fmtMinor(accountFreeCashMinor, position.marginCurrency) : '—'})!
                    </span>
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isAdjusting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ background: 'var(--ok)', color: '#000000', fontWeight: 700, border: 'none' }}
                  disabled={isAdjusting || isHalted || Number(calculatedAddQty) <= 0 || isOverBudget}
                  onClick={() => onAdjust(position.venuePositionId, 'increase', undefined, calculatedAddQty)}
                >
                  {isAdjusting ? 'Increasing Position…' : `Add +${calculatedAddQty} Qty • Est. Margin ${fmtMinor(calculatedAddMarginMinor, position.marginCurrency)}`}
                </button>
              </div>
            </div>
          )}

          {/* ── Tab 4: Adjust Leverage ── */}
          {activeTab === 'leverage' && (
            <div>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Adjust the leverage for this open position. Decreasing leverage requires additional free balance in your account as margin. Increasing leverage reduces margin but increases liquidation risk.
              </p>

              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>Current Leverage:</span>
                    <span className="pos-lev-pill">{currentLev}×</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>Target Leverage:</span>
                    <strong style={{ fontSize: 16, color: '#818cf8', fontWeight: 800 }}>{targetLeverage}×</strong>
                  </div>
                </div>

                {/* Preset Chips */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                  {LEVERAGE_PRESET_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className="btn btn-sm secondary"
                      style={{
                        flex: '1 1 0px',
                        minWidth: 40,
                        padding: '5px 0',
                        fontSize: 11.5,
                        background: Number(targetLeverage) === chip ? '#6366f1' : 'var(--surface-3)',
                        color: Number(targetLeverage) === chip ? '#ffffff' : 'var(--text-dim)',
                        borderColor: Number(targetLeverage) === chip ? '#6366f1' : 'var(--line)',
                        fontWeight: Number(targetLeverage) === chip ? 700 : 500,
                      }}
                      onClick={() => setTargetLeverage(String(chip))}
                    >
                      {chip}×
                    </button>
                  ))}
                </div>

                {/* Stepper + Direct Input */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                  <button
                    type="button"
                    className="btn btn-sm secondary"
                    style={{ width: 38, height: 34, fontSize: 16, fontWeight: 700, padding: 0 }}
                    disabled={Number(targetLeverage) <= 1}
                    onClick={() => {
                      const cur = Number(targetLeverage) || 1;
                      const next = Math.max(1, Math.round((cur - 0.5) * 10) / 10);
                      setTargetLeverage(String(next));
                    }}
                  >
                    −
                  </button>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={targetLeverage}
                      onChange={(e) => {
                        const val = e.target.value.replace(/[^\d.]/g, '');
                        setTargetLeverage(val);
                      }}
                      placeholder="e.g. 3.5"
                      style={{
                        width: '100%',
                        padding: '6px 28px 6px 12px',
                        fontSize: 13,
                        fontWeight: 700,
                        textAlign: 'center',
                        background: 'var(--surface-3)',
                        borderColor: isTargetLevValid ? 'var(--line)' : 'var(--danger)',
                        borderRadius: 'var(--radius-sm)',
                        color: 'var(--text)',
                      }}
                    />
                    <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                      ×
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm secondary"
                    style={{ width: 38, height: 34, fontSize: 16, fontWeight: 700, padding: 0 }}
                    disabled={Number(targetLeverage) >= 100}
                    onClick={() => {
                      const cur = Number(targetLeverage) || 1;
                      const next = Math.min(100, Math.round((cur + 0.5) * 10) / 10);
                      setTargetLeverage(String(next));
                    }}
                  >
                    +
                  </button>
                </div>

                {/* Interactive Leverage Slider */}
                <div style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                    <span>1× (Low risk)</span>
                    <span style={{ color: 'var(--text)', fontWeight: 600 }}>Slide to adjust: {targetLeverage}×</span>
                    <span>100× (High risk)</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="100"
                    step="0.5"
                    value={Number(targetLeverage) || 1}
                    onChange={(e) => setTargetLeverage(e.target.value)}
                    style={{
                      width: '100%',
                      cursor: 'pointer',
                      accentColor: '#818cf8',
                    }}
                  />
                </div>

                {/* Financial Breakdown Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', paddingTop: 12, borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Current Margin: </span>
                    <strong>{currentMarginMajor > 0 ? (position.marginCurrency === 'INR' ? `₹${currentMarginMajor.toFixed(2)}` : `${currentMarginMajor.toFixed(4)} USDT`) : '—'}</strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>New Required Margin: </span>
                    <strong>{newMarginMajor > 0 ? (position.marginCurrency === 'INR' ? `₹${newMarginMajor.toFixed(2)}` : `${newMarginMajor.toFixed(4)} USDT`) : '—'}</strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Margin Change: </span>
                    <strong style={{ color: marginDeltaMajor > 0 ? (isLevShortfall ? 'var(--danger)' : '#f59e0b') : 'var(--ok)' }}>
                      {marginDeltaMajor > 0
                        ? `+${position.marginCurrency === 'INR' ? `₹${marginDeltaMajor.toFixed(2)}` : `${marginDeltaMajor.toFixed(4)} USDT`} (Needs more)`
                        : marginDeltaMajor < 0
                          ? `−${position.marginCurrency === 'INR' ? `₹${Math.abs(marginDeltaMajor).toFixed(2)}` : `${Math.abs(marginDeltaMajor).toFixed(4)} USDT`} (To be freed)`
                          : '0.00'}
                    </strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Available Free Balance: </span>
                    <strong style={{ color: isLevShortfall ? 'var(--danger)' : 'var(--ok)' }}>
                      {position.marginCurrency === 'INR' ? `₹${freeBalanceMajor.toFixed(2)}` : `${freeBalanceMajor.toFixed(4)} USDT`}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Current Liq. Price: </span>
                    <span className="mono" style={{ color: '#facc15' }}>{fmtPrice(position.liquidationPrice)}</span>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Est. New Liq. Price: </span>
                    <span className="mono" style={{ color: '#facc15', fontWeight: 700 }}>{fmtPrice(estNewLiqPrice)}</span>
                  </div>
                </div>
              </div>

              {isLevShortfall && (
                <div style={{ background: 'rgba(239, 68, 68, 0.12)', border: '1px solid var(--danger)', borderRadius: 6, padding: '10px 14px', marginBottom: 14, fontSize: 12.5, color: 'var(--danger)' }}>
                  <strong>Insufficient Free Balance: </strong>
                  Lowering leverage to {targetLeverage}× requires {position.marginCurrency === 'INR' ? `₹${marginDeltaMajor.toFixed(2)}` : `${marginDeltaMajor.toFixed(4)} USDT`} additional margin, but this account has only {position.marginCurrency === 'INR' ? `₹${freeBalanceMajor.toFixed(2)}` : `${freeBalanceMajor.toFixed(4)} USDT`} free. You need at least {position.marginCurrency === 'INR' ? `₹${levShortfallMajor.toFixed(2)}` : `${levShortfallMajor.toFixed(4)} USDT`} more.
                </div>
              )}

              {leverageMsg && (
                <div style={{
                  background: leverageMsg.kind === 'ok' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                  border: `1px solid ${leverageMsg.kind === 'ok' ? 'var(--ok)' : 'var(--danger)'}`,
                  color: leverageMsg.kind === 'ok' ? 'var(--ok)' : 'var(--danger)',
                  borderRadius: 6,
                  padding: '10px 14px',
                  marginBottom: 14,
                  fontSize: 12.5,
                  fontWeight: 600,
                }}>
                  {leverageMsg.text}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm secondary"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}
                  disabled={isSyncingBalance}
                  onClick={handleSyncBalance}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    width="12"
                    height="12"
                    style={{ animation: isSyncingBalance ? 'spin 1s linear infinite' : 'none' }}
                  >
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                  {isSyncingBalance ? 'Syncing Balance…' : 'Sync Live Balance'}
                </button>

                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isUpdatingLeverage}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ background: '#6366f1', color: '#ffffff', fontWeight: 700, border: 'none' }}
                    disabled={!isTargetLevValid || targetLevNum === currentLev || isLevShortfall || isUpdatingLeverage || isHalted}
                    onClick={handleExecuteAdjustLeverage}
                  >
                    {isUpdatingLeverage
                      ? 'Updating Leverage…'
                      : targetLevNum === currentLev
                        ? `Already at ${currentLev}×`
                        : `Adjust Leverage to ${targetLeverage}×`}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Tab 5: Close Position (Two-Step Accidental Protection) ── */}
          {activeTab === 'close' && (
            <div>
              <div
                style={{
                  border: '1px solid rgba(240, 85, 90, 0.4)',
                  background: 'rgba(240, 85, 90, 0.08)',
                  borderRadius: 'var(--radius)',
                  padding: 16,
                  marginBottom: 16,
                }}
              >
                <h4 style={{ margin: '0 0 8px', color: 'var(--danger)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Full Market Exit Confirmation
                </h4>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
                  Closing this position will immediately execute a market order on CoinDCX for the entire <strong>{position.quantity}</strong>.
                </p>
                <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  <li>Any attached Stop Loss or Take Profit orders will be safely cancelled first.</li>
                  <li>Estimated PnL to be realized: <strong className={pnlClass(position.unrealisedPnlMinor)}>{pnlText(position.unrealisedPnlMinor, position.marginCurrency)}</strong></li>
                  <li>Margin released: <strong>{position.lockedMarginMinor ? fmtMinor(position.lockedMarginMinor, position.marginCurrency) : '—'}</strong></li>
                </ul>
              </div>

              {!confirmExit ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isExiting}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ background: 'var(--danger)', color: '#fff', border: 'none' }}
                    disabled={isExiting || isHalted}
                    onClick={() => setConfirmExit(true)}
                  >
                    Close Position at Market
                  </button>
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 12,
                    padding: 14,
                    background: 'rgba(240, 85, 90, 0.15)',
                    borderRadius: 'var(--radius)',
                    border: '1px solid var(--danger)',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', textAlign: 'right' }}>
                    Are you absolutely sure? Real money position will be closed immediately!
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-sm secondary"
                      onClick={() => setConfirmExit(false)}
                      disabled={isExiting}
                    >
                      No, Keep Position
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ background: 'var(--danger)', color: '#fff', border: 'none', fontWeight: 700 }}
                      disabled={isExiting || isHalted}
                      onClick={() => onExit(position.venuePositionId, position.marginCurrency)}
                    >
                      {isExiting ? 'Closing Position Now…' : 'YES, CONFIRM MARKET EXIT'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Group Position Management Modal (Safe Bulk Actions & Eligibility Fan-Out) ─── */

interface GroupPositionManageModalProps {
  readonly group: PositionGroup;
  readonly onClose: () => void;
  readonly onRefreshPositions: () => void;
  readonly isHalted?: boolean | undefined;
}

function GroupPositionManageModal({
  group,
  onClose,
  onRefreshPositions,
  isHalted,
}: GroupPositionManageModalProps) {
  const [activeTab, setActiveTab] = useState<'increase' | 'partial' | 'protection' | 'leverage' | 'close'>('increase');
  const [confirmExit, setConfirmExit] = useState(false);

  // Single balance fetch on modal mount (no 3s interval!)
  const accountsQuery = useQuery({
    queryKey: ['accounts'],
    queryFn: fetchAccounts,
    refetchInterval: false,
    staleTime: 60_000,
  });

  const [isSyncingAllBalances, setIsSyncingAllBalances] = useState(false);

  const handleSyncAllBalances = async () => {
    if (group.positions.length === 0 || isSyncingAllBalances) return;
    setIsSyncingAllBalances(true);
    try {
      const accountIds = Array.from(new Set(group.positions.map((p) => p.accountId)));
      await mapConcurrent(accountIds, 8, async (accId) => {
        try {
          await syncAccount(accId);
        } catch (err) {
          console.error(`Failed to sync balance for account ${accId}:`, err);
        }
      });
      await Promise.all([
        accountsQuery.refetch(),
        onRefreshPositions(),
      ]);
    } finally {
      setIsSyncingAllBalances(false);
    }
  };

  const isRefreshing = isSyncingAllBalances || accountsQuery.isFetching;

  // Sizing mode & states
  const [groupIncreaseSizingMode, setGroupIncreaseSizingMode] = useState<'percent' | 'quantity'>('percent');
  const [increasePct, setIncreasePct] = useState<number>(25);
  const [customIncreaseInput, setCustomIncreaseInput] = useState<string>('');
  const isCustomIncrease = customIncreaseInput !== '' && Number(customIncreaseInput) === increasePct;
  const [groupIncreaseQtyInput, setGroupIncreaseQtyInput] = useState<string>('0.01');

  const [reducePct, setReducePct] = useState<number>(25);
  const [customReduceInput, setCustomReduceInput] = useState<string>('');
  const isCustomReduce = customReduceInput !== '' && Number(customReduceInput) === reducePct;

  // Group Leverage States
  const [groupTargetLeverage, setGroupTargetLeverage] = useState<string>('5');
  const [groupLeverageSelection, setGroupLeverageSelection] = useState<Record<string, boolean>>({});
  const [isExecutingLeverage, setIsExecutingLeverage] = useState(false);
  const [groupLeverageMsg, setGroupLeverageMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [leverageAccountSearch, setLeverageAccountSearch] = useState('');

  // Group-level weighted average entry price
  const groupAvgEntry = useMemo(() => {
    let totalQ = 0;
    let sumNotional = 0;
    for (const p of group.positions) {
      const q = Number(p.quantity);
      const e = p.avgEntryPrice !== null ? Number(p.avgEntryPrice) : 0;
      if (q > 0 && e > 0) {
        totalQ += q;
        sumNotional += q * e;
      }
    }
    if (totalQ > 0 && sumNotional > 0) {
      return sumNotional / totalQ;
    }
    const first = group.positions.find((p) => p.avgEntryPrice !== null && Number(p.avgEntryPrice) > 0);
    return first ? Number(first.avgEntryPrice) : NaN;
  }, [group.positions]);

  const hasGroupRef = Number.isFinite(groupAvgEntry) && groupAvgEntry > 0;
  const sideOk = group.side === 'long' || group.side === 'short';

  // Protection state
  const existingSlPos = group.positions.find((p) => p.stopLossTrigger && p.stopLossTrigger !== '0' && Number(p.stopLossTrigger) > 0);
  const existingTpPos = group.positions.find((p) => p.takeProfitTrigger && p.takeProfitTrigger !== '0' && Number(p.takeProfitTrigger) > 0);
  const initSl = existingSlPos?.stopLossTrigger ?? '';
  const initTp = existingTpPos?.takeProfitTrigger ?? '';
  const initSlPct = (initSl && hasGroupRef && sideOk)
    ? triggerToPct(groupAvgEntry, Number(initSl), group.side as 'long' | 'short', 'sl').toFixed(2).replace(/\.?0+$/, '')
    : '';
  const initTpPct = (initTp && hasGroupRef && sideOk)
    ? triggerToPct(groupAvgEntry, Number(initTp), group.side as 'long' | 'short', 'tp').toFixed(2).replace(/\.?0+$/, '')
    : '';

  const [enableSl, setEnableSl] = useState<boolean>(() => Boolean(initSl));
  const [enableTp, setEnableTp] = useState<boolean>(() => Boolean(initTp));

  const [slTpMode, setSlTpMode] = useState<'percent' | 'price'>('percent');
  const [sl, setSl] = useState<string>(initSl);
  const [tp, setTp] = useState<string>(initTp);
  const [slPct, setSlPct] = useState<string>(initSlPct);
  const [tpPct, setTpPct] = useState<string>(initTpPct);
  const [trailing, setTrailing] = useState<boolean>(false);

  const currentProtectionPreset = (enableSl && enableTp)
    ? 'both'
    : (!enableSl && enableTp)
      ? 'tp_only'
      : (enableSl && !enableTp)
        ? 'sl_only'
        : 'none';

  const selectGroupPreset = (preset: 'both' | 'tp_only' | 'sl_only' | 'none') => {
    if (preset === 'both') {
      setEnableSl(true);
      setEnableTp(true);
      if (slTpMode === 'percent') {
        if (!slPct || Number(slPct) <= 0) setSlPct('5');
        if (!tpPct || Number(tpPct) <= 0) setTpPct('10');
      }
    } else if (preset === 'tp_only') {
      setEnableSl(false);
      setEnableTp(true);
      setSl('');
      setSlPct('');
      setTrailing(false);
      if (slTpMode === 'percent' && (!tpPct || Number(tpPct) <= 0)) {
        setTpPct('10');
      }
    } else if (preset === 'sl_only') {
      setEnableSl(true);
      setEnableTp(false);
      setTp('');
      setTpPct('');
      if (slTpMode === 'percent' && (!slPct || Number(slPct) <= 0)) {
        setSlPct('5');
      }
    } else {
      setEnableSl(false);
      setEnableTp(false);
      setSl('');
      setTp('');
      setSlPct('');
      setTpPct('');
      setTrailing(false);
    }
  };

  const validPositive = /^\d+(\.\d+)?$/;
  const slValid = !enableSl || (
    slTpMode === 'price'
      ? (sl.trim() !== '' && validPositive.test(sl) && Number(sl) > 0)
      : (slPct.trim() !== '' && validPositive.test(slPct) && Number(slPct) > 0 && Number(slPct) <= 100)
  );
  const tpValid = !enableTp || (
    slTpMode === 'price'
      ? (tp.trim() !== '' && validPositive.test(tp) && Number(tp) > 0)
      : (tpPct.trim() !== '' && validPositive.test(tpPct) && Number(tpPct) > 0 && Number(tpPct) <= 100)
  );

  const isSlActive = enableSl && (
    slTpMode === 'price'
      ? (sl.trim() !== '' && Number(sl) > 0)
      : (slPct.trim() !== '' && Number(slPct) > 0)
  );
  const isTpActive = enableTp && (
    slTpMode === 'price'
      ? (tp.trim() !== '' && Number(tp) > 0)
      : (tpPct.trim() !== '' && Number(tpPct) > 0)
  );

  const canSaveProtection = (isSlActive || isTpActive) && slValid && tpValid;

  // Search inside modal
  const [modalSearch, setModalSearch] = useState('');

  // Bulk execution states
  const [isExecuting, setIsExecuting] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; accountName: string } | null>(null);
  const [execResult, setExecResult] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isExecuting) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, isExecuting]);

  // Account map for quick lookup
  const accountsMap = useMemo(() => {
    const map = new Map<string, AccountListItem>();
    if (accountsQuery.data) {
      for (const a of accountsQuery.data) {
        map.set(a.id, a);
        map.set(a.name.toLowerCase().trim(), a);
      }
    }
    return map;
  }, [accountsQuery.data]);

  // Evaluate each account in group: required funds vs free cash
  const evaluatedAccounts = useMemo(() => {
    return group.positions.map((p) => {
      const acc = accountsMap.get(p.accountId) ?? accountsMap.get(p.accountName.toLowerCase().trim()) ?? null;
      const quoteScale = quoteScaleOf(p.marginCurrency);
      const freeCashMinor = acc
        ? (acc.balancesByCurrency?.[p.marginCurrency] ?? (acc.allocatedCurrency === p.marginCurrency ? acc.allocatedCapitalMinor : '0'))
        : null;
      const freeBalanceMajor = freeCashMinor ? Number(freeCashMinor) / (10 ** quoteScale) : 0;

      const posQty = Number(p.quantity);
      const lockedMarginMajor = p.lockedMarginMinor ? Number(p.lockedMarginMinor) / (10 ** quoteScale) : 0;
      const marginPerUnit = (posQty > 0 && lockedMarginMajor > 0)
        ? (lockedMarginMajor / posQty)
        : (p.markPrice && p.leverage ? Number(p.markPrice) / Number(p.leverage) : 0);

      let addQtyNum = 0;
      let targetAddMarginMajor = 0;

      if (groupIncreaseSizingMode === 'percent') {
        targetAddMarginMajor = freeBalanceMajor * (increasePct / 100);
        addQtyNum = marginPerUnit > 0 ? targetAddMarginMajor / marginPerUnit : 0;
      } else {
        const parsed = parseFloat(groupIncreaseQtyInput);
        addQtyNum = (!isNaN(parsed) && parsed > 0) ? parsed : 0;
        targetAddMarginMajor = addQtyNum * marginPerUnit;
      }

      const addQty = addQtyNum > 0 ? (addQtyNum >= 1 ? addQtyNum.toFixed(2) : addQtyNum.toFixed(4)).replace(/\.?0+$/, '') : '0.0000';
      const newTotalQty = (posQty + (parseFloat(addQty) || 0)).toFixed(4).replace(/\.?0+$/, '');
      const reqAddMarginMinor = BigInt(Math.max(0, Math.round(targetAddMarginMajor * (10 ** quoteScale)))).toString();
      const isFunded = freeCashMinor !== null && BigInt(freeCashMinor) >= BigInt(reqAddMarginMinor) && parseFloat(addQty) > 0;

      // Reduce calculations
      const reduceQty = (posQty * reducePct / 100).toFixed(4);
      const remainQty = Math.max(0, posQty - Number(reduceQty)).toFixed(4);
      const reqReduceMarginMinor = calcProportionalMinor(p.lockedMarginMinor, reducePct);

      return {
        position: p,
        account: acc,
        freeCashMinor,
        freeBalanceMajor,
        reqAddMarginMinor,
        isFunded,
        addQty,
        newTotalQty,
        reduceQty,
        remainQty,
        reqReduceMarginMinor,
      };
    });
  }, [group.positions, accountsMap, groupIncreaseSizingMode, increasePct, groupIncreaseQtyInput, reducePct]);

  const fundedAccounts = useMemo(() => evaluatedAccounts.filter((e) => e.isFunded), [evaluatedAccounts]);
  const skippedAccounts = useMemo(() => evaluatedAccounts.filter((e) => !e.isFunded), [evaluatedAccounts]);

  const totalFundedMarginMinor = useMemo(() => {
    let sum = 0n;
    for (const e of fundedAccounts) {
      if (e.reqAddMarginMinor) sum += BigInt(e.reqAddMarginMinor);
    }
    return sum > 0n ? String(sum) : null;
  }, [fundedAccounts]);

  const totalMarginReleasedMinor = useMemo(() => {
    let sum = 0n;
    for (const e of evaluatedAccounts) {
      if (e.reqReduceMarginMinor) sum += BigInt(e.reqReduceMarginMinor);
    }
    return sum > 0n ? String(sum) : null;
  }, [evaluatedAccounts]);

  const totalFreeCashMinor = useMemo(() => {
    let sum = 0n;
    for (const e of evaluatedAccounts) {
      if (e.freeCashMinor) sum += BigInt(e.freeCashMinor);
    }
    return sum > 0n ? String(sum) : null;
  }, [evaluatedAccounts]);

  const filteredEvaluations = useMemo(() => {
    if (!modalSearch.trim()) return evaluatedAccounts;
    const q = modalSearch.toLowerCase().trim();
    return evaluatedAccounts.filter((e) =>
      e.position.accountName.toLowerCase().includes(q) ||
      (e.position.groupName && e.position.groupName.toLowerCase().includes(q)),
    );
  }, [evaluatedAccounts, modalSearch]);

  const targetLevNum = parseFloat(groupTargetLeverage);
  const isTargetLevValid = !isNaN(targetLevNum) && targetLevNum >= 1 && targetLevNum <= 100;

  const evaluatedLeverageAccounts = useMemo(() => {
    return group.positions.map((p) => {
      const acc = accountsMap.get(p.accountId) ?? accountsMap.get(p.accountName.toLowerCase().trim()) ?? null;
      const quoteScale = quoteScaleOf(p.marginCurrency);
      const freeCashMinor = acc
        ? (acc.balancesByCurrency?.[p.marginCurrency] ?? (acc.allocatedCurrency === p.marginCurrency ? acc.allocatedCapitalMinor : '0'))
        : null;
      const freeBalanceMajor = freeCashMinor ? Number(freeCashMinor) / (10 ** quoteScale) : 0;

      const posQty = Number(p.quantity);
      const entryOrMark = (p.avgEntryPrice && Number(p.avgEntryPrice) > 0) ? Number(p.avgEntryPrice) : (p.markPrice ? Number(p.markPrice) : 0);
      const currentLev = (p.leverage && Number(p.leverage) > 0) ? Number(p.leverage) : 1;

      const currentMarginMajor = p.lockedMarginMinor && Number(p.lockedMarginMinor) > 0
        ? Number(p.lockedMarginMinor) / (10 ** quoteScale)
        : (currentLev > 0 ? (posQty * entryOrMark) / currentLev : 0);

      const newMarginMajor = isTargetLevValid && targetLevNum > 0
        ? (posQty * entryOrMark) / targetLevNum
        : currentMarginMajor;

      const marginDeltaMajor = newMarginMajor - currentMarginMajor;
      const isEligible = isTargetLevValid && (marginDeltaMajor <= 0 || freeBalanceMajor >= marginDeltaMajor);
      const isSame = isTargetLevValid && Math.abs(currentLev - targetLevNum) < 0.01;
      const shortfallMajor = (marginDeltaMajor > 0 && freeBalanceMajor < marginDeltaMajor) ? (marginDeltaMajor - freeBalanceMajor) : 0;

      return {
        position: p,
        account: acc,
        currentLev,
        posQty,
        freeBalanceMajor,
        currentMarginMajor,
        newMarginMajor,
        marginDeltaMajor,
        isEligible,
        isSame,
        shortfallMajor,
      };
    });
  }, [group.positions, accountsMap, isTargetLevValid, targetLevNum]);

  // Default select all eligible accounts that are not already at target leverage
  useEffect(() => {
    const nextSelection: Record<string, boolean> = {};
    for (const item of evaluatedLeverageAccounts) {
      if (item.isEligible && !item.isSame) {
        nextSelection[item.position.venuePositionId] = true;
      }
    }
    setGroupLeverageSelection(nextSelection);
  }, [groupTargetLeverage]);

  const selectedLeverageAccounts = useMemo(() => {
    return evaluatedLeverageAccounts.filter((e) => groupLeverageSelection[e.position.venuePositionId] && e.isEligible && !e.isSame);
  }, [evaluatedLeverageAccounts, groupLeverageSelection]);

  const totalNetMarginDeltaMajor = useMemo(() => {
    return selectedLeverageAccounts.reduce((sum, item) => sum + item.marginDeltaMajor, 0);
  }, [selectedLeverageAccounts]);

  const totalCurrentMarginMajor = useMemo(() => {
    return selectedLeverageAccounts.reduce((sum, item) => sum + item.currentMarginMajor, 0);
  }, [selectedLeverageAccounts]);

  const totalNewMarginMajor = useMemo(() => {
    return selectedLeverageAccounts.reduce((sum, item) => sum + item.newMarginMajor, 0);
  }, [selectedLeverageAccounts]);

  const filteredLeverageAccounts = useMemo(() => {
    if (!leverageAccountSearch.trim()) return evaluatedLeverageAccounts;
    const q = leverageAccountSearch.toLowerCase().trim();
    return evaluatedLeverageAccounts.filter((e) =>
      e.position.accountName.toLowerCase().includes(q) ||
      (e.position.groupName && e.position.groupName.toLowerCase().includes(q)),
    );
  }, [evaluatedLeverageAccounts, leverageAccountSearch]);

  const sideBadgeColor = group.side === 'long' ? 'var(--ok)' : 'var(--danger)';
  const groupTitle = group.groupNames.length === 1
    ? group.groupNames[0]
    : group.groupNames.length > 1
      ? `${group.groupNames.slice(0, 2).join(', ')}${group.groupNames.length > 2 ? ` (+${group.groupNames.length - 2})` : ''}`
      : 'Ungrouped';

  const totalWeight = group.positions.reduce((acc, pos) => acc + Number(pos.quantity), 0);
  const weightedRoeSum = group.positions.reduce((acc, pos) => {
    const r = calcRoePct(pos);
    return r !== null ? acc + r * Number(pos.quantity) : acc;
  }, 0);
  const groupRoe = totalWeight > 0 ? weightedRoeSum / totalWeight : null;

  // 1. Group Increase Action (Only on Funded Accounts)
  const handleExecuteIncrease = async () => {
    if (fundedAccounts.length === 0 || isExecuting) return;
    setIsExecuting(true);
    setExecResult(null);
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    let completed = 0;
    const batchGroupTradeId = crypto.randomUUID();
    await mapConcurrent(fundedAccounts, 12, async (item) => {
      try {
        await adjustFuturesPosition(item.position.venuePositionId, 'increase', undefined, batchGroupTradeId, item.addQty);
        succeeded++;
      } catch (err) {
        failed++;
        errors.push(`${item.position.accountName}: ${(err as Error).message}`);
      } finally {
        completed++;
        setProgress({ current: completed, total: fundedAccounts.length, accountName: item.position.accountName });
      }
    });

    setIsExecuting(false);
    setProgress(null);
    onRefreshPositions();
    await accountsQuery.refetch();

    if (failed === 0) {
      setExecResult({
        kind: 'ok',
        message: `Increased positions on ${succeeded} funded account${succeeded === 1 ? '' : 's'}. ${skippedAccounts.length} underfunded account(s) skipped cleanly.`,
      });
    } else {
      setExecResult({
        kind: 'err',
        message: `Completed: ${succeeded} succeeded, ${failed} failed (${errors.slice(0, 2).join('; ')}). ${skippedAccounts.length} skipped.`,
      });
    }
  };

  // 2. Group Partial Exit Action
  const handleExecuteReduce = async () => {
    if (group.positions.length === 0 || isExecuting) return;
    setIsExecuting(true);
    setExecResult(null);
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    const bp = Math.round(reducePct * 100);
    let completed = 0;
    const batchGroupTradeId = crypto.randomUUID();
    await mapConcurrent(group.positions, 12, async (pos) => {
      try {
        await adjustFuturesPosition(pos.venuePositionId, 'reduce', bp, batchGroupTradeId);
        succeeded++;
      } catch (err) {
        failed++;
        errors.push(`${pos.accountName}: ${(err as Error).message}`);
      } finally {
        completed++;
        setProgress({ current: completed, total: group.positions.length, accountName: pos.accountName });
      }
    });

    setIsExecuting(false);
    setProgress(null);
    onRefreshPositions();
    await accountsQuery.refetch();

    if (failed === 0) {
      setExecResult({
        kind: 'ok',
        message: `Successfully reduced ${reducePct}% across ${succeeded} account${succeeded === 1 ? '' : 's'}.`,
      });
    } else {
      setExecResult({
        kind: 'err',
        message: `Reduced ${succeeded} accounts; ${failed} failed: ${errors.slice(0, 2).join('; ')}`,
      });
    }
  };

  // 3. Group Close Position Action
  const handleExecuteExit = async () => {
    if (group.positions.length === 0 || isExecuting) return;
    setIsExecuting(true);
    setExecResult(null);
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    let completed = 0;
    const batchGroupTradeId = crypto.randomUUID();
    await mapConcurrent(group.positions, 12, async (pos) => {
      try {
        await exitFuturesPosition(pos.venuePositionId, pos.marginCurrency, batchGroupTradeId);
        succeeded++;
      } catch (err) {
        const msg = (err as Error).message || '';
        if (/no\s+active\s+position/i.test(msg) || /already\s+(closed|flat|exited)/i.test(msg)) {
          succeeded++;
        } else {
          failed++;
          errors.push(`${pos.accountName}: ${msg}`);
        }
      } finally {
        completed++;
        setProgress({ current: completed, total: group.positions.length, accountName: pos.accountName });
      }
    });

    setIsExecuting(false);
    setProgress(null);
    onRefreshPositions();
    await accountsQuery.refetch();

    if (failed === 0) {
      setExecResult({
        kind: 'ok',
        message: `Successfully closed positions at market across all ${succeeded} account${succeeded === 1 ? '' : 's'}!`,
      });
      setTimeout(() => onClose(), 1500);
    } else {
      setExecResult({
        kind: 'err',
        message: `Closed ${succeeded} accounts; ${failed} failed: ${errors.slice(0, 2).join('; ')}`,
      });
    }
  };

  // 4. Group Protection Action
  const handleExecuteProtection = async () => {
    if (group.positions.length === 0 || isExecuting) return;
    setIsExecuting(true);
    setExecResult(null);
    let succeeded = 0;
    let failed = 0;

    let completed = 0;
    await mapConcurrent(group.positions, 12, async (pos) => {
      try {
        const refPrice = pos.avgEntryPrice !== null ? Number(pos.avgEntryPrice) : NaN;
        const posSideOk = pos.side === 'long' || pos.side === 'short';
        const hasRef = Number.isFinite(refPrice) && refPrice > 0;

        let effectiveSl: string | undefined = undefined;
        let effectiveTp: string | undefined = undefined;

        if (enableSl) {
          if (slTpMode === 'percent') {
            const basePrice = hasRef ? refPrice : (hasGroupRef ? groupAvgEntry : NaN);
            const numPct = Number(slPct);
            if (numPct > 0 && Number.isFinite(basePrice) && basePrice > 0 && posSideOk) {
              effectiveSl = pctToTrigger(basePrice, numPct, pos.side as 'long' | 'short', 'sl').toFixed(8).replace(/\.?0+$/, '');
            }
          } else if (sl.trim() !== '' && Number(sl) > 0) {
            effectiveSl = sl.trim();
          }
        }

        if (enableTp) {
          if (slTpMode === 'percent') {
            const basePrice = hasRef ? refPrice : (hasGroupRef ? groupAvgEntry : NaN);
            const numPct = Number(tpPct);
            if (numPct > 0 && Number.isFinite(basePrice) && basePrice > 0 && posSideOk) {
              effectiveTp = pctToTrigger(basePrice, numPct, pos.side as 'long' | 'short', 'tp').toFixed(8).replace(/\.?0+$/, '');
            }
          } else if (tp.trim() !== '' && Number(tp) > 0) {
            effectiveTp = tp.trim();
          }
        }

        const body: { stopLossPrice?: string; takeProfitPrice?: string; moveExisting: boolean } = { moveExisting: true };
        if (effectiveSl) body.stopLossPrice = effectiveSl;
        if (effectiveTp) body.takeProfitPrice = effectiveTp;

        await setFuturesProtection(pos.venuePositionId, body);
        if (trailing && effectiveSl) {
          await setTrailingProtection(pos.venuePositionId, {
            enable: true,
            currentSlPrice: effectiveSl,
            stepBp: '100',
            distanceBp: '100',
          });
        }
        succeeded++;
      } catch {
        failed++;
      } finally {
        completed++;
        setProgress({ current: completed, total: group.positions.length, accountName: pos.accountName });
      }
    });

    setIsExecuting(false);
    setProgress(null);
    onRefreshPositions();

    setExecResult({
      kind: failed === 0 ? 'ok' : 'err',
      message: `Protection updated across ${succeeded} account${succeeded === 1 ? '' : 's'}${failed > 0 ? ` (${failed} failed)` : ''}.`,
    });
  };

  // 5. Group Leverage Action
  const handleExecuteGroupLeverage = async () => {
    if (selectedLeverageAccounts.length === 0 || !isTargetLevValid || isExecutingLeverage || isHalted) return;
    setIsExecutingLeverage(true);
    setGroupLeverageMsg(null);
    let succeeded = 0;
    let failed = 0;
    const errors: string[] = [];

    let completed = 0;
    await mapConcurrent(selectedLeverageAccounts, 12, async (item) => {
      try {
        await updateFuturesPositionLeverage(item.position.venuePositionId, targetLevNum);
        succeeded++;
      } catch (err) {
        failed++;
        errors.push(`${item.position.accountName}: ${(err as Error).message}`);
      } finally {
        completed++;
        setProgress({ current: completed, total: selectedLeverageAccounts.length, accountName: item.position.accountName });
      }
    });

    setIsExecutingLeverage(false);
    setProgress(null);
    onRefreshPositions();
    await accountsQuery.refetch();

    if (failed === 0) {
      setGroupLeverageMsg({
        kind: 'ok',
        text: `Successfully adjusted leverage to ${groupTargetLeverage}× across ${succeeded} account${succeeded === 1 ? '' : 's'}.`,
      });
    } else {
      setGroupLeverageMsg({
        kind: 'err',
        text: `Adjusted ${succeeded} accounts; ${failed} failed: ${errors.slice(0, 2).join('; ')}`,
      });
    }
  };

  return (
    <div className="position-modal-overlay" onClick={onClose}>
      <div className="position-modal group-manage-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="position-modal-header">
          <div>
            <h3 className="position-modal-title">
              <span>{group.pair} (Group Actions)</span>
              <span
                className="badge"
                style={{
                  color: sideBadgeColor,
                  borderColor: sideBadgeColor,
                  background: group.side === 'long' ? 'rgba(75,181,99,0.12)' : 'rgba(240,85,90,0.12)',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                }}
              >
                {group.side}
              </span>
              <span style={{ fontSize: 13, color: 'var(--text-dim)', fontWeight: 400 }}>
                ({group.marginCurrency})
              </span>
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <span className="group-badge">
                {groupTitle}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                Managing {group.positions.length} account{group.positions.length === 1 ? '' : 's'} holding this position
              </span>
            </div>
          </div>
          <button type="button" className="position-modal-close" onClick={onClose} title="Close (Esc)">
            &times;
          </button>
        </div>

        {isHalted && (
          <div
            style={{
              backgroundColor: 'rgba(239, 68, 68, 0.12)',
              border: '1px solid var(--danger)',
              borderRadius: 6,
              padding: '10px 14px',
              marginBottom: 16,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12.5,
              color: 'var(--danger)',
              fontWeight: 600,
            }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--danger)', display: 'inline-block' }} />
            <span>EMERGENCY KILL SWITCH ACTIVE: Bulk group position actions and market orders are locked.</span>
          </div>
        )}

        {/* Live Aggregated Metrics Header Card */}
        <div className="position-modal-metrics">
          <div className="modal-metric-card">
            <span className="modal-metric-label">Combined Unrealised PnL</span>
            <span
              className="modal-metric-value"
              style={{
                fontSize: 16,
                fontWeight: 800,
                color: (group.totalPnlMinor && group.totalPnlMinor.startsWith('-'))
                  ? '#ef4444'
                  : (group.totalPnlMinor && group.totalPnlMinor !== '0')
                    ? '#10b981'
                    : 'var(--text-dim)',
              }}
            >
              {pnlText(group.totalPnlMinor, group.marginCurrency)}
              {groupRoe !== null && (
                <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 6, color: groupRoe >= 0 ? '#10b981' : '#ef4444' }}>
                  {roeText(groupRoe).trim()}
                </span>
              )}
            </span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Total Position Size</span>
            <span className="modal-metric-value">{group.totalQty.toFixed(4).replace(/\.?0+$/, '')}</span>
          </div>

          <div className="modal-metric-card">
            <span className="modal-metric-label">Total Margin Invested</span>
            <span className="modal-metric-value">
              {group.totalMarginMinor ? fmtMinor(group.totalMarginMinor, group.marginCurrency) : '—'}
            </span>
          </div>
        </div>

        {/* Action Tabs */}
        <div className="position-modal-tabs">
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'increase' ? 'active' : ''}`}
            onClick={() => setActiveTab('increase')}
          >
            Add / Increase
          </button>
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'partial' ? 'active' : ''}`}
            onClick={() => setActiveTab('partial')}
          >
            Partial Exit
          </button>
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'protection' ? 'active' : ''}`}
            onClick={() => setActiveTab('protection')}
          >
            SL / TP Protection
          </button>
          <button
            type="button"
            className={`position-modal-tab ${activeTab === 'leverage' ? 'active' : ''}`}
            onClick={() => setActiveTab('leverage')}
          >
            Adjust Leverage
          </button>
          <button
            type="button"
            className={`position-modal-tab danger-tab ${activeTab === 'close' ? 'active' : ''}`}
            onClick={() => { setActiveTab('close'); setConfirmExit(false); }}
          >
            Close Group
          </button>
        </div>

        {/* Tab Body */}
        <div className="position-modal-body">
          {/* Progress / Status banner if executing */}
          {progress && (
            <div
              style={{
                padding: '10px 14px',
                background: 'rgba(124, 107, 255, 0.15)',
                border: '1px solid rgba(124, 107, 255, 0.4)',
                borderRadius: 'var(--radius)',
                marginBottom: 14,
                fontSize: 13,
                color: '#c4b5fd',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
              <span>
                Processing account <strong>{progress.current}</strong> of <strong>{progress.total}</strong> ({progress.accountName})…
              </span>
            </div>
          )}

          {/* Results banner */}
          {execResult && (
            <div
              style={{
                padding: '10px 14px',
                background: execResult.kind === 'ok' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(240, 85, 90, 0.15)',
                border: `1px solid ${execResult.kind === 'ok' ? 'var(--ok)' : 'var(--danger)'}`,
                borderRadius: 'var(--radius)',
                marginBottom: 14,
                fontSize: 13,
                color: execResult.kind === 'ok' ? 'var(--ok)' : 'var(--danger)',
                fontWeight: 600,
              }}
            >
              {execResult.message}
            </div>
          )}

          {/* ── Tab 1: Add / Increase (Group Fan-out with Available Balance Sizing) ── */}
          {activeTab === 'increase' && (
            <div>
              {/* Group Cash Overview & Live Sync All Balances */}
              <div
                style={{
                  background: 'var(--surface-2)',
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--radius)',
                  padding: '10px 14px',
                  marginBottom: 14,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <div>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 2 }}>
                    Combined Available Free Balance (All Accounts)
                  </span>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                    <strong style={{ fontSize: 16, color: 'var(--text)', fontFamily: 'var(--font-mono)' }}>
                      {totalFreeCashMinor ? fmtMinor(totalFreeCashMinor, group.marginCurrency) : '—'}
                    </strong>
                    <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                      • across {group.positions.length} accounts
                    </span>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className="btn btn-sm secondary"
                    onClick={() => void handleSyncAllBalances()}
                    disabled={isRefreshing}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '4px 10px',
                      fontSize: 11.5,
                      fontWeight: 600,
                    }}
                    title="Fetch and sync live exchange balances from CoinDCX for all accounts"
                  >
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: isRefreshing ? 'spin 1s linear infinite' : 'none' }}>
                      <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                    </svg>
                    {isRefreshing ? 'Syncing Balances…' : 'Sync All Balances'}
                  </button>
                </div>
              </div>

              {/* Sizing Controls Card */}
              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 14 }}>
                {/* Mode Selector */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Group Sizing Mode
                  </span>
                  <div style={{ display: 'flex', gap: 4, background: 'var(--surface-3)', padding: 3, borderRadius: 'var(--radius-pill)', border: '1px solid var(--line)' }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        padding: '2px 10px',
                        fontSize: 11,
                        background: groupIncreaseSizingMode === 'percent' ? 'var(--ok)' : 'transparent',
                        color: groupIncreaseSizingMode === 'percent' ? '#000000' : 'var(--muted)',
                        fontWeight: groupIncreaseSizingMode === 'percent' ? 700 : 500,
                        border: 'none',
                        borderRadius: 'var(--radius-pill)',
                        cursor: 'pointer',
                      }}
                      onClick={() => setGroupIncreaseSizingMode('percent')}
                    >
                      % of Available Balance
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        padding: '2px 10px',
                        fontSize: 11,
                        background: groupIncreaseSizingMode === 'quantity' ? 'var(--ok)' : 'transparent',
                        color: groupIncreaseSizingMode === 'quantity' ? '#000000' : 'var(--muted)',
                        fontWeight: groupIncreaseSizingMode === 'quantity' ? 700 : 500,
                        border: 'none',
                        borderRadius: 'var(--radius-pill)',
                        cursor: 'pointer',
                      }}
                      onClick={() => setGroupIncreaseSizingMode('quantity')}
                    >
                      Fixed Quantity per Account
                    </button>
                  </div>
                </div>

                {groupIncreaseSizingMode === 'percent' ? (
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>Allocate from each account's available balance:</span>
                      <strong style={{ fontSize: 14, color: 'var(--ok)' }}>+{increasePct}%</strong>
                    </div>

                    {/* Quick % Chips */}
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                      {INCREASE_PCT_CHIPS.map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          className="btn btn-sm secondary"
                          style={{
                            flex: 1,
                            minWidth: 54,
                            padding: '6px 0',
                            fontSize: 12,
                            background: increasePct === pct && !isCustomIncrease ? 'var(--ok)' : 'var(--surface-3)',
                            color: increasePct === pct && !isCustomIncrease ? '#000000' : 'var(--text-dim)',
                            borderColor: increasePct === pct && !isCustomIncrease ? 'var(--ok)' : 'var(--line)',
                            fontWeight: increasePct === pct && !isCustomIncrease ? 700 : 500,
                          }}
                          onClick={() => {
                            setIncreasePct(pct);
                            setCustomIncreaseInput('');
                          }}
                        >
                          +{pct}%
                        </button>
                      ))}

                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1.3, minWidth: 100 }}>
                        <input
                          type="text"
                          inputMode="decimal"
                          placeholder="Custom %"
                          value={customIncreaseInput}
                          onChange={(e) => {
                            const val = e.target.value.replace(/[^\d.]/g, '');
                            setCustomIncreaseInput(val);
                            const num = parseFloat(val);
                            if (!isNaN(num) && num >= 0 && num <= 100) setIncreasePct(num);
                          }}
                          style={{
                            width: '100%',
                            padding: '6px 8px',
                            fontSize: 12,
                            background: isCustomIncrease ? 'rgba(16, 185, 129, 0.15)' : 'var(--surface-3)',
                            borderColor: isCustomIncrease ? 'var(--ok)' : 'var(--line)',
                            color: isCustomIncrease ? 'var(--ok)' : 'var(--text)',
                            fontWeight: isCustomIncrease ? 700 : 400,
                            textAlign: 'center',
                            borderRadius: 'var(--radius-sm)',
                          }}
                        />
                        <span style={{ fontSize: 12, color: 'var(--muted)' }}>%</span>
                      </div>
                    </div>

                    {/* Interactive 0-100% Slider */}
                    <div style={{ margin: '10px 0 12px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, fontSize: 11.5, color: 'var(--muted)' }}>
                        <span>0% (Min)</span>
                        <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                          Slide: {increasePct}% of each account's free cash
                        </span>
                        <span>100% (Max Balance)</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={increasePct}
                        onChange={(e) => setIncreasePct(Number(e.target.value))}
                        style={{
                          width: '100%',
                          cursor: 'pointer',
                          accentColor: 'var(--ok)',
                        }}
                      />
                    </div>
                  </div>
                ) : (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <label htmlFor="group-increase-qty" style={{ fontSize: 12, color: 'var(--muted)', margin: 0 }}>
                        Fixed quantity to add per funded account:
                      </label>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <input
                        id="group-increase-qty"
                        type="text"
                        inputMode="decimal"
                        placeholder="e.g. 0.01"
                        value={groupIncreaseQtyInput}
                        onChange={(e) => setGroupIncreaseQtyInput(e.target.value.replace(/[^\d.]/g, ''))}
                        style={{
                          width: '100%',
                          padding: '8px 12px',
                          fontSize: 13,
                          background: 'var(--surface-3)',
                          borderColor: 'var(--line)',
                          borderRadius: 'var(--radius-sm)',
                          color: 'var(--text)',
                          fontWeight: 600,
                        }}
                      />
                      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        {group.pair.split('_')[0].replace(/^[A-Z]-/, '')}
                      </span>
                    </div>
                  </div>
                )}

                {/* Eligibility Summary Banner */}
                <div
                  style={{
                    padding: '8px 12px',
                    borderRadius: 'var(--radius-sm)',
                    background: skippedAccounts.length === 0 ? 'rgba(16, 185, 129, 0.12)' : 'rgba(245, 158, 11, 0.12)',
                    border: `1px solid ${skippedAccounts.length === 0 ? 'var(--ok)' : '#f59e0b'}`,
                    fontSize: 12.5,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <strong style={{ color: skippedAccounts.length === 0 ? 'var(--ok)' : '#f59e0b' }}>
                      {fundedAccounts.length} of {group.positions.length} accounts funded
                    </strong>
                    <span style={{ color: 'var(--text-dim)', marginLeft: 6 }}>
                      (Total Margin Needed: {totalFundedMarginMinor ? fmtMinor(totalFundedMarginMinor, group.marginCurrency) : '—'})
                    </span>
                  </div>
                  {skippedAccounts.length > 0 && (
                    <span style={{ fontSize: 11.5, color: 'var(--danger)', fontWeight: 600 }}>
                      {skippedAccounts.length} underfunded account(s) will be skipped
                    </span>
                  )}
                </div>
              </div>

              {/* Account Eligibility Breakdown Table (Bounded scrollable container for 100+ accounts) */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>
                    Account Sizing & Eligibility Breakdown ({filteredEvaluations.length})
                  </span>
                  <input
                    type="text"
                    placeholder="Filter accounts…"
                    value={modalSearch}
                    onChange={(e) => setModalSearch(e.target.value)}
                    style={{ padding: '3px 8px', fontSize: 11.5, width: 160, borderRadius: 4, background: 'var(--surface-3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                  />
                </div>

                <div className="table-scroll-container" style={{ maxHeight: 220 }}>
                  <table style={{ fontSize: 11.5 }}>
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th style={{ textAlign: 'right' }}>Current</th>
                        <th style={{ textAlign: 'right' }}>Adding</th>
                        <th style={{ textAlign: 'right' }}>Margin Needed</th>
                        <th style={{ textAlign: 'right' }}>Free Cash</th>
                        <th style={{ textAlign: 'center' }}>Eligibility</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEvaluations.map((item) => (
                        <tr key={item.position.venuePositionId}>
                          <td style={{ fontWeight: 600, color: 'var(--text)' }}>
                            {item.position.accountName}
                          </td>
                          <td style={{ textAlign: 'right' }}>{item.position.quantity}</td>
                          <td style={{ textAlign: 'right', color: item.isFunded ? 'var(--ok)' : 'var(--text-dim)' }}>
                            +{item.addQty}
                          </td>
                          <td style={{ textAlign: 'right', fontWeight: 600 }}>
                            {item.reqAddMarginMinor ? fmtMinor(item.reqAddMarginMinor, group.marginCurrency) : '—'}
                          </td>
                          <td style={{ textAlign: 'right', color: item.isFunded ? 'var(--text)' : 'var(--danger)' }}>
                            {item.freeCashMinor ? fmtMinor(item.freeCashMinor, group.marginCurrency) : '—'}
                          </td>
                          <td style={{ textAlign: 'center' }}>
                            {item.isFunded ? (
                              <span className="status-badge-funded">Funded</span>
                            ) : (
                              <span className="status-badge-skipped" title="Insufficient free cash — skipped during fan-out">
                                Skipped
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isExecuting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ background: 'var(--ok)', color: '#000000', fontWeight: 700, border: 'none' }}
                  disabled={
                    isExecuting ||
                    isHalted ||
                    fundedAccounts.length === 0 ||
                    (groupIncreaseSizingMode === 'percent' ? increasePct <= 0 : (parseFloat(groupIncreaseQtyInput) || 0) <= 0)
                  }
                  onClick={handleExecuteIncrease}
                >
                  {isExecuting
                    ? 'Processing Fan-out…'
                    : groupIncreaseSizingMode === 'percent'
                      ? `Add +${increasePct}% to ${fundedAccounts.length} Funded Account${fundedAccounts.length === 1 ? '' : 's'} (${totalFundedMarginMinor ? fmtMinor(totalFundedMarginMinor, group.marginCurrency) : ''})`
                      : `Add +${groupIncreaseQtyInput} Qty to ${fundedAccounts.length} Funded Account${fundedAccounts.length === 1 ? '' : 's'} (${totalFundedMarginMinor ? fmtMinor(totalFundedMarginMinor, group.marginCurrency) : ''})`}
                </button>
              </div>
            </div>
          )}

          {/* ── Tab 2: Partial Exit (Reduce for all accounts) ── */}
          {activeTab === 'partial' && (
            <div>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Safely reduce position size by {reducePct}% across all {group.positions.length} accounts holding this trade.
              </p>

              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontSize: 12, color: 'var(--muted)' }}>Select percentage to close:</span>
                  <strong style={{ fontSize: 14, color: '#f59e0b' }}>−{reducePct}%</strong>
                </div>

                <div style={{ display: 'flex', gap: 8, marginBottom: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  {REDUCE_PCT_CHIPS.map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      className="btn btn-sm secondary"
                      style={{
                        flex: 1,
                        minWidth: 50,
                        padding: '6px 0',
                        fontSize: 12,
                        background: reducePct === pct && !isCustomReduce ? '#f59e0b' : 'var(--surface-3)',
                        color: reducePct === pct && !isCustomReduce ? '#000000' : 'var(--text-dim)',
                        borderColor: reducePct === pct && !isCustomReduce ? '#f59e0b' : 'var(--line)',
                        fontWeight: reducePct === pct && !isCustomReduce ? 700 : 500,
                      }}
                      onClick={() => {
                        setReducePct(pct);
                        setCustomReduceInput('');
                      }}
                    >
                      −{pct}%
                    </button>
                  ))}

                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1.3, minWidth: 100 }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="Custom %"
                      value={customReduceInput}
                      onChange={(e) => {
                        const val = e.target.value.replace(/[^\d.]/g, '');
                        setCustomReduceInput(val);
                        const num = parseFloat(val);
                        if (!isNaN(num) && num > 0 && num < 100) setReducePct(num);
                      }}
                      style={{
                        width: '100%',
                        padding: '6px 8px',
                        fontSize: 12,
                        background: isCustomReduce ? 'rgba(245, 158, 11, 0.15)' : 'var(--surface-3)',
                        borderColor: isCustomReduce ? '#f59e0b' : 'var(--line)',
                        color: isCustomReduce ? '#f59e0b' : 'var(--text)',
                        fontWeight: isCustomReduce ? 700 : 400,
                        textAlign: 'center',
                        borderRadius: 'var(--radius-sm)',
                      }}
                    />
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>%</span>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Est. Margin Released Across Group: </span>
                    <strong style={{ color: '#f59e0b' }}>
                      {totalMarginReleasedMinor ? fmtMinor(totalMarginReleasedMinor, group.marginCurrency) : '—'}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Accounts Affected: </span>
                    <strong style={{ color: 'var(--text)' }}>{group.positions.length}</strong>
                  </div>
                </div>
              </div>

              {/* Account Breakdown */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>
                    Per-Account Partial Exit Breakdown
                  </span>
                  <input
                    type="text"
                    placeholder="Filter accounts…"
                    value={modalSearch}
                    onChange={(e) => setModalSearch(e.target.value)}
                    style={{ padding: '3px 8px', fontSize: 11.5, width: 160, borderRadius: 4, background: 'var(--surface-3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                  />
                </div>

                <div className="table-scroll-container" style={{ maxHeight: 220 }}>
                  <table style={{ fontSize: 11.5 }}>
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th style={{ textAlign: 'right' }}>Current Qty</th>
                        <th style={{ textAlign: 'right' }}>Selling (−{reducePct}%)</th>
                        <th style={{ textAlign: 'right' }}>Remaining</th>
                        <th style={{ textAlign: 'right' }}>Margin Released</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredEvaluations.map((item) => (
                        <tr key={item.position.venuePositionId}>
                          <td style={{ fontWeight: 600 }}>{item.position.accountName}</td>
                          <td style={{ textAlign: 'right' }}>{item.position.quantity}</td>
                          <td style={{ textAlign: 'right', color: '#f59e0b', fontWeight: 600 }}>−{item.reduceQty}</td>
                          <td style={{ textAlign: 'right' }}>{item.remainQty}</td>
                          <td style={{ textAlign: 'right', color: '#f59e0b' }}>
                            {item.reqReduceMarginMinor ? fmtMinor(item.reqReduceMarginMinor, group.marginCurrency) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isExecuting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  style={{ background: '#f59e0b', color: '#000000', fontWeight: 700, border: 'none' }}
                  disabled={isExecuting || isHalted || group.positions.length === 0 || reducePct <= 0 || reducePct >= 100}
                  onClick={handleExecuteReduce}
                >
                  {isExecuting ? 'Executing Group Exit…' : `Close ${reducePct}% Across All ${group.positions.length} Accounts`}
                </button>
              </div>
            </div>
          )}

          {/* ── Tab 3: SL/TP Protection across Group ── */}
          {activeTab === 'protection' && (
            <div>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Set bracket Stop Loss and Take Profit rules for all {group.positions.length} accounts in this group trade.
              </p>

              {/* Strategy Presets Bar */}
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Protection Strategy
                  </span>
                  <div style={{ display: 'flex', background: 'var(--surface-3)', borderRadius: 'var(--radius-sm)', padding: 2 }}>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        padding: '2px 10px', fontSize: 11,
                        background: slTpMode === 'percent' ? 'var(--accent)' : 'transparent',
                        color: slTpMode === 'percent' ? '#000000' : 'var(--muted)',
                        fontWeight: slTpMode === 'percent' ? 700 : 400,
                        border: 'none',
                      }}
                      onClick={() => {
                        if (slTpMode !== 'percent') {
                          if ((!slPct || slPct === '') && sl !== '' && hasGroupRef && sideOk) {
                            setSlPct(triggerToPct(groupAvgEntry, Number(sl), group.side as 'long' | 'short', 'sl').toFixed(2).replace(/\.?0+$/, ''));
                          }
                          if ((!tpPct || tpPct === '') && tp !== '' && hasGroupRef && sideOk) {
                            setTpPct(triggerToPct(groupAvgEntry, Number(tp), group.side as 'long' | 'short', 'tp').toFixed(2).replace(/\.?0+$/, ''));
                          }
                          setSlTpMode('percent');
                        }
                      }}
                    >
                      % Percent
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{
                        padding: '2px 10px', fontSize: 11,
                        background: slTpMode === 'price' ? 'var(--accent)' : 'transparent',
                        color: slTpMode === 'price' ? '#000000' : 'var(--muted)',
                        fontWeight: slTpMode === 'price' ? 700 : 400,
                        border: 'none',
                      }}
                      onClick={() => {
                        if (slTpMode !== 'price') {
                          if ((!sl || sl === '') && slPct !== '' && hasGroupRef && sideOk) {
                            setSl(pctToTrigger(groupAvgEntry, Number(slPct), group.side as 'long' | 'short', 'sl').toFixed(2).replace(/\.?0+$/, ''));
                          }
                          if ((!tp || tp === '') && tpPct !== '' && hasGroupRef && sideOk) {
                            setTp(pctToTrigger(groupAvgEntry, Number(tpPct), group.side as 'long' | 'short', 'tp').toFixed(2).replace(/\.?0+$/, ''));
                          }
                          setSlTpMode('price');
                        }
                      }}
                    >
                      Exact Price
                    </button>
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, background: 'var(--surface-3)', border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: 3 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-pressed={currentProtectionPreset === 'both'}
                    style={{
                      padding: '4px 6px',
                      fontSize: 11,
                      fontWeight: currentProtectionPreset === 'both' ? 700 : 500,
                      background: currentProtectionPreset === 'both' ? '#ffffff' : 'transparent',
                      color: currentProtectionPreset === 'both' ? '#000000' : 'var(--muted)',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      textAlign: 'center',
                    }}
                    onClick={() => selectGroupPreset('both')}
                  >
                    Both SL &amp; TP
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-pressed={currentProtectionPreset === 'tp_only'}
                    style={{
                      padding: '4px 6px',
                      fontSize: 11,
                      fontWeight: currentProtectionPreset === 'tp_only' ? 700 : 500,
                      background: currentProtectionPreset === 'tp_only' ? '#10b981' : 'transparent',
                      color: currentProtectionPreset === 'tp_only' ? '#000000' : 'var(--muted)',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      textAlign: 'center',
                    }}
                    onClick={() => selectGroupPreset('tp_only')}
                  >
                    TP Only
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-pressed={currentProtectionPreset === 'sl_only'}
                    style={{
                      padding: '4px 6px',
                      fontSize: 11,
                      fontWeight: currentProtectionPreset === 'sl_only' ? 700 : 500,
                      background: currentProtectionPreset === 'sl_only' ? '#ef4444' : 'transparent',
                      color: currentProtectionPreset === 'sl_only' ? '#ffffff' : 'var(--muted)',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      textAlign: 'center',
                    }}
                    onClick={() => selectGroupPreset('sl_only')}
                  >
                    SL Only
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    aria-pressed={currentProtectionPreset === 'none'}
                    style={{
                      padding: '4px 6px',
                      fontSize: 11,
                      fontWeight: currentProtectionPreset === 'none' ? 700 : 500,
                      background: currentProtectionPreset === 'none' ? 'var(--panel-2)' : 'transparent',
                      color: currentProtectionPreset === 'none' ? '#ffffff' : 'var(--text-dim)',
                      border: 'none',
                      borderRadius: 4,
                      cursor: 'pointer',
                      textAlign: 'center',
                    }}
                    onClick={() => selectGroupPreset('none')}
                  >
                    Clear All
                  </button>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                {/* Stop Loss Card */}
                <div style={{
                  background: 'var(--panel-2)',
                  border: `1px solid ${enableSl ? 'rgba(239, 68, 68, 0.3)' : 'var(--line)'}`,
                  borderRadius: 'var(--radius)',
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
                          if (checked && slTpMode === 'percent' && (!slPct || Number(slPct) <= 0)) {
                            setSlPct('5');
                          }
                        }}
                        style={{ width: 14, height: 14, cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: enableSl ? '#f87171' : 'var(--muted)' }}>
                        Stop Loss
                      </span>
                      <span style={{
                        fontSize: 9.5,
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: enableSl ? 'rgba(239, 68, 68, 0.15)' : 'var(--surface-3)',
                        color: enableSl ? '#f87171' : 'var(--text-dim)',
                        border: `1px solid ${enableSl ? 'rgba(239, 68, 68, 0.3)' : 'var(--line)'}`,
                        textTransform: 'uppercase',
                      }}>
                        {enableSl ? 'Active' : 'Disabled'}
                      </span>
                    </label>
                  </div>

                  {!enableSl ? (
                    <div style={{ fontSize: 11.5, color: 'var(--text-dim)', padding: '6px 0', fontStyle: 'italic' }}>
                      Stop Loss is disabled. No stop-loss order will be placed. Check the box above or select SL Only / Both to enable.
                    </div>
                  ) : slTpMode === 'price' ? (
                    <>
                      <input
                        id="grp-sl"
                        inputMode="decimal"
                        value={sl}
                        onChange={(e) => setSl(e.target.value)}
                        placeholder="Trigger Price, e.g. 80000"
                        style={{ marginTop: 4, width: '100%' }}
                      />
                      {sl !== '' && Number(sl) <= 0 && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Trigger price must be greater than 0.
                        </div>
                      )}
                      {sl !== '' && Number(sl) > 0 && hasGroupRef && sideOk && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          ≈ {triggerToPct(groupAvgEntry, Number(sl), group.side as 'long' | 'short', 'sl').toFixed(2)}% loss from avg entry
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <input
                        id="grp-sl"
                        inputMode="decimal"
                        value={slPct}
                        placeholder="Distance %, e.g. 5"
                        onChange={(e) => setSlPct(e.target.value.replace(/[^\d.]/g, ''))}
                        style={{ marginTop: 4, width: '100%' }}
                      />
                      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                        {SL_PCT_CHIPS.map((v) => (
                          <button
                            key={v}
                            type="button"
                            className="btn btn-sm secondary"
                            style={{
                              flex: 1, padding: '3px 0', fontSize: 11,
                              background: slPct === String(v) ? 'var(--danger)' : 'var(--surface-3)',
                              color: slPct === String(v) ? '#fff' : 'var(--text-dim)',
                              borderColor: slPct === String(v) ? 'var(--danger)' : 'var(--line)',
                            }}
                            onClick={() => setSlPct(String(v))}
                          >
                            {v}%
                          </button>
                        ))}
                      </div>
                      {slPct !== '' && Number(slPct) <= 0 && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Distance % must be greater than 0%. Entering 0% would trigger an immediate exit at market price.
                        </div>
                      )}
                      {hasGroupRef && sideOk && slPct !== '' && Number(slPct) > 0 && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Target Price: {fmtPrice(String(pctToTrigger(groupAvgEntry, Number(slPct), group.side as 'long' | 'short', 'sl')))}
                        </div>
                      )}
                    </>
                  )}

                  {enableSl && (
                    <div style={{ display: 'flex', alignItems: 'center', marginTop: 10, gap: 6 }}>
                      <input
                        type="checkbox"
                        id="grp-trailing"
                        checked={trailing}
                        onChange={(e) => setTrailing(e.target.checked)}
                        style={{ width: 14, height: 14, cursor: 'pointer' }}
                      />
                      <label htmlFor="grp-trailing" style={{ fontSize: 12, cursor: 'pointer', color: 'var(--text)' }}>
                        Auto-Trailing SL (1% step)
                      </label>
                    </div>
                  )}
                </div>

                {/* Take Profit Card */}
                <div style={{
                  background: 'var(--panel-2)',
                  border: `1px solid ${enableTp ? 'rgba(52, 211, 153, 0.3)' : 'var(--line)'}`,
                  borderRadius: 'var(--radius)',
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
                          if (checked && slTpMode === 'percent' && (!tpPct || Number(tpPct) <= 0)) {
                            setTpPct('10');
                          }
                        }}
                        style={{ width: 14, height: 14, cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: enableTp ? '#34d399' : 'var(--muted)' }}>
                        Take Profit
                      </span>
                      <span style={{
                        fontSize: 9.5,
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: enableTp ? 'rgba(52, 211, 153, 0.15)' : 'var(--surface-3)',
                        color: enableTp ? '#34d399' : 'var(--text-dim)',
                        border: `1px solid ${enableTp ? 'rgba(52, 211, 153, 0.3)' : 'var(--line)'}`,
                        textTransform: 'uppercase',
                      }}>
                        {enableTp ? 'Active' : 'Disabled'}
                      </span>
                    </label>
                  </div>

                  {!enableTp ? (
                    <div style={{ fontSize: 11.5, color: 'var(--text-dim)', padding: '6px 0', fontStyle: 'italic' }}>
                      Take Profit is disabled. No take-profit order will be placed. Check the box above or select TP Only / Both to enable.
                    </div>
                  ) : slTpMode === 'price' ? (
                    <>
                      <input
                        id="grp-tp"
                        inputMode="decimal"
                        value={tp}
                        onChange={(e) => setTp(e.target.value)}
                        placeholder="Target Price, e.g. 92000"
                        style={{ marginTop: 4, width: '100%' }}
                      />
                      {tp !== '' && Number(tp) <= 0 && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Target price must be greater than 0.
                        </div>
                      )}
                      {tp !== '' && Number(tp) > 0 && hasGroupRef && sideOk && (
                        <div className="hint" style={{ color: 'var(--ok)', fontSize: 11, marginTop: 4 }}>
                          ≈ {triggerToPct(groupAvgEntry, Number(tp), group.side as 'long' | 'short', 'tp').toFixed(2)}% gain from avg entry
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <input
                        id="grp-tp"
                        inputMode="decimal"
                        value={tpPct}
                        placeholder="Target %, e.g. 10"
                        onChange={(e) => setTpPct(e.target.value.replace(/[^\d.]/g, ''))}
                        style={{ marginTop: 4, width: '100%' }}
                      />
                      <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                        {TP_PCT_CHIPS.map((v) => (
                          <button
                            key={v}
                            type="button"
                            className="btn btn-sm secondary"
                            style={{
                              flex: 1, padding: '3px 0', fontSize: 11,
                              background: tpPct === String(v) ? 'var(--ok)' : 'var(--surface-3)',
                              color: tpPct === String(v) ? '#000000' : 'var(--text-dim)',
                              borderColor: tpPct === String(v) ? 'var(--ok)' : 'var(--line)',
                              fontWeight: tpPct === String(v) ? 700 : 500,
                            }}
                            onClick={() => setTpPct(String(v))}
                          >
                            {v}%
                          </button>
                        ))}
                      </div>
                      {tpPct !== '' && Number(tpPct) <= 0 && (
                        <div className="hint" style={{ color: 'var(--danger)', fontSize: 11, marginTop: 4 }}>
                          Target % must be greater than 0%.
                        </div>
                      )}
                      {hasGroupRef && sideOk && tpPct !== '' && Number(tpPct) > 0 && (
                        <div className="hint" style={{ color: 'var(--ok)', fontSize: 11, marginTop: 4 }}>
                          Target Price: {fmtPrice(String(pctToTrigger(groupAvgEntry, Number(tpPct), group.side as 'long' | 'short', 'tp')))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isExecuting}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={isExecuting || isHalted || !canSaveProtection}
                  onClick={handleExecuteProtection}
                >
                  {isExecuting
                    ? 'Updating Protection…'
                    : (!enableSl && !enableTp)
                      ? 'Select TP or SL Strategy'
                      : (enableTp && !enableSl)
                        ? `Apply Take Profit to All ${group.positions.length} Accounts`
                        : (enableSl && !enableTp)
                          ? `Apply Stop Loss to All ${group.positions.length} Accounts`
                          : `Apply Rules to All ${group.positions.length} Accounts`}
                </button>
              </div>
            </div>
          )}

          {/* ── Tab 4: Adjust Leverage (Bulk across Group Accounts) ── */}
          {activeTab === 'leverage' && (
            <div>
              <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Adjust leverage across accounts holding this position. Decreasing leverage requires additional free balance as margin in the respective accounts. Increasing leverage reduces required margin and frees collateral to the account wallet.
              </p>

              {/* Controls Card */}
              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 14 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Target Group Leverage
                  </span>
                  <strong style={{ fontSize: 16, color: '#818cf8', fontWeight: 800 }}>{groupTargetLeverage}×</strong>
                </div>

                {/* Preset Chips */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
                  {LEVERAGE_PRESET_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className="btn btn-sm secondary"
                      style={{
                        flex: '1 1 0px',
                        minWidth: 40,
                        padding: '5px 0',
                        fontSize: 11.5,
                        background: Number(groupTargetLeverage) === chip ? '#6366f1' : 'var(--surface-3)',
                        color: Number(groupTargetLeverage) === chip ? '#ffffff' : 'var(--text-dim)',
                        borderColor: Number(groupTargetLeverage) === chip ? '#6366f1' : 'var(--line)',
                        fontWeight: Number(groupTargetLeverage) === chip ? 700 : 500,
                      }}
                      onClick={() => setGroupTargetLeverage(String(chip))}
                    >
                      {chip}×
                    </button>
                  ))}
                </div>

                {/* Stepper + Direct Input */}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
                  <button
                    type="button"
                    className="btn btn-sm secondary"
                    style={{ width: 38, height: 34, fontSize: 16, fontWeight: 700, padding: 0 }}
                    disabled={Number(groupTargetLeverage) <= 1}
                    onClick={() => {
                      const cur = Number(groupTargetLeverage) || 1;
                      const next = Math.max(1, Math.round((cur - 0.5) * 10) / 10);
                      setGroupTargetLeverage(String(next));
                    }}
                  >
                    −
                  </button>
                  <div style={{ flex: 1, position: 'relative' }}>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={groupTargetLeverage}
                      onChange={(e) => {
                        const val = e.target.value.replace(/[^\d.]/g, '');
                        setGroupTargetLeverage(val);
                      }}
                      placeholder="e.g. 5"
                      style={{
                        width: '100%',
                        padding: '6px 28px 6px 12px',
                        fontSize: 13,
                        fontWeight: 700,
                        textAlign: 'center',
                        background: 'var(--surface-3)',
                        borderColor: isTargetLevValid ? 'var(--line)' : 'var(--danger)',
                        borderRadius: 'var(--radius-sm)',
                        color: 'var(--text)',
                      }}
                    />
                    <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                      ×
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn btn-sm secondary"
                    style={{ width: 38, height: 34, fontSize: 16, fontWeight: 700, padding: 0 }}
                    disabled={Number(groupTargetLeverage) >= 100}
                    onClick={() => {
                      const cur = Number(groupTargetLeverage) || 1;
                      const next = Math.min(100, Math.round((cur + 0.5) * 10) / 10);
                      setGroupTargetLeverage(String(next));
                    }}
                  >
                    +
                  </button>
                </div>

                {/* Interactive Slider */}
                <div style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>
                    <span>1× (Low risk)</span>
                    <span style={{ color: 'var(--text)', fontWeight: 600 }}>Slide to adjust: {groupTargetLeverage}×</span>
                    <span>100× (High risk)</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="100"
                    step="0.5"
                    value={Number(groupTargetLeverage) || 1}
                    onChange={(e) => setGroupTargetLeverage(e.target.value)}
                    style={{
                      width: '100%',
                      cursor: 'pointer',
                      accentColor: '#818cf8',
                    }}
                  />
                </div>

                {/* Aggregated Financial Breakdown Grid */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 16px', paddingTop: 12, borderTop: '1px solid var(--line)', fontSize: 12.5 }}>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Current Margin (Selected): </span>
                    <strong>
                      {group.marginCurrency === 'INR' ? `₹${totalCurrentMarginMajor.toFixed(2)}` : `${totalCurrentMarginMajor.toFixed(4)} USDT`}
                    </strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>New Required Margin: </span>
                    <strong>
                      {group.marginCurrency === 'INR' ? `₹${totalNewMarginMajor.toFixed(2)}` : `${totalNewMarginMajor.toFixed(4)} USDT`}
                    </strong>
                  </div>
                  <div>
                    <span style={{ color: 'var(--muted)' }}>Net Margin Delta: </span>
                    <strong style={{ color: totalNetMarginDeltaMajor > 0 ? '#f59e0b' : 'var(--ok)' }}>
                      {totalNetMarginDeltaMajor > 0
                        ? `+${group.marginCurrency === 'INR' ? `₹${totalNetMarginDeltaMajor.toFixed(2)}` : `${totalNetMarginDeltaMajor.toFixed(4)} USDT`} (Needs more)`
                        : totalNetMarginDeltaMajor < 0
                          ? `−${group.marginCurrency === 'INR' ? `₹${Math.abs(totalNetMarginDeltaMajor).toFixed(2)}` : `${Math.abs(totalNetMarginDeltaMajor).toFixed(4)} USDT`} (To be freed)`
                          : '0.00'}
                    </strong>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ color: 'var(--muted)' }}>Selected / Eligible: </span>
                    <strong style={{ color: '#818cf8' }}>
                      {selectedLeverageAccounts.length} selected ({evaluatedLeverageAccounts.filter((e) => e.isEligible && !e.isSame).length} eligible)
                    </strong>
                  </div>
                </div>
              </div>

              {/* Account Selection & Breakdown Table */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-dim)' }}>
                      Accounts ({filteredLeverageAccounts.length})
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm secondary"
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => {
                        const allEligible: Record<string, boolean> = {};
                        for (const item of evaluatedLeverageAccounts) {
                          if (item.isEligible && !item.isSame) {
                            allEligible[item.position.venuePositionId] = true;
                          }
                        }
                        setGroupLeverageSelection(allEligible);
                      }}
                    >
                      Select All Eligible
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm secondary"
                      style={{ padding: '2px 8px', fontSize: 11 }}
                      onClick={() => setGroupLeverageSelection({})}
                    >
                      Deselect All
                    </button>
                  </div>

                  <input
                    type="text"
                    placeholder="Filter accounts…"
                    value={leverageAccountSearch}
                    onChange={(e) => setLeverageAccountSearch(e.target.value)}
                    style={{ padding: '3px 8px', fontSize: 11.5, width: 160, borderRadius: 4, background: 'var(--surface-3)', border: '1px solid var(--line)', color: 'var(--text)' }}
                  />
                </div>

                <div className="table-scroll-container" style={{ maxHeight: 220 }}>
                  <table style={{ fontSize: 11.5 }}>
                    <thead>
                      <tr>
                        <th style={{ width: 32, textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={
                              evaluatedLeverageAccounts.filter((e) => e.isEligible && !e.isSame).length > 0 &&
                              evaluatedLeverageAccounts.filter((e) => e.isEligible && !e.isSame).every((e) => groupLeverageSelection[e.position.venuePositionId])
                            }
                            onChange={(e) => {
                              const checked = e.target.checked;
                              const next: Record<string, boolean> = {};
                              if (checked) {
                                for (const item of evaluatedLeverageAccounts) {
                                  if (item.isEligible && !item.isSame) {
                                    next[item.position.venuePositionId] = true;
                                  }
                                }
                              }
                              setGroupLeverageSelection(next);
                            }}
                            style={{ cursor: 'pointer' }}
                          />
                        </th>
                        <th>Account</th>
                        <th style={{ textAlign: 'center' }}>Current Lev</th>
                        <th style={{ textAlign: 'center' }}>Target Lev</th>
                        <th style={{ textAlign: 'right' }}>Margin Change</th>
                        <th style={{ textAlign: 'right' }}>Free Cash</th>
                        <th style={{ textAlign: 'center' }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLeverageAccounts.map((item) => {
                        const isSelected = Boolean(groupLeverageSelection[item.position.venuePositionId]);
                        return (
                          <tr key={item.position.venuePositionId} style={{ opacity: item.isSame || !item.isEligible ? 0.65 : 1 }}>
                            <td style={{ textAlign: 'center' }}>
                              <input
                                type="checkbox"
                                disabled={item.isSame || !item.isEligible}
                                checked={isSelected}
                                onChange={(e) => {
                                  const checked = e.target.checked;
                                  setGroupLeverageSelection((prev) => ({
                                    ...prev,
                                    [item.position.venuePositionId]: checked,
                                  }));
                                }}
                                style={{ cursor: item.isSame || !item.isEligible ? 'not-allowed' : 'pointer' }}
                              />
                            </td>
                            <td style={{ fontWeight: 600, color: 'var(--text)' }}>
                              {item.position.accountName}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <span className="pos-lev-pill">{item.currentLev}×</span>
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              <span style={{ fontWeight: 700, color: '#818cf8' }}>{groupTargetLeverage}×</span>
                            </td>
                            <td style={{ textAlign: 'right', fontWeight: 600 }}>
                              <span style={{ color: item.marginDeltaMajor > 0 ? (!item.isEligible ? 'var(--danger)' : '#f59e0b') : 'var(--ok)' }}>
                                {item.marginDeltaMajor > 0
                                  ? `+${group.marginCurrency === 'INR' ? `₹${item.marginDeltaMajor.toFixed(2)}` : `${item.marginDeltaMajor.toFixed(4)}`}`
                                  : item.marginDeltaMajor < 0
                                    ? `−${group.marginCurrency === 'INR' ? `₹${Math.abs(item.marginDeltaMajor).toFixed(2)}` : `${Math.abs(item.marginDeltaMajor).toFixed(4)}`}`
                                    : '0.00'}
                              </span>
                            </td>
                            <td style={{ textAlign: 'right', color: !item.isEligible ? 'var(--danger)' : 'var(--text)' }}>
                              {group.marginCurrency === 'INR' ? `₹${item.freeBalanceMajor.toFixed(2)}` : `${item.freeBalanceMajor.toFixed(4)} USDT`}
                            </td>
                            <td style={{ textAlign: 'center' }}>
                              {item.isSame ? (
                                <span className="badge" style={{ fontSize: 10, background: 'var(--surface-3)', color: 'var(--muted)' }}>Already {item.currentLev}×</span>
                              ) : !item.isEligible ? (
                                <span className="status-badge-skipped" title={`Needs ₹${item.shortfallMajor.toFixed(2)} more free cash`}>Shortfall</span>
                              ) : (
                                <span className="status-badge-funded">Eligible</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {groupLeverageMsg && (
                <div style={{
                  padding: '10px 14px',
                  background: groupLeverageMsg.kind === 'ok' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(240, 85, 90, 0.15)',
                  border: `1px solid ${groupLeverageMsg.kind === 'ok' ? 'var(--ok)' : 'var(--danger)'}`,
                  borderRadius: 'var(--radius)',
                  marginBottom: 14,
                  fontSize: 13,
                  color: groupLeverageMsg.kind === 'ok' ? 'var(--ok)' : 'var(--danger)',
                  fontWeight: 600,
                }}>
                  {groupLeverageMsg.text}
                </div>
              )}

              {/* Action Buttons */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn btn-sm secondary"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}
                  disabled={isRefreshing}
                  onClick={() => void handleSyncAllBalances()}
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    width="12"
                    height="12"
                    style={{ animation: isRefreshing ? 'spin 1s linear infinite' : 'none' }}
                  >
                    <polyline points="23 4 23 10 17 10" />
                    <polyline points="1 20 1 14 7 14" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                  {isRefreshing ? 'Syncing Balances…' : 'Sync All Balances'}
                </button>

                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isExecutingLeverage}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ background: '#6366f1', color: '#ffffff', fontWeight: 700, border: 'none' }}
                    disabled={!isTargetLevValid || selectedLeverageAccounts.length === 0 || isExecutingLeverage || isHalted}
                    onClick={handleExecuteGroupLeverage}
                  >
                    {isExecutingLeverage
                      ? 'Adjusting Leverage…'
                      : selectedLeverageAccounts.length === 0
                        ? 'No Accounts Selected'
                        : `Adjust Leverage on ${selectedLeverageAccounts.length} Account${selectedLeverageAccounts.length === 1 ? '' : 's'} to ${groupTargetLeverage}×`}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Tab 5: Close Group Position ── */}
          {activeTab === 'close' && (
            <div>
              <div
                style={{
                  border: '1px solid rgba(240, 85, 90, 0.4)',
                  background: 'rgba(240, 85, 90, 0.08)',
                  borderRadius: 'var(--radius)',
                  padding: 16,
                  marginBottom: 16,
                }}
              >
                <h4 style={{ margin: '0 0 8px', color: 'var(--danger)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Full Market Exit Confirmation ({group.positions.length} Accounts)
                </h4>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text)', lineHeight: 1.5 }}>
                  Closing this group position will immediately execute a market order on CoinDCX for all <strong>{group.positions.length} accounts</strong> (Total Qty: <strong>{group.totalQty.toFixed(4).replace(/\.?0+$/, '')}</strong>).
                </p>
                <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                  <li>Any attached Stop Loss or Take Profit orders will be cancelled first.</li>
                  <li>Estimated PnL to be realized: <strong className={pnlClass(group.totalPnlMinor)}>{pnlText(group.totalPnlMinor, group.marginCurrency)}</strong></li>
                  <li>Total Margin released: <strong>{group.totalMarginMinor ? fmtMinor(group.totalMarginMinor, group.marginCurrency) : '—'}</strong></li>
                </ul>
              </div>

              {!confirmExit ? (
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                  <button type="button" className="btn btn-sm secondary" onClick={onClose} disabled={isExecuting}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ background: 'var(--danger)', color: '#fff', border: 'none', fontWeight: 600 }}
                    disabled={isExecuting || isHalted}
                    onClick={() => setConfirmExit(true)}
                  >
                    Close Group Position at Market
                  </button>
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-end',
                    gap: 12,
                    padding: 14,
                    background: 'rgba(240, 85, 90, 0.15)',
                    borderRadius: 'var(--radius)',
                    border: '1px solid var(--danger)',
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', textAlign: 'right' }}>
                    Are you absolutely sure? All {group.positions.length} real money positions will be closed immediately!
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      type="button"
                      className="btn btn-sm secondary"
                      onClick={() => setConfirmExit(false)}
                      disabled={isExecuting}
                    >
                      No, Keep Group Open
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm"
                      style={{ background: 'var(--danger)', color: '#fff', border: 'none', fontWeight: 700 }}
                      disabled={isExecuting || isHalted}
                      onClick={handleExecuteExit}
                    >
                      {isExecuting ? 'Closing All Positions…' : `YES, CONFIRM MARKET EXIT FOR ALL ${group.positions.length} ACCOUNTS`}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Quick Exit Confirmation Modal (Fast & Safe Market Exits) ─── */

export type QuickExitTarget =
  | { type: 'group'; group: PositionGroup }
  | { type: 'account'; position: FuturesPositionRow };

export function QuickExitModal({
  target,
  onClose,
  onRefreshPositions,
  isHalted,
}: {
  readonly target: QuickExitTarget;
  readonly onClose: () => void;
  readonly onRefreshPositions: () => void;
  readonly isHalted?: boolean | undefined;
}) {
  const [isExecuting, setIsExecuting] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; accountName: string } | null>(null);
  const [execResult, setExecResult] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  const isGroup = target.type === 'group';
  const group = isGroup ? target.group : null;
  const position = !isGroup ? target.position : null;

  const handleConfirmExit = async () => {
    if (isExecuting || isHalted) return;
    setIsExecuting(true);
    setExecResult(null);

    if (isGroup && group) {
      let succeeded = 0;
      let failed = 0;
      const errors: string[] = [];

      let completed = 0;
      const batchGroupTradeId = crypto.randomUUID();
      await mapConcurrent(group.positions, 12, async (pos) => {
        try {
          await exitFuturesPosition(pos.venuePositionId, pos.marginCurrency, batchGroupTradeId);
          succeeded++;
        } catch (err) {
          const msg = (err as Error).message || '';
          if (/no\s+active\s+position/i.test(msg) || /already\s+(closed|flat|exited)/i.test(msg)) {
            succeeded++;
          } else {
            failed++;
            errors.push(`${pos.accountName}: ${msg}`);
          }
        } finally {
          completed++;
          setProgress({ current: completed, total: group.positions.length, accountName: pos.accountName });
        }
      });

      setIsExecuting(false);
      setProgress(null);
      onRefreshPositions();

      if (failed === 0) {
        setExecResult({
          kind: 'ok',
          message: `Successfully closed positions at market across all ${succeeded} account${succeeded === 1 ? '' : 's'}.`,
        });
        setTimeout(() => onClose(), 1500);
      } else {
        setExecResult({
          kind: 'err',
          message: `Closed ${succeeded} account${succeeded === 1 ? '' : 's'}; ${failed} failed: ${errors.slice(0, 2).join('; ')}`,
        });
      }
    } else if (position) {
      setProgress({ current: 1, total: 1, accountName: position.accountName });
      try {
        await exitFuturesPosition(position.venuePositionId, position.marginCurrency);
        setIsExecuting(false);
        setProgress(null);
        onRefreshPositions();
        setExecResult({
          kind: 'ok',
          message: `Successfully submitted market exit order for ${position.accountName}.`,
        });
        setTimeout(() => onClose(), 1500);
      } catch (err) {
        const msg = (err as Error).message || '';
        setIsExecuting(false);
        setProgress(null);
        if (/no\s+active\s+position/i.test(msg) || /already\s+(closed|flat|exited)/i.test(msg)) {
          onRefreshPositions();
          setExecResult({
            kind: 'ok',
            message: `Position for ${position.accountName} is already closed.`,
          });
          setTimeout(() => onClose(), 1500);
        } else {
          setExecResult({
            kind: 'err',
            message: `Exit failed: ${msg}`,
          });
        }
      }
    }
  };

  const pnlNum = isGroup ? Number(group?.totalPnlMinor ?? 0) : Number(position?.unrealisedPnlMinor ?? 0);
  const pnlMinor = isGroup ? group?.totalPnlMinor ?? null : position?.unrealisedPnlMinor ?? null;
  const quote = isGroup ? group!.marginCurrency : position!.marginCurrency;
  const roe = !isGroup && position ? calcRoePct(position) : null;
  const totalWeight = isGroup && group ? group.positions.reduce((acc, pos) => acc + Number(pos.quantity), 0) : 0;
  const weightedRoeSum = isGroup && group ? group.positions.reduce((acc, pos) => {
    const r = calcRoePct(pos);
    return r !== null ? acc + r * Number(pos.quantity) : acc;
  }, 0) : 0;
  const groupRoe = isGroup && totalWeight > 0 ? weightedRoeSum / totalWeight : null;
  const effectiveRoe = isGroup ? groupRoe : roe;

  const side = isGroup ? group!.side : position!.side;
  const sideColor = side === 'long' ? 'var(--ok)' : side === 'short' ? 'var(--danger)' : 'var(--text-dim)';

  return (
    <div className="position-modal-overlay" onClick={() => { if (!isExecuting) onClose(); }}>
      <div className="position-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
        {/* Header */}
        <div className="position-modal-header" style={{ borderBottom: '1px solid rgba(239, 68, 68, 0.25)', background: 'linear-gradient(180deg, rgba(239, 68, 68, 0.08) 0%, transparent 100%)' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 28,
                height: 28,
                borderRadius: '50%',
                background: 'rgba(239, 68, 68, 0.15)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#ef4444',
              }}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
              </div>
              <h3 className="position-modal-title" style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>
                {isGroup ? `Quick Exit Group: ${group!.asset}` : `Quick Exit: ${position!.accountName}`}
              </h3>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, marginLeft: 36 }}>
              <span className="badge" style={{ color: sideColor, borderColor: sideColor, textTransform: 'uppercase', fontWeight: 700, fontSize: 11 }}>
                {side}
              </span>
              <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                {isGroup
                  ? `${group!.groupNames.join(', ')} (${group!.positions.length} account${group!.positions.length === 1 ? '' : 's'})`
                  : `${position!.pair} (${position!.marginCurrency})`}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="position-modal-close"
            onClick={onClose}
            disabled={isExecuting}
            title="Cancel and close"
          >
            &times;
          </button>
        </div>

        <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {isHalted && (
            <div
              style={{
                backgroundColor: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid var(--danger)',
                borderRadius: 6,
                padding: '10px 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12.5,
                color: 'var(--danger)',
                fontWeight: 600,
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', backgroundColor: 'var(--danger)', display: 'inline-block' }} />
              <span>EMERGENCY KILL SWITCH ACTIVE: Market exits and order cancellations are strictly locked.</span>
            </div>
          )}
          {/* Key Metrics */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: isGroup ? 'repeat(3, 1fr)' : 'repeat(4, 1fr)',
            gap: 10,
            background: 'var(--panel-2)',
            padding: 14,
            borderRadius: 'var(--radius)',
            border: '1px solid var(--line)',
          }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {isGroup ? 'Total Qty' : 'Quantity'}
              </div>
              <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                {isGroup ? group!.totalQty.toFixed(4).replace(/\.?0+$/, '') : position!.quantity}
              </div>
            </div>

            {!isGroup && position && (
              <>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Entry</div>
                  <div className="mono" style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', marginTop: 2 }}>
                    {fmtPrice(position.avgEntryPrice)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Liquidation</div>
                  <div className="mono" style={{ fontSize: 13.5, fontWeight: 700, color: '#facc15', marginTop: 2 }}>
                    {fmtPrice(position.liquidationPrice)}
                  </div>
                </div>
              </>
            )}

            {isGroup && group && (
              <div>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Accounts</div>
                <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginTop: 2 }}>
                  {group.positions.length}
                </div>
              </div>
            )}

            <div>
              <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Unrealized PnL</div>
              <div className="mono" style={{
                fontSize: 15,
                fontWeight: 800,
                color: pnlNum > 0 ? '#10b981' : pnlNum < 0 ? '#ef4444' : 'var(--text-dim)',
                marginTop: 2,
              }}>
                {pnlText(pnlMinor, quote)}
                {effectiveRoe !== null && (
                  <span style={{ fontSize: 11.5, fontWeight: 700, display: 'block' }}>
                    {roeText(effectiveRoe).trim()}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Warning Banner */}
          <div style={{
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 'var(--radius)',
            padding: '12px 16px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#ef4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            <div style={{ fontSize: 12.5, lineHeight: 1.5, color: '#fca5a5' }}>
              <strong>Immediate Market Exit:</strong> This will place a market order on CoinDCX to close{' '}
              {isGroup ? `all positions in ${group!.positions.length} account(s)` : `the position for ${position!.accountName}`}.
              Any open Stop Loss or Take Profit orders will be cancelled automatically on the exchange.
            </div>
          </div>

          {/* Group Accounts Breakdown */}
          {isGroup && group && group.positions.length > 1 && (
            <div style={{ maxHeight: 150, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 'var(--radius)', background: 'var(--panel-2)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--line)', color: 'var(--muted)', background: 'rgba(0,0,0,0.2)' }}>
                    <th style={{ padding: '6px 12px', textAlign: 'left' }}>Account</th>
                    <th style={{ padding: '6px 12px', textAlign: 'right' }}>Qty</th>
                    <th style={{ padding: '6px 12px', textAlign: 'right' }}>PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {group.positions.map((p) => {
                    const accPnlNum = Number(p.unrealisedPnlMinor ?? 0);
                    return (
                      <tr key={p.venuePositionId} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                        <td style={{ padding: '6px 12px', fontWeight: 600 }}>{p.accountName}</td>
                        <td className="mono" style={{ padding: '6px 12px', textAlign: 'right' }}>{p.quantity}</td>
                        <td className="mono" style={{
                          padding: '6px 12px',
                          textAlign: 'right',
                          fontWeight: 700,
                          color: accPnlNum > 0 ? '#10b981' : accPnlNum < 0 ? '#ef4444' : 'var(--text-dim)',
                        }}>
                          {pnlText(p.unrealisedPnlMinor, p.marginCurrency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Progress / Status */}
          {progress && (
            <div style={{
              background: 'rgba(76, 141, 255, 0.1)',
              border: '1px solid rgba(76, 141, 255, 0.3)',
              borderRadius: 'var(--radius)',
              padding: '12px 16px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>
                  Exiting {progress.accountName} ({progress.current} of {progress.total})…
                </span>
                <span className="mono" style={{ color: 'var(--text-dim)' }}>
                  {Math.round((progress.current / progress.total) * 100)}%
                </span>
              </div>
              <div style={{ width: '100%', height: 6, background: 'var(--surface-3)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  width: `${(progress.current / progress.total) * 100}%`,
                  height: '100%',
                  background: 'var(--accent)',
                  transition: 'width 0.2s ease',
                }} />
              </div>
            </div>
          )}

          {/* Result Feedback */}
          {execResult && (
            <div style={{
              padding: '10px 14px',
              borderRadius: 'var(--radius)',
              fontSize: 12.5,
              fontWeight: 600,
              background: execResult.kind === 'ok' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
              color: execResult.kind === 'ok' ? '#10b981' : '#f87171',
              border: `1px solid ${execResult.kind === 'ok' ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            }}>
              {execResult.message}
            </div>
          )}

          {/* Action Buttons */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              className="btn secondary"
              onClick={onClose}
              disabled={isExecuting}
              style={{ padding: '8px 18px', fontSize: 13, fontWeight: 600 }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn"
              onClick={handleConfirmExit}
              disabled={isExecuting || isHalted || execResult?.kind === 'ok'}
              style={{
                padding: '8px 20px',
                fontSize: 13,
                fontWeight: 700,
                background: '#ef4444',
                color: '#ffffff',
                border: 'none',
                borderRadius: 'var(--radius)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                cursor: isExecuting || isHalted || execResult?.kind === 'ok' ? 'not-allowed' : 'pointer',
                opacity: isExecuting || isHalted || execResult?.kind === 'ok' ? 0.6 : 1,
              }}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              {isExecuting
                ? 'Closing Positions…'
                : isGroup
                  ? `Confirm & Close ${group!.positions.length} Position${group!.positions.length === 1 ? '' : 's'}`
                  : 'Confirm & Close Position'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Main Component ─── */

export function Futures() {
  const qc = useQueryClient();
  const [managingPosition, setManagingPosition] = useState<FuturesPositionRow | null>(null);
  const [managingGroup, setManagingGroup] = useState<PositionGroup | null>(null);
  const [quickExitTarget, setQuickExitTarget] = useState<QuickExitTarget | null>(null);
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [pnlFilter, setPnlFilter] = useState<'all' | 'profit' | 'loss'>('all');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Keyboard shortcut: Press '/' or 'Ctrl/Cmd+K' to focus search, 'Esc' to clear and blur
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      const isInputActive =
        activeEl instanceof HTMLInputElement ||
        activeEl instanceof HTMLTextAreaElement ||
        activeEl instanceof HTMLSelectElement ||
        (activeEl as HTMLElement | null)?.isContentEditable;

      if (e.key === '/' && !isInputActive) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      } else if (e.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setSearchQuery('');
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const killSwitchQuery = useQuery({
    queryKey: ['kill-switch'],
    queryFn: fetchKillSwitchStatus,
    refetchInterval: 3000,
  });
  const isHalted = Boolean(killSwitchQuery.data?.active);

  // By default, cards are EXPANDED so all critical details are visible immediately.
  // collapsedGroups keeps track of cards the user explicitly minimized.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  // Keep live market price feed streaming in real-time while on positions page
  const { isStreaming } = useLivePrices();

  const positions = useQuery({
    queryKey: ['futures-positions'],
    queryFn: fetchFuturesPositions,
    refetchInterval: isStreaming ? 10_000 : 2_000,
  });

  // Unified refresh handler: invalidates query cache immediately so local changes reflect instantly,
  // then runs exchange sync in the background to ensure venue mirror consistency.
  const handleRefreshAll = useCallback(async () => {
    void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    try {
      await refreshFuturesPositions();
    } catch {
      // background sync is best-effort
    }
    void qc.invalidateQueries({ queryKey: ['futures-positions'] });
  }, [qc]);

  const refreshMut = useMutation({
    mutationFn: () => refreshFuturesPositions(),
    onSuccess: (out) => {
      setMessage({
        kind: 'ok',
        text: `Re-read ${out.accounts} account${out.accounts === 1 ? '' : 's'} from the exchange — ${out.positions} open position${out.positions === 1 ? '' : 's'}.`,
      });
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  const adjustMut = useMutation({
    mutationFn: ({ id, direction, percentBp, quantity }: { id: string; direction: 'reduce' | 'increase'; percentBp?: number | undefined; quantity?: string | undefined }) =>
      adjustFuturesPosition(id, direction, percentBp, undefined, quantity),
    onSuccess: (out, { direction, percentBp, quantity }) => {
      setMessage({
        kind: 'ok',
        text: `${direction === 'reduce' ? 'Closed' : 'Added'} ${quantity ? `${quantity} qty` : `${(percentBp ?? 0) / 100}%`} — ${out.quantity} ${direction === 'reduce' ? 'sold' : 'bought'}${out.full ? ' (full exit via positions/exit)' : ''}.`,
      });
      setManagingPosition(null);
      void handleRefreshAll();
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  const exitMut = useMutation({
    mutationFn: ({ id, marginCurrency }: { id: string; marginCurrency: 'INR' | 'USDT' }) =>
      exitFuturesPosition(id, marginCurrency),
    onSuccess: (out) => {
      setMessage({
        kind: 'ok',
        text: `Position closed at market (cancelled ${out.cancelled.length} conditional order${out.cancelled.length === 1 ? '' : 's'}${out.venueGroupId === null ? '' : `, venue group ${out.venueGroupId}`}).`,
      });
      setManagingPosition(null);
      void handleRefreshAll();
    },
    onError: (e) => {
      const msg = (e as Error).message || '';
      if (/no\s+active\s+position/i.test(msg) || /already\s+(closed|flat|exited)/i.test(msg)) {
        setMessage({ kind: 'ok', text: 'Position is already closed.' });
        setManagingPosition(null);
        void handleRefreshAll();
      } else {
        setMessage({ kind: 'err', text: msg });
      }
    },
  });

  const protMut = useMutation({
    mutationFn: async (args: { readonly id: string; readonly slp?: string | undefined; readonly tpp?: string | undefined; readonly trailing?: boolean | undefined }) => {
      const body: { stopLossPrice?: string; takeProfitPrice?: string; moveExisting: boolean } = { moveExisting: true };
      if (args.slp !== undefined && args.slp !== '') body.stopLossPrice = args.slp;
      if (args.tpp !== undefined && args.tpp !== '') body.takeProfitPrice = args.tpp;

      const out = await setFuturesProtection(args.id, body);

      if (args.trailing && args.slp) {
        await setTrailingProtection(args.id, {
          enable: true,
          currentSlPrice: args.slp,
          stepBp: '100',
          distanceBp: '100',
        });
      } else if (!args.trailing) {
        await setTrailingProtection(args.id, { enable: false });
      }
      return out;
    },
    onSuccess: (out) => {
      const failures: string[] = [];
      if (out.stopLoss?.ok === false) failures.push(`SL: ${out.stopLoss.reason ?? 'refused'}`);
      if (out.takeProfit?.ok === false) failures.push(`TP: ${out.takeProfit.reason ?? 'refused'}`);
      setMessage(failures.length > 0
        ? { kind: 'err', text: `Some legs failed — ${failures.join('; ')}` }
        : { kind: 'ok', text: 'Protection updated.' });
      setManagingPosition(null);
      void qc.invalidateQueries({ queryKey: ['futures-positions'] });
    },
    onError: (e) => setMessage({ kind: 'err', text: (e as Error).message }),
  });

  const [showHiddenAccounts, setShowHiddenAccounts] = useState(false);

  const allRows = positions.data?.views ?? [];
  const hiddenRowsCount = useMemo(() => allRows.filter((r) => r.hideFromPositions).length, [allRows]);

  const rows = useMemo(() => {
    if (showHiddenAccounts) return allRows;
    return allRows.filter((r) => !r.hideFromPositions);
  }, [allRows, showHiddenAccounts]);

  const hasAny = rows.length > 0;

  // Build grouped positions
  const groups = useMemo(() => buildGroups(rows), [rows]);

  // Compute counts for Profit / Loss tabs
  const { profitCount, lossCount, allCount } = useMemo(() => {
    let profit = 0;
    let loss = 0;
    for (const g of groups) {
      const pnl = Number(g.totalPnlMinor ?? 0);
      if (pnl > 0) profit++;
      else if (pnl < 0) loss++;
    }
    return { profitCount: profit, lossCount: loss, allCount: groups.length };
  }, [groups]);

  // Filter grouped positions by group name, coin/asset, pair, or member account
  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return groups;
    return groups.filter((g) => {
      if (g.asset.toLowerCase().includes(q)) return true;
      if (g.pair.toLowerCase().includes(q)) return true;
      if (g.marginCurrency.toLowerCase().includes(q)) return true;
      if (g.groupNames.some((name) => name.toLowerCase().includes(q))) return true;
      if (g.positions.some((p) => p.accountName.toLowerCase().includes(q))) return true;
      return false;
    });
  }, [groups, searchQuery]);

  // Apply Profit / Loss filter tab
  const displayedGroups = useMemo(() => {
    if (pnlFilter === 'profit') {
      return filteredGroups.filter((g) => Number(g.totalPnlMinor ?? 0) > 0);
    }
    if (pnlFilter === 'loss') {
      return filteredGroups.filter((g) => Number(g.totalPnlMinor ?? 0) < 0);
    }
    return filteredGroups;
  }, [filteredGroups, pnlFilter]);

  // Keep managingPosition up-to-date with live polling
  const liveManagingPosition = useMemo(() => {
    if (managingPosition === null) return null;
    return rows.find((r) => r.venuePositionId === managingPosition.venuePositionId) ?? managingPosition;
  }, [rows, managingPosition]);

  // Keep managingGroup up-to-date with live polling
  const liveManagingGroup = useMemo(() => {
    if (managingGroup === null) return null;
    return groups.find((g) => g.key === managingGroup.key) ?? managingGroup;
  }, [groups, managingGroup]);

  // Keep quickExitTarget up-to-date with live polling
  const liveQuickExitTarget = useMemo<QuickExitTarget | null>(() => {
    if (quickExitTarget === null) return null;
    if (quickExitTarget.type === 'account') {
      const p = rows.find((r) => r.venuePositionId === quickExitTarget.position.venuePositionId) ?? quickExitTarget.position;
      return { type: 'account', position: p };
    }
    const g = groups.find((grp) => grp.key === quickExitTarget.group.key) ?? quickExitTarget.group;
    return { type: 'group', group: g };
  }, [rows, groups, quickExitTarget]);

  // Compute total PnL across all positions
  const totalPnl = useMemo(() => {
    const byCurrency: Record<string, string> = {};
    for (const p of rows) {
      if (p.unrealisedPnlMinor !== null) {
        const cur = p.marginCurrency;
        byCurrency[cur] = byCurrency[cur] === undefined
          ? p.unrealisedPnlMinor
          : addMinors(byCurrency[cur]!, p.unrealisedPnlMinor);
      }
    }
    return byCurrency;
  }, [rows]);

  // Compute total Margin invested across all positions
  const totalMargin = useMemo(() => {
    const byCurrency: Record<string, string> = {};
    for (const p of rows) {
      if (p.lockedMarginMinor !== null && p.lockedMarginMinor !== '' && p.lockedMarginMinor !== '0') {
        const cur = p.marginCurrency;
        byCurrency[cur] = byCurrency[cur] === undefined
          ? p.lockedMarginMinor
          : addMinors(byCurrency[cur]!, p.lockedMarginMinor);
      }
    }
    return byCurrency;
  }, [rows]);

  const toggleGroupCollapse = (key: string): void => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const collapseAll = (): void => {
    setCollapsedGroups(new Set(groups.map((g) => g.key)));
  };

  const expandAll = (): void => {
    setCollapsedGroups(new Set());
  };

  const allCollapsed = groups.length > 0 && groups.every((g) => collapsedGroups.has(g.key));

  return (
    <div className="panel full-width-page">
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>Positions</h2>
          <span
            className="badge"
            style={{
              background: 'rgba(75,181,99,0.12)',
              color: 'var(--ok)',
              border: '1px solid var(--ok)',
              fontSize: 11,
              fontWeight: 600,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '2px 8px',
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', display: 'inline-block' }} />
            Live (3s)
          </span>

          {groups.length > 1 && (
            <button
              type="button"
              className="btn btn-sm secondary"
              style={{ fontSize: 11.5, padding: '3px 10px' }}
              onClick={allCollapsed ? expandAll : collapseAll}
            >
              {allCollapsed ? 'Expand All' : 'Collapse All'}
            </button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Socket stream indicator matching Trade Watchlist */}
          {isStreaming ? (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: '#0ecb81',
                background: 'rgba(14, 203, 129, 0.12)',
                border: '1px solid rgba(14, 203, 129, 0.25)',
                borderRadius: 4,
                padding: '3px 8px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
              title="Real-time WebSocket streaming active (<500ms updates via CoinDCX)"
            >
              <span style={{ fontSize: 7, color: '#0ecb81' }}>●</span> Live (WS Stream)
            </span>
          ) : (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                color: '#f59e0b',
                background: 'rgba(245, 158, 11, 0.12)',
                border: '1px solid rgba(245, 158, 11, 0.25)',
                borderRadius: 4,
                padding: '3px 8px',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
              title="Connecting to real-time WebSocket stream — falling back to 1s HTTP polling"
            >
              <span style={{ fontSize: 7, color: '#f59e0b' }}>●</span> Polling (1s)
            </span>
          )}

          <button
            type="button"
            className="btn secondary btn-sm"
            disabled={refreshMut.isPending}
            onClick={() => refreshMut.mutate()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ animation: refreshMut.isPending ? 'spin 1s linear infinite' : 'none' }}>
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
            </svg>
            {refreshMut.isPending ? 'Reading…' : 'Sync'}
          </button>
          <span className="muted" style={{ fontSize: 11.5 }}>
            {positions.data === undefined ? '' : new Date(positions.data.at).toLocaleTimeString('en-IN')}
          </span>
        </div>
      </div>

      {/* ── Emergency Kill Switch Banner ── */}
      {isHalted && (
        <div
          style={{
            backgroundColor: 'rgba(239, 68, 68, 0.12)',
            border: '1px solid var(--danger)',
            borderRadius: 6,
            padding: '12px 16px',
            marginBottom: 16,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                backgroundColor: 'var(--danger)',
                display: 'inline-block',
                boxShadow: '0 0 8px var(--danger)',
              }}
            />
            <div>
              <strong style={{ color: 'var(--danger)', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                EMERGENCY KILL SWITCH ACTIVE — Read-Only Mode
              </strong>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
                All order placement, position exits, adjustments, and SL/TP modifications are locked. Live positions and balances are strictly read-only.
                {killSwitchQuery.data?.reason ? ` (${killSwitchQuery.data.reason})` : ''}
              </div>
            </div>
          </div>
          <Link
            to="/app/settings?tab=controls"
            className="btn btn-sm"
            style={{
              background: 'var(--danger)',
              color: '#fff',
              borderColor: 'var(--danger)',
              fontWeight: 600,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            Manage in Settings
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </Link>
        </div>
      )}

      {/* ── Summary ── */}
      {hasAny && (
        <div className="positions-summary">
          <div className="summary-stat-block summary-pnl-block">
            <div className="stat-label">Unrealised PnL</div>
            <div className="pnl-entries-row">
              {Object.entries(totalPnl).map(([cur, minor]) => {
                const pnlVal = Number(minor);
                const marginMinor = totalMargin[cur];
                const marginVal = marginMinor ? Number(marginMinor) : 0;
                const pct = marginVal > 0 ? (pnlVal / marginVal) * 100 : null;
                const isProf = pnlVal > 0;
                const isLoss = pnlVal < 0;
                const sign = isProf ? '+' : isLoss ? '-' : '';
                const pctColor = isProf ? 'var(--ok)' : isLoss ? 'var(--danger)' : 'var(--text-dim)';
                const pctBg = isProf ? 'rgba(16, 185, 129, 0.15)' : isLoss ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255, 255, 255, 0.05)';
                const pctBorder = isProf ? 'rgba(16, 185, 129, 0.35)' : isLoss ? 'rgba(239, 68, 68, 0.35)' : 'rgba(255, 255, 255, 0.1)';

                return (
                  <div key={cur} className="pnl-entry-item">
                    <span className={`pnl-big ${pnlClass(minor)}`}>
                      {pnlText(minor, cur as 'INR' | 'USDT')}
                    </span>
                    {pct !== null && (
                      <span
                        className="pnl-pct-badge"
                        style={{
                          color: pctColor,
                          background: pctBg,
                          border: `1px solid ${pctBorder}`,
                        }}
                      >
                        {sign}{Math.abs(pct).toFixed(2)}%
                      </span>
                    )}
                  </div>
                );
              })}
              {Object.keys(totalPnl).length === 0 && (
                <span className="pnl-big muted">—</span>
              )}
            </div>
          </div>

          <div className="summary-stat-block summary-margin-block">
            <div className="stat-label">Margin Invested</div>
            <div className="margin-entries-row">
              {Object.entries(totalMargin).map(([cur, minor]) => (
                <span key={cur} className="stat-value" style={{ fontWeight: 600 }}>
                  {fmtMinor(minor, cur as 'INR' | 'USDT')}
                </span>
              ))}
              {Object.keys(totalMargin).length === 0 && (
                <span className="stat-value muted">—</span>
              )}
            </div>
          </div>

          <div className="summary-stat-block summary-count-block">
            <div className="stat-label">Positions</div>
            <div className="stat-value">{rows.length}</div>
          </div>

          <div className="summary-stat-block summary-count-block">
            <div className="stat-label">Groups</div>
            <div className="stat-value">{groups.length}</div>
          </div>
        </div>
      )}

      {/* ── Messages ── */}
      {message !== null && (
        <div style={{ marginBottom: 12, fontSize: 13, color: message.kind === 'ok' ? 'var(--ok)' : 'var(--danger)' }}>
          {message.text}
        </div>
      )}

      {/* ── Loading / Error / Empty ── */}
      {positions.isLoading && <p className="muted">Loading positions…</p>}
      {positions.isError && <div className="error">{(positions.error as Error).message}</div>}

      {positions.isSuccess && !hasAny && (
        <div className="empty-state">
          <p>No open futures positions.</p>
          <p className="muted">Perpetual positions across your accounts will appear here — with mark, liquidation and unrealised PnL — while they are open.</p>
        </div>
      )}

      {/* ── Grouped Position Cards (Expanded by Default) ── */}
      {hasAny && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexWrap: 'wrap', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <div>
                <h3 style={{ fontSize: 14, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', margin: 0 }}>
                  Grouped Positions
                </h3>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {searchQuery.trim() !== ''
                    ? `Showing ${displayedGroups.length} of ${groups.length} group${groups.length === 1 ? '' : 's'}`
                    : pnlFilter !== 'all'
                      ? `Showing ${displayedGroups.length} ${pnlFilter === 'profit' ? 'profit-making' : 'loss-making'} group${displayedGroups.length === 1 ? '' : 's'}`
                      : 'All metrics and accounts visible by default'}
                </span>
              </div>

              {/* Profit / Loss Filter Tabs */}
              <div style={{ display: 'inline-flex', alignItems: 'center', background: 'var(--surface-2)', padding: 3, borderRadius: 8, border: '1px solid var(--line)', gap: 3 }}>
                <button
                  type="button"
                  style={{
                    padding: '4px 11px',
                    fontSize: 12,
                    fontWeight: 700,
                    borderRadius: 6,
                    border: 'none',
                    background: pnlFilter === 'all' ? 'rgba(255, 255, 255, 0.12)' : 'transparent',
                    color: pnlFilter === 'all' ? '#ffffff' : 'var(--muted)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    transition: 'all 0.15s ease',
                  }}
                  onClick={() => setPnlFilter('all')}
                >
                  All Positions
                  <span style={{
                    marginLeft: 6,
                    padding: '1px 6px',
                    borderRadius: 10,
                    fontSize: 11,
                    fontWeight: 700,
                    background: pnlFilter === 'all' ? 'rgba(255, 255, 255, 0.2)' : 'var(--surface-3)',
                    color: pnlFilter === 'all' ? '#ffffff' : 'var(--text-dim)',
                  }}>
                    {allCount}
                  </span>
                </button>
                <button
                  type="button"
                  style={{
                    padding: '4px 11px',
                    fontSize: 12,
                    fontWeight: 700,
                    borderRadius: 6,
                    border: 'none',
                    background: pnlFilter === 'profit' ? 'rgba(16, 185, 129, 0.2)' : 'transparent',
                    color: pnlFilter === 'profit' ? '#10b981' : 'var(--muted)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    transition: 'all 0.15s ease',
                  }}
                  onClick={() => setPnlFilter('profit')}
                >
                  In Profit
                  <span style={{
                    marginLeft: 6,
                    padding: '1px 6px',
                    borderRadius: 10,
                    fontSize: 11,
                    fontWeight: 700,
                    background: pnlFilter === 'profit' ? '#10b981' : 'rgba(16, 185, 129, 0.15)',
                    color: pnlFilter === 'profit' ? '#ffffff' : '#10b981',
                  }}>
                    {profitCount}
                  </span>
                </button>
                <button
                  type="button"
                  style={{
                    padding: '4px 11px',
                    fontSize: 12,
                    fontWeight: 700,
                    borderRadius: 6,
                    border: 'none',
                    background: pnlFilter === 'loss' ? 'rgba(239, 68, 68, 0.2)' : 'transparent',
                    color: pnlFilter === 'loss' ? '#ef4444' : 'var(--muted)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    transition: 'all 0.15s ease',
                  }}
                  onClick={() => setPnlFilter('loss')}
                >
                  In Loss
                  <span style={{
                    marginLeft: 6,
                    padding: '1px 6px',
                    borderRadius: 10,
                    fontSize: 11,
                    fontWeight: 700,
                    background: pnlFilter === 'loss' ? '#ef4444' : 'rgba(239, 68, 68, 0.15)',
                    color: pnlFilter === 'loss' ? '#ffffff' : '#ef4444',
                  }}>
                    {lossCount}
                  </span>
                </button>
              </div>

              {/* Hidden Accounts Visibility Toggle Button */}
              {hiddenRowsCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowHiddenAccounts((prev) => !prev)}
                  style={{
                    padding: '4px 11px',
                    fontSize: 12,
                    fontWeight: 700,
                    borderRadius: 8,
                    border: showHiddenAccounts
                      ? '1px solid rgba(239, 68, 68, 0.4)'
                      : '1px solid var(--border)',
                    background: showHiddenAccounts
                      ? 'rgba(239, 68, 68, 0.15)'
                      : 'var(--surface-2)',
                    color: showHiddenAccounts ? '#fca5a5' : 'var(--muted)',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    transition: 'all 0.15s ease',
                  }}
                  title={showHiddenAccounts ? 'Click to hide accounts marked as hidden' : 'Click to show positions from hidden accounts'}
                >
                  {showHiddenAccounts ? (
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  )}
                  <span>
                    {showHiddenAccounts
                      ? `Showing ${hiddenRowsCount} Hidden`
                      : `Show ${hiddenRowsCount} Hidden`}
                  </span>
                </button>
              )}
            </div>

            {/* Group or Coin Search Input */}
            <div className={`tradex-search-bar ${searchQuery.trim() !== '' ? 'has-query' : ''}`}>
              <svg
                className="tradex-search-icon"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search coin, group, or account (e.g. BTC, Scalping)..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="tradex-search-input"
                aria-label="Search group or coin"
              />
              {searchQuery.trim() !== '' ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span className={`tradex-search-count ${displayedGroups.length === 0 ? 'zero' : ''}`}>
                    {displayedGroups.length} match{displayedGroups.length === 1 ? '' : 'es'}
                  </span>
                  <button
                    type="button"
                    className="tradex-search-clear"
                    onClick={() => {
                      setSearchQuery('');
                      searchInputRef.current?.focus();
                    }}
                    title="Clear search (Esc)"
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <kbd className="tradex-search-kbd" title="Press / or Ctrl+K to search">
                  /
                </kbd>
              )}
            </div>
          </div>

          {displayedGroups.length === 0 ? (
            <div className="empty-state" style={{ padding: '36px 16px', textAlign: 'center' }}>
              {searchQuery.trim() !== '' ? (
                <>
                  <p style={{ margin: 0, fontSize: '14.5px', fontWeight: 600 }}>No groups or coins match "{searchQuery}"</p>
                  <p className="muted" style={{ margin: '6px 0 14px', fontSize: '13px' }}>Try searching by coin symbol (e.g. BTC, ETH), group name, or account name.</p>
                  <button type="button" className="btn secondary btn-sm" onClick={() => setSearchQuery('')}>
                    Clear search
                  </button>
                </>
              ) : pnlFilter === 'profit' ? (
                <>
                  <p style={{ margin: 0, fontSize: '14.5px', fontWeight: 600 }}>No profit-making positions</p>
                  <p className="muted" style={{ margin: '6px 0 14px', fontSize: '13px' }}>None of your active positions currently have positive unrealised PnL.</p>
                  <button type="button" className="btn secondary btn-sm" onClick={() => setPnlFilter('all')}>
                    View all positions
                  </button>
                </>
              ) : pnlFilter === 'loss' ? (
                <>
                  <p style={{ margin: 0, fontSize: '14.5px', fontWeight: 600 }}>No loss-making positions</p>
                  <p className="muted" style={{ margin: '6px 0 14px', fontSize: '13px' }}>None of your active positions currently have negative unrealised PnL.</p>
                  <button type="button" className="btn secondary btn-sm" onClick={() => setPnlFilter('all')}>
                    View all positions
                  </button>
                </>
              ) : (
                <p className="muted">No positions to display.</p>
              )}
            </div>
          ) : (
            displayedGroups.map((g) => (
              <GroupCard
                key={g.key}
                group={g}
                collapsed={collapsedGroups.has(g.key)}
                onToggle={() => toggleGroupCollapse(g.key)}
                onManage={(pos) => { setManagingPosition(pos); setMessage(null); }}
                onManageGroup={(grp) => { setManagingGroup(grp); setMessage(null); }}
                onQuickExit={(pos) => { setQuickExitTarget({ type: 'account', position: pos }); setMessage(null); }}
                onQuickExitGroup={(grp) => { setQuickExitTarget({ type: 'group', group: grp }); setMessage(null); }}
                isHalted={isHalted}
              />
            ))
          )}
        </div>
      )}

      {/* ── Position Management Modal (Safe Execution & Bracket Controls) ── */}
      {liveManagingPosition !== null && (
        <PositionManageModal
          position={liveManagingPosition}
          onClose={() => setManagingPosition(null)}
          onExit={(id, mc) => exitMut.mutate({ id, marginCurrency: mc })}
          onAdjust={(id, direction, percentBp, quantity) => adjustMut.mutate({ id, direction, percentBp, quantity })}
          onProtection={(args) => protMut.mutate(args)}
          isExiting={exitMut.isPending}
          isAdjusting={adjustMut.isPending}
          isProtecting={protMut.isPending}
          isHalted={isHalted}
        />
      )}

      {/* ── Group Position Management Modal (Safe Bulk Actions & Account Eligibility Fan-Out) ── */}
      {liveManagingGroup !== null && (
        <GroupPositionManageModal
          group={liveManagingGroup}
          onClose={() => setManagingGroup(null)}
          onRefreshPositions={handleRefreshAll}
          isHalted={isHalted}
        />
      )}

      {/* ── Quick Exit Confirmation Modal (One-Click Exit with Confirmation) ── */}
      {liveQuickExitTarget !== null && (
        <QuickExitModal
          target={liveQuickExitTarget}
          onClose={() => setQuickExitTarget(null)}
          onRefreshPositions={handleRefreshAll}
          isHalted={isHalted}
        />
      )}
    </div>
  );
}

