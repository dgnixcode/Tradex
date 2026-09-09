import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { confirmAccount, validateAccount } from '../api.ts';
import type { Reconciliation, ValidateAccountInput } from '../api.ts';

// Connect an exchange account (onboarding). Owner + a fresh second factor only,
// server-side — the riskiest action in the product. The key and secret leave this
// form only as a POST to /validate, where they are sealed immediately and never
// logged. Two deliberate steps: validate proves the key and shows the typed-vs-
// real capital (they often differ), and confirm records which figure the customer
// keeps as the percentage-sizing basis. Nothing is activated between the steps.

function minorToMajor(minor: string, currency: string): string {
  const scale = currency === 'INR' ? 2 : 8;
  const digits = minor.padStart(scale + 1, '0');
  const whole = digits.slice(0, -scale);
  const frac = digits.slice(-scale).replace(/0+$/, '');
  const num = `${whole}${frac === '' ? '' : `.${frac}`}`;
  return currency === 'INR' ? `₹${num}` : `${num} ${currency}`;
}

type Step = 'form' | 'reconcile' | 'done';

export function ConnectAccount() {
  const [step, setStep] = useState<Step>('form');

  // form state
  const [accountName, setAccountName] = useState('');
  const [capital, setCapital] = useState('');
  const [currency, setCurrency] = useState<'INR' | 'USDT'>('INR');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // reconcile state
  const [reconcile, setReconcile] = useState<Reconciliation | null>(null);
  const [adoptReal, setAdoptReal] = useState(false);

  const validate = useMutation({
    mutationFn: (input: ValidateAccountInput) => validateAccount(input),
    onSuccess: (r) => { setReconcile(r.reconciliation); setStep('reconcile'); setFormError(null); },
    onError: (e) => setFormError(e instanceof Error ? e.message : 'the venue rejected the key'),
  });

  const confirm = useMutation({
    mutationFn: () => confirmAccount({
      accountId: reconcile?.accountId ?? '',
      credentialId: reconcile?.credentialId ?? '',
      confirmedAgainstMinor: adoptReal ? (reconcile?.realFreeMinor ?? '') : (reconcile?.typedCapitalMinor ?? ''),
      adoptRealAsBasis: adoptReal,
      fundingCurrencies: reconcile?.fundingCurrencies ?? [],
      balances: reconcile?.balances ?? [],
    }),
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
    const typed = minorToMajor(reconcile.typedCapitalMinor, reconcile.allocatedCurrency);
    const real = minorToMajor(reconcile.realFreeMinor, reconcile.allocatedCurrency);
    return (
      <div className="panel">
        <h2>Reconcile {accountName}</h2>
        <p className="sub muted" style={{ marginTop: -8 }}>
          The key is valid. The balance CoinDCX reports rarely equals the capital you typed — choose which
          figure becomes the percentage-sizing basis.
        </p>

        {reconcile.diverges ? (
          <div className="spread-warning">
            The real balance differs from what you typed. Pick a basis below.
          </div>
        ) : (
          <p className="muted">Typed and real match — either basis is the same figure.</p>
        )}

        <label className="ack">
          <input type="radio" name="basis" checked={!adoptReal} onChange={() => setAdoptReal(false)} />
          <span>Keep what I typed: <strong>{typed}</strong></span>
        </label>
        <label className="ack">
          <input type="radio" name="basis" checked={adoptReal} onChange={() => setAdoptReal(true)} />
          <span>Adopt the real balance: <strong>{real}</strong></span>
        </label>

        <p className="muted">Key {reconcile.apiKeyLast4} · can fund with {reconcile.fundingCurrencies.join(' / ') || 'nothing yet'}</p>
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

  const canValidate = accountName.trim() !== '' && /^\d+$/.test(capital) && apiKey.length >= 8 && apiSecret.length >= 8;

  return (
    <div className="panel">
      <h2>Connect an exchange account</h2>
      <p className="sub muted" style={{ marginTop: -8 }}>
        Paste an API key from your exchange. It is sealed immediately — never stored or shown in plaintext — and
        this action needs the workspace owner with a fresh second factor.
      </p>

      <form
        onSubmit={(e) => { e.preventDefault(); if (canValidate) { setFormError(null); validate.mutate({ accountName, allocatedCapitalMinor: capital, allocatedCurrency: currency, apiKey, apiSecret }); } }}
      >
        <div className="row">
          <div className="field">
            <label htmlFor="name">Account name</label>
            <input id="name" value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="e.g. Savings" />
          </div>
          <div className="field">
            <label htmlFor="ccy">Funding currency</label>
            <select id="ccy" value={currency} onChange={(e) => setCurrency(e.target.value as 'INR' | 'USDT')}>
              <option value="INR">INR</option>
              <option value="USDT">USDT</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="capital">Allocated capital (minor units)</label>
          <input id="capital" inputMode="numeric" value={capital} onChange={(e) => setCapital(e.target.value)} placeholder="e.g. 10000000 for ₹1,00,000" />
        </div>
        <div className="field">
          <label htmlFor="apikey">API key</label>
          <input id="apikey" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="apisecret">API secret</label>
          <input id="apisecret" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} autoComplete="off" />
        </div>

        {formError !== null && <div className="error">{formError}</div>}

        <div className="row" style={{ maxWidth: 460 }}>
          <Link to="/app/accounts" className="btn secondary">Cancel</Link>
          <button className="btn" type="submit" disabled={!canValidate || validate.isPending}>
            {validate.isPending ? 'Checking key…' : 'Validate key'}
          </button>
        </div>
      </form>
    </div>
  );
}
