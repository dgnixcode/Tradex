import { Link } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';
import { useBranding } from '../branding.tsx';

export function Guarantee() {
  const { branding } = useBranding();

  return (
    <div className="landing landing-dark">
      <MarketingHeader />

      <div className="wm-subpage-hero-wrap">
        <section className="mk-section mk-block" style={{ padding: '20px 0 10px' }}>
          <div className="section-head" style={{ maxWidth: '840px', margin: '0 auto', textAlign: 'center' }}>
            <span className="kicker">Investor Security Covenant</span>
            <h1 className="wm-subpage-title">
              The <span className="wm-grad">100% Capital Protection</span> Guarantee
            </h1>
            <p className="wm-subpage-sub">
              We place capital preservation above all else. Discover the mathematical risk parameters, algorithmic downside circuit breakers, and non-custodial protections that safeguard your wealth.
            </p>
          </div>
        </section>
      </div>

      <section className="mk-section mk-block" style={{ paddingTop: '40px' }}>
        <div style={{ maxWidth: '960px', margin: '0 auto' }}>

          <div style={{ borderRadius: '18px', overflow: 'hidden', marginBottom: '40px', border: '1px solid rgba(16, 185, 129, 0.35)', boxShadow: '0 20px 45px rgba(0,0,0,0.5)' }}>
            <img
              src="/images/crypto_vault_shield.jpg"
              alt="Aza WealthKare 100% Capital Protection Cryptographic Shield"
              style={{ width: '100%', maxHeight: '440px', objectFit: 'cover', display: 'block' }}
            />
          </div>
          
          <div className="wm-pillar-card" style={{ padding: '36px', marginBottom: '32px' }}>
            <h2 style={{ fontSize: '26px', fontWeight: 850, marginBottom: '14px', color: '#ffffff' }}>
              Why We Can Offer a 100% Principal Guarantee
            </h2>
            <p style={{ fontSize: '15.5px', lineHeight: 1.7, color: '#94a3b8', marginBottom: '16px' }}>
              Unlike retail traders who hold losing positions in hope of a turnaround, {branding.name} operates with institutional algorithmic discipline. Every trade position is sized strictly as a small fraction of your portfolio and bracketed by non-negotiable stop-loss orders.
            </p>
            <p style={{ fontSize: '15.5px', lineHeight: 1.7, color: '#94a3b8', margin: 0 }}>
              Because your funds remain exclusively in your personal <strong>CoinDCX</strong> wallet with withdrawal permissions disabled, you face zero counterparty or credit risk. You hold the ultimate keys to your money at every microsecond.
            </p>
          </div>

          <div className="wm-pillars-grid" style={{ marginTop: 0, marginBottom: '40px' }}>
            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">⚡</div>
              <h3>Automated Downside Limits</h3>
              <p>
                Strict stop-losses are attached the instant any position fills. Market drops never trigger liquidation; losses on individual legs are capped at small basis points.
              </p>
            </div>

            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">🛡️</div>
              <h3>Portfolio Drawdown Cap</h3>
              <p>
                Total portfolio volatility is hard-capped at &lt; 2.5%. If unusual market turbulence occurs, trading automatically de-escalates to cash (USDT/INR).
              </p>
            </div>

            <div className="wm-pillar-card">
              <div className="wm-pillar-icon">🔒</div>
              <h3>Zero Custody Vulnerability</h3>
              <p>
                We never take deposits. Your money is protected by CoinDCX&rsquo;s exchange-grade cold storage, multi-factor authentication, and regulatory compliance.
              </p>
            </div>
          </div>

          <div className="wm-final-cta-wrap">
            <h2 className="wm-cta-title">
              Protect Your Principal While Compounding Returns
            </h2>
            <p style={{ color: '#94a3b8', marginBottom: '28px', fontSize: '15.5px' }}>
              Target 3% to 5% monthly profits with the assurance of complete principal protection.
            </p>
            <Link to="/contact" className="btn btn-lg wm-btn-primary" style={{ textDecoration: 'none' }}>
              Schedule Your Capital Allocation Call →
            </Link>
          </div>

        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
