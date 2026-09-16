import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';

type Currency = 'INR' | 'USDT';

const INR_PRESETS = [
  { label: '₹1 Lakh', value: 100000 },
  { label: '₹5 Lakhs', value: 500000 },
  { label: '₹10 Lakhs', value: 1000000 },
  { label: '₹25 Lakhs', value: 2500000 },
  { label: '₹50 Lakhs', value: 5000000 },
];

const USDT_PRESETS = [
  { label: '$1,500', value: 1500 },
  { label: '$5,000', value: 5000 },
  { label: '$10,000', value: 10000 },
  { label: '$25,000', value: 25000 },
  { label: '$50,000', value: 50000 },
];

const RATE_PRESETS = [3.0, 3.5, 4.0, 4.5, 5.0];

export function ProfitCalculator() {
  const [currency, setCurrency] = useState<Currency>('INR');
  const [amount, setAmount] = useState<number>(1000000); // 10 Lakh default
  const [monthlyRate, setMonthlyRate] = useState<number>(4.0); // 4% default
  const [isCustomRate, setIsCustomRate] = useState<boolean>(false);

  const presets = currency === 'INR' ? INR_PRESETS : USDT_PRESETS;
  const symbol = currency === 'INR' ? '₹' : '$';

  const formatMoney = (val: number): string => {
    if (currency === 'INR') {
      return '₹' + Math.round(val).toLocaleString('en-IN');
    }
    return '$' + Math.round(val).toLocaleString('en-US');
  };

  const { monthlyProfit, yearlyProfit, totalYearlyValue, apyPercent } = useMemo(() => {
    const rateDecimal = (monthlyRate || 0) / 100;
    const mProfit = amount * rateDecimal;
    // Compounded monthly over 12 months: P * (1 + r)^12
    const totalCompounded = amount * Math.pow(1 + rateDecimal, 12);
    const yProfit = totalCompounded - amount;
    const apy = ((totalCompounded - amount) / (amount || 1)) * 100;

    return {
      monthlyProfit: mProfit,
      yearlyProfit: yProfit,
      totalYearlyValue: totalCompounded,
      apyPercent: apy,
    };
  }, [amount, monthlyRate]);

  return (
    <div className="calc-card">
      <div className="calc-header">
        <div className="calc-header-left">
          <span className="pill ok" style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Interactive ROI Calculator
          </span>
          <h3 style={{ margin: '8px 0 4px', fontSize: '22px', fontWeight: 700 }}>
            Estimate Your Crypto Wealth Growth
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: '13.5px' }}>
            Simulate monthly earnings based on our target 3%–5% systematic wealth management strategies.
          </p>
        </div>

        {/* Currency Switcher */}
        <div className="calc-currency-toggle">
          <button
            type="button"
            className={`calc-toggle-btn ${currency === 'INR' ? 'active' : ''}`}
            onClick={() => {
              setCurrency('INR');
              setAmount(1000000);
            }}
          >
            INR (₹)
          </button>
          <button
            type="button"
            className={`calc-toggle-btn ${currency === 'USDT' ? 'active' : ''}`}
            onClick={() => {
              setCurrency('USDT');
              setAmount(10000);
            }}
          >
            USDT ($)
          </button>
        </div>
      </div>

      <div className="calc-grid">
        {/* Controls Column */}
        <div className="calc-controls">
          <div className="field">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label htmlFor="calc-amount" style={{ marginBottom: 0 }}>Capital in Your Exchange Account</label>
              <span style={{ fontWeight: 700, color: 'var(--text)', fontSize: '15px' }}>
                {formatMoney(amount)}
              </span>
            </div>

            <div className="calc-input-row" style={{ marginTop: '8px' }}>
              <span className="calc-input-symbol">{symbol}</span>
              <input
                id="calc-amount"
                type="number"
                min={currency === 'INR' ? 50000 : 500}
                max={currency === 'INR' ? 100000000 : 1000000}
                step={currency === 'INR' ? 25000 : 500}
                value={amount}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (!Number.isNaN(val) && val >= 0) setAmount(val);
                }}
                className="calc-number-input"
              />
            </div>

            {/* Quick chips */}
            <div className="calc-chips">
              {presets.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  className={`calc-chip ${amount === p.value ? 'active' : ''}`}
                  onClick={() => setAmount(p.value)}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="field" style={{ marginTop: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <label htmlFor="calc-rate-input" style={{ marginBottom: 0 }}>Target Monthly Profit Rate</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <input
                  id="calc-rate-input"
                  type="number"
                  min="1.0"
                  max="25.0"
                  step="0.1"
                  value={monthlyRate}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!Number.isNaN(v) && v >= 0) {
                      setMonthlyRate(v);
                      setIsCustomRate(true);
                    }
                  }}
                  style={{
                    width: '64px',
                    padding: '3px 6px',
                    fontSize: '13.5px',
                    fontWeight: 700,
                    textAlign: 'right',
                    borderRadius: '6px',
                    border: '1px solid var(--line-strong)',
                    background: '#fff',
                  }}
                />
                <span style={{ fontWeight: 700, color: '#16a34a', fontSize: '13.5px' }}>% / mo</span>
              </div>
            </div>

            {/* Rate Presets & Custom toggle */}
            <div className="calc-chips" style={{ marginTop: '10px' }}>
              {RATE_PRESETS.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`calc-chip ${!isCustomRate && monthlyRate === r ? 'active' : ''}`}
                  onClick={() => {
                    setMonthlyRate(r);
                    setIsCustomRate(false);
                  }}
                >
                  {r.toFixed(1)}%
                </button>
              ))}
              <button
                type="button"
                className={`calc-chip ${isCustomRate ? 'active' : ''}`}
                onClick={() => setIsCustomRate(true)}
              >
                ✏️ Custom %
              </button>
            </div>

            <input
              id="calc-rate"
              type="range"
              min="1.0"
              max="10.0"
              step="0.1"
              value={monthlyRate}
              onChange={(e) => {
                setMonthlyRate(Number(e.target.value));
                setIsCustomRate(!RATE_PRESETS.includes(Number(e.target.value)));
              }}
              className="calc-range-slider"
              style={{ marginTop: '14px' }}
            />

            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--muted)', marginTop: '4px' }}>
              <span>3.0% (Conservative)</span>
              <span>4.0% (Target Baseline)</span>
              <span>5.0%+ (Growth Target)</span>
            </div>
          </div>

          <div className="calc-guarantee-notice">
            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
              <span style={{ fontSize: '18px' }}>🛡️</span>
              <div>
                <strong style={{ display: 'block', fontSize: '13px', color: '#16a34a' }}>
                  100% Principal Protection Guarantee
                </strong>
                <span style={{ fontSize: '12.5px', color: 'var(--muted)', lineHeight: '1.4', display: 'block', marginTop: '2px' }}>
                  Your initial capital of <strong>{formatMoney(amount)}</strong> stays in your personal CoinDCX wallet. Our team never has withdrawal permissions.
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Results Column */}
        <div className="calc-results">
          <div className="calc-result-box highlight">
            <span className="calc-result-label">Expected Monthly Profit</span>
            <div className="calc-result-value profit">
              +{formatMoney(monthlyProfit)}
              <span className="calc-result-sub"> / month</span>
            </div>
            <span className="calc-result-hint">Generated directly into your exchange balance</span>
          </div>

          <div className="calc-results-row">
            <div className="calc-result-box">
              <span className="calc-result-label">1-Year Compounded Return</span>
              <div className="calc-result-value" style={{ fontSize: '20px', color: 'var(--text)' }}>
                +{formatMoney(yearlyProfit)}
              </div>
              <span className="calc-result-sub" style={{ color: '#16a34a', fontWeight: 600 }}>
                {apyPercent.toFixed(1)}% Compounded APY
              </span>
            </div>

            <div className="calc-result-box">
              <span className="calc-result-label">Total Portfolio After 1 Year</span>
              <div className="calc-result-value" style={{ fontSize: '20px', color: 'var(--text)' }}>
                {formatMoney(totalYearlyValue)}
              </div>
              <span className="calc-result-sub">Principal + Compounded Gains</span>
            </div>
          </div>

          <div className="calc-cta-wrap">
            <Link to="/contact" className="btn btn-lg" style={{ width: '100%', textAlign: 'center', textDecoration: 'none' }}>
              Request Wealth Consultation for {formatMoney(amount)} →
            </Link>
            <p className="calc-disclaimer">
              * Calculations illustrate monthly compounded growth. Funds remain under your sole custody in your verified exchange account.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
