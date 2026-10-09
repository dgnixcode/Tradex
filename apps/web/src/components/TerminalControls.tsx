type Panel = 'trade' | 'watchlist' | 'position';

export function TerminalControls({ active, onSelect, asset, positionCount }: {
  active: string | null;
  onSelect: (panel: Panel | null) => void;
  asset: string;
  positionCount: number;
}) {
  const controls = [
    { panel: 'trade' as const, label: 'Order', name: 'Order Ticket', icon: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 11h6M9 16h6M12 13v6" /></> },
    { panel: 'watchlist' as const, label: 'Watch', name: 'Watchlist', icon: <><path d="m8 3 1.5 3 3.5.5-2.5 2.4.6 3.4L8 10.7l-3.1 1.6.6-3.4L3 6.5 6.5 6 8 3Z" /><path d="M16 6h5M16 10h5M4 16h17M4 20h17" /></> },
    { panel: 'position' as const, label: 'Positions', name: 'Positions', icon: <><path d="M5 3v3m0 9v6M12 3v9m0 6v3M19 3v2m0 9v7" /><rect x="3" y="6" width="4" height="9" rx="1" /><rect x="10" y="12" width="4" height="6" rx="1" /><rect x="17" y="5" width="4" height="9" rx="1" /></> },
  ];
  return <aside className="trading-vertical-rail" aria-label="Terminal side controls">
    {controls.map(({ panel, label, name, icon }) => <button key={panel} type="button"
      className={`rail-tab-btn ${active === panel ? 'active' : ''}`}
      onClick={() => onSelect(active === panel ? null : panel)}
      aria-label={name} aria-pressed={active === panel}
      title={`${active === panel ? 'Close' : 'Open'} ${panel === 'position' ? `${asset} positions (${positionCount} open)` : name}`}>
      <span className="rail-tab-icon"><svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{icon}</svg></span>
      <span className="rail-tab-label">{label}</span>
      {panel === 'position' && positionCount > 0 && <span className="rail-position-count" aria-label={`${positionCount} open positions`}>{positionCount > 99 ? '99+' : positionCount}</span>}
    </button>)}
    {controls.some(({ panel }) => panel === active) && <button type="button" className="rail-collapse-btn"
      onClick={() => onSelect(null)} aria-label="Collapse panel" title="Collapse side panel">
      <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
    </button>}
  </aside>;
}
