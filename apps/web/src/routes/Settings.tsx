import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchFuturesPositions,
  fetchKillSwitchStatus,
  fetchTradingState,
  fetchWorkspace,
  pauseTrading,
  renameWorkspace,
  resumeTrading,
  stepUp,
  toggleKillSwitch,
  updateServerBranding,
} from '../api.ts';
import type { ApiError } from '../api.ts';
import {
  alertSound,
  loadPositionAlertConfig,
  savePositionAlertConfig,
  type AlertSoundType,
  type CoinAlertRule,
  type PositionAlertConfig,
} from '../audio-alerts.ts';
import { useAuth } from '../auth.tsx';
import {
  useBranding,
  DEFAULT_BRAND_NAME,
  DEFAULT_EMAIL,
  DEFAULT_PHONE,
  DEFAULT_WHATSAPP,
  DEFAULT_ADDRESS,
  DEFAULT_HOURS,
} from '../branding.tsx';
import { Brand } from '../components/Brand.tsx';
import { KillSwitchModal } from '../components/KillSwitchModal.tsx';
import { buildGroups, calcGroupRoePct } from './Futures.tsx';

// Category tabs for organized settings management
type SettingsCategory = 'controls' | 'alerts' | 'branding' | 'contact' | 'security';

const minorLabel = (minor: string, currency: 'INR' | 'USDT'): string => {
  const scale = currency === 'INR' ? 2 : 8;
  const digits = minor.padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  const num = `${whole}${frac === '' ? '' : `.${frac}`}`;
  return currency === 'INR' ? `₹${num}` : `${num} ${currency}`;
};

const PRESET_ICONS = ['◆', '◈', '▲', '✦', '◉', '■', '❖', '✚', 'Ω', '§'];
const DOWN_PRESETS = [3, 5, 10, 15, 20];
const UP_PRESETS = [5, 10, 15, 20, 30];
const POPULAR_COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'AVAX', 'ADA', 'NEAR', 'PEPE'] as const;

