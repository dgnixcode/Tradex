import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { fetchAssets, fetchGroups, previewTrade } from '../api.ts';
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
  const [positionMarginType, setPositionMarginType] = useState<PositionMarginType>('isolated');
  const [percent, setPercent] = useState('');
  const [stopLossPrice, setStopLossPrice] = useState('');
  const [takeProfitPrice, setTakeProfitPrice] = useState('');
  const [reduceOnly, setReduceOnly] = useState(false);

  const selectedGroup: GroupSummary | undefined = useMemo(
    () => groups.data?.find((g) => g.id === groupId),
    [groups.data, groupId],
  );
  const selectedAsset: AssetOption | undefined = useMemo(
    () => assets.data?.find((a) => a.asset === asset),
    [assets.data, asset],
  );

  const preview = useMutation({
    mutationFn: (req: PlanRequest) => previewTrade(req),
    onSuccess: (result) => navigate(`/app/trades/${result.groupTradeId}`),
  });

  // Cross margin is USDT-only (research/03 F4). If the operator flips to INR
  // while crossed is selected, snap it back to isolated so the DB CHECK never
  // sees an invalid combination.
  const effectiveMarginType: PositionMarginType =
    marginCurrency === 'INR' && positionMarginType === 'crossed' ? 'isolated' : positionMarginType;

  const accountCount = selectedGroup?.enabledCount ?? 0;
  const leverageValid = /^\d+(\.\d+)?$/.test(leverage) && Number(leverage) >= 1 && Number(leverage) <= 100;
  const percentValid = /^\d+(\.\d+)?$/.test(percent) && Number(percent) > 0 && Number(percent) <= 100;
  const priceOk = (p: string): boolean => p === '' || /^\d+(\.\d+)?$/.test(p);

  const canPreview =
    groupId !== '' && asset !== '' && accountCount > 0
    && leverageValid && percentValid
    && (orderType !== 'limit' || (limitPrice !== '' && priceOk(limitPrice)))
    && priceOk(stopLossPrice) && priceOk(takeProfitPrice);

  const submitPreview = (): void => {
    const req: PlanRequest = {
      groupId,
      createdBy: '',
      asset,
      side,
      orderType,
      sizingMode: 'pct_allocated',
      percentBp: Math.round(Number(percent) * 100),
      ...(orderType === 'limit' ? { limitPrice } : {}),
      isFutures: true,
      leverage,
      marginCurrency,
      positionMarginType: effectiveMarginType,
      ...(stopLossPrice !== '' ? { stopLossPrice } : {}),
      ...(takeProfitPrice !== '' ? { takeProfitPrice } : {}),
      ...(reduceOnly ? { reduceOnly: true } : {}),
    };
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
        <div className="field">
          <label htmlFor="side">Side</label>
          <select id="side" value={side} onChange={(e) => setSide(e.target.value as Side)}>
            <option value="buy">Long (buy)</option>
            <option value="sell">Short (sell)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="type">Order type</label>
          <select id="type" value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}>
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
        </div>
      </div>

      {orderType === 'limit' && (
        <div className="field">
          <label htmlFor="limit">Limit price</label>
          <input
            id="limit"
            inputMode="decimal"
            value={limitPrice}
            placeholder="e.g. 85000"
            onChange={(e) => setLimitPrice(e.target.value)}
          />
        </div>
      )}

      <div className="row">
        <div className="field">
          <label htmlFor="mc">Margin currency</label>
          <select id="mc" value={marginCurrency} onChange={(e) => setMarginCurrency(e.target.value as MarginCurrency)}>
            <option value="USDT">USDT</option>
            <option value="INR">INR</option>
          </select>
        </div>
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
          <input
            id="lev"
            inputMode="decimal"
            value={leverage}
            placeholder="5"
            onChange={(e) => setLeverage(e.target.value)}
          />
          <div className="hint">1× to the market&rsquo;s per-tier max (server enforces).</div>
        </div>
      </div>

      <div className="field">
        <label htmlFor="pct">Size (% of allocated capital)</label>
        <input
          id="pct"
          inputMode="decimal"
          value={percent}
          placeholder="e.g. 20"
          onChange={(e) => setPercent(e.target.value)}
        />
        <div className="hint">
          {percentValid && leverageValid
            ? `${percent}% × ${leverage}× = ${(Number(percent) * Number(leverage)).toFixed(0)}% of allocated as notional exposure.`
            : 'Percent of the group’s allocated capital is used as margin; notional = margin × leverage.'}
        </div>
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="sl">Stop-loss trigger (optional)</label>
          <input id="sl" inputMode="decimal" value={stopLossPrice} placeholder="e.g. 80000" onChange={(e) => setStopLossPrice(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="tp">Take-profit trigger (optional)</label>
          <input id="tp" inputMode="decimal" value={takeProfitPrice} placeholder="e.g. 92000" onChange={(e) => setTakeProfitPrice(e.target.value)} />
        </div>
      </div>

      <div className="field">
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={reduceOnly} onChange={(e) => setReduceOnly(e.target.checked)} />
          <span>Reduce-only (never increases an existing position)</span>
        </label>
      </div>

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
