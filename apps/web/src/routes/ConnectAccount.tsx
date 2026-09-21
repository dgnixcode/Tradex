import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { confirmAccount, validateAccount, stepUp, ApiError } from '../api.ts';
import type { Reconciliation, ValidateAccountInput } from '../api.ts';

// Connect an exchange account (onboarding). Owner + a fresh second factor only,
// server-side — the riskiest action in the product. The key and secret leave this
// form only as a POST to /validate, where they are sealed immediately and never
// logged.
//
// Nothing about the account's money is typed here. The funding currency and the
// allocated capital are both READ FROM THE EXCHANGE: the currency from what the
// account can actually fund with, the capital from the free balance it holds at
// that moment. The customer cannot mistype a figure they never see, and the
// reconcile step is a confirmation, not a choice.

/**
 * Minor units -> a readable amount. The scale is a PARAMETER, never derived from
 * the currency code: a balance row carries the wallet scale the venue reported,
 * which is finer than the currency's tradable step (a real INR balance came back
 * at scale 18). Deriving the scale from the code renders such a row as
 * ₹50,84,37,69,24,990 instead of ₹0.005.
 */
function formatMinor(minor: string, scale: number, currency: string, maxDecimals = 2): string {
  if (!minor) return currency === 'INR' ? '₹0.00' : `0.00 ${currency}`;
  const neg = minor.startsWith('-');
  const digits = neg ? minor.slice(1) : minor;

  if (scale > maxDecimals) {
    const diff = scale - maxDecimals;
    const divisor = 10n ** BigInt(diff);
    const half = divisor / 2n;
    const rounded = (BigInt(digits) + half) / divisor;
    const padded = String(rounded).padStart(maxDecimals + 1, '0');
    const whole = padded.slice(0, -maxDecimals);
    const frac = padded.slice(-maxDecimals);
    const num = `${whole}.${frac}`;
    const sign = neg ? '−' : '';
    return currency === 'INR' ? `${sign}₹${num}` : `${sign}${num} ${currency}`;
  }

  const padded = digits.padStart(scale + 1, '0');
  const whole = scale === 0 ? padded : padded.slice(0, -scale);
  const frac = scale === 0 ? '' : padded.slice(-scale);
  const num = scale === 0 ? whole : `${whole}.${frac}`;
  const sign = neg ? '−' : '';
  return currency === 'INR' ? `${sign}₹${num}` : `${sign}${num} ${currency}`;
}

/** The tradable step of a quote. Sizing bases are always stated at this scale. */
const quoteScaleOf = (currency: string): number => (currency === 'INR' ? 2 : 8);

function isReauthError(e: unknown): boolean {
  if (e instanceof ApiError && e.code === 'reauth_required') return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /second factor|reauth|two-factor/i.test(msg);
}

type Step = 'form' | 'reconcile' | 'done';

