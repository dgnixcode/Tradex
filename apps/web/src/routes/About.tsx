import { Link } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';
import { useBranding } from '../branding.tsx';

export function About() {
  const { branding } = useBranding();

  return (
    <div className="landing landing-light">
      <MarketingHeader />

      <section className="mk-section mk-block" style={{ paddingTop: '60px', paddingBottom: '30px' }}>
        <div className="section-head" style={{ maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
          <span className="kicker">About {branding.name}</span>
          <h1 style={{ fontSize: '42px', fontWeight: 800, margin: '14px 0 20px', letterSpacing: '-0.03em' }}>
            Institutional Crypto Wealth Management Built on <span className="wm-grad">Zero Custody Risk</span>
          </h1>
          <p style={{ fontSize: '17px', lineHeight: 1.6, color: 'var(--text-dim)' }}>
            We founded {branding.name} to solve the single greatest hazard in crypto investing: counterparty risk. We believe you should never have to hand over your life savings to a third party to achieve professional, compounding returns.
          </p>
        </div>
      </section>

      {/* Story & Philosophy */}
      <section className="mk-section mk-block" style={{ paddingTop: '10px' }}>
        <div style={{ maxWidth: '960px', margin: '0 auto' }}>
          <div className="wm-pillar-card" style={{ padding: '40px', marginBottom: '36px' }}>
            <h2 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '16px', color: 'var(--ink)' }}>
              Our Core Philosophy: Non-Custodial Wealth
            </h2>
            <p style={{ fontSize: '15.5px', lineHeight: 1.7, color: 'var(--text-dim)', marginBottom: '16px' }}>
              Over the last decade, crypto investors have repeatedly suffered devastating losses from exchange insolvencies, unregistered hedge funds, and black-box collective schemes that vanished with user deposits.
            </p>
            <p style={{ fontSize: '15.5px', lineHeight: 1.7, color: 'var(--text-dim)', marginBottom: '0' }}>
              {branding.name} was engineered as the antidote. We never take possession of your assets. Your funds remain in your personal, verified <strong>CoinDCX</strong> exchange account. We manage trading with strictly withdrawal-disabled execution access. You retain 100% ownership, complete visibility, and 24/7 liquidity.
            </p>
          </div>

          <div className="wm-pillars-grid" style={{ marginTop: '0', marginBottom: '48px' }}>
            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">🏛️</div>
              <h3>Institutional Discipline</h3>
              <p>
                We reject emotional gambling and volatile hype cycles. Our quantitative trading engine relies on mathematical edge, delta-neutral hedging, and strict 1:2+ risk-to-reward ratios.
              </p>
            </div>

            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">🛡️</div>
              <h3>Capital Preservation First</h3>
              <p>
                Rule #1 in professional wealth management is to never lose principal. Our 100% capital protection framework ensures your starting investment is shielded against market downturns.
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
          <div className="wm-final-cta" style={{ margin: '0 auto' }}>
            <h2 style={{ fontSize: '30px', fontWeight: 800, margin: '0 0 14px' }}>
              Experience Fiduciary Crypto Wealth Management
            </h2>
            <p style={{ color: 'var(--text-dim)', marginBottom: '24px', fontSize: '15px' }}>
              Speak with a senior portfolio advisor to learn how we can protect and grow your capital.
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
