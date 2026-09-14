import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { confirmAccount, validateAccount } from '../api.ts';
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
function formatMinor(minor: string, scale: number, currency: string): string {
  const digits = minor.padStart(scale + 1, '0');
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const frac = scale === 0 ? '' : digits.slice(-scale).replace(/0+$/, '');
  const num = `${whole}${frac === '' ? '' : `.${frac}`}`;
  return currency === 'INR' ? `₹${num}` : `${num} ${currency}`;
}

/** The tradable step of a quote. Sizing bases are always stated at this scale. */
const quoteScaleOf = (currency: string): number => (currency === 'INR' ? 2 : 8);

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

  const validate = useMutation({
    mutationFn: (input: ValidateAccountInput) => validateAccount(input),
    onSuccess: (r) => { setReconcile(r.reconciliation); setStep('reconcile'); setFormError(null); },
    onError: (e) => setFormError(e instanceof Error ? e.message : 'the venue rejected the key'),
  });

  const confirm = useMutation({
    // Only the account id: the basis, funding currency and balances were all read
    // from the venue and stored during validate, so there is nothing to send back.
    mutationFn: () => confirmAccount(reconcile?.accountId ?? ''),
    onSuccess: () => { setStep('done'); },
    onError: (e) => setFormError(e instanceof Error ? e.message : 'could not activate the account'),
  });

  if (step === 'done') {
    return (
      <div className="panel">
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
      <div className="panel">
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
          <table style={{ marginTop: 8 }}>
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
        </details>

        {formError !== null && <div className="error">{formError}</div>}

        <div className="row" style={{ maxWidth: 420 }}>
          <button className="btn secondary" onClick={() => setStep('form')}>Back</button>
          <button className="btn" disabled={confirm.isPending} onClick={() => confirm.mutate()}>
            {confirm.isPending ? 'Connecting…' : 'Connect account'}
          </button>
        </div>
      </div>
    );
  }

  const canValidate = accountName.trim() !== '' && apiKey.length >= 8 && apiSecret.length >= 8;

  return (
    <div className="panel">
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

        {formError !== null && <div className="error">{formError}</div>}

        <div className="row" style={{ maxWidth: 460 }}>
          <Link to="/app/accounts" className="btn secondary">Cancel</Link>
          <button className="btn" type="submit" disabled={!canValidate || validate.isPending}>
            {validate.isPending ? 'Reading the account…' : 'Validate key'}
          </button>
        </div>
      </form>
    </div>
  );
}
