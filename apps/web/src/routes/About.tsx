import { Link } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';

export function About() {
  return (
    <div className="landing landing-dark">
      <MarketingHeader />

      <div className="wm-subpage-hero-wrap">
        <section className="mk-section mk-block" style={{ padding: '20px 0 10px' }}>
          <div className="section-head" style={{ maxWidth: '840px', margin: '0 auto', textAlign: 'center' }}>
            <span className="kicker">About Aza WealthKare</span>
            <h1 className="wm-subpage-title">
              Aza WealthKare: Institutional Crypto Wealth Management Built on <span className="wm-grad">Zero Custody Risk</span>
            </h1>
            <p className="wm-subpage-sub">
              We founded Aza WealthKare to solve the single greatest hazard in crypto investing: counterparty risk. We believe you should never have to hand over your life savings to a third party to achieve professional, compounding returns.
            </p>
          </div>
        </section>
      </div>

      {/* Story & Philosophy */}
      <section className="mk-section mk-block" style={{ paddingTop: '40px' }}>
        <div style={{ maxWidth: '960px', margin: '0 auto' }}>

          <div style={{ borderRadius: '18px', overflow: 'hidden', marginBottom: '40px', border: '1px solid rgba(16, 185, 129, 0.35)', boxShadow: '0 20px 45px rgba(0,0,0,0.5)' }}>
            <img
              src="/images/crypto_bull_hero.jpg"
              alt="Aza WealthKare Institutional Crypto Bullish Wealth Management"
              style={{ width: '100%', maxHeight: '440px', objectFit: 'cover', display: 'block' }}
            />
          </div>

          <div className="wm-pillar-card" style={{ padding: '40px', marginBottom: '36px' }}>
            <h2 style={{ fontSize: '26px', fontWeight: 800, marginBottom: '16px', color: '#0b1a30', fontFamily: "'Playfair Display', Georgia, serif" }}>
              The Aza WealthKare Philosophy: Non-Custodial Wealth Creation
            </h2>
            <p style={{ fontSize: '15.5px', lineHeight: 1.7, color: '#475569', marginBottom: '16px' }}>
              Over the last decade, crypto investors have repeatedly suffered devastating losses from exchange insolvencies, unregistered hedge funds, and black-box collective schemes that vanished with user deposits.
            </p>
            <p style={{ fontSize: '15.5px', lineHeight: 1.7, color: '#475569', marginBottom: '0' }}>
              Aza WealthKare was engineered as the definitive antidote. We never take possession of your assets. Your funds remain in your personal, verified <strong>trading account</strong>. Aza WealthKare manages trading with strictly withdrawal-disabled execution access. You retain 100% ownership, complete visibility, and 24/7 liquidity.
            </p>
          </div>

          <div className="wm-pillars-grid" style={{ marginTop: '0', marginBottom: '48px' }}>
            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">🏛️</div>
              <h3>Institutional Discipline</h3>
              <p>
                We reject emotional gambling and volatile hype cycles. The Aza WealthKare quantitative trading engine relies on mathematical edge, delta-neutral hedging, and strict 1:2+ risk-to-reward ratios.
              </p>
            </div>

            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">🛡️</div>
              <h3>Aza WealthKare Capital Preservation First</h3>
              <p>
                Rule #1 in professional wealth management at Aza WealthKare is to never lose principal. Our 100% capital protection framework ensures your starting investment is shielded against market downturns.
              </p>
            </div>

            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">🤝</div>
              <h3>Complete Transparency</h3>
              <p>
                No opaque monthly PDF statements or delayed quarterly reports. Every trade executes in real-time inside your personal exchange account where you can audit every rupee.
              </p>
            </div>
          </div>

          {/* Stats Bar */}
          <div className="wm-track-summary" style={{ margin: '0 0 50px 0' }}>
            <div className="wm-summary-stat">
              <span className="num">100%</span>
              <span className="lbl">Non-Custodial</span>
            </div>
            <div className="wm-summary-stat">
              <span className="num">3% – 5%</span>
              <span className="lbl">Target Monthly Profit</span>
            </div>
            <div className="wm-summary-stat">
              <span className="num">100%</span>
              <span className="lbl">Principal Guarantee</span>
            </div>
            <div className="wm-summary-stat">
              <span className="num">24/7</span>
              <span className="lbl">Client Liquidity</span>
            </div>
          </div>

          {/* Call to action */}
          <div className="wm-final-cta-wrap" style={{ margin: '0 auto' }}>
            <h2 className="wm-cta-title">
              Experience Fiduciary Crypto Wealth Management with Aza WealthKare
            </h2>
            <p style={{ color: '#94a3b8', marginBottom: '28px', fontSize: '15.5px' }}>
              Speak with an Aza WealthKare senior portfolio advisor to learn how we can protect and grow your capital.
            </p>
            <Link to="/contact" className="btn btn-lg wm-btn-primary" style={{ textDecoration: 'none' }}>
              Schedule a Consultation →
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
