import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';
import { ProfitCalculator } from '../components/ProfitCalculator.tsx';

interface FaqItem {
  readonly q: string;
  readonly a: string;
}

const FAQS: readonly FaqItem[] = [
  {
    q: 'Can anyone withdraw or transfer money from my trading account?',
    a: 'No, never. Management access granted to Aza WealthKare is strictly trade-only, with withdrawal permissions permanently disabled at the exchange API layer. It is technically and cryptographically impossible for Aza WealthKare or anyone else to move or withdraw funds from your account. You remain the sole custodian of your assets with full 24/7 access.',
  },
  {
    q: 'How does Aza WealthKare generate consistent 3%–5% monthly profits?',
    a: 'The Aza WealthKare quantitative desk executes systematic, disciplined trading across low-risk market spreads, delta-hedging, and trend-following strategies. By employing rigorous 1:2+ risk-reward ratios and automated trailing stop-losses, Aza WealthKare captures steady monthly returns while capping market exposure.',
  },
  {
    q: 'How does the Aza WealthKare 100% Capital Safety Guarantee work?',
    a: 'Aza WealthKare operates under an ironclad capital preservation mandate. Every managed position is bracketed by automated downside stop-losses and strict portfolio drawdown caps (< 2.5%). Our proprietary risk containment architecture prevents catastrophic drops and preserves your initial principal.',
  },
  {
    q: 'Can I withdraw my funds or profits whenever I want?',
    a: 'Yes, 100% at any time. Because your money never leaves your personal trading account, you have complete liquidity. You can withdraw your profits directly to your linked bank account or pause Aza WealthKare management at any second directly from your exchange app.',
  },
  {
    q: 'Which exchanges and currencies does Aza WealthKare support?',
    a: 'Aza WealthKare supports leading registered exchange trading accounts for both Indian Rupee (INR) and Tether (USDT) futures and spot portfolios, including CoinDCX, Binance, and other tier-1 exchange venues.',
  },
  {
    q: 'How do I get started with Aza WealthKare?',
    a: 'Simply request a consultation via our contact form. An Aza WealthKare senior wealth advisor will reach out to understand your goals, guide you through securing your personal exchange account with trade-only delegation, and activate your portfolio management.',
  },
];

