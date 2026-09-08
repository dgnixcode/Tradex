import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { fetchAssets, fetchGroups, previewTrade } from '../api.ts';
import type { AssetOption, GroupSummary, PlanRequest } from '../api.ts';
import { SizingFields } from '../components/SizingFields.tsx';

// The trade ticket (T04.7 / 21 F2). The single most important property of this
// screen: its ONLY action is "Preview N accounts". There is no submit, no place,
// no send — the customer cannot send a trade from here, by design (rung 0). The
// button navigates to the confirmation screen; nothing reaches a venue.
//
// Sizing fields default EMPTY (15 F6): a pre-filled amount is a pre-filled
// mistake on a screen that moves real money. Order type is filtered to what the
// chosen market actually allows. The spread warning is QUALITATIVE — it never
// shows a CoinDCX-derived number (ARCHITECTURE §6a).

type Side = 'buy' | 'sell';
type OrderType = 'market' | 'limit';
type SizingMode = PlanRequest['sizingMode'];

export function TradeTicket() {
  const navigate = useNavigate();
  const groups = useQuery({ queryKey: ['groups'], queryFn: fetchGroups });
  const assets = useQuery({ queryKey: ['assets'], queryFn: fetchAssets });

  const [groupId, setGroupId] = useState('');
  const [asset, setAsset] = useState('');
  const [side, setSide] = useState<Side>('buy');
  const [orderType, setOrderType] = useState<OrderType>('market');
  const [sizingMode, setSizingMode] = useState<SizingMode>('pct_allocated');
  // Sizing inputs default EMPTY (15 F6). Nothing is pre-filled.
  const [sizingValue, setSizingValue] = useState('');
  const [percent, setPercent] = useState('');
  const [limitPrice, setLimitPrice] = useState('');

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

  const accountCount = selectedGroup?.enabledCount ?? 0;
  const isPercentMode = sizingMode.startsWith('pct_');
  const needsValue = sizingMode !== 'sell_all';

  const canPreview =
    groupId !== '' && asset !== '' && accountCount > 0
    && (!needsValue || (isPercentMode ? percent !== '' : sizingValue !== ''))
    && (orderType !== 'limit' || limitPrice !== '');

  const submitPreview = () => {
    const req: PlanRequest = {
      groupId,
      createdBy: '', // the server derives the actor from the session
      asset,
      side,
      orderType,
      sizingMode,
      ...(isPercentMode ? { percentBp: Math.round(Number(percent) * 100) } : {}),
      ...(needsValue && !isPercentMode ? { sizingValue } : {}),
      ...(orderType === 'limit' ? { limitPrice } : {}),
    };
    preview.mutate(req);
  };

  return (
    <div className="panel">
      <h2>New group trade</h2>

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
          <div className="hint">Trades in {selectedAsset.quotes.join(' and ')}</div>
        )}
      </div>

      <div className="row">
        <div className="field">
          <label htmlFor="side">Side</label>
          <select id="side" value={side} onChange={(e) => setSide(e.target.value as Side)}>
            <option value="buy">Buy</option>
            <option value="sell">Sell</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="type">Order type</label>
          <select id="type" value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}>
            {/* In v1 both types are offered; the server refuses per-market via the
                order-type gate, and the confirmation lists any such skip. */}
            <option value="market">Market</option>
            <option value="limit">Limit</option>
          </select>
        </div>
      </div>

      <SizingFields
        side={side}
        orderType={orderType}
        sizingMode={sizingMode}
        onModeChange={setSizingMode}
        sizingValue={sizingValue}
        onValueChange={setSizingValue}
        percent={percent}
        onPercentChange={setPercent}
        limitPrice={limitPrice}
        onLimitPriceChange={setLimitPrice}
      />

      {orderType === 'market' && (
        // The spread warning is QUALITATIVE by rule (ARCHITECTURE §6a). It never
        // shows a measured spread or a percentage — only advice. The server
        // computes the real number and refuses if it is too wide.
        <div className="spread-warning">
          Market orders fill at the current book price. If the spread on the chosen
          market is wide, a limit order is recommended to control the price.
        </div>
      )}

      {preview.isError && (
        <div className="error">{(preview.error as Error).message}</div>
      )}

      {/* The ONLY action on this screen. Not a submit — a preview. There is no
          code path from here to a send. */}
      <button className="btn" disabled={!canPreview || preview.isPending} onClick={submitPreview}>
        {preview.isPending ? 'Previewing…' : `Preview ${accountCount} account${accountCount === 1 ? '' : 's'}`}
      </button>
    </div>
  );
}

/** Per-currency capital, never a single cross-currency total (money-units rule). */
function formatCapital(group: GroupSummary): string {
  const parts: string[] = [];
  const inr = group.allocatedByCurrency.INR;
  const usdt = group.allocatedByCurrency.USDT;
  if (inr !== '0') parts.push(`₹${minorToMajor(inr, 2)}`);
  if (usdt !== '0') parts.push(`${minorToMajor(usdt, 8)} USDT`);
  return parts.length === 0 ? 'none allocated' : parts.join(' + ');
}

/** minor units → a major-unit string. Presentation only; never used for sizing. */
function minorToMajor(minor: string, scale: number): string {
  if (scale === 0) return minor;
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
}
