import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchFuturesPositions } from '../api.ts';
import {
  alertSound,
  loadPositionAlertConfig,
  type PositionAlertConfig,
} from '../audio-alerts.ts';
import { buildGroups, calcGroupRoePct } from '../routes/Futures.tsx';

interface BreachedGroup {
  readonly groupKey: string;
  readonly asset: string;
  readonly pair: string;
  readonly side: 'long' | 'short' | 'flat';
  readonly groupNames: string[];
  readonly roePct: number;
  readonly direction: 'down' | 'up';
  readonly thresholdPct: number;
  readonly markPrice?: number | null;
  readonly triggerReason: string;
}

export function GlobalPositionAlerts() {
  const [config, setConfig] = useState<PositionAlertConfig>(() => loadPositionAlertConfig());
  const [acknowledgedKeys, setAcknowledgedKeys] = useState<Set<string>>(() => new Set());
  const [activeBreaches, setActiveBreaches] = useState<readonly BreachedGroup[]>([]);
  const [isAlarmPlaying, setIsAlarmPlaying] = useState(false);
  const [dismissedVisually, setDismissedVisually] = useState(false);

  // Listen for config changes from Settings page
  useEffect(() => {
    const handleConfigChange = (e: Event) => {
      const customEvent = e as CustomEvent<PositionAlertConfig>;
      if (customEvent.detail) {
        setConfig(customEvent.detail);
      } else {
        setConfig(loadPositionAlertConfig());
      }
    };
    window.addEventListener('tradex-alert-config-changed', handleConfigChange);
    return () => {
      window.removeEventListener('tradex-alert-config-changed', handleConfigChange);
    };
  }, []);

  // Poll futures positions across any screen
  const positionsQuery = useQuery({
    queryKey: ['futures-positions'],
    queryFn: fetchFuturesPositions,
    refetchInterval: 3000,
    refetchIntervalInBackground: true,
  });

  // Evaluate position groups against threshold config
  useEffect(() => {
    if (!config.enabled || !positionsQuery.data?.views || positionsQuery.data.views.length === 0) {
      if (alertSound.isPlaying()) {
        alertSound.stopAlertLoop();
      }
      setIsAlarmPlaying(false);
      setActiveBreaches([]);
      return;
    }

    const groups = buildGroups(positionsQuery.data.views);
    const newBreaches: BreachedGroup[] = [];
    const currentActiveKeys = new Set<string>();

    for (const g of groups) {
      const assetUpper = g.asset.toUpperCase();

      // Check coin scope filter:
      if (config.coinScope === 'specific') {
        const isSelected = config.specificCoins.some((c) => c.toUpperCase() === assetUpper);
        if (!isSelected) {
          // Ignore coins not in the designated specific coins list
          continue;
        }
      }

      const roe = calcGroupRoePct(g);
      const coinRule = config.coinRules?.[assetUpper];

      // Effective thresholds (custom override or master)
      const effectiveDownPct = typeof coinRule?.downThresholdPct === 'number' && coinRule.downThresholdPct > 0
        ? coinRule.downThresholdPct
        : config.downThresholdPct;
      const effectiveUpPct = typeof coinRule?.upThresholdPct === 'number' && coinRule.upThresholdPct > 0
        ? coinRule.upThresholdPct
        : config.upThresholdPct;

      const markPrices = g.positions.map((p) => Number(p.markPrice)).filter((v) => Number.isFinite(v) && v > 0);
      const currentMarkPrice = markPrices.length > 0 ? markPrices[0]! : null;

      // 1. Downward ROE drop breach
      if (config.downAlertEnabled && roe !== null && roe <= -Math.abs(effectiveDownPct)) {
        const breachKey = `${g.key}:down`;
        currentActiveKeys.add(breachKey);
        newBreaches.push({
          groupKey: g.key,
          asset: g.asset,
          pair: g.pair,
          side: g.side,
          groupNames: g.groupNames,
          roePct: roe,
          direction: 'down',
          thresholdPct: effectiveDownPct,
          markPrice: currentMarkPrice,
          triggerReason: `Return dropped to ${roe.toFixed(2)}% (Threshold: -${effectiveDownPct}%)`,
        });
      }
      // 2. Upward ROE rise breach
      else if (config.upAlertEnabled && roe !== null && roe >= Math.abs(effectiveUpPct)) {
        const breachKey = `${g.key}:up`;
        currentActiveKeys.add(breachKey);
        newBreaches.push({
          groupKey: g.key,
          asset: g.asset,
          pair: g.pair,
          side: g.side,
          groupNames: g.groupNames,
          roePct: roe,
          direction: 'up',
          thresholdPct: effectiveUpPct,
          markPrice: currentMarkPrice,
          triggerReason: `Return rose to +${roe.toFixed(2)}% (Threshold: +${effectiveUpPct}%)`,
        });
      }
      // 3. Target price floor breach (if configured for this coin)
      else if (currentMarkPrice !== null && coinRule?.targetPriceBelow && currentMarkPrice <= coinRule.targetPriceBelow) {
        const breachKey = `${g.key}:price-below`;
        currentActiveKeys.add(breachKey);
        newBreaches.push({
          groupKey: g.key,
          asset: g.asset,
          pair: g.pair,
          side: g.side,
          groupNames: g.groupNames,
          roePct: roe ?? 0,
          direction: 'down',
          thresholdPct: effectiveDownPct,
          markPrice: currentMarkPrice,
          triggerReason: `Mark price (${currentMarkPrice}) dropped below target price (${coinRule.targetPriceBelow})`,
        });
      }
      // 4. Target price ceiling breach (if configured for this coin)
      else if (currentMarkPrice !== null && coinRule?.targetPriceAbove && currentMarkPrice >= coinRule.targetPriceAbove) {
        const breachKey = `${g.key}:price-above`;
        currentActiveKeys.add(breachKey);
        newBreaches.push({
          groupKey: g.key,
          asset: g.asset,
          pair: g.pair,
          side: g.side,
          groupNames: g.groupNames,
          roePct: roe ?? 0,
          direction: 'up',
          thresholdPct: effectiveUpPct,
          markPrice: currentMarkPrice,
          triggerReason: `Mark price (${currentMarkPrice}) rose above target price (${coinRule.targetPriceAbove})`,
        });
      }
    }

    // Recovered groups: remove from acknowledged set so they can trigger again if re-breached
    setAcknowledgedKeys((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const k of prev) {
        if (!currentActiveKeys.has(k)) {
          next.delete(k);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    // Check if any breach is unacknowledged
    const unacknowledged = newBreaches.filter(
      (b) => !acknowledgedKeys.has(`${b.groupKey}:${b.direction}`)
    );

    setActiveBreaches(newBreaches);

    if (unacknowledged.length > 0) {
      setDismissedVisually(false);
      alertSound.startAlertLoop(
        config.soundType,
        config.volume,
        config.repeatIntervalSeconds * 1000
      );
      setIsAlarmPlaying(true);
    } else {
      if (alertSound.isPlaying()) {
        alertSound.stopAlertLoop();
      }
      setIsAlarmPlaying(false);
    }
  }, [
    config,
    positionsQuery.data?.views,
    acknowledgedKeys,
  ]);

  // Clean up sound on unmount
  useEffect(() => {
    return () => {
      alertSound.stopAlertLoop();
    };
  }, []);

  const handleStopAlert = () => {
    alertSound.stopAlertLoop();
    setIsAlarmPlaying(false);
    setAcknowledgedKeys((prev) => {
      const next = new Set(prev);
      for (const b of activeBreaches) {
        next.add(`${b.groupKey}:${b.direction}`);
      }
      return next;
    });
  };

  if (!config.enabled || activeBreaches.length === 0 || (dismissedVisually && !isAlarmPlaying)) {
    return null;
  }

  const hasDownBreach = activeBreaches.some((b) => b.direction === 'down');

  return (
    <div
      className={`global-position-alert-top-banner ${hasDownBreach ? 'alert-danger' : 'alert-success'}`}
      role="alert"
      aria-live="assertive"
      onClick={() => {
        if (isAlarmPlaying && !alertSound.isActivelySounding()) {
          alertSound.startAlertLoop(
            config.soundType,
            config.volume,
            config.repeatIntervalSeconds * 1000
          );
        }
      }}
    >
      <div className="alert-top-banner-inner">
        {/* Left Section: Icon, Title & Sound Indicator */}
        <div className="alert-banner-left">
          <div className="alert-banner-icon-wrap">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" />
              <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
          </div>
          <div className="alert-banner-title-area">
            <span className="alert-banner-badge">
              {hasDownBreach ? 'POSITION DROP ALERT' : 'POSITION PROFIT TARGET'}
            </span>
            {isAlarmPlaying && (
              <span className="alert-banner-sound-pill" title="Alarm actively sounding">
                <span className="audio-test-indicator">
                  <span className="audio-test-bar" style={{ background: hasDownBreach ? '#ef4444' : '#10b981' }} />
                  <span className="audio-test-bar" style={{ background: hasDownBreach ? '#ef4444' : '#10b981' }} />
                  <span className="audio-test-bar" style={{ background: hasDownBreach ? '#ef4444' : '#10b981' }} />
                </span>
                <span className="alert-banner-sound-text">SOUNDING</span>
              </span>
            )}
          </div>
        </div>

        {/* Center Section: Breached Position Chips */}
        <div className="alert-banner-chips">
          {activeBreaches.map((b) => {
            const isDown = b.direction === 'down';
            return (
              <div
                key={`${b.groupKey}:${b.direction}`}
                className={`alert-coin-chip ${isDown ? 'chip-down' : 'chip-up'}`}
                title={b.triggerReason}
              >
                <span className="alert-chip-asset">{b.asset}</span>
                <span className={`alert-chip-side ${b.side === 'long' ? 'side-long' : 'side-short'}`}>
                  {b.side.toUpperCase()}
                </span>
                {b.groupNames.length > 0 && (
                  <span className="alert-chip-group">({b.groupNames.join(', ')})</span>
                )}
                <span className="alert-chip-roe">
                  {isDown ? '↓ ' : '↑ '}
                  {b.roePct >= 0 ? `+${b.roePct.toFixed(2)}%` : `${b.roePct.toFixed(2)}%`}
                </span>
              </div>
            );
          })}
        </div>

        {/* Right Section: Action Controls */}
        <div className="alert-banner-actions">
          {isAlarmPlaying && (
            <button
              type="button"
              className="alert-stop-sound-btn"
              onClick={handleStopAlert}
              title="Stop sounding siren alert immediately"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
              <span>Stop Alert</span>
            </button>
          )}

          <Link
            to="/app/positions"
            className="alert-view-positions-btn"
            onClick={() => {
              if (isAlarmPlaying) {
                handleStopAlert();
              }
            }}
          >
            <span>View Positions →</span>
          </Link>

          {!isAlarmPlaying && (
            <button
              type="button"
              className="alert-dismiss-btn"
              onClick={() => setDismissedVisually(true)}
              title="Dismiss notification"
              aria-label="Dismiss notification"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
