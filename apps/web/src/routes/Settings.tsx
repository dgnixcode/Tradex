import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWorkspace, renameWorkspace, stepUp } from '../api.ts';
import type { ApiError } from '../api.ts';
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

// The Settings page — workspace preferences, platform branding, and company contact channels.
//
// Allows operators to customize the brand name, upload custom logos, configure
// direct client contact channels (email, phone, address, and WhatsApp chat number),
// and preview how everything appears across the application and website.

const PRESET_ICONS = ['⚡', '🚀', '📈', '🛡️', '🌐', '💎', '🏛️', '🎯', '🔥', '📊'];

export function Settings() {
  const qc = useQueryClient();
  const workspace = useQuery({ queryKey: ['workspace'], queryFn: fetchWorkspace });
  const { state } = useAuth();
  const role = state.status === 'authenticated' ? state.session.role : '';
  const totpEnabled = state.status === 'authenticated' ? state.session.totpEnabled : false;
  const isOwner = role === 'owner';

  const { branding, updateBranding, resetBranding } = useBranding();

  // Branding states
  const [name, setName] = useState(() => branding.name || DEFAULT_BRAND_NAME);
  const [logo, setLogo] = useState<string | null>(null);
  const [logoTab, setLogoTab] = useState<'upload' | 'url' | 'icon'>('upload');
  const [urlInput, setUrlInput] = useState('');
  const [iconInput, setIconInput] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);

  // Contact info states
  const [email, setEmail] = useState(() => branding.email || DEFAULT_EMAIL);
  const [phone, setPhone] = useState(() => branding.phone || DEFAULT_PHONE);
  const [whatsapp, setWhatsapp] = useState(() => branding.whatsapp || DEFAULT_WHATSAPP);
  const [address, setAddress] = useState(() => branding.address || DEFAULT_ADDRESS);
  const [hours, setHours] = useState(() => branding.hours || DEFAULT_HOURS);

  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const nameInitializedRef = useRef(false);

  // Initialize once from workspace data if branding was not customized
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

  const rename = useMutation({
    mutationFn: (n: string) => renameWorkspace(n),
    onSuccess: (r) => {
      setCode('');
      setNeedsCode(false);
      void qc.invalidateQueries({ queryKey: ['workspace'] });
      updateBranding({
        name: r.newName,
        logo,
        email: email.trim(),
        phone: phone.trim(),
        whatsapp: whatsapp.trim(),
        address: address.trim(),
        hours: hours.trim(),
      });
      setStatus({ kind: 'ok', message: `Platform settings updated. Workspace renamed to "${r.newName}".` });
    },
    onError: (e) => {
      const err = e as ApiError;
      if (err.status === 403 && /reauth|second factor|two-factor/i.test(err.message)) {
        setNeedsCode(true);
        setStatus({ kind: 'err', message: 'Enter a code from your authenticator, then save again.' });
        return;
      }
      setStatus({ kind: 'err', message: err.message ?? 'Could not save workspace name on server.' });
    },
  });

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

  const handleResetDefaults = () => {
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

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setStatus(null);
    const cleanName = name.trim();
    if (cleanName === '') {
      setStatus({ kind: 'err', message: 'Platform name is required.' });
      return;
    }

    // Check if workspace name changed on server (for owners)
    const serverNameChanged = workspace.data !== undefined && cleanName !== workspace.data.name;

    if (isOwner && serverNameChanged) {
      if (needsCode) {
        try {
          await stepUp(code.trim());
        } catch (err) {
          const ae = err as ApiError;
          setStatus({ kind: 'err', message: ae.message ?? 'That code was not accepted.' });
          return;
        }
      }
      rename.mutate(cleanName);
      return;
    }

    // Apply updates locally and sync across tabs
    updateBranding({
      name: cleanName,
      logo,
      email: email.trim(),
      phone: phone.trim(),
      whatsapp: whatsapp.trim(),
      address: address.trim(),
      hours: hours.trim(),
    });
    setStatus({ kind: 'ok', message: 'Platform settings and contact channels saved successfully.' });
  };

  const hasPendingChanges =
    name.trim() !== branding.name ||
    logo !== branding.logo ||
    email.trim() !== branding.email ||
    phone.trim() !== branding.phone ||
    whatsapp.trim() !== branding.whatsapp ||
    address.trim() !== branding.address ||
    hours.trim() !== branding.hours ||
    (isOwner && workspace.data !== undefined && name.trim() !== workspace.data.name);

  const cleanWhatsapp = (whatsapp || '').replace(/[^0-9]/g, '') || '919876543210';
  const whatsappTestUrl = `https://wa.me/${cleanWhatsapp}?text=${encodeURIComponent(`Hello ${name || DEFAULT_BRAND_NAME}, I would like to inquire about your wealth management services.`)}`;

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Settings &amp; Platform Configuration</h2>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 24 }}>
        Manage platform branding, identity, and customer-facing contact channels across the website and application.
      </p>

      {workspace.isLoading && <p className="muted">Loading workspace configuration…</p>}
      {workspace.isError && <div className="error">{(workspace.error as Error).message}</div>}

      <form onSubmit={submit}>
        {/* =========================================================================
            SECTION 1: PLATFORM BRANDING & IDENTITY
           ========================================================================= */}
        <div className="settings-section-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 22 }}>🏛️</span>
            <div>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Platform Branding &amp; Identity</h3>
              <p className="muted" style={{ margin: '2px 0 0', fontSize: 13 }}>
                Controls the logo, wordmark, and brand name displayed on the marketing website, login portal, and trading desk.
              </p>
            </div>
          </div>

          {isOwner && !totpEnabled && (
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 14, padding: '8px 12px', background: 'rgba(245, 158, 11, 0.08)', borderRadius: 8, border: '1px solid rgba(245, 158, 11, 0.25)' }}>
              Two-factor authentication is not enrolled. It is recommended before owner actions — <Link to="/app/security" style={{ color: '#34d399' }}>enrol in Security &amp; 2FA</Link>.
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
                📁 Upload Image
              </button>
              <button
                type="button"
                className={`branding-tab-btn ${logoTab === 'icon' ? 'active' : ''}`}
                onClick={() => setLogoTab('icon')}
              >
                ✨ Icon / Emoji
              </button>
              <button
                type="button"
                className={`branding-tab-btn ${logoTab === 'url' ? 'active' : ''}`}
                onClick={() => setLogoTab('url')}
              >
                🔗 Image URL
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
                  <div style={{ fontSize: 24, marginBottom: 6 }}>📤</div>
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
                    placeholder="Type an emoji or symbol"
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

        {/* =========================================================================
            SECTION 2: COMPANY CONTACT CHANNELS & WHATSAPP INTEGRATION
           ========================================================================= */}
        <div className="settings-section-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <span style={{ fontSize: 22 }}>📞</span>
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
                <span className="settings-input-icon" style={{ color: '#25D366' }}>💬</span>
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
                  Powers the floating WhatsApp button in bottom-right.
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
                <span className="settings-input-icon">📞</span>
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
                <span className="settings-input-icon">✉️</span>
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
                <span className="settings-input-icon">🕒</span>
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
              <span className="settings-input-icon" style={{ top: 12, alignItems: 'flex-start' }}>🏢</span>
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
                <span style={{ color: '#25D366' }}>💬</span>
                <span className="settings-preview-label">WhatsApp:</span>
                <span className="settings-preview-val" style={{ color: '#34d399' }}>{whatsapp || DEFAULT_WHATSAPP}</span>
              </div>
              <div className="settings-preview-item">
                <span>📞</span>
                <span className="settings-preview-label">Phone:</span>
                <span className="settings-preview-val">{phone || DEFAULT_PHONE}</span>
              </div>
              <div className="settings-preview-item">
                <span>✉️</span>
                <span className="settings-preview-label">Email:</span>
                <span className="settings-preview-val">{email || DEFAULT_EMAIL}</span>
              </div>
              <div className="settings-preview-item">
                <span>🏢</span>
                <span className="settings-preview-label">Address:</span>
                <span className="settings-preview-val" style={{ opacity: 0.9 }}>{address || DEFAULT_ADDRESS}</span>
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

        {/* Actions & Feedback */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 24, flexWrap: 'wrap' }}>
          <button
            className="btn"
            type="submit"
            disabled={rename.isPending || name.trim() === '' || !hasPendingChanges}
            style={{ padding: '10px 22px', fontSize: 14, fontWeight: 600 }}
          >
            {rename.isPending ? 'Saving Settings…' : 'Save Platform Settings'}
          </button>

          <button
            type="button"
            className="btn secondary"
            onClick={handleResetDefaults}
            title="Restore all branding and contact defaults"
          >
            Restore Defaults
          </button>

          {hasPendingChanges && (
            <span style={{ fontSize: 12.5, color: '#f59e0b', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span>●</span> You have unsaved changes
            </span>
          )}
        </div>
      </form>

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
          <span>{status.kind === 'ok' ? '✅' : '⚠️'}</span>
          <span>{status.message}</span>
        </div>
      )}

      {/* Security Link */}
      <section style={{ borderTop: '1px solid var(--line-subtle)', paddingTop: 20, marginTop: 32 }}>
        <h3 style={{ marginTop: 0, fontSize: 16 }}>Security &amp; Multi-Factor Authentication</h3>
        <p className="muted" style={{ marginTop: -4, marginBottom: 12, fontSize: 13 }}>
          Enforce hardware or app-based two-factor authentication (TOTP) across owner and operator sessions.
        </p>
        <Link to="/app/security" className="btn btn-sm secondary">Manage Security &amp; 2FA →</Link>
      </section>
    </div>
  );
}