export function ConnectAccount() {
  const [step, setStep] = useState<Step>('form');

  // form state
  const [accountName, setAccountName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // reconcile state — every figure below came from the exchange
  const [reconcile, setReconcile] = useState<Reconciliation | null>(null);

  // 2FA step-up state
  const [needsCode, setNeedsCode] = useState(false);
  const [totpCode, setTotpCode] = useState('');
  const [steppingUp, setSteppingUp] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<'validate' | 'confirm' | null>(null);

  const validate = useMutation({
    mutationFn: (input: ValidateAccountInput) => validateAccount(input),
    onSuccess: (r) => {
      setReconcile(r.reconciliation);
      setStep('reconcile');
      setFormError(null);
      setNeedsCode(false);
      setStepUpError(null);
    },
    onError: (e) => {
      if (isReauthError(e)) {
        setNeedsCode(true);
        setPendingAction('validate');
        setStepUpError(null);
        setFormError(null);
      } else {
        setFormError(e instanceof Error ? e.message : 'the venue rejected the key');
      }
    },
  });

  const confirm = useMutation({
    // Only the account id: the basis, funding currency and balances were all read
    // from the venue and stored during validate, so there is nothing to send back.
    mutationFn: () => confirmAccount(reconcile?.accountId ?? ''),
    onSuccess: () => {
      setStep('done');
      setNeedsCode(false);
      setStepUpError(null);
    },
    onError: (e) => {
      if (isReauthError(e)) {
        setNeedsCode(true);
        setPendingAction('confirm');
        setStepUpError(null);
        setFormError(null);
      } else {
        setFormError(e instanceof Error ? e.message : 'could not activate the account');
      }
    },
  });

  const handleStepUp = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    const cleanCode = totpCode.trim();
    if (!cleanCode) return;
    setSteppingUp(true);
    setStepUpError(null);
    try {
      await stepUp(cleanCode);
      setNeedsCode(false);
      setTotpCode('');
      setStepUpError(null);
      setFormError(null);
      if (pendingAction === 'confirm') {
        confirm.mutate();
      } else {
        validate.mutate({ accountName, apiKey, apiSecret });
      }
    } catch (err) {
      setStepUpError(err instanceof Error ? err.message : 'Invalid 2FA code. Please check your authenticator app.');
    } finally {
      setSteppingUp(false);
    }
  };

  const renderStepUpPrompt = () => {
    if (!needsCode) return null;
    return (
      <div style={{
        margin: '16px 0',
        padding: '16px 20px',
        background: 'rgba(59, 130, 246, 0.08)',
        border: '1px solid rgba(59, 130, 246, 0.3)',
        borderRadius: 8,
      }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text, #e2e8f0)', marginBottom: 6 }}>
          Security Verification Required
        </div>
        <p className="muted" style={{ fontSize: 13, margin: '0 0 12px 0', lineHeight: 1.4 }}>
          Connecting exchange credentials requires a fresh second factor. Enter your 6-digit Authenticator code to continue without losing your entered keys.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            placeholder="6-digit code"
            value={totpCode}
            onChange={(e) => setTotpCode(e.target.value.replace(/\s+/g, ''))}
            aria-label="2FA code"
            style={{
              width: 160,
              padding: '8px 12px',
              fontSize: 15,
              letterSpacing: '2px',
              fontFamily: 'monospace',
              borderRadius: 6,
              background: '#171f33',
              color: '#ffffff',
              border: '1px solid #28354d',
            }}
            autoFocus
          />
          <button
            type="button"
            className="btn"
            disabled={steppingUp || totpCode.trim().length < 6}
            onClick={(e) => void handleStepUp(e)}
          >
            {steppingUp ? 'Verifying…' : 'Verify & Continue'}
          </button>
          <button
            type="button"
            className="btn secondary"
            onClick={() => { setNeedsCode(false); setTotpCode(''); }}
          >
            Dismiss
          </button>
        </div>
        {stepUpError !== null && (
          <div className="error" style={{ marginTop: 10, fontSize: 13 }}>{stepUpError}</div>
        )}
      </div>
    );
  };

  if (step === 'done') {
    return (
      <div className="panel full-width-page">
        <h2>Account connected</h2>
        <div className="spread-warning" style={{ borderColor: 'var(--ok)', color: 'var(--ok)', borderStyle: 'solid' }}>
          <strong>{accountName}</strong> is now active and ready to group and trade.
        </div>
        <Link to="/app/accounts" className="btn">Back to accounts</Link>
      </div>
    );
  }

  if (step === 'reconcile' && reconcile !== null) {
    const real = formatMinor(reconcile.realFreeMinor, quoteScaleOf(reconcile.allocatedCurrency), reconcile.allocatedCurrency);
    return (
      <div className="panel full-width-page">
        <h2>Review {accountName}</h2>
        <p className="sub muted" style={{ marginTop: -8 }}>
          The key works. Everything below was read from the exchange just now — nothing here was
          typed, so there is nothing to reconcile. Connecting adopts these as this account&apos;s
          sizing basis.
        </p>

        <table style={{ maxWidth: 560 }}>
          <tbody>
            <tr>
              <td className="muted">Funding currency</td>
              <td className="mono"><strong>{reconcile.allocatedCurrency}</strong></td>
            </tr>
            <tr>
              <td className="muted">Allocated capital</td>
              <td className="mono"><strong>{real}</strong></td>
            </tr>
            <tr>
              <td className="muted">Key</td>
              <td className="mono">…{reconcile.apiKeyLast4}</td>
            </tr>
          </tbody>
        </table>

        {reconcile.fundingCurrencies.length > 1 && (
          <p className="muted" style={{ fontSize: 12.5 }}>
            This account can fund with {reconcile.fundingCurrencies.join(' and ')}. Orders are sized
            against the {reconcile.allocatedCurrency} balance.
          </p>
        )}

        <details style={{ marginBottom: 16 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>
            Balances read from the exchange ({reconcile.balances.length})
          </summary>
          <div className="table-scroll-container" style={{ marginTop: 8 }}>
            <table>
              <thead>
                <tr><th>Currency</th><th>Free</th><th>Locked</th></tr>
              </thead>
              <tbody>
                {reconcile.balances.map((b) => (
                  <tr key={b.currency}>
                    <td>{b.currency}</td>
                    <td className="mono">{formatMinor(b.freeMinor, b.scale, b.currency)}</td>
                    <td className="mono">{formatMinor(b.lockedMinor, b.scale, b.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        {renderStepUpPrompt()}
        {formError !== null && <div className="error">{formError}</div>}

        <div className="row" style={{ maxWidth: 420 }}>
          <button className="btn secondary" onClick={() => setStep('form')}>Back</button>
          <button className="btn" disabled={confirm.isPending || steppingUp} onClick={() => confirm.mutate()}>
            {confirm.isPending ? 'Connecting…' : 'Connect account'}
          </button>
        </div>
      </div>
    );
  }

  const canValidate = accountName.trim() !== '' && apiKey.length >= 8 && apiSecret.length >= 8;

  return (
    <div className="panel full-width-page">
      <h2>Connect an exchange account</h2>
      <p className="sub muted" style={{ marginTop: -8 }}>
        Paste an API key from your exchange. It is sealed immediately — never stored or shown in plaintext — and
        this action needs the workspace owner with a fresh second factor.
      </p>

      <form
        onSubmit={(e) => { e.preventDefault(); if (canValidate) { setFormError(null); validate.mutate({ accountName, apiKey, apiSecret }); } }}
      >
        <div className="field">
          <label htmlFor="name">Account name</label>
          <input id="name" value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="e.g. Savings" />
        </div>
        <div className="field">
          <label htmlFor="apikey">API key</label>
          <input id="apikey" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="apisecret">API secret</label>
          <input id="apisecret" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} autoComplete="off" />
          <div className="hint">
            The funding currency and the allocated capital are read from the exchange at the next
            step — you never enter them, so they cannot drift from the real account.
          </div>
        </div>

        {renderStepUpPrompt()}
        {formError !== null && <div className="error">{formError}</div>}

        <div className="row" style={{ maxWidth: 460 }}>
          <Link to="/app/accounts" className="btn secondary">Cancel</Link>
          <button className="btn" type="submit" disabled={!canValidate || validate.isPending || steppingUp}>
            {validate.isPending ? 'Reading the account…' : 'Validate key'}
          </button>
        </div>
      </form>
    </div>
  );
}
