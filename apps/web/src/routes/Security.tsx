import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { beginTotp, confirmTotp } from '../api.ts';
import { useAuth } from '../auth.tsx';
import type { BeginTotpResult } from '../api.ts';

// Own-account security (real 2FA). A signed-in user secures their own login by
// enrolling an authenticator app. The secret is shown EXACTLY ONCE (the server
// stores only the KMS-sealed envelope) and 2FA flips on only after a code from
// that authenticator verifies — so enrolment cannot lock you out with a mistyped
// scan. Once on, every login needs a code, and the owner+reauth actions
// (resume, limits, large trades) that were hard-403 become reachable.

export function Security() {
  const { state } = useAuth();
  // Seed from the session; a fresh session read keeps it truthful after a reload.
  const already = state.status === 'authenticated' ? state.session.totpEnabled : false;
  const [enabled, setEnabled] = useState(already);
  const [pending, setPending] = useState<BeginTotpResult | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const begin = useMutation({
    mutationFn: () => beginTotp(),
    onSuccess: (r) => { setPending(r); setCode(''); setError(null); },
    onError: (e) => setError(e instanceof Error ? e.message : 'could not start enrolment'),
  });
  const confirm = useMutation({
    mutationFn: (c: string) => confirmTotp(c),
    onSuccess: () => { setEnabled(true); setPending(null); setError(null); },
    onError: (e) => setError(e instanceof Error ? e.message : 'that code was not accepted'),
  });

  return (
    <div className="panel">
      <h2>Security</h2>
      <p className="sub muted" style={{ marginTop: -8 }}>
        Two-factor authentication for your own Tradex login — never the exchange&rsquo;s. It is what
        unlocks the owner actions (resume trading, changing limits) that need a fresh second factor.
      </p>

      {enabled ? (
        <div className="spread-warning" style={{ borderColor: 'var(--ok)', color: 'var(--ok)', borderStyle: 'solid' }}>
          2FA is <strong>on</strong> for this account. Every login will now ask for a code from your authenticator.
        </div>
      ) : pending === null ? (
        <div>
          <button className="btn" onClick={() => begin.mutate()} disabled={begin.isPending}>
            {begin.isPending ? 'Preparing…' : 'Turn on 2FA'}
          </button>
          {error !== null && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
        </div>
      ) : (
        <div>
          <p className="muted">Scan this QR or enter the secret in your authenticator app:</p>
          <div className="totp-box mono" aria-label="otpauth URI">
            {pending.otpauthUri}
          </div>
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
              aria-label="Verification code"
            />
            <button className="btn" type="submit" disabled={confirm.isPending || code.trim() === ''}>
              {confirm.isPending ? 'Verifying…' : 'Enable 2FA'}
            </button>
          </form>
          {error !== null && <div className="error" style={{ marginTop: 10 }}>{error}</div>}
        </div>
      )}
    </div>
  );
}
