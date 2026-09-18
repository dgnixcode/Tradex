import { Link } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';
import { useBranding } from '../branding.tsx';

export function NotFound() {
  const { branding } = useBranding();

  return (
    <div className="landing landing-dark not-found-page">
      <MarketingHeader />

      <main className="wm-subpage-hero-wrap not-found-wrap">
        <section className="mk-section not-found-section" aria-label="404 Page Not Found">
          <div className="not-found-card">
            <div className="not-found-badge">
              <span className="not-found-dot" aria-hidden="true" />
              <span>404 · RESOURCE NOT FOUND</span>
            </div>

            <div className="not-found-code" aria-hidden="true">
              404
            </div>

            <h1 className="not-found-title">
              We Couldn&rsquo;t Find That Page
            </h1>

            <p className="not-found-sub">
              The wealth management link or resource you followed may have been updated, relocated, or is temporarily unavailable. Your assets remain secure in your personal trading account.
            </p>

            <div className="not-found-actions">
              <Link to="/" className="btn wm-btn-primary not-found-btn-home">
                <span>← Return to Home</span>
              </Link>
              <Link to="/model" className="btn wm-btn-secondary not-found-btn-explore">
                <span>Explore Our Services</span>
              </Link>
              <Link to="/contact" className="btn secondary not-found-btn-contact">
                <span>Contact Advisory Desk</span>
              </Link>
            </div>

            <div className="not-found-quick-links">
              <div className="not-found-links-header">
                Helpful Navigation Shortcuts
              </div>
              <div className="not-found-grid">
                <Link to="/" className="not-found-tile">
                  <span className="not-found-tile-icon">🏛️</span>
                  <div className="not-found-tile-body">
                    <span className="not-found-tile-title">Home</span>
                    <span className="not-found-tile-desc">Overview of institutional crypto wealth intelligence</span>
                  </div>
                </Link>

                <Link to="/model" className="not-found-tile">
                  <span className="not-found-tile-icon">📈</span>
                  <div className="not-found-tile-body">
                    <span className="not-found-tile-title">Our Services</span>
                    <span className="not-found-tile-desc">Algorithmic alpha and delta-hedging execution</span>
                  </div>
                </Link>

                <Link to="/guarantee" className="not-found-tile">
                  <span className="not-found-tile-icon">🛡️</span>
                  <div className="not-found-tile-body">
                    <span className="not-found-tile-title">Digital Assets</span>
                    <span className="not-found-tile-desc">100% Capital preservation guarantee and safety</span>
                  </div>
                </Link>

                <Link to="/#calculator" className="not-found-tile">
                  <span className="not-found-tile-icon">🧮</span>
                  <div className="not-found-tile-body">
                    <span className="not-found-tile-title">Insights Simulator</span>
                    <span className="not-found-tile-desc">Calculate compounding 3%–5% monthly returns</span>
                  </div>
                </Link>
              </div>
            </div>

            <div className="not-found-support-note">
              Need immediate assistance? Speak directly with the {branding.name} advisory desk via{' '}
              <a
                href={`https://wa.me/${(branding.whatsapp || '').replace(/[^0-9]/g, '') || '919876543210'}?text=${encodeURIComponent(`Hello ${branding.name}, I encountered a 404 page on your website.`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="not-found-wa-link"
              >
                WhatsApp Support →
              </a>
            </div>
          </div>
        </section>
      </main>

      <MarketingFooter />
    </div>
  );
}
