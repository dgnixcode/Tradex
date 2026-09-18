import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useMutation } from '@tanstack/react-query';
import { beginTotp, confirmTotp, disableTotp } from '../api.ts';
import { useAuth } from '../auth.tsx';
import type { BeginTotpResult } from '../api.ts';

// Own-account security (real 2FA). A signed-in user secures their own login by
// enrolling an authenticator app. The secret is shown EXACTLY ONCE (the server
// stores only the KMS-sealed envelope) and 2FA flips on only after a code from
// that authenticator verifies.
//
// Users can also:
// 1. Disable 2FA: Proving identity with their current 6-digit code.
// 2. Change / Re-link Authenticator: Proving identity with their current code,
//    scanning a fresh QR, and confirming with the new device.

export function Security() {
  const { state, refreshSession } = useAuth();
  // Seed from the session; a fresh session read keeps it truthful after a reload.
  const already = state.status === 'authenticated' ? state.session.totpEnabled : false;
  const [enabled, setEnabled] = useState(already);
  const [mode, setMode] = useState<'idle' | 'disabling' | 'changing'>('idle');
  const [currentCode, setCurrentCode] = useState('');
  const [pending, setPending] = useState<BeginTotpResult | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const clearMessages = () => {
    setError(null);
    setSuccessMsg(null);
  };

  const begin = useMutation({
    mutationFn: (curCode?: string) => beginTotp(curCode),
    onSuccess: (r) => {
      setPending(r);
      setCode('');
      clearMessages();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'could not start enrolment'),
  });

  const confirm = useMutation({
    mutationFn: (c: string) => confirmTotp(c),
    onSuccess: async () => {
      await refreshSession();
      setEnabled(true);
      setPending(null);
      setMode('idle');
      setCurrentCode('');
      setCode('');
      clearMessages();
      setSuccessMsg('Two-factor authentication is active.');
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'that code was not accepted'),
  });

  const disable = useMutation({
    mutationFn: (c: string) => disableTotp(c),
    onSuccess: async () => {
      await refreshSession();
      setEnabled(false);
      setPending(null);
      setMode('idle');
      setCurrentCode('');
      setCode('');
      clearMessages();
      setSuccessMsg('Two-factor authentication has been turned off.');
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'could not disable 2FA'),
  });

  const cancelAction = () => {
    setMode('idle');
    setPending(null);
    setCurrentCode('');
    setCode('');
    clearMessages();
  };

  return (
    <div className="panel">
      <h2>Security</h2>
      <p className="sub muted" style={{ marginTop: -8, marginBottom: 20 }}>
        Two-factor authentication for your own Tradex login — never the exchange&rsquo;s. It is what
        unlocks the owner actions (resume trading, changing limits) that need a fresh second factor.
      </p>

      {successMsg !== null && (
        <div style={{
          background: 'rgba(16, 185, 129, 0.1)',
          border: '1px solid rgba(16, 185, 129, 0.3)',
          color: '#10b981',
          padding: '10px 14px',
          borderRadius: 'var(--radius, 8px)',
          marginBottom: 16,
          fontSize: 13,
          fontWeight: 600,
        }}>
          ✓ {successMsg}
        </div>
      )}

      {error !== null && (
        <div className="error" style={{ marginBottom: 16 }}>
          {error}
        </div>
      )}

      {/* STATE 1: 2FA is currently ENABLED */}
      {enabled ? (
        <div>
          {/* Active 2FA Summary Card */}
          <div style={{
            background: 'rgba(16, 185, 129, 0.05)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: 10,
            padding: '16px 20px',
            marginBottom: 20,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              <span style={{ fontSize: 18 }}>🛡️</span>
              <h3 style={{ margin: 0, color: 'var(--ok, #10b981)', fontSize: 16 }}>
                Two-Factor Authentication is Active
              </h3>
            </div>
            <p className="muted" style={{ margin: 0, fontSize: 13, lineHeight: 1.5 }}>
              Your login and owner actions are secured with TOTP. Every login will ask for a 6-digit code from your authenticator app.
            </p>
          </div>

          {/* Sub-flow: Idle mode (Action buttons) */}
          {mode === 'idle' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn secondary"
                onClick={() => { clearMessages(); setMode('changing'); }}
              >
                🔄 Change Authenticator App
              </button>
              <button
                type="button"
                className="btn danger-outline"
                onClick={() => { clearMessages(); setMode('disabling'); }}
              >
                ⛔ Turn Off 2FA
              </button>
            </div>
          )}

          {/* Sub-flow: Turn Off 2FA */}
          {mode === 'disabling' && (
            <div style={{
              background: 'rgba(239, 68, 68, 0.04)',
              border: '1px solid rgba(239, 68, 68, 0.25)',
              borderRadius: 10,
              padding: 16,
              maxWidth: 520,
            }}>
              <h4 style={{ margin: '0 0 8px 0', color: 'var(--danger, #ef4444)' }}>
                Turn Off Two-Factor Authentication
              </h4>
              <p className="muted" style={{ fontSize: 13, margin: '0 0 14px 0', lineHeight: 1.4 }}>
                Disabling 2FA lowers your login security. To verify your identity, enter the current 6-digit code from your authenticator app:
              </p>
              <form
                className="add-member-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (currentCode.trim() !== '') disable.mutate(currentCode.trim());
                }}
              >
                <input
                  inputMode="numeric"
                  value={currentCode}
                  onChange={(e) => setCurrentCode(e.target.value)}
                  placeholder="Current 6-digit code"
                  maxLength={6}
                  autoFocus
                  aria-label="Current 2FA verification code"
                />
                <button
                  className="btn danger"
                  type="submit"
                  disabled={disable.isPending || currentCode.trim().length < 6}
                >
                  {disable.isPending ? 'Verifying…' : 'Yes, Turn Off 2FA'}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={cancelAction}
                  disabled={disable.isPending}
                >
                  Cancel
                </button>
              </form>
            </div>
          )}

          {/* Sub-flow: Change Authenticator App */}
          {mode === 'changing' && (
            <div style={{ maxWidth: 520 }}>
              {pending === null ? (
                <div style={{
                  background: 'rgba(59, 130, 246, 0.05)',
                  border: '1px solid rgba(59, 130, 246, 0.25)',
                  borderRadius: 10,
                  padding: 16,
                }}>
                  <h4 style={{ margin: '0 0 8px 0', color: 'var(--text)' }}>
                    Verify Identity to Change Authenticator
                  </h4>
                  <p className="muted" style={{ fontSize: 13, margin: '0 0 14px 0', lineHeight: 1.4 }}>
                    To protect your account, please enter the current 6-digit code from your existing authenticator app:
                  </p>
                  <form
                    className="add-member-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (currentCode.trim() !== '') begin.mutate(currentCode.trim());
                    }}
                  >
                    <input
                      inputMode="numeric"
                      value={currentCode}
                      onChange={(e) => setCurrentCode(e.target.value)}
                      placeholder="Current 6-digit code"
                      maxLength={6}
                      autoFocus
                      aria-label="Current 2FA verification code"
                    />
                    <button
                      className="btn"
                      type="submit"
                      disabled={begin.isPending || currentCode.trim().length < 6}
                    >
                      {begin.isPending ? 'Verifying…' : 'Continue to New QR'}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      onClick={cancelAction}
                      disabled={begin.isPending}
                    >
                      Cancel
                    </button>
                  </form>
                </div>
              ) : (
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <h4 style={{ margin: 0 }}>Scan With Your New Authenticator</h4>
                    <button type="button" className="btn ghost btn-sm" onClick={cancelAction}>
                      Cancel
                    </button>
                  </div>
                  <p className="muted" style={{ fontSize: 13, margin: '0 0 10px 0' }}>
                    Open your new authenticator app (Google Authenticator, 1Password, Authy, Apple Keychain) and scan this new QR code:
                  </p>
                  <div
                    style={{
                      margin: '10px 0', padding: 10, display: 'inline-block',
                      background: '#fff', border: '1px solid var(--border, rgba(0,0,0,0.12))', borderRadius: 10,
                    }}
                  >
                    <QRCodeSVG
                      value={pending.otpauthUri}
                      size={210}
                      level="M"
                      marginSize={1}
                      title="Tradex two-factor re-enrolment QR"
                      aria-label="Scan with your new authenticator app"
                    />
                  </div>
                  <p className="muted" style={{ margin: '8px 0 6px', fontSize: 13 }}>
                    Or type this secret key manually:
                  </p>
                  <div className="totp-box mono" aria-label="secret">
                    {pending.secret}
                  </div>
                  <p className="muted" style={{ margin: '12px 0 6px', fontSize: 13 }}>
                    Then enter the 6-digit code from your <strong>NEW</strong> app to confirm and activate:
                  </p>
                  <form
                    className="add-member-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (code.trim() !== '') confirm.mutate(code.trim());
                    }}
                  >
                    <input
                      inputMode="numeric"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="Code from NEW app"
                      maxLength={6}
                      aria-label="Verification code from new app"
                    />
                    <button className="btn" type="submit" disabled={confirm.isPending || code.trim().length < 6}>
                      {confirm.isPending ? 'Verifying…' : 'Activate New App'}
                    </button>
                  </form>
                </div>
              )}
            </div>
          )}
        </div>
      ) : pending === null ? (
        /* STATE 2: 2FA is currently DISABLED */
        <div>
          <p className="muted" style={{ marginBottom: 16 }}>
            Two-factor authentication is currently <strong>off</strong>. Turn it on to require a one-time code on every login and protect your account.
          </p>
          <button className="btn" onClick={() => { clearMessages(); begin.mutate(undefined); }} disabled={begin.isPending}>
            {begin.isPending ? 'Preparing…' : 'Turn on 2FA'}
          </button>
        </div>
      ) : (
        /* STATE 3: Enrolling 2FA for the first time */
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h4 style={{ margin: 0 }}>Set Up Two-Factor Authentication</h4>
            <button type="button" className="btn ghost btn-sm" onClick={cancelAction}>
              Cancel
            </button>
          </div>
          <p className="muted">Open your authenticator app (Google Authenticator, 1Password, Authy…) and scan the code:</p>
          <div
            style={{
              margin: '10px 0', padding: 10, display: 'inline-block',
              background: '#fff', border: '1px solid var(--border, rgba(0,0,0,0.12))', borderRadius: 10,
            }}
          >
            <QRCodeSVG
              value={pending.otpauthUri}
              size={210}
              level="M"
              marginSize={1}
              title="Tradex two-factor enrolment QR"
              aria-label="Scan with your authenticator app"
            />
          </div>
          <p className="muted" style={{ margin: '8px 0 6px' }}>
            Or, if your app can&rsquo;t scan, type this secret instead:
          </p>
          <div className="totp-box mono" aria-label="secret">
            {pending.secret}
          </div>
          <p className="muted" style={{ margin: '12px 0 6px' }}>Then enter the 6-digit code it shows, to confirm and enable:</p>
          <form
            className="add-member-form"
            onSubmit={(e) => { e.preventDefault(); if (code.trim() !== '') confirm.mutate(code.trim()); }}
          >
            <input
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="6-digit code"
              maxLength={6}
              aria-label="Verification code"
            />
            <button className="btn" type="submit" disabled={confirm.isPending || code.trim() === ''}>
              {confirm.isPending ? 'Verifying…' : 'Enable 2FA'}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