export function Settings() {
  const qc = useQueryClient();
  const workspace = useQuery({ queryKey: ['workspace'], queryFn: fetchWorkspace });
  const { state } = useAuth();
  const role = state.status === 'authenticated' ? state.session.role : '';
  const totpEnabled = state.status === 'authenticated' ? state.session.totpEnabled : false;
  const isOwner = role === 'owner';

  const { branding, updateBranding, resetBranding } = useBranding();

  // Active Category Tab with URL query param sync (?tab=controls)
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const validTabs: SettingsCategory[] = ['controls', 'alerts', 'branding', 'contact', 'security'];
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>(() => {
    if (tabParam && (validTabs as string[]).includes(tabParam)) {
      return tabParam as SettingsCategory;
    }
    return 'controls';
  });

  useEffect(() => {
    if (tabParam && (validTabs as string[]).includes(tabParam) && tabParam !== activeCategory) {
      setActiveCategory(tabParam as SettingsCategory);
    }
  }, [tabParam, activeCategory]);

  // =========================================================================
  // CATEGORY 0: DESK CONTROLS & EMERGENCY KILL SWITCH STATE
  // =========================================================================
  const [showKillSwitchModal, setShowKillSwitchModal] = useState(false);
  const [controlsMsg, setControlsMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [deskPausing, setDeskPausing] = useState(false);
  const [deskPauseReason, setDeskPauseReason] = useState('');

  const killSwitchQuery = useQuery({
    queryKey: ['kill-switch'],
    queryFn: fetchKillSwitchStatus,
    refetchInterval: 3000,
  });
  const isHalted = Boolean(killSwitchQuery.data?.active);

  const toggleKillSwitchMut = useMutation({
    mutationFn: ({ active, reason }: { active: boolean; reason?: string | undefined }) => toggleKillSwitch(active, reason),
    onSuccess: (res) => {
      setControlsMsg({
        kind: 'ok',
        text: res.active
          ? 'Emergency Kill Switch ENGAGED. Platform is in read-only mode.'
          : 'Emergency Kill Switch DISENGAGED. Live trading resumed.',
      });
      setShowKillSwitchModal(false);
      void qc.invalidateQueries({ queryKey: ['kill-switch'] });
    },
    onError: (e) => setControlsMsg({ kind: 'err', text: (e as Error).message }),
  });

  const ts = useQuery({ queryKey: ['trading-state'], queryFn: fetchTradingState, refetchInterval: 5000 });
  const tradingData = ts.data;
  const deskPaused = tradingData?.tenant.tradingPaused === true;
  const canPause = role === 'owner' || role === 'trader';

  const pauseDeskMut = useMutation({
    mutationFn: () => pauseTrading(deskPauseReason),
    onSuccess: () => {
      setDeskPausing(false);
      setDeskPauseReason('');
      setControlsMsg({ kind: 'ok', text: 'Desk trading has been paused.' });
      void qc.invalidateQueries({ queryKey: ['trading-state'] });
    },
    onError: (e) => setControlsMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Could not pause desk' }),
  });

  const resumeDeskMut = useMutation({
    mutationFn: () => resumeTrading(),
    onSuccess: () => {
      setControlsMsg({ kind: 'ok', text: 'Desk trading has been resumed.' });
      void qc.invalidateQueries({ queryKey: ['trading-state'] });
    },
    onError: (e) => setControlsMsg({ kind: 'err', text: e instanceof Error ? e.message : 'Could not resume desk' }),
  });

  // =========================================================================
  // CATEGORY 1: POSITION & RISK ALERTS STATE
  // =========================================================================
  const [alertConfig, setAlertConfig] = useState<PositionAlertConfig>(() => loadPositionAlertConfig());
  const [isTestingSound, setIsTestingSound] = useState(false);
  const [alertsSavedStatus, setAlertsSavedStatus] = useState<string | null>(null);

  // Live positions query for monitoring preview
  const livePositions = useQuery({
    queryKey: ['futures-positions'],
    queryFn: fetchFuturesPositions,
    refetchInterval: 5000,
  });

  const positionGroups = buildGroups(livePositions.data?.views ?? []);

  // Specific coins alert state & helpers
  const [newCoinInput, setNewCoinInput] = useState('');
  const [coinInputError, setCoinInputError] = useState<string | null>(null);

  const activePositionCoins = useMemo(
    () => Array.from(new Set(positionGroups.map((g) => g.asset.toUpperCase()))),
    [positionGroups]
  );

  const handleAddSpecificCoin = (coinRaw: string) => {
    const symbol = coinRaw.trim().toUpperCase();
    if (!symbol) return;
    if (alertConfig.specificCoins.includes(symbol)) {
      setCoinInputError(`${symbol} is already in your specific coins watchlist.`);
      return;
    }
    setCoinInputError(null);
    setAlertConfig((prev) => ({
      ...prev,
      specificCoins: [...prev.specificCoins, symbol],
    }));
    setNewCoinInput('');
  };

  const handleRemoveSpecificCoin = (symbol: string) => {
    setAlertConfig((prev) => {
      const nextSpecific = prev.specificCoins.filter((c) => c !== symbol);
      const nextRules = { ...(prev.coinRules || {}) };
      delete nextRules[symbol];
      return {
        ...prev,
        specificCoins: nextSpecific,
        coinRules: nextRules,
      };
    });
  };

  const handleUpdateCoinRule = (symbol: string, ruleUpdate: Partial<CoinAlertRule>) => {
    setAlertConfig((prev) => {
      const existing = prev.coinRules?.[symbol] || { coin: symbol };
      return {
        ...prev,
        coinRules: {
          ...(prev.coinRules || {}),
          [symbol]: {
            ...existing,
            ...ruleUpdate,
          },
        },
      };
    });
  };

  // Stop any testing loop when unmounting or switching tabs
  useEffect(() => {
    return () => {
      alertSound.stopAlertLoop();
    };
  }, []);

  const handleTestSoundToggle = () => {
    if (isTestingSound) {
      alertSound.stopAlertLoop();
      setIsTestingSound(false);
    } else {
      setIsTestingSound(true);
      alertSound.startAlertLoop(
        alertConfig.soundType,
        alertConfig.volume,
        alertConfig.repeatIntervalSeconds * 1000
      );
    }
  };

  const handlePlaySample = (type: AlertSoundType) => {
    if (isTestingSound) {
      alertSound.stopAlertLoop();
      setIsTestingSound(false);
    }
    alertSound.playChime(type, alertConfig.volume);
  };

  const handleSaveAlertConfig = () => {
    savePositionAlertConfig(alertConfig);
    setAlertsSavedStatus('Alert settings saved successfully and live across all screens.');
    setTimeout(() => {
      setAlertsSavedStatus(null);
    }, 4000);
  };

  // =========================================================================
  // CATEGORY 2 & 3: BRANDING & CONTACT CHANNELS STATE
  // =========================================================================
  const [name, setName] = useState(() => branding.name || DEFAULT_BRAND_NAME);
  const [logo, setLogo] = useState<string | null>(null);
  const [logoTab, setLogoTab] = useState<'upload' | 'url' | 'icon'>('upload');
  const [urlInput, setUrlInput] = useState('');
  const [iconInput, setIconInput] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);

  const [email, setEmail] = useState(() => branding.email || DEFAULT_EMAIL);
  const [phone, setPhone] = useState(() => branding.phone || DEFAULT_PHONE);
  const [whatsapp, setWhatsapp] = useState(() => branding.whatsapp || DEFAULT_WHATSAPP);
  const [address, setAddress] = useState(() => branding.address || DEFAULT_ADDRESS);
  const [hours, setHours] = useState(() => branding.hours || DEFAULT_HOURS);

  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameInitializedRef = useRef(false);

  useEffect(() => {
    if (!nameInitializedRef.current && workspace.data?.name) {
      if (!branding.name || branding.name === DEFAULT_BRAND_NAME) {
        setName(workspace.data.name);
      }
      nameInitializedRef.current = true;
    }
  }, [workspace.data?.name, branding.name]);

  useEffect(() => {
    setLogo(branding.logo);
    if (branding.logo) {
      if (branding.logoType === 'icon') {
        setIconInput(branding.logo);
      } else if (branding.logoType === 'image' && !branding.logo.startsWith('data:')) {
        setUrlInput(branding.logo);
      }
    }
    setEmail(branding.email || DEFAULT_EMAIL);
    setPhone(branding.phone || DEFAULT_PHONE);
    setWhatsapp(branding.whatsapp || DEFAULT_WHATSAPP);
    setAddress(branding.address || DEFAULT_ADDRESS);
    setHours(branding.hours || DEFAULT_HOURS);
  }, [branding]);

  const [saving, setSaving] = useState(false);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      setStatus({ kind: 'err', message: 'Please select a valid image file (PNG, JPG, SVG, WebP).' });
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setStatus({ kind: 'err', message: 'Image file size should be less than 2 MB.' });
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setLogo(reader.result);
        setStatus({ kind: 'ok', message: 'Logo image loaded. Click "Save Platform Settings" to apply.' });
      }
    };
    reader.onerror = () => {
      setStatus({ kind: 'err', message: 'Failed to read image file.' });
    };
    reader.readAsDataURL(file);
  };

  const handleApplyUrl = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanUrl = urlInput.trim();
    if (!cleanUrl) {
      setStatus({ kind: 'err', message: 'Please enter a valid image URL.' });
      return;
    }
    setLogo(cleanUrl);
    setStatus({ kind: 'ok', message: 'Image URL applied. Click "Save Platform Settings" to apply.' });
  };

  const handleSelectIcon = (icon: string) => {
    setIconInput(icon);
    setLogo(icon);
    setStatus({ kind: 'ok', message: `Selected icon ${icon}. Click "Save Platform Settings" to apply.` });
  };

  const handleRemoveLogo = () => {
    setLogo(null);
    setUrlInput('');
    setIconInput('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setStatus({ kind: 'ok', message: 'Logo reset to default gradient mark. Click "Save Platform Settings" to apply.' });
  };

  const handleResetDefaults = async () => {
    if (isOwner) {
      setSaving(true);
      try {
        await updateServerBranding({
          name: DEFAULT_BRAND_NAME,
          logo: null,
          email: DEFAULT_EMAIL,
          phone: DEFAULT_PHONE,
          whatsapp: DEFAULT_WHATSAPP,
          address: DEFAULT_ADDRESS,
          hours: DEFAULT_HOURS,
        });
      } catch (err) {
        const ae = err as ApiError;
        setStatus({ kind: 'err', message: ae.message ?? 'Failed to reset settings on server.' });
        setSaving(false);
        return;
      } finally {
        setSaving(false);
      }
    }
    resetBranding();
    setName(DEFAULT_BRAND_NAME);
    setLogo(null);
    setUrlInput('');
    setIconInput('');
    setEmail(DEFAULT_EMAIL);
    setPhone(DEFAULT_PHONE);
    setWhatsapp(DEFAULT_WHATSAPP);
    setAddress(DEFAULT_ADDRESS);
    setHours(DEFAULT_HOURS);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setStatus({ kind: 'ok', message: 'All branding and contact settings restored to default values.' });
  };

  const submitBranding = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setStatus(null);
    const cleanName = name.trim();
    if (cleanName === '') {
      setStatus({ kind: 'err', message: 'Platform name is required.' });
      return;
    }

    setSaving(true);
    try {
      const serverNameChanged = workspace.data !== undefined && cleanName !== workspace.data.name;

      if (isOwner && serverNameChanged) {
        if (needsCode) {
          try {
            await stepUp(code.trim());
          } catch (err) {
            const ae = err as ApiError;
            setStatus({ kind: 'err', message: ae.message ?? 'That code was not accepted.' });
            setSaving(false);
            return;
          }
        }
        try {
          await renameWorkspace(cleanName);
          setCode('');
          setNeedsCode(false);
          void qc.invalidateQueries({ queryKey: ['workspace'] });
        } catch (err) {
          const ae = err as ApiError;
          if (ae.status === 403 && /reauth|second factor|two-factor/i.test(ae.message)) {
            setNeedsCode(true);
            setStatus({ kind: 'err', message: 'Enter a code from your authenticator, then save again.' });
            setSaving(false);
            return;
          }
          throw err;
        }
      }

      if (isOwner) {
        await updateServerBranding({
          name: cleanName,
          logo,
          email: email.trim(),
          phone: phone.trim(),
          whatsapp: whatsapp.trim(),
          address: address.trim(),
          hours: hours.trim(),
        });
      }

      updateBranding({
        name: cleanName,
        logo,
        email: email.trim(),
        phone: phone.trim(),
        whatsapp: whatsapp.trim(),
        address: address.trim(),
        hours: hours.trim(),
      });

      setStatus({
        kind: 'ok',
        message: isOwner
          ? 'Settings saved to database and live across the platform.'
          : 'Settings saved locally.',
      });
    } catch (err) {
      const ae = err as ApiError;
      setStatus({ kind: 'err', message: ae.message ?? 'Could not save settings.' });
    } finally {
      setSaving(false);
    }
  };

  const hasBrandingChanges =
    name.trim() !== branding.name ||
    logo !== branding.logo ||
    (isOwner && workspace.data !== undefined && name.trim() !== workspace.data.name);

  const hasContactChanges =
    email.trim() !== branding.email ||
    phone.trim() !== branding.phone ||
    whatsapp.trim() !== branding.whatsapp ||
    address.trim() !== branding.address ||
    hours.trim() !== branding.hours;

  const cleanWhatsapp = (whatsapp || '').replace(/[^0-9]/g, '') || '919876543210';
  const whatsappTestUrl = `https://wa.me/${cleanWhatsapp}?text=${encodeURIComponent(`Hello ${name || DEFAULT_BRAND_NAME}, I would like to inquire about your trading and wealth management desk.`)}`;

  return (
    <div className="panel full-width-page">
      <h2 style={{ margin: 0 }}>Desk Settings &amp; Configuration</h2>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        Manage real-time position movement audio alerts, institutional branding, client contact channels, and security.
      </p>

      {/* Category Navigation Bar */}
      <nav className="settings-categories-nav" aria-label="Settings Categories">
        <button
          type="button"
          className={`settings-category-btn ${activeCategory === 'controls' ? 'active' : ''}`}
          onClick={() => {
            if (isTestingSound) alertSound.stopAlertLoop();
            setIsTestingSound(false);
            setActiveCategory('controls');
            setSearchParams({ tab: 'controls' }, { replace: true });
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>Desk Controls</span>
          {isHalted && (
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: 'var(--danger, #ef4444)',
                boxShadow: '0 0 6px var(--danger, #ef4444)',
                display: 'inline-block',
                marginLeft: 4,
              }}
              title="Emergency Kill Switch Active"
            />
          )}
        </button>

        <button
          type="button"
          className={`settings-category-btn ${activeCategory === 'alerts' ? 'active' : ''}`}
          onClick={() => {
            if (isTestingSound) alertSound.stopAlertLoop();
            setIsTestingSound(false);
            setActiveCategory('alerts');
            setSearchParams({ tab: 'alerts' }, { replace: true });
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          <span>Position &amp; Risk Alerts</span>
        </button>

        <button
          type="button"
          className={`settings-category-btn ${activeCategory === 'branding' ? 'active' : ''}`}
          onClick={() => {
            if (isTestingSound) alertSound.stopAlertLoop();
            setIsTestingSound(false);
            setActiveCategory('branding');
            setSearchParams({ tab: 'branding' }, { replace: true });
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 2 7 22 7 12 2" />
            <line x1="4" y1="22" x2="20" y2="22" />
            <line x1="6" y1="18" x2="18" y2="18" />
            <line x1="10" y1="7" x2="10" y2="18" />
            <line x1="14" y1="7" x2="14" y2="18" />
            <line x1="18" y1="7" x2="18" y2="18" />
            <line x1="6" y1="7" x2="6" y2="18" />
          </svg>
          <span>Platform Branding</span>
        </button>

        <button
          type="button"
          className={`settings-category-btn ${activeCategory === 'contact' ? 'active' : ''}`}
          onClick={() => {
            if (isTestingSound) alertSound.stopAlertLoop();
            setIsTestingSound(false);
            setActiveCategory('contact');
            setSearchParams({ tab: 'contact' }, { replace: true });
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
          </svg>
          <span>Company &amp; Contact</span>
        </button>

        <button
          type="button"
          className={`settings-category-btn ${activeCategory === 'security' ? 'active' : ''}`}
          onClick={() => {
            if (isTestingSound) alertSound.stopAlertLoop();
            setIsTestingSound(false);
            setActiveCategory('security');
            setSearchParams({ tab: 'security' }, { replace: true });
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <span>Security &amp; 2FA</span>
        </button>
      </nav>

      {/* =========================================================================
          TAB 0: DESK CONTROLS & EMERGENCY KILL SWITCH
         ========================================================================= */}
      {activeCategory === 'controls' && (
        <div>
          {controlsMsg !== null && (
            <div
              className={controlsMsg.kind === 'ok' ? 'desk-ok-banner' : 'error'}
              style={{
                marginBottom: 16,
                padding: '10px 14px',
                borderRadius: 6,
                background: controlsMsg.kind === 'ok' ? 'rgba(52, 211, 153, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                border: `1px solid ${controlsMsg.kind === 'ok' ? 'var(--ok, #34d399)' : 'var(--danger, #ef4444)'}`,
                color: controlsMsg.kind === 'ok' ? 'var(--ok, #34d399)' : 'var(--danger, #ef4444)',
                fontSize: 13,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>{controlsMsg.text}</span>
              <button
                type="button"
                onClick={() => setControlsMsg(null)}
                style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 14 }}
              >
                ✕
              </button>
            </div>
          )}

          {/* CARD 1: Emergency Kill Switch (Read-Only Safety Deadbolt) */}
          <div
            className="settings-section-card"
            style={{
              borderColor: isHalted ? 'var(--danger, #ef4444)' : undefined,
              boxShadow: isHalted ? '0 0 25px rgba(239, 68, 68, 0.2)' : undefined,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 8,
                    background: isHalted ? 'rgba(239, 68, 68, 0.15)' : 'rgba(16, 185, 129, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: isHalted ? 'var(--danger, #ef4444)' : 'var(--ok, #10b981)',
                    flexShrink: 0,
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                  </svg>
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16 }}>Platform Emergency Kill Switch</h3>
                  <p className="muted" style={{ margin: '3px 0 0', fontSize: 13 }}>
                    Cryptographic deadbolt that freezes all order placement, exits, adjustments, and SL/TP modifications across the entire platform.
                  </p>
                </div>
              </div>

              <div>
                <span
                  className="badge"
                  style={{
                    background: isHalted ? 'rgba(239, 68, 68, 0.18)' : 'rgba(52, 211, 153, 0.12)',
                    color: isHalted ? 'var(--danger, #ef4444)' : 'var(--ok, #34d399)',
                    border: `1px solid ${isHalted ? 'var(--danger, #ef4444)' : 'var(--ok, #34d399)'}`,
                    padding: '5px 12px',
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: '0.04em',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: isHalted ? 'var(--danger, #ef4444)' : 'var(--ok, #34d399)',
                      boxShadow: isHalted ? '0 0 8px var(--danger, #ef4444)' : 'none',
                    }}
                  />
                  {isHalted ? 'KILL SWITCH ENGAGED (READ-ONLY)' : 'NORMAL (LIVE TRADING)'}
                </span>
              </div>
            </div>

            {isHalted ? (
              <div
                style={{
                  background: 'rgba(239, 68, 68, 0.08)',
                  border: '1px solid rgba(239, 68, 68, 0.3)',
                  borderRadius: 8,
                  padding: '16px 18px',
                  marginBottom: 16,
                }}
              >
                <div style={{ fontWeight: 700, color: 'var(--danger, #ef4444)', fontSize: 14, marginBottom: 6 }}>
                  Platform is in Read-Only Mode
                </div>
                <div style={{ color: 'var(--text-dim, #94a3b8)', fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>
                  All order execution, position exits, bracket adjustments, and automated triggers are rejected.
                  Live balances, active positions, mark prices, and order books remain 100% visible and update in real time.
                </div>
                {killSwitchQuery.data?.reason && (
                  <div style={{ fontSize: 12.5, color: 'var(--text, #e2e8f0)', marginBottom: 4 }}>
                    <span className="muted">Engagement reason: </span>
                    <strong style={{ color: '#fff' }}>{killSwitchQuery.data.reason}</strong>
                  </div>
                )}
                {killSwitchQuery.data?.changedAt && (
                  <div style={{ fontSize: 12, color: 'var(--text-dim, #94a3b8)', marginBottom: 14 }}>
                    <span className="muted">Engaged at: </span>
                    <span>{new Date(killSwitchQuery.data.changedAt).toLocaleString('en-IN')}</span>
                  </div>
                )}
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowKillSwitchModal(true)}
                  style={{
                    backgroundColor: 'var(--ok, #10b981)',
                    borderColor: 'var(--ok, #10b981)',
                    color: '#fff',
                    fontWeight: 600,
                    padding: '8px 16px',
                  }}
                >
                  Disengage Kill Switch / Resume Trading
                </button>
              </div>
            ) : (
              <div>
                <p style={{ color: 'var(--text-dim, #94a3b8)', fontSize: 13, lineHeight: 1.5, margin: '0 0 16px' }}>
                  If you need to perform server updates, investigate a suspected anomaly, or halt execution during extreme volatility,
                  activate this kill switch. The platform's cryptographic signer will instantly refuse to sign any order or cancel requests,
                  and all API mutation routes will reject requests with HTTP 403 Forbidden.
                </p>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => setShowKillSwitchModal(true)}
                  style={{
                    backgroundColor: 'var(--danger, #ef4444)',
                    borderColor: 'var(--danger, #ef4444)',
                    color: '#fff',
                    fontWeight: 600,
                    padding: '8px 16px',
                  }}
                >
                  Engage Emergency Kill Switch
                </button>
              </div>
            )}
          </div>

          {/* CARD 2: Desk Trading Status (Tenant Pause) */}
          <div className="settings-section-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 8,
                    background: 'rgba(59, 130, 246, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#3b82f6',
                    flexShrink: 0,
                  }}
                >
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="10" y1="15" x2="10" y2="9" />
                    <line x1="14" y1="15" x2="14" y2="9" />
                  </svg>
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16 }}>Desk Trading Status</h3>
                  <p className="muted" style={{ margin: '3px 0 0', fontSize: 13 }}>
                    Tenant-level pause. Pausing stops new trades immediately; resuming requires workspace owner authority.
                  </p>
                </div>
              </div>

              <div>
                <span className={`badge ${deskPaused ? 'skipped' : 'planned'}`} style={{ padding: '5px 12px', fontSize: 12, fontWeight: 700 }}>
                  {deskPaused ? 'DESK PAUSED' : 'DESK TRADING'}
                </span>
              </div>
            </div>

            {deskPaused && tradingData?.tenant.pausedReason !== null && (
              <div style={{ background: '#171f33', padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 13 }}>
                <span className="muted">Pause reason: </span>
                <span style={{ color: '#fff' }}>{tradingData?.tenant.pausedReason}</span>
              </div>
            )}

            {deskPaused ? (
              <div>
                {isOwner ? (
                  <button
                    type="button"
                    className="btn primary"
                    disabled={resumeDeskMut.isPending}
                    onClick={() => resumeDeskMut.mutate()}
                  >
                    {resumeDeskMut.isPending ? 'Resuming…' : 'Resume Desk Trading'}
                  </button>
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                    Only a workspace <strong>owner</strong> can resume desk trading.
                  </p>
                )}
              </div>
            ) : (
              <div>
                {canPause ? (
                  deskPausing ? (
                    <form
                      style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (deskPauseReason.trim() !== '') pauseDeskMut.mutate();
                      }}
                    >
                      <input
                        style={{ maxWidth: 360 }}
                        value={deskPauseReason}
                        onChange={(e) => setDeskPauseReason(e.target.value)}
                        placeholder="Why are you pausing the desk?"
                        aria-label="Pause reason"
                      />
                      <button
                        className="btn danger btn-sm"
                        type="submit"
                        disabled={pauseDeskMut.isPending || deskPauseReason.trim() === ''}
                      >
                        {pauseDeskMut.isPending ? 'Pausing…' : 'Confirm Pause'}
                      </button>
                      <button className="btn secondary btn-sm" type="button" onClick={() => setDeskPausing(false)}>
                        Cancel
                      </button>
                    </form>
                  ) : (
                    <button className="btn secondary" type="button" onClick={() => setDeskPausing(true)}>
                      Pause Desk Trading
                    </button>
                  )
                ) : (
                  <p className="muted" style={{ margin: 0, fontSize: 13 }}>A viewer cannot pause desk trading.</p>
                )}
              </div>
            )}
          </div>

          {/* CARD 3: Platform Exchange Mode & Market Restrictions */}
          <div className="settings-section-card">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  background: 'rgba(168, 85, 247, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#a855f7',
                  flexShrink: 0,
                }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                  <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                  <line x1="6" y1="6" x2="6.01" y2="6" />
                  <line x1="6" y1="18" x2="6.01" y2="18" />
                </svg>
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 16 }}>Exchange Venue &amp; Markets</h3>
                <p className="muted" style={{ margin: '3px 0 0', fontSize: 13 }}>
                  Upstream exchange operational mode and market-specific trade restrictions.
                </p>
              </div>
            </div>

            {tradingData !== undefined ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 12 }}>
                  <span className="desk-k" style={{ fontSize: 13, color: 'var(--text-dim, #94a3b8)' }}>Exchange Mode:</span>
                  <span className={`badge ${tradingData.platform.mode === 'normal' ? 'planned' : 'skipped'}`}>
                    {tradingData.platform.mode}
                  </span>
                </div>
                {tradingData.platform.mode !== 'normal' && (
                  <div style={{ marginBottom: 14, fontSize: 13 }}>
                    <span className="muted">Venue note: </span>
                    <span>{tradingData.platform.modeReason ?? 'No reason provided by exchange'}</span>
                  </div>
                )}

                {tradingData.restrictedMarkets.length > 0 ? (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Restricted Markets ({tradingData.restrictedMarkets.length})</div>
                    <div className="table-scroll-container">
                      <table style={{ width: '100%', fontSize: 13 }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', padding: '8px' }}>Market</th>
                            <th style={{ textAlign: 'left', padding: '8px' }}>Mode</th>
                            <th style={{ textAlign: 'left', padding: '8px' }}>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tradingData.restrictedMarkets.map((m) => (
                            <tr key={m.market}>
                              <td style={{ padding: '8px' }}>{m.market}</td>
                              <td style={{ padding: '8px' }}><span className="badge skipped">{m.mode}</span></td>
                              <td style={{ padding: '8px' }} className="muted">{m.reason ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : (
                  <p className="muted" style={{ margin: '8px 0 0', fontSize: 13 }}>All exchange futures markets are unrestricted.</p>
                )}
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Loading exchange status…</p>
            )}
          </div>

          {/* CARD 4: Desk Risk Limits & Caps */}
          <div className="settings-section-card" style={{ marginBottom: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <div
                style={{
                  width: 40,
                  height: 40,
                  borderRadius: 8,
                  background: 'rgba(234, 179, 8, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#eab308',
                  flexShrink: 0,
                }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
                </svg>
              </div>
              <div>
                <h3 style={{ margin: 0, fontSize: 16 }}>Desk Risk Limits</h3>
                <p className="muted" style={{ margin: '3px 0 0', fontSize: 13 }}>
                  Safety caps enforced on maximum order notional and daily cumulative turnover.
                </p>
              </div>
            </div>

            {tradingData !== undefined ? (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16, marginBottom: 14 }}>
                  <div style={{ background: '#171f33', padding: '14px 18px', borderRadius: 8, border: '1px solid #28354d' }}>
                    <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Per-Order Cap</div>
                    <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginTop: 4 }}>
                      {minorLabel(tradingData.caps.perOrderNotionalMinor, 'INR')}
                    </div>
                  </div>
                  <div style={{ background: '#171f33', padding: '14px 18px', borderRadius: 8, border: '1px solid #28354d' }}>
                    <div className="muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Daily Turnover Cap</div>
                    <div className="mono" style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginTop: 4 }}>
                      {minorLabel(tradingData.caps.dailyNotionalMinor, 'INR')}
                    </div>
                  </div>
                </div>
                <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
                  Adjusting these limits requires workspace owner authentication and step-up 2FA verification.
                </p>
              </div>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Loading risk limits…</p>
            )}
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB 1: POSITION & RISK ALERTS
         ========================================================================= */}
      {activeCategory === 'alerts' && (
        <div>
          <div className="settings-section-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, background: 'rgba(239, 68, 68, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444', flexShrink: 0 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Position Movement Audio Alerts</h3>
                  <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
                    Audible tone sounds across any screen when any group moves beyond your threshold until stopped.
                  </p>
                </div>
              </div>

              {/* Master Alerts Toggle */}
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 10, cursor: 'pointer', background: '#171f33', padding: '6px 14px', borderRadius: 8, border: '1px solid #28354d' }}>
                <input
                  type="checkbox"
                  checked={alertConfig.enabled}
                  onChange={(e) => setAlertConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
                  style={{ width: 16, height: 16, cursor: 'pointer' }}
                />
                <span style={{ fontWeight: 700, fontSize: 13, color: alertConfig.enabled ? '#34d399' : '#94a3b8' }}>
                  {alertConfig.enabled ? 'Alerts Active' : 'Alerts Disabled'}
                </span>
              </label>
            </div>

            {/* Threshold Configuration Grid */}
            <div className="alert-config-grid">
              {/* Downward Movement (Loss/Drop) Card */}
              <div className={`alert-threshold-card ${alertConfig.downAlertEnabled ? 'active-down' : ''}`}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444' }} />
                    <span style={{ fontWeight: 700, fontSize: 14 }}>Group Drop Alert (Down %)</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={alertConfig.downAlertEnabled}
                    onChange={(e) => setAlertConfig((prev) => ({ ...prev, downAlertEnabled: e.target.checked }))}
                    style={{ width: 15, height: 15, cursor: 'pointer' }}
                  />
                </div>

                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Sound alarm when any position group's return falls below this percentage.
                </p>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, color: '#ef4444', fontSize: 15 }}>-</span>
                  <input
                    type="number"
                    min="0.5"
                    max="1000"
                    step="0.5"
                    value={alertConfig.downThresholdPct}
                    onChange={(e) => {
                      const val = Math.max(0.1, Number(e.target.value) || 1);
                      setAlertConfig((prev) => ({ ...prev, downThresholdPct: val }));
                    }}
                    style={{ width: 90, padding: '6px 10px', fontSize: 14, fontWeight: 700 }}
                  />
                  <span style={{ fontWeight: 700, fontSize: 14 }}>%</span>
                </div>

                <div className="alert-preset-chips">
                  <span className="muted" style={{ fontSize: 11 }}>Presets:</span>
                  {DOWN_PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`alert-preset-chip ${alertConfig.downThresholdPct === p ? 'selected' : ''}`}
                      onClick={() => setAlertConfig((prev) => ({ ...prev, downThresholdPct: p }))}
                    >
                      -{p}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Upward Movement (Gain/Rise) Card */}
              <div className={`alert-threshold-card ${alertConfig.upAlertEnabled ? 'active-up' : ''}`}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#10b981' }} />
                    <span style={{ fontWeight: 700, fontSize: 14 }}>Group Rise Alert (Up %)</span>
                  </div>
                  <input
                    type="checkbox"
                    checked={alertConfig.upAlertEnabled}
                    onChange={(e) => setAlertConfig((prev) => ({ ...prev, upAlertEnabled: e.target.checked }))}
                    style={{ width: 15, height: 15, cursor: 'pointer' }}
                  />
                </div>

                <p className="muted" style={{ margin: 0, fontSize: 12 }}>
                  Sound alarm when any position group's return rises beyond this percentage.
                </p>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontWeight: 700, color: '#10b981', fontSize: 15 }}>+</span>
                  <input
                    type="number"
                    min="0.5"
                    max="1000"
                    step="0.5"
                    value={alertConfig.upThresholdPct}
                    onChange={(e) => {
                      const val = Math.max(0.1, Number(e.target.value) || 1);
                      setAlertConfig((prev) => ({ ...prev, upThresholdPct: val }));
                    }}
                    style={{ width: 90, padding: '6px 10px', fontSize: 14, fontWeight: 700 }}
                  />
                  <span style={{ fontWeight: 700, fontSize: 14 }}>%</span>
                </div>

                <div className="alert-preset-chips">
                  <span className="muted" style={{ fontSize: 11 }}>Presets:</span>
                  {UP_PRESETS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      className={`alert-preset-chip ${alertConfig.upThresholdPct === p ? 'selected' : ''}`}
                      onClick={() => setAlertConfig((prev) => ({ ...prev, upThresholdPct: p }))}
                    >
                      +{p}%
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Coin Scope & Specific Coins Selection */}
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 18, marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 8 }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Alert Coin Target &amp; Specific Coins</h4>
                  <p className="muted" style={{ margin: '3px 0 0', fontSize: 12.5 }}>
                    Configure whether alerts trigger for all traded coins, or exclusively for designated specific coins.
                  </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="badge" style={{ fontSize: 12, fontWeight: 700, background: alertConfig.coinScope === 'specific' ? 'rgba(59, 130, 246, 0.15)' : 'rgba(255, 255, 255, 0.06)', color: alertConfig.coinScope === 'specific' ? '#60a5fa' : 'var(--muted)', borderColor: alertConfig.coinScope === 'specific' ? '#3b82f6' : 'var(--line)' }}>
                    {alertConfig.coinScope === 'specific' ? `${alertConfig.specificCoins.length} Specific Coins Active` : 'All Traded Coins Active'}
                  </span>
                </div>
              </div>

              {/* Scope Selector: All Coins vs Specific Coins */}
              <div className="alert-scope-selector">
                <div
                  className={`alert-scope-card ${alertConfig.coinScope === 'all' ? 'active' : ''}`}
                  onClick={() => setAlertConfig((prev) => ({ ...prev, coinScope: 'all' }))}
                >
                  <div className="alert-scope-radio">
                    <div className="alert-scope-radio-dot" />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13.5, color: '#f1f5f9' }}>
                      All Traded Coins (Default)
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                      Monitors every open position group across all coins and symbols.
                    </div>
                  </div>
                </div>

                <div
                  className={`alert-scope-card ${alertConfig.coinScope === 'specific' ? 'active' : ''}`}
                  onClick={() => setAlertConfig((prev) => ({ ...prev, coinScope: 'specific' }))}
                >
                  <div className="alert-scope-radio">
                    <div className="alert-scope-radio-dot" />
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13.5, color: '#f1f5f9' }}>
                      Specific Coins Only
                    </div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                      Only sound alerts for designated coins in your alert watchlist below.
                    </div>
                  </div>
                </div>
              </div>

              {/* Specific Coins Watchlist & Management Panel */}
              <div className="alert-coins-panel">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                  <div style={{ fontWeight: 700, fontSize: 13.5, color: '#e2e8f0' }}>
                    Specific Coins Watchlist
                  </div>
                  {alertConfig.specificCoins.length > 0 && (
                    <button
                      type="button"
                      className="btn btn-sm secondary"
                      onClick={() => setAlertConfig((prev) => ({ ...prev, specificCoins: [], coinRules: {} }))}
                      style={{ fontSize: 11.5, padding: '2px 8px' }}
                    >
                      Clear All Coins
                    </button>
                  )}
                </div>

                {/* Add Coin Row */}
                <div className="alert-coin-add-row">
                  <input
                    type="text"
                    className="alert-coin-input"
                    placeholder="Enter coin symbol (e.g. BTC, ETH, SOL, DOGE)..."
                    value={newCoinInput}
                    onChange={(e) => {
                      setNewCoinInput(e.target.value.toUpperCase());
                      setCoinInputError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleAddSpecificCoin(newCoinInput);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => handleAddSpecificCoin(newCoinInput)}
                    disabled={!newCoinInput.trim()}
                    style={{ padding: '8px 16px', fontSize: 13, fontWeight: 700 }}
                  >
                    + Add Coin
                  </button>
                </div>

                {coinInputError && (
                  <div style={{ color: '#ef4444', fontSize: 12, marginTop: 6, fontWeight: 600 }}>
                    {coinInputError}
                  </div>
                )}

                {/* Quick Add Suggestions */}
                <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {activePositionCoins.length > 0 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span className="muted" style={{ fontSize: 11.5, fontWeight: 600 }}>From Active Positions:</span>
                      {activePositionCoins.map((coin) => {
                        const isAdded = alertConfig.specificCoins.includes(coin);
                        return (
                          <button
                            key={coin}
                            type="button"
                            className="alert-chip-btn"
                            disabled={isAdded}
                            onClick={() => handleAddSpecificCoin(coin)}
                            style={{ opacity: isAdded ? 0.5 : 1, cursor: isAdded ? 'default' : 'pointer' }}
                          >
                            <span>{isAdded ? '✓' : '+'}</span>
                            <span>{coin}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className="muted" style={{ fontSize: 11.5, fontWeight: 600 }}>Popular:</span>
                    {POPULAR_COINS.map((coin) => {
                      const isAdded = alertConfig.specificCoins.includes(coin);
                      return (
                        <button
                          key={coin}
                          type="button"
                          className="alert-chip-btn"
                          disabled={isAdded}
                          onClick={() => handleAddSpecificCoin(coin)}
                          style={{ opacity: isAdded ? 0.5 : 1, cursor: isAdded ? 'default' : 'pointer' }}
                        >
                          <span>{isAdded ? '✓' : '+'}</span>
                          <span>{coin}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Configured Specific Coins Cards */}
                {alertConfig.specificCoins.length === 0 ? (
                  <div style={{ marginTop: 14, padding: '14px', textAlign: 'center', background: 'rgba(255, 255, 255, 0.02)', borderRadius: 6, border: '1px dashed #28354d', color: 'var(--muted)', fontSize: 12.5 }}>
                    {alertConfig.coinScope === 'specific' ? (
                      <span style={{ color: '#f59e0b', fontWeight: 600 }}>
                        No specific coins added yet. Please add at least one coin above, or switch to "All Traded Coins" so alerts can sound.
                      </span>
                    ) : (
                      <span>No specific coin filters configured. Alerts will monitor all open positions by default.</span>
                    )}
                  </div>
                ) : (
                  <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                    {alertConfig.specificCoins.map((coin) => {
                      const rule = alertConfig.coinRules?.[coin];
                      const hasCustomThreshold = (rule?.downThresholdPct !== null && rule?.downThresholdPct !== undefined) || (rule?.upThresholdPct !== null && rule?.upThresholdPct !== undefined);
                      const hasPriceTarget = (rule?.targetPriceBelow !== null && rule?.targetPriceBelow !== undefined) || (rule?.targetPriceAbove !== null && rule?.targetPriceAbove !== undefined);

                      return (
                        <div key={coin} className="alert-coin-card">
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <span className="alert-coin-badge">{coin}</span>
                              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                                {hasCustomThreshold || hasPriceTarget ? 'Custom Rules' : `Default (-${alertConfig.downThresholdPct}% / +${alertConfig.upThresholdPct}%)`}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="alert-tag-remove"
                              onClick={() => handleRemoveSpecificCoin(coin)}
                              title={`Remove ${coin}`}
                              aria-label={`Remove ${coin}`}
                            >
                              ×
                            </button>
                          </div>

                          {/* Quick Custom Threshold Inputs */}
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                              <span style={{ color: '#ef4444', fontWeight: 600 }}>Drop Alert (%):</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ color: '#ef4444', fontWeight: 700 }}>-</span>
                                <input
                                  type="number"
                                  min="0.5"
                                  max="1000"
                                  step="0.5"
                                  placeholder={String(alertConfig.downThresholdPct)}
                                  value={rule?.downThresholdPct ?? ''}
                                  onChange={(e) => {
                                    const val = e.target.value === '' ? null : Math.max(0.1, Number(e.target.value) || 1);
                                    handleUpdateCoinRule(coin, { downThresholdPct: val });
                                  }}
                                  style={{ width: 65, padding: '3px 6px', fontSize: 12, background: '#171f33', color: '#f1f5f9', border: '1px solid #28354d', borderRadius: 4 }}
                                />
                                <span>%</span>
                              </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                              <span style={{ color: '#10b981', fontWeight: 600 }}>Rise Alert (%):</span>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                                <span style={{ color: '#10b981', fontWeight: 700 }}>+</span>
                                <input
                                  type="number"
                                  min="0.5"
                                  max="1000"
                                  step="0.5"
                                  placeholder={String(alertConfig.upThresholdPct)}
                                  value={rule?.upThresholdPct ?? ''}
                                  onChange={(e) => {
                                    const val = e.target.value === '' ? null : Math.max(0.1, Number(e.target.value) || 1);
                                    handleUpdateCoinRule(coin, { upThresholdPct: val });
                                  }}
                                  style={{ width: 65, padding: '3px 6px', fontSize: 12, background: '#171f33', color: '#f1f5f9', border: '1px solid #28354d', borderRadius: 4 }}
                                />
                                <span>%</span>
                              </div>
                            </div>

                            {/* Target Price Alerts */}
                            <div style={{ borderTop: '1px solid #1e293b', paddingTop: 6, marginTop: 2, display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>Price Floor (&lt;=):</span>
                                <input
                                  type="number"
                                  step="any"
                                  placeholder="Optional price"
                                  value={rule?.targetPriceBelow ?? ''}
                                  onChange={(e) => {
                                    const val = e.target.value === '' ? null : Number(e.target.value) || null;
                                    handleUpdateCoinRule(coin, { targetPriceBelow: val });
                                  }}
                                  style={{ width: 95, padding: '3px 6px', fontSize: 11.5, background: '#171f33', color: '#f1f5f9', border: '1px solid #28354d', borderRadius: 4 }}
                                />
                              </div>

                              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <span style={{ color: 'var(--muted)', fontSize: 11.5 }}>Price Ceiling (&gt;=):</span>
                                <input
                                  type="number"
                                  step="any"
                                  placeholder="Optional price"
                                  value={rule?.targetPriceAbove ?? ''}
                                  onChange={(e) => {
                                    const val = e.target.value === '' ? null : Number(e.target.value) || null;
                                    handleUpdateCoinRule(coin, { targetPriceAbove: val });
                                  }}
                                  style={{ width: 95, padding: '3px 6px', fontSize: 11.5, background: '#171f33', color: '#f1f5f9', border: '1px solid #28354d', borderRadius: 4 }}
                                />
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Audio Synthesis & Sound Controls */}
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 18, marginTop: 10 }}>
              <h4 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700 }}>Audio Tone &amp; Volume Customization</h4>
              
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, alignItems: 'flex-start' }}>
                {/* Sound Tone Selector */}
                <div>
                  <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>
                    Alert Sound Tone
                  </label>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select
                      value={alertConfig.soundType}
                      onChange={(e) => {
                        const nextType = e.target.value as AlertSoundType;
                        setAlertConfig((prev) => ({ ...prev, soundType: nextType }));
                        handlePlaySample(nextType);
                      }}
                      style={{ flex: 1, padding: '8px 12px', fontSize: 13, background: '#171f33', color: '#f1f5f9', border: '1px solid #28354d', borderRadius: 6 }}
                    >
                      <option value="siren">Emergency Siren (High-Fidelity MP3 - Recommended)</option>
                      <option value="harmonic">Harmonic Chime (Melodic Tri-Tone)</option>
                      <option value="bell">Crystal Bell (Resonant Clear Tone)</option>
                      <option value="pulse">Alert Pulse (Dual Attention Tone)</option>
                    </select>

                    <button
                      type="button"
                      className="btn btn-sm secondary"
                      onClick={() => handlePlaySample(alertConfig.soundType)}
                      title="Play sample tone"
                      style={{ padding: '8px 12px' }}
                    >
                      Sample
                    </button>
                  </div>
                  <span className="muted" style={{ fontSize: 11.5, display: 'block', marginTop: 4 }}>
                    Emergency MP3 siren audio with Web Audio synthesizer fallback.
                  </span>
                </div>

                {/* Volume Slider */}
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <label style={{ fontWeight: 600, fontSize: 13 }}>Alert Volume</label>
                    <span style={{ fontWeight: 700, fontSize: 13, color: '#3b82f6' }}>
                      {Math.round(alertConfig.volume * 100)}%
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.1"
                    max="1"
                    step="0.05"
                    value={alertConfig.volume}
                    onChange={(e) => setAlertConfig((prev) => ({ ...prev, volume: Number(e.target.value) }))}
                    style={{ width: '100%', cursor: 'pointer' }}
                  />
                  <span className="muted" style={{ fontSize: 11.5, display: 'block', marginTop: 4 }}>
                    Controls volume across desk speakers or headphones.
                  </span>
                </div>

                {/* Repeat Frequency */}
                <div>
                  <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13 }}>
                    Repeat Interval
                  </label>
                  <select
                    value={alertConfig.repeatIntervalSeconds}
                    onChange={(e) => setAlertConfig((prev) => ({ ...prev, repeatIntervalSeconds: Number(e.target.value) }))}
                    style={{ width: '100%', padding: '8px 12px', fontSize: 13, background: '#171f33', color: '#f1f5f9', border: '1px solid #28354d', borderRadius: 6 }}
                  >
                    <option value="2">Repeat every 2 seconds</option>
                    <option value="3">Repeat every 3 seconds (Standard)</option>
                    <option value="5">Repeat every 5 seconds</option>
                  </select>
                  <span className="muted" style={{ fontSize: 11.5, display: 'block', marginTop: 4 }}>
                    Frequency of tone repeats until acknowledged or stopped.
                  </span>
                </div>
              </div>

              {/* Sound Test Desk */}
              <div style={{ marginTop: 18, padding: '14px 18px', background: '#141a29', border: '1px solid #232d42', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 6, background: 'rgba(59, 130, 246, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3b82f6' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                    </svg>
                  </div>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>Preview Continuous Alarm</div>
                    <div className="muted" style={{ fontSize: 12 }}>
                      Test the exact repeating alert tone and sound level as it will play during live trades.
                    </div>
                  </div>
                </div>

                <button
                  type="button"
                  className={isTestingSound ? 'btn danger' : 'btn secondary'}
                  onClick={handleTestSoundToggle}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 18px', fontSize: 13, fontWeight: 700 }}
                >
                  {isTestingSound ? (
                    <>
                      <span>Stop Test Alarm</span>
                      <span className="audio-test-indicator">
                        <span className="audio-test-bar" />
                        <span className="audio-test-bar" />
                        <span className="audio-test-bar" />
                      </span>
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                      <span>Test Alert Sound</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Live Groups Monitoring Status Preview */}
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 18, marginTop: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <h4 style={{ margin: 0, fontSize: 14.5, fontWeight: 700 }}>Live Group Status Monitor</h4>
                <span className="muted" style={{ fontSize: 12 }}>
                  {positionGroups.length} open position {positionGroups.length === 1 ? 'group' : 'groups'}
                </span>
              </div>

              {livePositions.isLoading && <div className="muted" style={{ fontSize: 12.5 }}>Checking positions…</div>}

              {positionGroups.length === 0 && !livePositions.isLoading && (
                <div style={{ padding: '16px', textAlign: 'center', background: 'rgba(255, 255, 255, 0.02)', borderRadius: 6, color: 'var(--muted)', fontSize: 13 }}>
                  No active futures positions currently open. Alerts will trigger automatically when positions exceed configured thresholds.
                </div>
              )}

              {positionGroups.length > 0 && (
                <div style={{ overflowX: 'auto' }}>
                  <table className="settings-live-groups-table">
                    <thead>
                      <tr>
                        <th>Asset &amp; Pair</th>
                        <th>Side</th>
                        <th>Mark Price</th>
                        <th>Current Group ROE</th>
                        <th>Alert Scope</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {positionGroups.map((g) => {
                        const assetUpper = g.asset.toUpperCase();
                        const isCoinMonitored = alertConfig.coinScope === 'all' || alertConfig.specificCoins.some((c) => c.toUpperCase() === assetUpper);
                        const coinRule = alertConfig.coinRules?.[assetUpper];

                        const effectiveDown = typeof coinRule?.downThresholdPct === 'number' && coinRule.downThresholdPct > 0
                          ? coinRule.downThresholdPct
                          : alertConfig.downThresholdPct;
                        const effectiveUp = typeof coinRule?.upThresholdPct === 'number' && coinRule.upThresholdPct > 0
                          ? coinRule.upThresholdPct
                          : alertConfig.upThresholdPct;

                        const markPrices = g.positions.map((p) => Number(p.markPrice)).filter((v) => Number.isFinite(v) && v > 0);
                        const currentMarkPrice = markPrices.length > 0 ? markPrices[0]! : null;

                        const roe = calcGroupRoePct(g);
                        const isDownBreach = isCoinMonitored && alertConfig.downAlertEnabled && roe !== null && roe <= -Math.abs(effectiveDown);
                        const isUpBreach = isCoinMonitored && alertConfig.upAlertEnabled && roe !== null && roe >= Math.abs(effectiveUp);
                        const isPriceBelowBreach = isCoinMonitored && currentMarkPrice !== null && coinRule?.targetPriceBelow && currentMarkPrice <= coinRule.targetPriceBelow;
                        const isPriceAboveBreach = isCoinMonitored && currentMarkPrice !== null && coinRule?.targetPriceAbove && currentMarkPrice >= coinRule.targetPriceAbove;

                        return (
                          <tr key={g.key} style={{ opacity: isCoinMonitored ? 1 : 0.6 }}>
                            <td>
                              <span style={{ fontWeight: 700, color: '#f1f5f9' }}>{g.asset}</span>
                              <span className="muted" style={{ fontSize: 11.5, marginLeft: 6 }}>{g.pair}</span>
                            </td>
                            <td>
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 700,
                                  padding: '2px 6px',
                                  borderRadius: 4,
                                  textTransform: 'uppercase',
                                  background: g.side === 'long' ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                                  color: g.side === 'long' ? '#34d399' : '#f87171',
                                }}
                              >
                                {g.side}
                              </span>
                            </td>
                            <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                              {currentMarkPrice !== null ? currentMarkPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : '—'}
                            </td>
                            <td style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                              {roe === null ? (
                                '—'
                              ) : (
                                <span style={{ color: roe >= 0 ? '#10b981' : '#ef4444' }}>
                                  {roe >= 0 ? `+${roe.toFixed(2)}%` : `${roe.toFixed(2)}%`}
                                </span>
                              )}
                            </td>
                            <td>
                              {alertConfig.coinScope === 'all' ? (
                                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: 'rgba(59, 130, 246, 0.12)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.25)' }}>
                                  All Coins (-{effectiveDown}% / +{effectiveUp}%)
                                </span>
                              ) : isCoinMonitored ? (
                                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: 'rgba(59, 130, 246, 0.18)', color: '#93c5fd', border: '1px solid #3b82f6' }}>
                                  Specific Coin (-{effectiveDown}% / +{effectiveUp}%)
                                </span>
                              ) : (
                                <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: 'rgba(255, 255, 255, 0.05)', color: '#94a3b8', border: '1px solid #334155' }}>
                                  Ignored (Not in Specific List)
                                </span>
                              )}
                            </td>
                            <td>
                              {!isCoinMonitored ? (
                                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                                  Filtered out
                                </span>
                              ) : isDownBreach ? (
                                <span style={{ color: '#ef4444', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <span>▼</span> Alert: Down Breach
                                </span>
                              ) : isUpBreach ? (
                                <span style={{ color: '#10b981', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <span>▲</span> Alert: Up Breach
                                </span>
                              ) : isPriceBelowBreach ? (
                                <span style={{ color: '#ef4444', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <span>▼</span> Alert: Price Floor
                                </span>
                              ) : isPriceAboveBreach ? (
                                <span style={{ color: '#10b981', fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                                  <span>▲</span> Alert: Price Ceiling
                                </span>
                              ) : (
                                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                                  Safe (within bounds)
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Save Alerts Button */}
            <div style={{ marginTop: 24, display: 'flex', alignItems: 'center', gap: 14 }}>
              <button
                type="button"
                className="btn"
                onClick={handleSaveAlertConfig}
                style={{ padding: '10px 22px', fontSize: 14, fontWeight: 700 }}
              >
                Save Alert Settings
              </button>

              {alertsSavedStatus && (
                <span style={{ fontSize: 13, color: '#34d399', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                  <span>{alertsSavedStatus}</span>
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      {/* =========================================================================
          TAB 2: PLATFORM BRANDING & IDENTITY
         ========================================================================= */}
      {activeCategory === 'branding' && (
        <div>
          <form onSubmit={submitBranding}>
            <div className="settings-section-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <div style={{ width: 34, height: 34, borderRadius: 8, background: 'rgba(59, 130, 246, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3b82f6', flexShrink: 0 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 22 7 12 2"/><line x1="4" y1="22" x2="20" y2="22"/><line x1="6" y1="18" x2="18" y2="18"/><line x1="10" y1="7" x2="10" y2="18"/><line x1="14" y1="7" x2="14" y2="18"/><line x1="18" y1="7" x2="18" y2="18"/><line x1="6" y1="7" x2="6" y2="18"/></svg>
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Platform Branding &amp; Identity</h3>
                  <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
                    Controls the logo, wordmark, and brand name displayed on the marketing website, login portal, and trading desk.
                  </p>
                </div>
              </div>

              {isOwner && !totpEnabled && (
                <div style={{ fontSize: 13, marginBottom: 16, padding: '10px 14px', background: 'rgba(245, 158, 11, 0.12)', borderRadius: 8, border: '1px solid rgba(245, 158, 11, 0.4)', color: '#fef08a', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                  <span>Two-factor authentication is not enrolled. It is recommended before owner actions — <Link to="/app/security" style={{ color: '#34d399', fontWeight: 600, textDecoration: 'underline' }}>enrol in Security &amp; 2FA</Link>.</span>
                </div>
              )}

              {/* Platform Name */}
              <div className="field" style={{ marginBottom: 18 }}>
                <label htmlFor="brand-name" style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13.5 }}>
                  Platform Brand Name
                </label>
                <input
                  id="brand-name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Aza WealthKare"
                  aria-label="Platform brand name"
                  maxLength={120}
                  style={{ width: '100%', maxWidth: 420 }}
                />
                {!isOwner && workspace.data && (
                  <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                    (Workspace name: <strong>{workspace.data.name}</strong>)
                  </div>
                )}
              </div>

              {/* Logo / Icon Tabs */}
              <div className="field" style={{ marginBottom: 18 }}>
                <label style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13.5 }}>
                  Brand Logo / Icon
                </label>

                <div className="branding-logo-tabs">
                  <button
                    type="button"
                    className={`branding-tab-btn ${logoTab === 'upload' ? 'active' : ''}`}
                    onClick={() => setLogoTab('upload')}
                  >
                    Upload Image
                  </button>
                  <button
                    type="button"
                    className={`branding-tab-btn ${logoTab === 'icon' ? 'active' : ''}`}
                    onClick={() => setLogoTab('icon')}
                  >
                    Symbol / Monogram
                  </button>
                  <button
                    type="button"
                    className={`branding-tab-btn ${logoTab === 'url' ? 'active' : ''}`}
                    onClick={() => setLogoTab('url')}
                  >
                    Image URL
                  </button>
                </div>

                {logoTab === 'upload' && (
                  <div>
                    <div
                      className="branding-file-drop"
                      onClick={() => fileInputRef.current?.click()}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
                      role="button"
                      tabIndex={0}
                    >
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
                        style={{ display: 'none' }}
                        onChange={handleFileUpload}
                      />
                      <div style={{ marginBottom: 6 }}>
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 13.5 }}>Click to browse image file</div>
                      <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                        PNG, SVG, JPG, or WebP up to 2 MB (recommended square aspect ratio)
                      </div>
                    </div>
                  </div>
                )}

                {logoTab === 'icon' && (
                  <div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <input
                        value={iconInput}
                        onChange={(e) => {
                          setIconInput(e.target.value);
                          setLogo(e.target.value.trim() ? e.target.value.trim() : null);
                        }}
                        placeholder="Symbol or letter"
                        maxLength={10}
                        style={{ width: 140, textAlign: 'center', fontSize: 16 }}
                      />
                      <span className="muted" style={{ fontSize: 12.5 }}>
                        or pick a quick institutional symbol:
                      </span>
                    </div>

                    <div className="branding-icon-presets">
                      {PRESET_ICONS.map((ic) => (
                        <button
                          key={ic}
                          type="button"
                          className={`branding-icon-btn ${logo === ic ? 'selected' : ''}`}
                          onClick={() => handleSelectIcon(ic)}
                          title={`Select ${ic}`}
                        >
                          {ic}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {logoTab === 'url' && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      value={urlInput}
                      onChange={(e) => setUrlInput(e.target.value)}
                      placeholder="https://example.com/logo.svg"
                      style={{ flex: 1, maxWidth: 360 }}
                    />
                    <button type="button" className="btn btn-sm secondary" onClick={handleApplyUrl}>
                      Apply URL
                    </button>
                  </div>
                )}

                {logo && (
                  <div className="branding-current-logo-preview" style={{ marginTop: 12 }}>
                    <span className="muted" style={{ fontSize: 12 }}>Active custom logo:</span>
                    <Brand customName="" customLogo={logo} showName={false} size="sm" />
                    <button
                      type="button"
                      className="btn btn-sm secondary"
                      onClick={handleRemoveLogo}
                      style={{ marginLeft: 'auto', fontSize: 12, padding: '3px 9px' }}
                    >
                      Reset to Default Logo
                    </button>
                  </div>
                )}
              </div>

              {/* Live Branding Previews */}
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                  Live Brand Preview
                </div>
                <div className="branding-preview-container">
                  <div className="branding-preview-card dark">
                    <div className="branding-preview-label">Sidebar &amp; Portal (Dark)</div>
                    <Brand customName={name || DEFAULT_BRAND_NAME} customLogo={logo} />
                  </div>
                  <div className="branding-preview-card light">
                    <div className="branding-preview-label">Website Header (Light/Glass)</div>
                    <Brand customName={name || DEFAULT_BRAND_NAME} customLogo={logo} />
                  </div>
                </div>
              </div>
            </div>

            {/* 2FA Step-up code if required */}
            {needsCode && (
              <div style={{ marginBottom: 14, padding: 16, background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8 }}>
                <label style={{ display: 'block', marginBottom: 6, fontSize: 13, fontWeight: 600, color: '#fca5a5' }}>
                  Enter 6-digit 2FA code to confirm server workspace rename:
                </label>
                <input
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="6-digit authentication code"
                  aria-label="Verification code"
                  style={{ width: 180, background: '#171f33', color: '#ffffff', border: '1px solid #28354d', padding: '8px 12px', borderRadius: 6 }}
                />
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }}>
              <button
                className="btn"
                type="submit"
                disabled={saving || name.trim() === '' || !hasBrandingChanges}
                style={{ padding: '10px 22px', fontSize: 14, fontWeight: 600 }}
              >
                {saving ? 'Saving Branding…' : 'Save Platform Branding'}
              </button>

              <button
                type="button"
                className="btn secondary"
                onClick={handleResetDefaults}
                title="Restore all branding and contact defaults"
              >
                Restore Defaults
              </button>

              {hasBrandingChanges && (
                <span style={{ fontSize: 12.5, color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>●</span> You have unsaved changes
                </span>
              )}
            </div>
          </form>
        </div>
      )}

      {/* =========================================================================
          TAB 3: COMPANY & CONTACT CHANNELS
         ========================================================================= */}
      {activeCategory === 'contact' && (
        <div>
          <form onSubmit={submitBranding}>
            <div className="settings-section-card">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                <div style={{ width: 34, height: 34, borderRadius: 8, background: 'rgba(59, 130, 246, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#3b82f6', flexShrink: 0 }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Company &amp; Direct Contact Channels</h3>
                  <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
                    These contact details automatically sync across the website footer, the Contact page, and the floating WhatsApp chat widget.
                  </p>
                </div>
              </div>

              <div className="settings-contact-grid">
                {/* WhatsApp Chat Number */}
                <div>
                  <label htmlFor="settings-whatsapp" style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13.5 }}>
                    WhatsApp Chat Number <span style={{ color: '#25D366' }}>(Bottom-Right Widget)</span>
                  </label>
                  <div className="settings-input-group">
                    <span className="settings-input-icon" style={{ color: '#25D366' }}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                    </span>
                    <input
                      id="settings-whatsapp"
                      type="text"
                      value={whatsapp}
                      onChange={(e) => setWhatsapp(e.target.value)}
                      placeholder="e.g. +91 98765 43210"
                      aria-label="WhatsApp Chat Number"
                    />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 5 }}>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      Powers the floating WhatsApp button in bottom-right on the public website.
                    </span>
                    <a
                      href={whatsappTestUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 12, color: '#34d399', textDecoration: 'none', fontWeight: 600 }}
                    >
                      Test Link ↗
                    </a>
                  </div>
                </div>

                {/* Direct Phone Number */}
                <div>
                  <label htmlFor="settings-phone" style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13.5 }}>
                    Advisory Desk Phone Number
                  </label>
                  <div className="settings-input-group">
                    <span className="settings-input-icon">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                    </span>
                    <input
                      id="settings-phone"
                      type="tel"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="e.g. +91 98765 43210"
                      aria-label="Advisory Desk Phone"
                    />
                  </div>
                  <span className="muted" style={{ fontSize: 11.5, display: 'block', marginTop: 5 }}>
                    Displayed in website footer and Contact page.
                  </span>
                </div>

                {/* Advisory Email */}
                <div>
                  <label htmlFor="settings-email" style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13.5 }}>
                    Support / Advisory Email
                  </label>
                  <div className="settings-input-group">
                    <span className="settings-input-icon">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                    </span>
                    <input
                      id="settings-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="e.g. support@azawealthkare.com"
                      aria-label="Advisory Email"
                    />
                  </div>
                  <span className="muted" style={{ fontSize: 11.5, display: 'block', marginTop: 5 }}>
                    Official client inquiry and recovery destination.
                  </span>
                </div>

                {/* Operating Hours */}
                <div>
                  <label htmlFor="settings-hours" style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13.5 }}>
                    Desk Operating Hours
                  </label>
                  <div className="settings-input-group">
                    <span className="settings-input-icon">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    </span>
                    <input
                      id="settings-hours"
                      type="text"
                      value={hours}
                      onChange={(e) => setHours(e.target.value)}
                      placeholder="e.g. Monday – Saturday: 9:00 AM – 8:00 PM IST"
                      aria-label="Desk Operating Hours"
                    />
                  </div>
                  <span className="muted" style={{ fontSize: 11.5, display: 'block', marginTop: 5 }}>
                    Office and consultation availability window.
                  </span>
                </div>
              </div>

              {/* Corporate / Office Address */}
              <div style={{ marginTop: 18 }}>
                <label htmlFor="settings-address" style={{ display: 'block', marginBottom: 6, fontWeight: 600, fontSize: 13.5 }}>
                  Corporate Office Address
                </label>
                <div className="settings-input-group">
                  <span className="settings-input-icon" style={{ top: 12, alignItems: 'flex-start' }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="9" y1="22" x2="9" y2="22.01"/><line x1="15" y1="22" x2="15" y2="22.01"/><line x1="9" y1="6" x2="9" y2="6.01"/><line x1="15" y1="6" x2="15" y2="6.01"/><line x1="9" y1="10" x2="9" y2="10.01"/><line x1="15" y1="10" x2="15" y2="10.01"/><line x1="9" y1="14" x2="9" y2="14.01"/><line x1="15" y1="14" x2="15" y2="14.01"/><line x1="9" y1="18" x2="9" y2="18.01"/><line x1="15" y1="18" x2="15" y2="18.01"/></svg>
                  </span>
                  <textarea
                    id="settings-address"
                    rows={2}
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="e.g. Level 14, Tower B, BKC Financial District, Mumbai"
                    aria-label="Corporate Office Address"
                  />
                </div>
                <span className="muted" style={{ fontSize: 11.5, display: 'block', marginTop: 5 }}>
                  Displayed in the website footer strip and the Contact page office location.
                </span>
              </div>

              {/* Live Contact Preview */}
              <div className="settings-preview-box">
                <div className="settings-preview-title">
                  Live Website Preview (Footer &amp; Channels)
                </div>
                <div className="settings-preview-items">
                  <div className="settings-preview-item">
                    <span style={{ color: '#25D366', display: 'flex', alignItems: 'center' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
                    </span>
                    <span className="settings-preview-label">WhatsApp:</span>
                    <span className="settings-preview-val" style={{ color: '#34d399' }}>{whatsapp || DEFAULT_WHATSAPP}</span>
                  </div>
                  <div className="settings-preview-item">
                    <span style={{ display: 'flex', alignItems: 'center' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                    </span>
                    <span className="settings-preview-label">Phone:</span>
                    <span className="settings-preview-val">{phone || DEFAULT_PHONE}</span>
                  </div>
                  <div className="settings-preview-item">
                    <span style={{ display: 'flex', alignItems: 'center' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                    </span>
                    <span className="settings-preview-label">Email:</span>
                    <span className="settings-preview-val">{email || DEFAULT_EMAIL}</span>
                  </div>
                  <div className="settings-preview-item">
                    <span style={{ display: 'flex', alignItems: 'center' }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="9" y1="22" x2="9" y2="22.01"/><line x1="15" y1="22" x2="15" y2="22.01"/><line x1="9" y1="6" x2="9" y2="6.01"/><line x1="15" y1="6" x2="15" y2="6.01"/><line x1="9" y1="10" x2="9" y2="10.01"/><line x1="15" y1="10" x2="15" y2="10.01"/><line x1="9" y1="14" x2="9" y2="14.01"/><line x1="15" y1="14" x2="15" y2="14.01"/><line x1="9" y1="18" x2="9" y2="18.01"/><line x1="15" y1="18" x2="15" y2="18.01"/></svg>
                    </span>
                    <span className="settings-preview-label">Address:</span>
                    <span className="settings-preview-val" style={{ opacity: 0.9 }}>{address || DEFAULT_ADDRESS}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 18, flexWrap: 'wrap' }}>
              <button
                className="btn"
                type="submit"
                disabled={saving || !hasContactChanges}
                style={{ padding: '10px 22px', fontSize: 14, fontWeight: 600 }}
              >
                {saving ? 'Saving Contacts…' : 'Save Contact Channels'}
              </button>

              <button
                type="button"
                className="btn secondary"
                onClick={handleResetDefaults}
                title="Restore all branding and contact defaults"
              >
                Restore Defaults
              </button>

              {hasContactChanges && (
                <span style={{ fontSize: 12.5, color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span>●</span> You have unsaved changes
                </span>
              )}
            </div>
          </form>
        </div>
      )}

      {/* =========================================================================
          TAB 4: SECURITY & MULTI-FACTOR
         ========================================================================= */}
      {activeCategory === 'security' && (
        <div className="settings-section-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: 'rgba(52, 211, 153, 0.15)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#34d399', flexShrink: 0 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Security &amp; Session Protection</h3>
              <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
                Two-factor authentication, failed attempt alerts, and automated IP lockout policies.
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16, marginBottom: 20 }}>
            {/* 2FA Status */}
            <div style={{ background: '#111520', border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>Two-Factor Authentication (TOTP)</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: 4,
                    background: totpEnabled ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                    color: totpEnabled ? '#34d399' : '#fef08a',
                  }}
                >
                  {totpEnabled ? 'Enrolled & Active' : 'Not Enrolled'}
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: '0 0 12px' }}>
                Protects owner accounts with one-time authenticator codes for sensitive operations and logins.
              </p>
              <Link to="/app/security" className="btn btn-sm secondary">
                Configure 2FA →
              </Link>
            </div>

            {/* Brute Force & IP Lockout Policy */}
            <div style={{ background: '#111520', border: '1px solid var(--line)', borderRadius: 8, padding: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 13.5, marginBottom: 6 }}>Automated IP Protection &amp; Alerts</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 8px', borderRadius: 4, background: 'rgba(59, 130, 246, 0.15)', color: '#60a5fa' }}>
                  24-Hour Lockout Active
                </span>
              </div>
              <p className="muted" style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
                Failed login attempts trigger automated security alert emails to the desk owner. On the 4th consecutive failed attempt, the offending IP address is automatically blocked for 24 hours.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Global Status Message */}
      {status !== null && (
        <div
          style={{
            marginTop: 16,
            padding: '12px 16px',
            borderRadius: 8,
            fontSize: 13.5,
            background: status.kind === 'ok' ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
            border: `1px solid ${status.kind === 'ok' ? 'rgba(16, 185, 129, 0.35)' : 'rgba(239, 68, 68, 0.35)'}`,
            color: status.kind === 'ok' ? '#34d399' : '#fca5a5',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          {status.kind === 'ok' ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          )}
          <span>{status.message}</span>
        </div>
      )}

      {/* ── Emergency Kill Switch Modal (Read-Only Safety Lock) ── */}
      <KillSwitchModal
        isOpen={showKillSwitchModal}
        isHalted={isHalted}
        status={killSwitchQuery.data}
        onClose={() => setShowKillSwitchModal(false)}
        onToggle={(active, reason) => toggleKillSwitchMut.mutate({ active, reason })}
        isToggling={toggleKillSwitchMut.isPending}
      />
    </div>
  );
}
