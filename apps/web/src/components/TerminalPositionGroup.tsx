import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FuturesPositionRow } from '../api.ts';
import { calcRoePct, fmtMinor, fmtPrice, pnlText, roeText } from '../routes/Futures.tsx';
import type { PositionGroup } from '../routes/Futures.tsx';
import { PositionCurrencyBadge } from './PositionCurrencyBadge.tsx';

function PositionRow({ position: p, asset, halted, onManage, onExit }: {
  position: FuturesPositionRow; asset: string; halted: boolean;
  onManage: (position: FuturesPositionRow) => void; onExit: (position: FuturesPositionRow) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const roe = calcRoePct(p);
  const pnl = Number(p.unrealisedPnlMinor ?? 0);
  const priceCurrency = p.pair.endsWith('_INR') ? 'INR' : 'USDT';
  const nearLiquidation = p.liqBufferBp !== null && p.liqBufferBp < 1000;
  return <article className="terminal-position-row" aria-label={`${p.accountName} ${asset} ${p.marginCurrency} position`}>
    <div className="terminal-position-top">
      <div className="terminal-position-identity">
        <Link to={`/app/accounts/${p.accountId}`} title={p.accountName}>{p.accountName}</Link>
        <span>{p.side === 'long' ? 'Long' : p.side === 'short' ? 'Short' : 'Flat'}{p.leverage ? ` · ${p.leverage}×` : ''}</span>
      </div>
      <div className={`terminal-position-pnl ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : ''}`}>
        <strong>{pnlText(p.unrealisedPnlMinor, p.marginCurrency)}</strong>
        {roe !== null && <span>{roeText(roe).trim()}</span>}
      </div>
    </div>
    <div className="terminal-position-sizing">
      <span><small>Qty</small> {p.quantity} {asset}</span>
      <span><small>Margin</small> {p.lockedMarginMinor ? fmtMinor(p.lockedMarginMinor, p.marginCurrency) : '—'}</span>
    </div>
    {(!p.stopLossTrigger || nearLiquidation) && <div className="terminal-position-risk">
      {!p.stopLossTrigger && <span className="warning">No stop loss</span>}
      {nearLiquidation && <span className="danger">Liq buffer {(p.liqBufferBp! / 100).toFixed(1)}%</span>}
    </div>}
    <div className="terminal-position-actions">
      <button type="button" className="terminal-details-toggle" aria-expanded={expanded} aria-controls={detailsId}
        aria-label={`${expanded ? 'Hide' : 'Show'} details for ${p.accountName}`} onClick={() => setExpanded(!expanded)}>
        Details <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      <button type="button" className="btn secondary btn-sm" onClick={() => onManage(p)} aria-label={`Manage ${p.accountName} position`}>Manage</button>
      <button type="button" className="btn btn-sm quick-exit-btn" disabled={halted} onClick={() => onExit(p)}
        aria-label={`Review exit for ${p.accountName}`} title={halted ? 'Trading halted' : `Review market exit for ${p.accountName}`}>Review exit</button>
    </div>
    {expanded && <dl id={detailsId} className="terminal-position-detail-grid">
      <div><dt>Entry ({priceCurrency})</dt><dd>{fmtPrice(p.avgEntryPrice)}</dd></div>
      <div><dt>Mark ({priceCurrency})</dt><dd>{fmtPrice(p.markPrice)}</dd></div>
      <div><dt>Liquidation ({priceCurrency})</dt><dd className={nearLiquidation ? 'danger' : ''}>{fmtPrice(p.liquidationPrice)}</dd></div>
      <div><dt>Take profit ({priceCurrency})</dt><dd>{p.takeProfitTrigger ? fmtPrice(p.takeProfitTrigger) : '—'}</dd></div>
      <div><dt>Stop loss ({priceCurrency})</dt><dd>{p.stopLossTrigger ? fmtPrice(p.stopLossTrigger) : '—'}</dd></div>
      <div><dt>Liquidation buffer</dt><dd className={nearLiquidation ? 'danger' : ''}>{p.liqBufferBp === null ? '—' : `${(p.liqBufferBp / 100).toFixed(1)}%`}</dd></div>
    </dl>}
  </article>;
}

export function TerminalPositionGroup({ group: g, collapsed, search, halted, onToggle, onManageGroup, onExitGroup, onManagePosition, onExitPosition }: {
  group: PositionGroup; collapsed: boolean; search: string; halted: boolean; onToggle: () => void;
  onManageGroup: (group: PositionGroup) => void; onExitGroup: (group: PositionGroup) => void;
  onManagePosition: (position: FuturesPositionRow) => void; onExitPosition: (position: FuturesPositionRow) => void;
}) {
  const query = search.trim().toLowerCase();
  const groupMatches = `${g.asset} ${g.marginCurrency} ${g.groupNames.join(' ')}`.toLowerCase().includes(query);
  const positions = !query || groupMatches ? g.positions : g.positions.filter((p) => p.accountName.toLowerCase().includes(query));
  const groupId = useId();
  if (!positions.length) return null;
  const pnl = Number(g.totalPnlMinor ?? 0);
  return <section className={`terminal-position-group currency-${g.marginCurrency.toLowerCase()}`}>
    <button type="button" className="terminal-group-summary" aria-expanded={!collapsed} aria-controls={groupId}
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${g.asset} ${g.side} ${g.marginCurrency} accounts`} onClick={onToggle}>
      <span className="terminal-group-instrument"><PositionCurrencyBadge currency={g.marginCurrency} /><strong>{g.asset}</strong><span>{g.side}</span></span>
      <span className={`terminal-group-pnl ${pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : ''}`}>{pnlText(g.totalPnlMinor, g.marginCurrency)}</span>
      <span className="terminal-group-chevron" aria-hidden="true">{collapsed ? '⌄' : '⌃'}</span>
      <span className="terminal-group-name" title={g.groupNames.join(', ')}>{g.groupNames.join(', ') || 'Ungrouped'}</span>
      <span className="terminal-group-count">{positions.length !== g.positions.length ? `${positions.length} of ` : ''}{g.positions.length} account{g.positions.length === 1 ? '' : 's'} · Qty {g.totalQty.toLocaleString('en-US', { maximumFractionDigits: 12 })}</span>
    </button>
    {g.positions.length > 1 && <div className="terminal-group-actions">
      <button type="button" className="btn secondary btn-sm" onClick={() => onManageGroup(g)} title={`Manage all ${g.positions.length} accounts`}>Manage group</button>
      <button type="button" className="btn btn-sm quick-exit-btn" disabled={halted} onClick={() => onExitGroup(g)} title={`Review exit for all ${g.positions.length} accounts`}>Exit group · {g.positions.length}</button>
    </div>}
    {!collapsed && <div id={groupId} className="terminal-group-accounts">
      {positions.map((p) => <PositionRow key={p.venuePositionId} position={p} asset={g.asset} halted={halted} onManage={onManagePosition} onExit={onExitPosition} />)}
    </div>}
  </section>;
}
