import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';

type Currency = 'INR' | 'USDT';

interface Preset {
  readonly label: string;
  readonly value: number;
}

const INR_PRESETS: readonly Preset[] = [
  { label: '₹1 Lakh', value: 100000 },
  { label: '₹5 Lakhs', value: 500000 },
  { label: '₹10 Lakhs', value: 1000000 },
  { label: '₹25 Lakhs', value: 2500000 },
  { label: '₹50 Lakhs', value: 5000000 },
  { label: '₹1 Crore', value: 10000000 },
];

const USDT_PRESETS: readonly Preset[] = [
  { label: '$1,500', value: 1500 },
  { label: '$5,000', value: 5000 },
  { label: '$10,000', value: 10000 },
  { label: '$25,000', value: 25000 },
  { label: '$50,000', value: 50000 },
  { label: '$100,000', value: 100000 },
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

  const formatDenom = (val: number): string => {
    if (currency === 'INR') {
      if (val >= 10000000) return `(₹${(val / 10000000).toFixed(val % 10000000 === 0 ? 0 : 2)} Crore)`;
      if (val >= 100000) return `(₹${(val / 100000).toFixed(val % 100000 === 0 ? 0 : 2)} Lakhs)`;
      return '';
    }
    if (val >= 1000000) return `($${(val / 1000000).toFixed(1)}M)`;
    if (val >= 1000) return `($${(val / 1000).toFixed(0)}k)`;
    return '';
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

  // Dynamic slider track fill percentage (range 1.0 to 12.0)
  const sliderFillPercent = Math.min(100, Math.max(0, ((monthlyRate - 1.0) / (12.0 - 1.0)) * 100));

  return (
    <div className="calc-card">
      <div className="calc-header">
        <div className="calc-header-left">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
            <span className="calc-badge">
              ⚡ Interactive ROI Simulator
            </span>
            <span className="calc-badge-guarantee">
              🛡️ 100% Principal Shield
            </span>
          </div>
          <h3 style={{ margin: '0 0 6px', fontSize: '24px', fontWeight: 800, color: 'var(--ink)' }}>
            Estimate Your Crypto Wealth Growth
          </h3>
          <p className="muted" style={{ margin: 0, fontSize: '14px', lineHeight: 1.5 }}>
            Simulate monthly compounding based on our systematic 3%–5% non-custodial strategies.
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
          <div className="calc-group">
            <div className="calc-group-head">
              <label htmlFor="calc-amount" className="calc-label">Capital in Your Exchange Account</label>
              <div className="calc-live-val">
                <span>{formatMoney(amount)}</span>
                {formatDenom(amount) && <span className="calc-denom">{formatDenom(amount)}</span>}
              </div>
            </div>

            <div className="calc-input-row">
              <span className="calc-input-symbol">{symbol}</span>
              <input
                id="calc-amount"
                type="number"
                min={currency === 'INR' ? 50000 : 500}
                max={currency === 'INR' ? 500000000 : 5000000}
                step={currency === 'INR' ? 25000 : 500}
                value={amount || ''}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  if (!Number.isNaN(val) && val >= 0) setAmount(val);
                }}
                className="calc-number-input"
                placeholder="Enter capital amount"
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

          <div className="calc-group" style={{ marginTop: '24px' }}>
            <div className="calc-group-head">
              <label htmlFor="calc-rate-input" className="calc-label">Target Monthly Return Rate</label>
              <div className="calc-rate-badge-wrap">
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
                      setIsCustomRate(!RATE_PRESETS.includes(v));
                    }
                  }}
                  className="calc-rate-number-box"
                />
                <span className="calc-rate-unit">% / month</span>
              </div>
            </div>

            {/* Rate Presets & Custom toggle */}
            <div className="calc-chips">
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
                  {r.toFixed(1)}% {r === 4.0 ? '★' : ''}
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

            <div className="calc-slider-wrap">
              <input
                id="calc-rate"
                type="range"
                min="1.0"
                max="12.0"
                step="0.1"
                value={monthlyRate > 12.0 ? 12.0 : monthlyRate}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setMonthlyRate(val);
                  setIsCustomRate(!RATE_PRESETS.includes(val));
                }}
                className="calc-range-slider"
                style={{
                  background: `linear-gradient(to right, #16a34a 0%, #16a34a ${sliderFillPercent}%, #e2e8f0 ${sliderFillPercent}%, #e2e8f0 100%)`,
                }}
              />
            </div>

            <div className="calc-slider-labels">
              <span>3.0% (Conservative)</span>
              <span>4.0% (Target Baseline)</span>
              <span>5.0%+ (Growth Target)</span>
            </div>
          </div>

          <div className="calc-guarantee-notice">
            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
              <div className="calc-shield-ico">🛡️</div>
              <div>
                <strong className="calc-shield-title">
                  100% Principal Protection Guarantee
                </strong>
                <p className="calc-shield-desc">
                  Your capital of <strong>{formatMoney(amount)}</strong> stays exclusively in your personal CoinDCX wallet. Withdrawals are permanently disabled at the exchange permission layer.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Results Column */}
        <div className="calc-results">
          <div className="calc-result-box highlight">
            <div className="calc-result-top-badge">ESTIMATED EARNINGS</div>
            <span className="calc-result-label">Expected Monthly Profit</span>
            <div className="calc-result-value profit">
              +{formatMoney(monthlyProfit)}
              <span className="calc-result-sub"> / month</span>
            </div>
            <div className="calc-result-hint-row">
              <span className="calc-hint-dot" />
              <span>Directly credited to your personal CoinDCX wallet</span>
            </div>
          </div>

          <div className="calc-results-row">
            <div className="calc-result-box">
              <span className="calc-result-label">1-Year Compounded Return</span>
              <div className="calc-result-value sm-val">
                +{formatMoney(yearlyProfit)}
              </div>
              <span className="calc-apy-badge">
                +{apyPercent.toFixed(1)}% Compounded APY
              </span>
            </div>

            <div className="calc-result-box">
              <span className="calc-result-label">Total Portfolio (1 Year)</span>
              <div className="calc-result-value sm-val">
                {formatMoney(totalYearlyValue)}
              </div>
              <span className="calc-result-note">
                Principal + Compounded Gains
              </span>
            </div>
          </div>

          <div className="calc-cta-wrap">
            <Link
              to={`/contact?capital=${amount}&currency=${currency}&rate=${monthlyRate}`}
              className="calc-primary-cta"
            >
              <span>Schedule Wealth Consultation for {formatMoney(amount)}</span>
              <span className="calc-cta-arrow">→</span>
            </Link>
            <p className="calc-disclaimer">
              * Compounded projections illustrate monthly reinvestment with zero withdrawal deductions. Client capital remains in client's verified exchange account under 100% self-custody.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

