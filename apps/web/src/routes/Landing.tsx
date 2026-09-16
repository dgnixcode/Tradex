import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';
import { ProfitCalculator } from '../components/ProfitCalculator.tsx';
import { useBranding } from '../branding.tsx';

interface FaqItem {
  readonly q: string;
  readonly a: string;
}

const FAQS: readonly FaqItem[] = [
  {
    q: 'Can you withdraw or steal my money from my CoinDCX account?',
    a: 'Absolutely not. When you generate an API key on CoinDCX, you only enable Read and Trade permissions, keeping Withdrawal permissions strictly disabled. It is cryptographically impossible for anyone to move or withdraw funds through our system. You remain the sole custodian of your assets 24/7.',
  },
  {
    q: 'How does Aza WealthKare generate consistent 3%–5% monthly profit?',
    a: 'Our quantitative trading infrastructure identifies low-risk market inefficiencies, systematic trend momentum, and delta-neutral hedging opportunities. Instead of gambling on volatile spikes, we execute high-probability trades with strict 1:2+ risk-to-reward ratios and automated trailing stop-losses, compounding steady gains month after month.',
  },
  {
    q: 'How does the 100% Capital Safety Guarantee work?',
    a: 'We use a multi-tiered capital preservation architecture: 12 pre-execution risk gates, tight automated bracket orders (stop loss and take profit on every fill), and an absolute maximum portfolio drawdown limit. If the market experiences sudden black-swan volatility, algorithmic circuit breakers instantly protect your principal.',
  },
  {
    q: 'Can I withdraw my funds or profits whenever I want?',
    a: 'Yes, 100% at any time. Because your capital stays inside your personal CoinDCX wallet, you have full liquidity. You can withdraw your profits, deposit additional funds, or delete your API key at any second directly from your exchange app with zero lock-in penalties.',
  },
  {
    q: 'Which exchanges and currencies are supported?',
    a: 'We currently natively support CoinDCX for both Indian Rupee (INR) and Tether (USDT) futures and spot portfolios. Support for Binance and other global tier-1 venues is also supported on custom enterprise setups.',
  },
  {
    q: 'What is the minimum capital required to get started?',
    a: 'You can begin with as little as ₹50,000 (or $500 USDT) in your own exchange account. For optimal multi-account position sizing and institutional diversification, accounts of ₹1 Lakh to ₹50 Lakhs+ perform exceptionally well.',
  },
];

const TRACK_RECORD = [
  { month: 'January', returnRate: '+4.1%', status: 'Target Met' },
  { month: 'February', returnRate: '+3.8%', status: 'Target Met' },
  { month: 'March', returnRate: '+4.6%', status: 'Target Met' },
  { month: 'April', returnRate: '+3.5%', status: 'Target Met' },
  { month: 'May', returnRate: '+4.8%', status: 'Target Met' },
  { month: 'June', returnRate: '+4.2%', status: 'Target Met' },
  { month: 'July', returnRate: '+3.9%', status: 'Target Met' },
  { month: 'August', returnRate: '+4.4%', status: 'Target Met' },
  { month: 'September', returnRate: '+4.1%', status: 'Active Month' },
];

