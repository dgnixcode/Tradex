import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchTradingState } from '../api.ts';

// A passive status chip for the panel topbar. It is read-only (pause/resume live
// on the desk-controls page) but makes a non-normal state visible from ANYWHERE,
// with the reason — so a trader is never surprised that an order was refused
// because the desk was paused or the platform is in a degraded mode.
export function DeskStatus() {
  const ts = useQuery({ queryKey: ['trading-state'], queryFn: fetchTradingState });
  const data = ts.data;

  const paused = data?.tenant.tradingPaused === true;
  const platformOff = data !== undefined && (data.platform.killSwitch || data.platform.mode !== 'normal');
  const restricted = (data?.restrictedMarkets.length ?? 0) > 0;

  if (!paused && !platformOff && !restricted) return null;

  const label = paused ? 'trading paused' : data?.platform.killSwitch ? 'platform halted' : platformOff ? `${data?.platform.mode}` : 'market restricted';

  return (
    <Link to="/app/trading" className={`status-chip${paused || data?.platform.killSwitch ? ' danger' : ''}`} title="View desk controls">
      {label}
    </Link>
  );
}
