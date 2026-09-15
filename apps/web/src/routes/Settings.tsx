import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchWorkspace, renameWorkspace, stepUp } from '../api.ts';
import type { ApiError } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { useBranding, DEFAULT_BRAND_NAME } from '../branding.tsx';
import { Brand } from '../components/Brand.tsx';

// The Settings page — workspace preferences and platform branding.
//
// Allows users to customize the platform name, upload or set a custom logo/icon,
// and preview how the brand looks across the authenticated sidebar and the public
// marketing pages. Renaming the workspace emits a server-side audit row.

const PRESET_ICONS = ['⚡', '🚀', '📈', '🛡️', '🌐', '💎', '🏛️', '🎯', '🔥', '📊'];

export function Settings() {
  const qc = useQueryClient();
  const workspace = useQuery({ queryKey: ['workspace'], queryFn: fetchWorkspace });
  const { state } = useAuth();
  const role = state.status === 'authenticated' ? state.session.role : '';
  const totpEnabled = state.status === 'authenticated' ? state.session.totpEnabled : false;
  const isOwner = role === 'owner';

  const { branding, updateBranding, resetBranding } = useBranding();

  const [name, setName] = useState('');
  const [logo, setLogo] = useState<string | null>(null);
  const [logoTab, setLogoTab] = useState<'upload' | 'url' | 'icon'>('upload');
  const [urlInput, setUrlInput] = useState('');
  const [iconInput, setIconInput] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'err'; message: string } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize from branding and workspace data
  useEffect(() => {
    if (name === '') {
      setName(branding.name || workspace.data?.name || DEFAULT_BRAND_NAME);
    }
  }, [workspace.data, branding.name, name]);

  useEffect(() => {
    setLogo(branding.logo);
    if (branding.logo) {
      if (branding.logoType === 'icon') {
        setIconInput(branding.logo);
      } else if (branding.logoType === 'image' && !branding.logo.startsWith('data:')) {
        setUrlInput(branding.logo);
      }
    }
  }, [branding.logo, branding.logoType]);

  const rename = useMutation({
    mutationFn: (n: string) => renameWorkspace(n),
    onSuccess: (r) => {
      setCode('');
      setNeedsCode(false);
      void qc.invalidateQueries({ queryKey: ['workspace'] });
      updateBranding({ name: r.newName, logo });
      setStatus({ kind: 'ok', message: `Platform branding updated. Renamed to "${r.newName}".` });
    },
    onError: (e) => {
      const err = e as ApiError;
      if (err.status === 403 && /reauth|second factor|two-factor/i.test(err.message)) {
        setNeedsCode(true);
        setStatus({ kind: 'err', message: 'Enter a code from your authenticator, then save again.' });
        return;
      }
      // If server rename failed, we still give the error
      setStatus({ kind: 'err', message: err.message ?? 'could not save workspace name on server' });
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
        setStatus({ kind: 'ok', message: 'Logo image loaded. Click "Save Branding" to apply.' });
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
    setStatus({ kind: 'ok', message: 'Image URL applied. Click "Save Branding" to apply.' });
  };

  const handleSelectIcon = (icon: string) => {
    setIconInput(icon);
    setLogo(icon);
    setStatus({ kind: 'ok', message: `Selected icon ${icon}. Click "Save Branding" to apply.` });
  };

  const handleRemoveLogo = () => {
    setLogo(null);
    setUrlInput('');
    setIconInput('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setStatus({ kind: 'ok', message: 'Logo reset to default gradient mark. Click "Save Branding" to apply.' });
  };

  const handleResetDefaults = () => {
    resetBranding();
    setName(DEFAULT_BRAND_NAME);
    setLogo(null);
    setUrlInput('');
    setIconInput('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setStatus({ kind: 'ok', message: 'Branding reset to default Tradex values.' });
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

    // Otherwise apply locally
    updateBranding({ name: cleanName, logo });
    setStatus({ kind: 'ok', message: 'Platform branding saved successfully.' });
  };

  const hasPendingChanges =
    name.trim() !== branding.name ||
    logo !== branding.logo ||
    (isOwner && workspace.data !== undefined && name.trim() !== workspace.data.name);

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Settings</h2>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        Platform branding and workspace preferences.
      </p>

      {workspace.isLoading && <p className="muted">Loading…</p>}
      {workspace.isError && <div className="error">{(workspace.error as Error).message}</div>}

      <div className="branding-section">
        <section style={{ marginBottom: 24 }}>
          <h3 style={{ marginTop: 0 }}>Platform Branding</h3>
          <p className="muted" style={{ marginTop: -4, marginBottom: 14, fontSize: 12.5 }}>
            Change the name and logo/icon for your platform. This updates the sidebar,
            top marketing header, landing page, and footer.
          </p>

          {isOwner && !totpEnabled && (
            <div className="muted" style={{ fontSize: 12.5, marginBottom: 14 }}>
              Two-factor authentication is not enrolled. It is optional, but recommended before
              owner actions — <Link to="/app/security">enrol in Security &amp; 2FA</Link>.
            </div>
          )}

          <form onSubmit={submit}>
            {/* Platform / Workspace Name */}
            <div className="field" style={{ marginBottom: 16 }}>
              <label htmlFor="brand-name" style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                Platform Name
              </label>
              <input
                id="brand-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Platform name (e.g. Tradex)"
                aria-label="Platform name"
                maxLength={120}
                style={{ width: '100%', maxWidth: 360 }}
              />
              {!isOwner && workspace.data && (
                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                  (Workspace name: <strong>{workspace.data.name}</strong>)
                </div>
              )}
            </div>

            {/* Platform Logo / Icon */}
            <div className="field" style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', marginBottom: 6, fontWeight: 600 }}>
                Platform Logo or Icon
              </label>

              {/* Tabs for choose upload vs URL vs Icon */}
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

              {/* Upload file tab */}
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
                    <div style={{ fontWeight: 600, fontSize: 13.5 }}>Click to browse image</div>
                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                      PNG, SVG, JPG or WebP up to 2 MB (recommended square icon)
                    </div>
                  </div>
                </div>
              )}

              {/* Icon / Emoji tab */}
              {logoTab === 'icon' && (
                <div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      value={iconInput}
                      onChange={(e) => {
                        setIconInput(e.target.value);
                        setLogo(e.target.value.trim() ? e.target.value.trim() : null);
                      }}
                      placeholder="Type an emoji or symbol (e.g. ⚡, 🚀, 📈)"
                      maxLength={10}
                      style={{ width: 140, textAlign: 'center', fontSize: 16 }}
                    />
                    <span className="muted" style={{ fontSize: 12.5 }}>
                      or choose a quick preset below:
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

              {/* URL tab */}
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

              {/* Current logo indicator and remove button */}
              {logo && (
                <div className="branding-current-logo-preview">
                  <span className="muted" style={{ fontSize: 12 }}>Current custom logo:</span>
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
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                Live Branding Preview
              </div>
              <div className="branding-preview-container">
                {/* Dark preview (Sidebar) */}
                <div className="branding-preview-card dark">
                  <div className="branding-preview-label">Sidebar / Dark Theme</div>
                  <Brand customName={name || DEFAULT_BRAND_NAME} customLogo={logo} />
                </div>

                {/* Light preview (Marketing) */}
                <div className="branding-preview-card light">
                  <div className="branding-preview-label">Marketing / Light Theme</div>
                  <Brand customName={name || DEFAULT_BRAND_NAME} customLogo={logo} />
                </div>
              </div>
            </div>

            {/* 2FA code if step-up required */}
            {needsCode && (
              <div style={{ marginBottom: 14 }}>
                <label style={{ display: 'block', marginBottom: 4, fontSize: 12.5, fontWeight: 600 }}>
                  Enter 6-digit 2FA code to confirm server rename:
                </label>
                <input
                  inputMode="numeric"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="6-digit code"
                  aria-label="Verification code"
                  style={{ width: 140 }}
                />
              </div>
            )}

            {/* Actions */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16 }}>
              <button
                className="btn"
                type="submit"
                disabled={rename.isPending || name.trim() === '' || !hasPendingChanges}
              >
                {rename.isPending ? 'Saving…' : 'Save Branding'}
              </button>

              <button
                type="button"
                className="btn secondary"
                onClick={handleResetDefaults}
                title="Restore Tradex defaults"
              >
                Restore Defaults
              </button>
            </div>
          </form>

          {status !== null && (
            <div
              style={{
                marginTop: 14,
                fontSize: 13,
                color: status.kind === 'ok' ? 'var(--ok)' : 'var(--danger)',
              }}
            >
              {status.message}
            </div>
          )}
        </section>

        <section style={{ borderTop: '1px solid var(--line-subtle)', paddingTop: 20 }}>
          <h3 style={{ marginTop: 0 }}>Security &amp; Two-Factor</h3>
          <p className="muted" style={{ marginTop: -4, marginBottom: 8, fontSize: 12.5 }}>
            Two-factor authentication is optional. When enrolled, owner actions like changing limits
            and connecting exchange accounts require a fresh authentication code.
          </p>
          <Link to="/app/security" className="btn btn-sm secondary">Go to Security &amp; 2FA</Link>
        </section>
      </div>
    </div>
  );
}

