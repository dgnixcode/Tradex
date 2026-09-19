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
      const roe = calcGroupRoePct(g);
      if (roe === null) continue;

      // Downward drop breach
      if (config.downAlertEnabled && roe <= -Math.abs(config.downThresholdPct)) {
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
          thresholdPct: config.downThresholdPct,
        });
      }
      // Upward rise breach
      else if (config.upAlertEnabled && roe >= Math.abs(config.upThresholdPct)) {
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
          thresholdPct: config.upThresholdPct,
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
      if (!alertSound.isPlaying()) {
        alertSound.startAlertLoop(
          config.soundType,
          config.volume,
          config.repeatIntervalSeconds * 1000
        );
      }
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
    <div className="global-position-alert-overlay" role="alert" aria-live="assertive">
      <div
        className="global-position-alert-card"
        style={{
          borderColor: hasDownBreach ? 'rgba(239, 68, 68, 0.7)' : 'rgba(16, 185, 129, 0.7)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                background: hasDownBreach ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)',
                color: hasDownBreach ? '#ef4444' : '#10b981',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14.5, color: '#f8fafc', display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>Position Movement Alert</span>
                {isAlarmPlaying && (
                  <span className="audio-test-indicator" title="Alert sound playing continuously">
                    <span className="audio-test-bar" style={{ background: '#ef4444' }} />
                    <span className="audio-test-bar" style={{ background: '#ef4444' }} />
                    <span className="audio-test-bar" style={{ background: '#ef4444' }} />
                  </span>
                )}
              </div>
              <div className="muted" style={{ fontSize: 12 }}>
                {isAlarmPlaying ? 'Alarm is sounding until stopped.' : 'Alarm silenced (active breach)'}
              </div>
            </div>
          </div>

          {!isAlarmPlaying && (
            <button
              type="button"
              onClick={() => setDismissedVisually(true)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--muted)',
                cursor: 'pointer',
                padding: '4px',
              }}
              title="Dismiss notification"
              aria-label="Dismiss notification"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Breached Groups List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {activeBreaches.map((b) => {
            const isDown = b.direction === 'down';
            return (
              <div
                key={`${b.groupKey}:${b.direction}`}
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  padding: '8px 12px',
                  borderRadius: 6,
                  border: `1px solid ${isDown ? 'rgba(239, 68, 68, 0.3)' : 'rgba(16, 185, 129, 0.3)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 700, fontSize: 13.5, color: '#f1f5f9' }}>{b.asset}</span>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: 3,
                        textTransform: 'uppercase',
                        background: b.side === 'long' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                        color: b.side === 'long' ? '#34d399' : '#f87171',
                      }}
                    >
                      {b.side}
                    </span>
                    {b.groupNames.length > 0 && (
                      <span className="muted" style={{ fontSize: 11.5 }}>
                        ({b.groupNames.join(', ')})
                      </span>
                    )}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>
                    Threshold: {isDown ? `-${b.thresholdPct}%` : `+${b.thresholdPct}%`}
                  </div>
                </div>

                <div style={{ textAlign: 'right' }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 800,
                      color: isDown ? '#ef4444' : '#10b981',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {b.roePct >= 0 ? `+${b.roePct.toFixed(2)}%` : `${b.roePct.toFixed(2)}%`}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: isDown ? '#fca5a5' : '#6ee7b7',
                    }}
                  >
                    {isDown ? 'Down Move' : 'Up Move'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {isAlarmPlaying && (
            <button
              type="button"
              className="btn"
              onClick={handleStopAlert}
              style={{
                flex: 1,
                background: '#ef4444',
                borderColor: '#dc2626',
                color: '#ffffff',
                fontWeight: 700,
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                padding: '8px 14px',
              }}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                <line x1="23" y1="9" x2="17" y2="15" />
                <line x1="17" y1="9" x2="23" y2="15" />
              </svg>
              <span>Stop Alert</span>
            </button>
          )}

          <Link
            to="/app/positions"
            className="btn secondary"
            onClick={() => {
              if (isAlarmPlaying) {
                handleStopAlert();
              }
            }}
            style={{
              flex: isAlarmPlaying ? 'initial' : 1,
              textAlign: 'center',
              fontSize: 13,
              fontWeight: 600,
              padding: '8px 14px',
            }}
          >
            <span>View Positions →</span>
          </Link>
        </div>
      </div>
    </div>
  );
}
