import type { PlanRequest } from '../api.ts';

type SizingMode = PlanRequest['sizingMode'];

// The sizing controls (T04.7 / 21 F2). Each mode names its BASIS inline, because
// "20%" is meaningless until you know 20% of what — allocated capital, free
// balance, equity, or the held position. The available modes depend on the side:
// a buy cannot size against a position it does not yet hold, so pct_position and
// sell_all are sell-only (mirrored from the Intent type on the server).
//
// Every input starts EMPTY (15 F6). No default amount, no default percentage —
// a pre-filled figure on a money screen is a pre-filled mistake.

interface BuyMode { mode: Exclude<SizingMode, 'pct_position' | 'sell_all'>; label: string; basis: string; kind: 'percent' | 'amount' | 'quantity'; }
interface SellMode { mode: Exclude<SizingMode, 'pct_allocated' | 'pct_equity' | 'pct_free'>; label: string; basis: string; kind: 'percent' | 'amount' | 'quantity' | 'none'; }

const BUY_MODES: readonly BuyMode[] = [
  { mode: 'pct_allocated', label: 'Percent of allocated capital', basis: 'the capital typed at onboarding', kind: 'percent' },
  { mode: 'pct_free', label: 'Percent of free balance', basis: 'the spendable quote balance right now', kind: 'percent' },
  { mode: 'pct_equity', label: 'Percent of equity', basis: 'free balance plus the value of holdings', kind: 'percent' },
  { mode: 'quote_amount', label: 'Quote amount', basis: 'a fixed amount in the quote currency', kind: 'amount' },
  { mode: 'base_quantity', label: 'Base quantity', basis: 'an exact quantity of the asset', kind: 'quantity' },
];

const SELL_MODES: readonly SellMode[] = [
  { mode: 'pct_position', label: 'Percent of position', basis: 'the quantity currently held', kind: 'percent' },
  { mode: 'sell_all', label: 'Sell all', basis: 'the entire held position', kind: 'none' },
  { mode: 'quote_amount', label: 'Quote amount', basis: 'a fixed amount in the quote currency', kind: 'amount' },
  { mode: 'base_quantity', label: 'Base quantity', basis: 'an exact quantity of the asset', kind: 'quantity' },
];

interface Props {
  side: 'buy' | 'sell';
  orderType: 'market' | 'limit';
  sizingMode: SizingMode;
  onModeChange: (m: SizingMode) => void;
  sizingValue: string;
  onValueChange: (v: string) => void;
  percent: string;
  onPercentChange: (v: string) => void;
  limitPrice: string;
  onLimitPriceChange: (v: string) => void;
}

export function SizingFields(props: Props) {
  const modes = props.side === 'buy' ? BUY_MODES : SELL_MODES;
  const current = modes.find((m) => m.mode === props.sizingMode) ?? modes[0];
  const kind = current.kind;

  return (
    <>
      <div className="field">
        <label htmlFor="mode">Sizing</label>
        <select
          id="mode"
          value={props.sizingMode}
          onChange={(e) => props.onModeChange(e.target.value as SizingMode)}
        >
          {modes.map((m) => (
            <option key={m.mode} value={m.mode}>{m.label}</option>
          ))}
        </select>
        <div className="hint">Sized against {current.basis}.</div>
      </div>

      {kind === 'percent' && (
        <div className="field">
          <label htmlFor="percent">Percentage</label>
          <input
            id="percent"
            inputMode="decimal"
            value={props.percent}
            placeholder="e.g. 20"
            onChange={(e) => props.onPercentChange(e.target.value)}
          />
          <div className="hint">Per cent of {current.basis}. Applied to each account independently.</div>
        </div>
      )}

      {kind === 'amount' && (
        <div className="field">
          <label htmlFor="amount">Quote amount (minor units)</label>
          <input
            id="amount"
            inputMode="numeric"
            value={props.sizingValue}
            placeholder="e.g. 2000000 for ₹20,000"
            onChange={(e) => props.onValueChange(e.target.value)}
          />
          <div className="hint">The same amount is applied to every account.</div>
        </div>
      )}

      {kind === 'quantity' && (
        <div className="field">
          <label htmlFor="qty">Base quantity</label>
          <input
            id="qty"
            inputMode="decimal"
            value={props.sizingValue}
            placeholder="e.g. 0.05"
            onChange={(e) => props.onValueChange(e.target.value)}
          />
          <div className="hint">The same quantity is requested for every account, floored to each market's step.</div>
        </div>
      )}

      {props.orderType === 'limit' && (
        <div className="field">
          <label htmlFor="limit">Limit price</label>
          <input
            id="limit"
            inputMode="decimal"
            value={props.limitPrice}
            placeholder="Price in the quote currency"
            onChange={(e) => props.onLimitPriceChange(e.target.value)}
          />
          <div className="hint">
            A limit order fills only at this price or better, and is not subject to the market-order spread guard.
          </div>
        </div>
      )}
    </>
  );
}
