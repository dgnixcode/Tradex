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
    q: 'Can anyone withdraw or transfer money from my CoinDCX account?',
    a: 'No, never. Management access is strictly trade-only, with withdrawal permissions permanently disabled. It is technically and cryptographically impossible for anyone to move or withdraw funds from your account. You remain the sole custodian of your assets with full 24/7 access.',
  },
  {
    q: 'How does Aza WealthKare generate consistent 3%–5% monthly profits?',
    a: 'Our quantitative desk executes systematic, disciplined trading across low-risk market spreads, delta-hedging, and trend-following strategies. By employing rigorous 1:2+ risk-reward ratios and automated trailing stop-losses, we capture steady monthly returns while capping market exposure.',
  },
  {
    q: 'How does the 100% Capital Safety Guarantee work?',
    a: 'We operate under a strict capital preservation mandate. Every managed position is bracketed by automated downside stop-losses and strict portfolio drawdown caps. Our proprietary risk containment architecture prevents catastrophic drops and preserves your initial principal.',
  },
  {
    q: 'Can I withdraw my funds or profits whenever I want?',
    a: 'Yes, 100% at any time. Because your money never leaves your personal CoinDCX wallet, you have complete liquidity. You can withdraw your profits to your linked bank account or stop management at any second directly from your exchange app.',
  },
  {
    q: 'Which exchanges and currencies are supported?',
    a: 'We natively support CoinDCX for both Indian Rupee (INR) and Tether (USDT) futures and spot portfolios. Support for Binance and global exchange venues is also provided for bespoke client allocations.',
  },
  {
    q: 'How do I get started with Aza WealthKare?',
    a: 'Simply request a consultation via our contact form. Our senior wealth advisor will reach out to understand your goals, guide you through securing your personal exchange account with trade-only delegation, and activate your portfolio management.',
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
              🛡️ Non-Custodial Wealth Management · 100% Capital Protection
            </span>
          </div>

          <h1 className="wm-hero-title">
            Grow Your Crypto Wealth. <br />
            <span className="wm-grad">Keep 100% Custody</span> in Your Own Account.
          </h1>

          <p className="wm-hero-sub">
            We professionally manage institutional trading directly inside your personal <strong>CoinDCX</strong> exchange account.
            Targeting <strong>3% to 5% monthly profit</strong> with an ironclad <strong>100% capital protection guarantee</strong>.
            Zero third-party deposits — your money never leaves your hands.
          </p>

          <div className="wm-hero-ctas">
            <Link to="/contact" className="btn btn-lg wm-btn-primary">
              Book a Consultation →
            </Link>
            <a href="#calculator" className="btn btn-lg secondary wm-btn-secondary">
              Calculate Your Growth ↓
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
              <span className="wm-trust-lbl">Principal Guarantee</span>
            </div>
          </div>
        </div>

        {/* Hero Visual: Client Portfolio Card */}
        <div className="wm-hero-visual">
          <div className="wm-portfolio-card">
            <div className="wm-card-top">
              <div className="wm-card-account">
                <span className="wm-dot active" />
                <div>
                  <div style={{ fontWeight: 700, fontSize: '14px', color: 'var(--text)' }}>
                    CoinDCX Managed Portfolio
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--muted)' }}>
                    Client Self-Custody · Real-Time Execution
                  </div>
                </div>
              </div>
              <span className="pill ok" style={{ fontSize: '11px', padding: '3px 8px' }}>
                PROTECTED
              </span>
            </div>

            <div className="wm-card-balance-block">
              <span className="wm-card-subhead">Monthly Performance Target</span>
              <div className="wm-card-balance" style={{ color: '#16a34a' }}>+3.0% – +5.0%</div>
              <div className="wm-card-pnl">
                <span className="wm-pnl-green">Steady Compounded Growth</span>
                <span className="wm-pnl-label">deposited to your exchange</span>
              </div>
            </div>

            <div className="wm-card-metrics">
              <div className="wm-card-metric-box">
                <span className="m-label">Capital Guarantee</span>
                <span className="m-val" style={{ color: '#16a34a' }}>100% Shielded</span>
              </div>
              <div className="wm-card-metric-box">
                <span className="m-label">Custody Location</span>
                <span className="m-val">Your Personal Account</span>
              </div>
            </div>

            {/* Systematic positions snapshot */}
            <div className="wm-card-trades">
              <div className="wm-card-trades-head">
                <span>Systematic Strategies Active</span>
                <span>CoinDCX Venue</span>
              </div>
              <div className="wm-trade-row">
                <span className="t-pair">BTC-USDT Market Spread</span>
                <span className="t-side buy">ACTIVE</span>
                <span className="t-pnl">+1.84%</span>
              </div>
              <div className="wm-trade-row">
                <span className="t-pair">ETH-INR Trend Discipline</span>
                <span className="t-side buy">ACTIVE</span>
                <span className="t-pnl">+1.15%</span>
              </div>
              <div className="wm-trade-row">
                <span className="t-pair">SOL-USDT Momentum</span>
                <span className="t-side sell">HEDGED</span>
                <span className="t-pnl">+1.24%</span>
              </div>
            </div>

            <div className="wm-card-footer">
              <span>🔒 Zero Third-Party Deposit · 24/7 Liquidity in Your Bank</span>
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
            Traditional funds ask you to send them your money. We built a system where your capital stays safely in your own hands.
          </p>
        </div>

        <div className="wm-pillars-grid">
          <div className="wm-pillar-card" id="guarantee">
            <div className="wm-pillar-icon">🛡️</div>
            <h3>100% Capital Safety Guarantee</h3>
            <p>
              Your initial principal is protected with strict mathematical risk management. Every trade has algorithmic stop-losses, trailing circuit breakers, and reserve-backed risk absorption.
            </p>
            <ul className="wm-pillar-points">
              <li>Algorithmic downside locks on all legs</li>
              <li>Maximum portfolio drawdown limit (&lt; 2.5%)</li>
              <li>Automatic risk de-escalation in high volatility</li>
            </ul>
          </div>

          <div className="wm-pillar-card">
            <div className="wm-pillar-icon">🏦</div>
            <h3>100% Non-Custodial Control</h3>
            <p>
              Your money stays in your personal <strong>CoinDCX</strong> account. We manage trading with strictly withdrawal-disabled access. You can stop or withdraw your money at any second.
            </p>
            <ul className="wm-pillar-points">
              <li>Zero transfer of crypto or INR to third parties</li>
              <li>You hold the exchange credentials and 2FA</li>
              <li>Instant 24/7 liquidity directly to your bank</li>
            </ul>
          </div>

          <div className="wm-pillar-card">
            <div className="wm-pillar-icon">📈</div>
            <h3>Consistent 3%–5% Monthly Profits</h3>
            <p>
              Our quantitative desk uses systematic delta-neutral and trend-following strategies. Instead of high-risk gambling, we compound consistent 36%–60% annualized gains for our clients.
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
          <span className="kicker">Seamless Client Onboarding</span>
          <h2>How It Works: Zero Transfer, Total Transparency</h2>
          <p>Get started with private wealth management in 4 straightforward steps.</p>
        </div>

        <div className="wm-steps-grid">
          <div className="wm-step-card">
            <div className="wm-step-num">01</div>
            <h3>Keep Capital in Your Exchange</h3>
            <p>
              Maintain your INR or USDT balance inside your personal verified <strong>CoinDCX</strong> account. You never transfer capital to us.
            </p>
          </div>

          <div className="wm-step-card">
            <div className="wm-step-num">02</div>
            <h3>Book Private Consultation</h3>
            <p>
              Connect with our senior wealth advisory team to structure your risk preferences, capital allocation, and target return parameters.
            </p>
          </div>

          <div className="wm-step-card">
            <div className="wm-step-num">03</div>
            <h3>Enable Secure Delegation</h3>
            <p>
              We guide you through granting trade-only delegation on your exchange with withdrawal permissions permanently disabled.
            </p>
          </div>

          <div className="wm-step-card">
            <div className="wm-step-num">04</div>
            <h3>Enjoy 3%–5% Monthly Profits</h3>
            <p>
              Our institutional engine executes systematic trades. Watch your compounding profits accumulate live in your CoinDCX mobile app.
            </p>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- COMPARISON TABLE */}
      <section className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">Transparent Comparison</span>
          <h2>Why High-Net-Worth Clients Choose {branding.name}</h2>
          <p>See how our non-custodial wealth management model compares with traditional investment alternatives.</p>
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
                <td className="bad-text">✗ You must deposit crypto to them</td>
                <td>✓ Bank / Asset Management Co.</td>
              </tr>
              <tr>
                <td><strong>Withdrawal Risk</strong></td>
                <td className="highlight ok-text">✓ Impossible (Withdrawal disabled)</td>
                <td className="bad-text">✗ High (They hold your coins)</td>
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
                <td>Penalty on early exit / T+2 days</td>
              </tr>
              <tr>
                <td><strong>Transparency</strong></td>
                <td className="highlight ok-text">✓ Live trades visible on your exchange</td>
                <td>Monthly static PDF report</td>
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
            Disciplined quantitative risk management produces steady compounding results without reckless gambles.
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
          <h2>Built for Total Peace of Mind</h2>
          <p>Real money demands uncompromising engineering. Here is how your capital security is ensured.</p>
        </div>

        <div className="features">
          <div className="feature">
            <div className="feature-icon">🔒</div>
            <h3>Zero Withdrawal Authority</h3>
            <p>
              Management access is granted with <strong>withdrawals permanently blocked</strong>. Even our own operators cannot initiate an outgoing transfer from your exchange.
            </p>
          </div>

          <div className="feature">
            <div className="feature-icon">🛡️</div>
            <h3>12 Automated Safety Gates</h3>
            <p>
              Before any order executes, 12 safety checks run: live spread validation, slippage buffers, balance sufficiency, and exchange market liquidity.
            </p>
          </div>

          <div className="feature">
            <div className="feature-icon">⚡</div>
            <h3>Automated Bracket Stop-Loss</h3>
            <p>
              Every single position is immediately bracketed with a stop-loss and trailing take-profit order to lock in gains and prevent runaway drawdown.
            </p>
          </div>

          <div className="feature">
            <div className="feature-icon">🎯</div>
            <h3>Exact-Decimal Precision</h3>
            <p>
              All sizing calculations are executed using exact-decimal arithmetic. Never floating-point approximations. Not a single paisa is unaccounted for.
            </p>
          </div>

          <div className="feature">
            <div className="feature-icon">📱</div>
            <h3>Live Verification on Your Phone</h3>
            <p>
              Because trades execute directly on your CoinDCX account, you can open your CoinDCX app anytime to view every position, order, and rupee live.
            </p>
          </div>

          <div className="feature">
            <div className="feature-icon">🔑</div>
            <h3>Isolated Execution Boundary</h3>
            <p>
              Credentials are encrypted at rest using AES-256-GCM envelope encryption and never leave our secure, dedicated trading environment.
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
            Join discerning investors earning 3% to 5% monthly profits without ever transferring custody of their funds.
          </p>
          <div style={{ display: 'flex', gap: '12px', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/contact" className="btn btn-lg wm-btn-primary" style={{ minWidth: '240px', textDecoration: 'none' }}>
              Schedule a Consultation →
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