export function Landing() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);

  const toggleFaq = (index: number) => {
    setOpenFaq(openFaq === index ? null : index);
  };

  return (
    <div className="landing landing-dark">
      <MarketingHeader />

      {/* -------------------------------------------------- HERO SECTION */}
      <div className="wm-hero-wrap">
        <section className="wm-hero">
          <div className="wm-hero-content">
            <div className="wm-badge-row">
              <span className="pill ok wm-hero-pill">
                <span className="wm-hero-live-dot" />
                <span>Non-Custodial Wealth Management</span>
                <span className="wm-hero-pill-sep">·</span>
                <span className="wm-hero-pill-bold">100% Capital Protection</span>
              </span>
            </div>

            <h1 className="wm-hero-title">
              Grow Your Wealth. <br />
              <span className="wm-grad">Keep 100% Custody</span> in <br className="hide-mobile" />
              Your Own Trading Account.
            </h1>

            <p className="wm-hero-sub">
              <strong>Aza WealthKare</strong> deploys institutional algorithmic execution directly inside your personal <strong>trading account</strong>.
              Targeting <strong>3% to 5% monthly profit</strong> with an ironclad <strong>100% capital protection guarantee</strong>.
              Zero third-party deposits — your capital never leaves your possession.
            </p>

            <div className="wm-hero-ctas">
              <Link to="/contact" className="btn btn-lg wm-btn-primary">
                <span>Book a Consultation</span>
                <span className="btn-arrow">→</span>
              </Link>
              <a href="#calculator" className="btn btn-lg secondary wm-btn-secondary">
                <span>Calculate Your Growth</span>
                <span className="btn-arrow">↓</span>
              </a>
            </div>

            {/* Trust stats bar: 4 cleanly proportioned columns, no awkward line drop */}
            <div className="wm-trust-bar">
              <div className="wm-trust-item">
                <span className="wm-trust-val highlight">3% – 5%</span>
                <span className="wm-trust-lbl">Target Monthly Profit</span>
              </div>
              <div className="wm-trust-item">
                <span className="wm-trust-val">100%</span>
                <span className="wm-trust-lbl">Self-Custody In Account</span>
              </div>
              <div className="wm-trust-item">
                <span className="wm-trust-val highlight-danger">0%</span>
                <span className="wm-trust-lbl">Withdrawal Access</span>
              </div>
              <div className="wm-trust-item">
                <span className="wm-trust-val highlight-blue">100%</span>
                <span className="wm-trust-lbl">Principal Guarantee</span>
              </div>
            </div>
          </div>

          {/* Hero Visual: Cinematic Crypto Bull & Real-Time Telemetry Terminal */}
          <div className="wm-hero-visual">
            <div className="wm-hero-media-wrap">
              <img
                src="/images/crypto_bull_hero.jpg"
                alt="Aza WealthKare Institutional Bull and Trading Command"
                className="wm-hero-img"
                loading="eager"
              />
              <div className="wm-hero-overlay-card">
                <div className="wm-hero-overlay-head">
                  <span className="wm-hero-badge-live">
                    <span className="wm-hero-live-dot" />
                    Aza WealthKare Execution Desk
                  </span>
                  <span className="wm-hero-venue-tag">
                    Institutional Venue
                  </span>
                </div>

                <div className="wm-hero-stats-strip">
                  <div className="wm-hero-stat-box">
                    <span className="wm-hero-stat-val green">+3% – +5%</span>
                    <span className="wm-hero-stat-lbl">Monthly Target</span>
                  </div>
                  <div className="wm-hero-stat-box">
                    <span className="wm-hero-stat-val">100%</span>
                    <span className="wm-hero-stat-lbl">Capital Shield</span>
                  </div>
                  <div className="wm-hero-stat-box">
                    <span className="wm-hero-stat-val blue">Zero</span>
                    <span className="wm-hero-stat-lbl">Custody Risk</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* -------------------------------------------------- 3 PILLARS */}
      <section id="model" className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">The Aza WealthKare Standard</span>
          <h2>A New Paradigm in Crypto Wealth Management by Aza WealthKare</h2>
          <p>
            Traditional funds ask you to send them your money. At Aza WealthKare, we built a non-custodial system where your capital stays safely in your own hands.
          </p>
        </div>

        <div className="wm-pillars-grid">
          <div className="wm-pillar-card" id="guarantee">
            <div className="wm-pillar-icon">🛡️</div>
            <h3>Aza WealthKare 100% Capital Safety Guarantee</h3>
            <p>
              Your initial principal is protected with Aza WealthKare&rsquo;s strict mathematical risk management. Every trade has algorithmic stop-losses, trailing circuit breakers, and reserve-backed risk absorption.
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
              Your money stays in your personal <strong>trading account</strong>. Aza WealthKare manages trading with strictly withdrawal-disabled access. You can stop or withdraw your money at any second.
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
              The Aza WealthKare quantitative desk uses systematic delta-neutral and trend-following strategies. Instead of high-risk gambling, we compound consistent 36%–60% annualized gains for our clients.
            </p>
            <ul className="wm-pillar-points">
              <li>Strict 1:2+ risk-to-reward ratio on every setup</li>
              <li>Profits settle directly inside your exchange balance</li>
              <li>Transparent real-time PnL visible in your exchange app</li>
            </ul>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- INTERACTIVE CALCULATOR */}
      <section id="calculator" className="mk-section mk-block" style={{ paddingTop: '20px' }}>
        <div className="section-head" style={{ marginBottom: '28px' }}>
          <span className="kicker">Aza WealthKare Yield Simulator</span>
          <h2>Calculate What Your Capital Can Earn with Aza WealthKare</h2>
          <p>See how Aza WealthKare&rsquo;s consistent 3%–5% monthly compounding transforms your portfolio while maintaining 100% principal protection.</p>
        </div>

        <ProfitCalculator />
      </section>

      {/* -------------------------------------------------- HOW IT WORKS */}
      <section id="how-it-works" className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">Seamless Client Onboarding</span>
          <h2>How Aza WealthKare Works: Zero Transfer, Total Transparency</h2>
          <p>Get started with private wealth management by Aza WealthKare in 4 straightforward steps.</p>
        </div>

        <div className="wm-steps-grid">
          <div className="wm-step-card">
            <div className="wm-step-num">01</div>
            <h3>Keep Capital in Your Trading Account</h3>
            <p>
              Maintain your INR or USDT balance inside your personal verified <strong>trading account</strong>. You never transfer capital to Aza WealthKare.
            </p>
          </div>

          <div className="wm-step-card">
            <div className="wm-step-num">02</div>
            <h3>Book Private Wealth Consultation</h3>
            <p>
              Connect with an Aza WealthKare senior wealth advisory team to structure your risk preferences, capital allocation, and target return parameters.
            </p>
          </div>

          <div className="wm-step-card">
            <div className="wm-step-num">03</div>
            <h3>Enable Secure Trade-Only Delegation</h3>
            <p>
              We guide you through granting trade-only delegation to Aza WealthKare on your exchange with withdrawal permissions permanently disabled.
            </p>
          </div>

          <div className="wm-step-card">
            <div className="wm-step-num">04</div>
            <h3>Enjoy 3%–5% Monthly Profits</h3>
            <p>
              The Aza WealthKare algorithmic engine executes systematic trades. Watch your compounding profits accumulate live in your exchange mobile app.
            </p>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- COMPARISON TABLE */}
      <section className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">Transparent Comparison</span>
          <h2>Why High-Net-Worth Clients Choose Aza WealthKare</h2>
          <p>See how the Aza WealthKare non-custodial wealth management model compares with traditional investment alternatives.</p>
        </div>

        <div className="wm-table-wrap">
          <table className="wm-comp-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th className="highlight">Aza WealthKare Desk</th>
                <th>Crypto Hedge Funds</th>
                <th>Bank FDs / Mutual Funds</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Custody of Funds</strong></td>
                <td className="highlight ok-text">✓ 100% in your own trading account</td>
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

      {/* -------------------------------------------------- RISK MANAGEMENT & CAPITAL PROTECTION FRAMEWORK */}
      <div className="wm-vault-section-wrap">
        <div style={{ maxWidth: '1240px', margin: '0 auto' }}>
          <div className="section-head">
            <span className="kicker">Aza WealthKare Capital Protection Framework</span>
            <h2>How Aza WealthKare Protects 100% of Your Capital Across Market Cycles</h2>
            <p>
              Disciplined quantitative risk management engineered by Aza WealthKare to preserve initial principal during market drawdowns while steadily extracting 3%–5% monthly alpha.
            </p>
          </div>

          <div className="wm-pillars-grid">
            <div className="wm-pillar-card">
              <span className="wm-pillar-icon">🛡️</span>
              <h3>Delta-Neutral Market Shield</h3>
              <p>
                Eliminates directional crypto downside. Long and short exposures are balanced so sharp Bitcoin or Ethereum sell-offs do not deplete client capital.
              </p>
              <ul className="wm-pillar-points">
                <li>Zero directional exposure to market crashes</li>
                <li>Yield harvested from spreads &amp; funding rates</li>
                <li>Low market correlation &amp; beta</li>
              </ul>
            </div>

            <div className="wm-pillar-card">
              <span className="wm-pillar-icon">⚡</span>
              <h3>Automated Hard Bracket Stops</h3>
              <p>
                Every single order is immediately bracketed by automated stop-loss thresholds with an ironclad &lt;2.5% max drawdown limit.
              </p>
              <ul className="wm-pillar-points">
                <li>Sub-millisecond automated stop execution</li>
                <li>Zero emotional or discretionary bias</li>
                <li>De-risks directly to cash upon volatility spikes</li>
              </ul>
            </div>

            <div className="wm-pillar-card">
              <span className="wm-pillar-icon">🔐</span>
              <h3>Isolated Personal Wallet Custody</h3>
              <p>
                Your funds are never pooled into third-party smart contracts or custodial schemes. Everything stays in your verified trading account.
              </p>
              <ul className="wm-pillar-points">
                <li>Withdrawal permissions permanently disabled</li>
                <li>24/7 instant liquidity to your bank account</li>
                <li>Zero counterparty commingling risk</li>
              </ul>
            </div>
          </div>

          {/* Cryptographic Vault Feature Showcase */}
          <div className="wm-vault-feature">
            <div className="wm-vault-img-wrap">
              <img
                src="/images/crypto_vault_shield.jpg"
                alt="Aza WealthKare Institutional Cryptographic Vault Shield"
                loading="lazy"
              />
            </div>
            <div>
              <span className="kicker">Aza WealthKare Cryptographic Architecture</span>
              <h3 style={{ fontSize: '26px', fontWeight: 800, margin: '8px 0 14px', color: '#ffffff' }}>
                The Aza WealthKare 100% Principal Protection Guarantee
              </h3>
              <p style={{ color: '#94a3b8', fontSize: '15px', lineHeight: 1.6, marginBottom: '22px' }}>
                The Aza WealthKare trading infrastructure connects to your personal trading account with strict trade-only delegation.
                Withdrawal permissions are permanently disabled. No matter how wild crypto markets swing, your capital remains permanently isolated in your verified account.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                <div className="wm-vault-mini-stat">
                  <strong style={{ display: 'block', fontSize: '13.5px', color: '#ffffff', marginBottom: '2px' }}>Zero Third-Party Risk</strong>
                  <span style={{ fontSize: '12px', color: '#94a3b8' }}>No pooling, zero commingling, zero transfer</span>
                </div>
                <div className="wm-vault-mini-stat highlight">
                  <strong style={{ display: 'block', fontSize: '13.5px', color: '#34d399', marginBottom: '2px' }}>Automated Risk Fences</strong>
                  <span style={{ fontSize: '12px', color: '#6ee7b7' }}>Sub-millisecond drawdown circuit breakers</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------- QUANTITATIVE EXECUTION & REGIME MATRIX */}
      <div className="wm-algo-section-wrap">
        <div style={{ maxWidth: '1240px', margin: '0 auto' }}>
          {/* Quantitative Algorithmic Execution Showcase */}
          <div className="wm-algo-showcase" style={{ marginTop: 0 }}>
            <div>
              <span className="kicker" style={{ color: '#34d399' }}>24/7 Systematic Alpha by Aza WealthKare</span>
              <h3 style={{ fontSize: '28px', fontWeight: 800, margin: '8px 0 14px', color: '#ffffff' }}>
                Inside the Aza WealthKare Real-Time Execution Desk
              </h3>
              <p style={{ color: '#94a3b8', fontSize: '15px', lineHeight: 1.6, marginBottom: '24px' }}>
                While retail traders struggle with emotional fatigue and volatility whipsaws, Aza WealthKare proprietary quantitative algorithms execute disciplined market-making and basis spreads around the clock.
              </p>
              <div style={{ display: 'flex', gap: '28px', flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontSize: '26px', fontWeight: 850, color: '#34d399', fontFamily: 'var(--mono)' }}>&lt; 2.5%</div>
                  <div style={{ fontSize: '11.5px', color: '#94a3b8', marginTop: '2px' }}>Max Monitored Drawdown</div>
                </div>
                <div>
                  <div style={{ fontSize: '26px', fontWeight: 850, color: '#ffffff', fontFamily: 'var(--mono)' }}>24/7/365</div>
                  <div style={{ fontSize: '11.5px', color: '#94a3b8', marginTop: '2px' }}>Algorithmic Surveillance</div>
                </div>
                <div>
                  <div style={{ fontSize: '26px', fontWeight: 850, color: '#34d399', fontFamily: 'var(--mono)' }}>100%</div>
                  <div style={{ fontSize: '11.5px', color: '#94a3b8', marginTop: '2px' }}>Personal Trading Account Settlement</div>
                </div>
              </div>
            </div>
            <div className="wm-algo-img-wrap">
              <img
                src="/images/algo_trading_desk.jpg"
                alt="Aza WealthKare Quantitative Algorithmic Execution Command Desk"
                loading="lazy"
              />
            </div>
          </div>

          {/* Market Regime Resilience Card */}
          <div className="wm-regime-wrap">
            <div style={{ textAlign: 'center', maxWidth: '640px', margin: '0 auto 24px' }}>
              <span className="kicker" style={{ fontSize: '11.5px' }}>Aza WealthKare Cycle-Tested Engineering</span>
              <h3 style={{ fontSize: '22px', fontWeight: 800, margin: '8px 0 6px', color: '#ffffff' }}>
                Aza WealthKare Market Regime Performance Matrix
              </h3>
              <p style={{ fontSize: '14px', color: '#94a3b8', margin: 0 }}>
                Aza WealthKare algorithms dynamically adapt execution logic based on macroeconomic crypto volatility.
              </p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px' }} className="wm-regime-grid">
              <div className="wm-regime-card bull">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '20px' }}>📈</span>
                  <strong style={{ fontSize: '14.5px', color: '#34d399' }}>Bull Market Regimes</strong>
                </div>
                <p style={{ fontSize: '13px', color: '#a7f3d0', margin: 0, lineHeight: 1.5 }}>
                  Systematic trend capture with automated trailing take-profits. Locks in targeted 3%–5% monthly gains while ratcheting stop-losses upward.
                </p>
              </div>

              <div className="wm-regime-card bear">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '20px' }}>📉</span>
                  <strong style={{ fontSize: '14.5px', color: '#60a5fa' }}>Bear Market Regimes</strong>
                </div>
                <p style={{ fontSize: '13px', color: '#bfdbfe', margin: 0, lineHeight: 1.5 }}>
                  Capital preservation mode. Neutralizes exposure through synthetic short hedges and harvests steady basis yield with 100% principal protection.
                </p>
              </div>

              <div className="wm-regime-card chop">
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '20px' }}>⚡</span>
                  <strong style={{ fontSize: '14.5px', color: '#c084fc' }}>High Volatility &amp; Chop</strong>
                </div>
                <p style={{ fontSize: '13px', color: '#e9d5ff', margin: 0, lineHeight: 1.5 }}>
                  Mean-reversion micro-scalping within strict bracket corridors. Captures intraday spreads while hard risk fences prevent runaway losses.
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* -------------------------------------------------- SECURITY & RISK */}
      <section id="security" className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">Aza WealthKare Safety Architecture</span>
          <h2>Built by Aza WealthKare for Total Peace of Mind</h2>
          <p>Real money demands uncompromising engineering. Here is how Aza WealthKare safeguards your wealth.</p>
        </div>

        <div className="features">
          <div className="feature">
            <div className="feature-icon">🔒</div>
            <h3>Zero Withdrawal Authority</h3>
            <p>
              Management access is granted to Aza WealthKare with <strong>withdrawals permanently blocked</strong>. Even our own operators cannot initiate an outgoing transfer from your exchange.
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
              Because trades execute directly on your trading account, you can open your exchange app anytime to view every position, order, and rupee live.
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
          <span className="kicker">Aza WealthKare Advisory</span>
          <h2>Frequently Asked Questions About Aza WealthKare</h2>
          <p>Everything you need to know about Aza WealthKare&rsquo;s non-custodial crypto wealth management service.</p>
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
      <section className="mk-section mk-block" style={{ padding: '60px 24px' }}>
        <div className="wm-final-cta-wrap">
          <span className="pill ok" style={{ fontSize: '12.5px', letterSpacing: '0.05em' }}>
            Zero Custody Risk · 100% Capital Guaranteed by Aza WealthKare
          </span>
          <h2 className="wm-cta-title">
            Put Your Capital to Work with Aza WealthKare Today
          </h2>
          <p style={{ maxWidth: '640px', margin: '0 auto 32px', color: '#94a3b8', fontSize: '16.5px', lineHeight: 1.6 }}>
            Join discerning investors earning 3% to 5% monthly profits through Aza WealthKare without ever transferring custody of their funds.
          </p>
          <div style={{ display: 'flex', gap: '14px', justifyContent: 'center', flexWrap: 'wrap' }}>
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