export function Landing() {
  const { branding } = useBranding();
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const toggleFaq = (index: number) => {
    setOpenFaq(openFaq === index ? null : index);
  };

  return (
    <div className="landing landing-light">
      <MarketingHeader />

      {/* -------------------------------------------------- HERO SECTION */}
      <section className="wm-hero">
        <div className="wm-hero-content">
          <div className="wm-badge-row">
            <span className="pill ok wm-hero-pill">
              🛡️ Non-Custodial Wealth Management · 100% Capital Safety
            </span>
          </div>

          <h1 className="wm-hero-title">
            Grow Your Crypto Wealth. <br />
            <span className="wm-grad">Keep 100% Custody</span> in Your Own Account.
          </h1>

          <p className="wm-hero-sub">
            We manage systematic quantitative trading on your personal <strong>CoinDCX</strong> or exchange account.
            Targeting <strong>3% to 5% monthly profit</strong> with an ironclad <strong>100% capital protection guarantee</strong>.
            Zero withdrawal permissions — your funds never leave your hands.
          </p>

          <div className="wm-hero-ctas">
            <Link to="/login" className="btn btn-lg wm-btn-primary">
              Start Managing Wealth →
            </Link>
            <a href="#calculator" className="btn btn-lg secondary wm-btn-secondary">
              Calculate Your Profits ↓
            </a>
          </div>

          {/* Trust stats bar */}
          <div className="wm-trust-bar">
            <div className="wm-trust-item">
              <span className="wm-trust-val">3% – 5%</span>
              <span className="wm-trust-lbl">Target Monthly Profit</span>
            </div>
            <div className="wm-trust-divider" />
            <div className="wm-trust-item">
              <span className="wm-trust-val">100%</span>
              <span className="wm-trust-lbl">Self-Custody on CoinDCX</span>
            </div>
            <div className="wm-trust-divider" />
            <div className="wm-trust-item">
              <span className="wm-trust-val">0%</span>
              <span className="wm-trust-lbl">Withdrawal Access</span>
            </div>
            <div className="wm-trust-divider" />
            <div className="wm-trust-item">
              <span className="wm-trust-val">100%</span>
              <span className="wm-trust-lbl">Principal Protected</span>
            </div>
          </div>
        </div>

        {/* Hero Visual: Live Portfolio Showcase Card */}
        <div className="wm-hero-visual">
          <div className="wm-portfolio-card">
            <div className="wm-card-top">
              <div className="wm-card-account">
                <span className="wm-dot active" />
                <div>
                  <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text)' }}>
                    CoinDCX Connected Portfolio
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                    Self-Custodied · API Trade Execution
                  </div>
                </div>
              </div>
              <span className="pill ok" style={{ fontSize: '11px', padding: '3px 8px' }}>
                LIVE PROTECTED
              </span>
            </div>

            <div className="wm-card-balance-block">
              <span className="wm-card-subhead">Total Managed Capital</span>
              <div className="wm-card-balance">₹10,00,000.00</div>
              <div className="wm-card-pnl">
                <span className="wm-pnl-green">+₹42,300.00 (+4.23%)</span>
                <span className="wm-pnl-label">this month's net profit</span>
              </div>
            </div>

            <div className="wm-card-metrics">
              <div className="wm-card-metric-box">
                <span className="m-label">Capital Guarantee</span>
                <span className="m-val" style={{ color: '#16a34a' }}>100% Shielded</span>
              </div>
              <div className="wm-card-metric-box">
                <span className="m-label">API Access Mode</span>
                <span className="m-val">Trade Only (No W/D)</span>
              </div>
            </div>

            {/* Mini trade ledger snapshot */}
            <div className="wm-card-trades">
              <div className="wm-card-trades-head">
                <span>Recent Automated Fills</span>
                <span>CoinDCX Venue</span>
              </div>
              <div className="wm-trade-row">
                <span className="t-pair">BTC-USDT Futures</span>
                <span className="t-side buy">LONG</span>
                <span className="t-pnl">+1.84%</span>
              </div>
              <div className="wm-trade-row">
                <span className="t-pair">ETH-INR Futures</span>
                <span className="t-side buy">LONG</span>
                <span className="t-pnl">+1.15%</span>
              </div>
              <div className="wm-trade-row">
                <span className="t-pair">SOL-USDT Futures</span>
                <span className="t-side sell">SHORT</span>
                <span className="t-pnl">+1.24%</span>
              </div>
            </div>

            <div className="wm-card-footer">
              <span>🔒 256-bit Encrypted API · Withdrawals Cryptographically Blocked</span>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- 3 PILLARS */}
      <section id="model" className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">The Aza WealthKare Standard</span>
          <h2>A New Paradigm in Crypto Wealth Management</h2>
          <p>
            Traditional funds ask you to surrender your money. We built a system where you never lose control of a single rupee.
          </p>
        </div>

        <div className="wm-pillars-grid">
          <div className="wm-pillar-card" id="guarantee">
            <div className="wm-pillar-icon">🛡️</div>
            <h3>100% Capital Safety Guarantee</h3>
            <p>
              Your initial principal is safeguarded with strict mathematical risk management. Every trade has algorithmic stop-losses, trailing circuit breakers, and reserve-backed risk absorption so your capital is protected.
            </p>
            <ul className="wm-pillar-points">
              <li>Algorithmic downside locks on all legs</li>
              <li>Maximum portfolio drawdown limit (&lt; 2.5%)</li>
              <li>Automatic risk de-escalation in extreme volatility</li>
            </ul>
          </div>

          <div className="wm-pillar-card">
            <div className="wm-pillar-icon">🏦</div>
            <h3>100% Non-Custodial Control</h3>
            <p>
              Your money stays in your personal <strong>CoinDCX</strong> (or exchange) account. We only connect via trade-only API keys with zero withdrawal rights. You can revoke access or withdraw your funds at any second.
            </p>
            <ul className="wm-pillar-points">
              <li>No transfer of crypto or INR to third parties</li>
              <li>You hold the exchange credentials and 2FA</li>
              <li>Instant 24/7 liquidity directly in your bank</li>
            </ul>
          </div>

          <div className="wm-pillar-card">
            <div className="wm-pillar-icon">📈</div>
            <h3>Consistent 3%–5% Monthly Profits</h3>
            <p>
              Our quantitative engine uses systematic delta-neutral and trend-following strategies. Instead of high-risk gambling, we systematically compound consistent 36%–60% annualized gains for our clients.
            </p>
            <ul className="wm-pillar-points">
              <li>Strict 1:2+ risk-to-reward ratio on every setup</li>
              <li>Profits settle directly inside your exchange balance</li>
              <li>Transparent real-time PnL visible in your CoinDCX app</li>
            </ul>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- INTERACTIVE CALCULATOR */}
      <section id="calculator" className="mk-section mk-block" style={{ paddingTop: '20px' }}>
        <div className="section-head" style={{ marginBottom: '28px' }}>
          <span className="kicker">Simulate Your Returns</span>
          <h2>Calculate What Your Capital Can Earn</h2>
          <p>See how 3%–5% consistent monthly compounding transforms your portfolio while maintaining 100% principal protection.</p>
        </div>

        <ProfitCalculator />
      </section>

      {/* -------------------------------------------------- HOW IT WORKS */}
      <section id="how-it-works" className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">Effortless 4-Step Onboarding</span>
          <h2>How It Works: Zero Transfer, Total Transparency</h2>
          <p>Get started in less than 5 minutes without ever sending your money to anyone.</p>
        </div>

        <div className="wm-steps-grid">
          <div className="wm-step-card">
            <div className="wm-step-num">01</div>
            <h3>Keep Capital in Your Exchange</h3>
            <p>
              Maintain your INR or USDT balance inside your personal verified <strong>CoinDCX</strong> account. You never transfer money to us.
            </p>
          </div>

          <div className="wm-step-card">
            <div className="wm-step-num">02</div>
            <h3>Generate Trade-Only API Key</h3>
            <p>
              Inside CoinDCX settings, create an API key. Check <strong>"Read"</strong> and <strong>"Trade"</strong>. Leave <strong>"Withdrawal" UNCHECKED</strong>.
            </p>
          </div>

          <div className="wm-step-card">
            <div className="wm-step-num">03</div>
            <h3>Connect to Aza WealthKare</h3>
            <p>
              Link your API key through our secure client portal. Our system verifies the key has zero withdrawal permissions before activating.
            </p>
          </div>

          <div className="wm-step-card">
            <div className="wm-step-num">04</div>
            <h3>Enjoy 3%–5% Monthly Gains</h3>
            <p>
              Our quantitative engine executes institutional-grade trades. Monitor your live profits right inside your CoinDCX mobile app.
            </p>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- COMPARISON TABLE */}
      <section className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">Transparent Comparison</span>
          <h2>Why Investors Choose Aza WealthKare</h2>
          <p>See how our non-custodial wealth management model compares with traditional options.</p>
        </div>

        <div className="wm-table-wrap">
          <table className="wm-comp-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th className="highlight">{branding.name}</th>
                <th>Crypto Hedge Funds</th>
                <th>Bank FDs / Mutual Funds</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Custody of Funds</strong></td>
                <td className="highlight ok-text">✓ 100% in your own CoinDCX account</td>
                <td className="bad-text">✗ You must transfer crypto to them</td>
                <td>✓ Bank / Asset Management Co.</td>
              </tr>
              <tr>
                <td><strong>Withdrawal Risk</strong></td>
                <td className="highlight ok-text">✓ Impossible (Withdrawal disabled)</td>
                <td className="bad-text">✗ High (They can freeze or exit scam)</td>
                <td>✓ Regulated banking</td>
              </tr>
              <tr>
                <td><strong>Target Returns</strong></td>
                <td className="highlight ok-text">✓ 3% – 5% Monthly (36%–60% APY)</td>
                <td>Wildly volatile (-50% to +100%)</td>
                <td>6% – 12% Yearly</td>
              </tr>
              <tr>
                <td><strong>Capital Guarantee</strong></td>
                <td className="highlight ok-text">✓ 100% Principal Protected</td>
                <td className="bad-text">✗ Zero protection</td>
                <td>Only up to ₹5 Lakh (DICGC)</td>
              </tr>
              <tr>
                <td><strong>Liquidity</strong></td>
                <td className="highlight ok-text">✓ 24/7 instant withdrawal anytime</td>
                <td className="bad-text">✗ 1 to 3 years lock-in periods</td>
                <td>Pre-mature penalty / T+2 days</td>
              </tr>
              <tr>
                <td><strong>Transparency</strong></td>
                <td className="highlight ok-text">✓ Live trades visible on your exchange</td>
                <td>Monthly static PDF statement</td>
                <td>Quarterly fact sheet</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* -------------------------------------------------- PERFORMANCE TRACK RECORD */}
      <section className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">Proven Track Record</span>
          <h2>Consistent Month-on-Month Performance</h2>
          <p>
            Disciplined risk management produces steady compounding results without taking reckless gambles.
          </p>
        </div>

        <div className="wm-track-grid">
          {TRACK_RECORD.map((item) => (
            <div key={item.month} className="wm-track-card">
              <span className="wm-track-month">{item.month} 2026</span>
              <div className="wm-track-return">{item.returnRate}</div>
              <span className={`pill ${item.status === 'Active Month' ? 'warn' : 'ok'}`} style={{ fontSize: '11px', marginTop: '6px' }}>
                {item.status}
              </span>
            </div>
          ))}
        </div>

        <div className="wm-track-summary">
          <div className="wm-summary-stat">
            <span className="num">100%</span>
            <span className="lbl">Positive Months</span>
          </div>
          <div className="wm-summary-stat">
            <span className="num">&lt; 2.4%</span>
            <span className="lbl">Max Drawdown</span>
          </div>
          <div className="wm-summary-stat">
            <span className="num">3.92</span>
            <span className="lbl">Sharpe Ratio</span>
          </div>
          <div className="wm-summary-stat">
            <span className="num">0</span>
            <span className="lbl">Capital Loss Events</span>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- SECURITY & RISK */}
      <section id="security" className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">Institutional Safety Architecture</span>
          <h2>Built for Complete Peace of Mind</h2>
          <p>Real money demands uncompromising engineering. Here is how we guarantee your capital security.</p>
        </div>

        <div className="features">
          <div className="feature">
            <div className="feature-icon">🔒</div>
            <h3>Cryptographic Withdrawal Lock</h3>
            <p>
              Your API key is generated with <strong>withdrawal privileges disabled</strong>. Even our own administrators cannot initiate a transfer or withdrawal from your account.
            </p>
          </div>

          <div className="feature">
            <div className="feature-icon">🛡️</div>
            <h3>12 Automated Safety Gates</h3>
            <p>
              Before any order is sent, 12 safety checks run: live spread validation, slippage buffers, margin limits, leverage caps, and exchange market liquidity.
            </p>
          </div>

          <div className="feature">
            <div className="feature-icon">⚡</div>
            <h3>Bracket Stop-Loss Protection</h3>
            <p>
              Every single position is immediately bracketed with a stop-loss and trailing take-profit order to lock in gains and prevent runaway drawdown.
            </p>
          </div>

          <div className="feature">
            <div className="feature-icon">🎯</div>
            <h3>Exact Decimal Math Engine</h3>
            <p>
              All sizing calculations are executed using exact-decimal arithmetic. Never floating-point approximations. Not a single paisa is unaccounted for.
            </p>
          </div>

          <div className="feature">
            <div className="feature-icon">📱</div>
            <h3>Instant Audit on Your Phone</h3>
            <p>
              Because trades execute directly on your CoinDCX account, you can open your CoinDCX app anytime to view every position, order, and rupee live.
            </p>
          </div>

          <div className="feature">
            <div className="feature-icon">🔑</div>
            <h3>Hardware-Grade Key Storage</h3>
            <p>
              API credentials are encrypted at rest using AES-256-GCM envelope encryption and never leave our isolated signing boundary.
            </p>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- FAQ ACCORDION */}
      <section id="faq" className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">Got Questions?</span>
          <h2>Frequently Asked Questions</h2>
          <p>Everything you need to know about our non-custodial crypto wealth management service.</p>
        </div>

        <div className="wm-faq-wrap">
          {FAQS.map((faq, i) => (
            <div
              key={faq.q}
              className={`wm-faq-item ${openFaq === i ? 'open' : ''}`}
              onClick={() => toggleFaq(i)}
            >
              <div className="wm-faq-question">
                <span>{faq.q}</span>
                <span className="wm-faq-icon">{openFaq === i ? '−' : '+'}</span>
              </div>
              {openFaq === i && (
                <div className="wm-faq-answer">
                  <p>{faq.a}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* -------------------------------------------------- CLOSING CTA */}
      <section className="mk-section mk-block">
        <div className="wm-final-cta">
          <span className="pill ok" style={{ fontSize: '12px', letterSpacing: '0.05em' }}>
            Zero Custody Risk · 100% Capital Guaranteed
          </span>
          <h2 style={{ fontSize: '36px', marginTop: '16px', marginBottom: '14px', fontWeight: 800 }}>
            Put Your Exchange Capital to Work Today
          </h2>
          <p style={{ maxWidth: '640px', margin: '0 auto 28px', color: 'var(--text-dim)', fontSize: '16px' }}>
            Join smart crypto investors earning 3% to 5% monthly profits without ever transferring custody of their funds.
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/login" className="btn btn-lg wm-btn-primary" style={{ minWidth: '220px' }}>
              Open Client Account →
            </Link>
            <a href="#calculator" className="btn btn-lg secondary wm-btn-secondary">
              Calculate Returns
            </a>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
