import { useRouteError, isRouteErrorResponse, Link } from 'react-router-dom';
import { NotFound } from '../routes/NotFound.tsx';
import { MarketingHeader } from './MarketingHeader.tsx';
import { MarketingFooter } from './MarketingFooter.tsx';
import { BrandingProvider } from '../branding.tsx';
import { AuthProvider } from '../auth.tsx';

export function RouteErrorBoundary() {
  const error = useRouteError();

  // If it's a 404 route error response, render the full luxury 404 page
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <BrandingProvider>
        <AuthProvider>
          <NotFound />
        </AuthProvider>
      </BrandingProvider>
    );
  }

  const errorMessage = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
    ? error.message
    : 'An unexpected application error occurred.';

  return (
    <BrandingProvider>
      <AuthProvider>
        <div className="landing landing-dark not-found-page">
          <MarketingHeader />

          <main className="wm-subpage-hero-wrap not-found-wrap">
            <section className="mk-section not-found-section" aria-label="Application Error">
              <div className="not-found-card">
                <div className="not-found-badge" style={{ borderColor: 'rgba(239, 68, 68, 0.4)', background: 'rgba(239, 68, 68, 0.1)', color: '#dc2626' }}>
                  <span className="not-found-dot" style={{ background: '#dc2626', boxShadow: '0 0 8px #dc2626' }} aria-hidden="true" />
                  <span>SYSTEM NOTIFICATION</span>
                </div>

                <div className="not-found-code" style={{ color: '#dc2626', opacity: 0.85 }} aria-hidden="true">
                  500
                </div>

                <h1 className="not-found-title">
                  Application Encountered an Issue
                </h1>

                <p className="not-found-sub">
                  Our quantitative systems are operating normally, but your browser encountered an unexpected rendering condition.
                </p>

                {errorMessage && (
                  <div style={{
                    maxWidth: '540px',
                    margin: '0 auto 28px',
                    padding: '12px 16px',
                    borderRadius: '8px',
                    background: '#fef2f2',
                    border: '1px solid #fecaca',
                    fontSize: '13px',
                    color: '#991b1b',
                    fontFamily: 'monospace',
                    wordBreak: 'break-word',
                    textAlign: 'left'
                  }}>
                    {errorMessage}
                  </div>
                )}

                <div className="not-found-actions">
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="btn wm-btn-primary not-found-btn-home"
                  >
                    <span>🔄 Reload Page</span>
                  </button>
                  <Link to="/" className="btn wm-btn-secondary not-found-btn-explore">
                    <span>Return to Home</span>
                  </Link>
                  <Link to="/contact" className="btn secondary not-found-btn-contact">
                    <span>Report to Support Desk</span>
                  </Link>
                </div>
              </div>
            </section>
          </main>

          <MarketingFooter />
        </div>
      </AuthProvider>
    </BrandingProvider>
  );
}
