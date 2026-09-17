import { Link } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';
import { ProfitCalculator } from '../components/ProfitCalculator.tsx';
import { useBranding } from '../branding.tsx';

export function Model() {
  const { branding } = useBranding();

  return (
    <div className="landing landing-dark">
      <MarketingHeader />

      <div className="wm-subpage-hero-wrap">
        <section className="mk-section mk-block" style={{ padding: '20px 0 10px' }}>
          <div className="section-head" style={{ maxWidth: '840px', margin: '0 auto', textAlign: 'center' }}>
            <span className="kicker">Quantitative Methodology</span>
            <h1 style={{ fontSize: '44px', fontWeight: 850, margin: '14px 0 20px', letterSpacing: '-0.03em', color: '#ffffff' }}>
              The <span className="wm-grad">3%–5% Monthly</span> Growth &amp; Protection Architecture
            </h1>
            <p style={{ fontSize: '17px', lineHeight: 1.6, color: '#94a3b8' }}>
              Discover how {branding.name} combines systematic algorithmic execution, non-custodial risk containment, and capital preservation guarantees to generate consistent returns across all market conditions.
            </p>
          </div>
        </section>
      </div>

      <section className="mk-section mk-block" style={{ paddingTop: '40px' }}>
        <div style={{ maxWidth: '1040px', margin: '0 auto' }}>

          <div style={{ borderRadius: '18px', overflow: 'hidden', marginBottom: '40px', border: '1px solid rgba(16, 185, 129, 0.35)', boxShadow: '0 20px 45px rgba(0,0,0,0.5)' }}>
            <img
              src="/images/algo_trading_desk.jpg"
              alt="Aza WealthKare Quantitative Algorithmic Execution Infrastructure"
              style={{ width: '100%', maxHeight: '440px', objectFit: 'cover', display: 'block' }}
            />
          </div>
          
          {/* Detailed breakdown grid */}
          <div className="wm-pillars-grid" style={{ marginTop: 0, marginBottom: '40px' }}>
            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">📊</div>
              <h3>Quantitative Alpha</h3>
              <p>
                Our engine identifies statistical mispricings, order-book depth imbalances, and trend momentum across major crypto pairs (BTC, ETH, SOL).
              </p>
              <ul className="wm-pillar-points">
                <li>Delta-neutral hedging</li>
                <li>Systematic market-spread capture</li>
                <li>Momentum continuation models</li>
              </ul>
            </div>

            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">🛡️</div>
              <h3>Automated Risk Brackets</h3>
              <p>
                No unhedged bets. Every trade fill triggers an automated bracket order with strict stop-losses and trailing take-profits.
              </p>
              <ul className="wm-pillar-points">
                <li>Fixed 1:2+ risk/reward ratio</li>
                <li>Trailing stops lock in paper gains</li>
                <li>Zero emotional or panic decisions</li>
              </ul>
            </div>

            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">🔒</div>
              <h3>Non-Custodial Guarantee</h3>
              <p>
                Your capital stays 100% in your own verified CoinDCX exchange account. We execute with withdrawal privileges disabled.
              </p>
              <ul className="wm-pillar-points">
                <li>Zero risk of third-party theft</li>
                <li>Instant 24/7 bank liquidity</li>
                <li>Real-time verification in CoinDCX app</li>
              </ul>
            </div>
          </div>

          {/* Calculator Section */}
          <div style={{ marginTop: '50px', marginBottom: '50px' }}>
            <div className="section-head" style={{ marginBottom: '24px', textAlign: 'center' }}>
              <span className="kicker">Simulate Growth</span>
              <h2>Project Your Returns With Our Model</h2>
            </div>
            <ProfitCalculator />
          </div>

          {/* Guarantee Deep Dive */}
          <div className="wm-pillar-card" style={{ padding: '36px', marginTop: '40px' }}>
            <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '16px' }}>
              <span style={{ fontSize: '32px' }}>🛡️</span>
              <h2 style={{ fontSize: '26px', fontWeight: 850, margin: 0, color: '#ffffff' }}>
                How the 100% Capital Guarantee Operates
              </h2>
            </div>
            <p style={{ fontSize: '15.5px', lineHeight: 1.7, color: '#94a3b8', marginBottom: '16px' }}>
              We enforce a strict capital preservation covenant: our multi-tiered risk architecture ensures that your initial principal is never exposed to catastrophic liquidation or runaway drawdowns.
            </p>
            <div className="wm-steps-grid" style={{ marginTop: '20px', gridTemplateColumns: 'repeat(3, 1fr)' }}>
              <div className="wm-step-card">
                <div className="wm-step-num">01</div>
                <h3>Max 2.5% Drawdown Cap</h3>
                <p>Overall portfolio risk is hard-capped at &lt; 2.5%, triggering automatic de-risking if violated.</p>
              </div>
              <div className="wm-step-card">
                <div className="wm-step-num">02</div>
                <h3>12 Pre-Trade Safety Gates</h3>
                <p>Liquidity, spread, slippage, and balance checks execute before any order is submitted.</p>
              </div>
              <div className="wm-step-card">
                <div className="wm-step-num">03</div>
                <h3>Reserve-Backed Shield</h3>
                <p>Our firm maintains a balance reserve buffer to absorb unexpected slippage or venue delays.</p>
              </div>
            </div>
          </div>

          {/* CTA */}
          <div className="wm-final-cta-wrap" style={{ marginTop: '50px' }}>
            <h2 style={{ fontSize: '32px', fontWeight: 850, margin: '0 0 14px' }}>
              Ready to Implement Institutional Management?
            </h2>
            <p style={{ color: '#94a3b8', marginBottom: '28px', fontSize: '15.5px' }}>
              Speak directly with our senior investment desk to discuss custom allocation and account setup.
            </p>
            <Link to="/contact" className="btn btn-lg wm-btn-primary" style={{ textDecoration: 'none' }}>
              Book an Advisory Consultation →
            </Link>
          </div>

        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
