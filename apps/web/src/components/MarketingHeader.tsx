import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { useBranding } from '../branding.tsx';
import { Brand } from './Brand.tsx';

interface DesktopNavLink {
  readonly to: string;
  readonly label: string;
}

interface DrawerNavItem {
  readonly to: string;
  readonly label: string;
  readonly desc: string;
  readonly icon: string;
}

const DESKTOP_NAV: readonly DesktopNavLink[] = [
  { to: '/', label: 'Home' },
  { to: '/about', label: 'About' },
  { to: '/model', label: 'Our Services' },
  { to: '/guarantee', label: 'Digital Assets' },
  { to: '/#calculator', label: 'Insights' },
  { to: '/contact', label: 'Contact' },
];

const DRAWER_ITEMS: readonly DrawerNavItem[] = [
  { to: '/', label: 'Home', desc: 'Quantitative wealth intelligence overview', icon: '🏛️' },
  { to: '/about', label: 'About Us', desc: 'Our philosophy & safety covenants', icon: 'ℹ️' },
  { to: '/model', label: 'Our Services', desc: 'Systematic alpha & spread capture', icon: '📈' },
  { to: '/guarantee', label: 'Digital Assets', desc: '100% Principal protection guarantee', icon: '🛡️' },
  { to: '/#calculator', label: 'Insights Simulator', desc: 'Simulate compounding monthly returns', icon: '🧮' },
  { to: '/faq', label: 'FAQ', desc: 'Investor answers & security guidelines', icon: '💬' },
  { to: '/contact', label: 'Contact Advisory', desc: 'Schedule private consultation with an advisor', icon: '✉️' },
];

export function MarketingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { state } = useAuth();
  const { branding } = useBranding();
  const location = useLocation();
  const authed = state.status === 'authenticated';

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = originalOverflow;
    };
  }, [menuOpen]);

  return (
    <header className={`mk-header${scrolled ? ' scrolled' : ''}`}>
      <Brand to="/" />

      <nav className="mk-nav" aria-label="Primary">
        {DESKTOP_NAV.map((l) => {
          const isHome = l.to === '/' && location.pathname === '/';
          const isCurrent = location.pathname === l.to;
          const linkClass = `mk-nav-link ${isHome || isCurrent ? 'is-active' : ''}`;
          const content = <span>{l.label}</span>;

          return l.to.startsWith('/#') ? (
            <a key={l.to} href={l.to.substring(1)} className={linkClass}>{content}</a>
          ) : (
            <Link key={l.to} to={l.to} className={linkClass}>{content}</Link>
          );
        })}
      </nav>

      <div className="mk-header-actions">
        {authed ? (
          <Link to="/app" className="btn btn-sm mk-header-console-btn">
            Management Console
          </Link>
        ) : (
          <>
            <Link
              to="/login"
              className="btn secondary btn-sm mk-header-op-btn"
              title="Internal Trading Desk Access"
            >
              Desk Login
            </Link>
            <Link to="/contact" className="btn btn-sm ref-header-cta-btn">
              Get Started →
            </Link>
          </>
        )}
        <button
          className="mk-menu-btn"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
            {menuOpen ? (
              <path d="M6 6l12 12M6 18L18 6" strokeLinecap="round" />
            ) : (
              <>
                <path d="M4 7h16" strokeLinecap="round" />
                <path d="M4 12h16" strokeLinecap="round" />
                <path d="M4 17h16" strokeLinecap="round" />
              </>
            )}
          </svg>
        </button>
      </div>

      {menuOpen && (
        <div className="mk-drawer-portal" role="dialog" aria-modal="true" aria-label="Navigation Menu">
          {/* Backdrop Scrim */}
          <div
            className="mk-drawer-scrim"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />

          {/* Slide-over Drawer Panel */}
          <div className="mk-drawer-panel">
            {/* Header with Brand and Close Button */}
            <div className="mk-drawer-header">
              <Brand to="/" onClick={() => setMenuOpen(false)} />
              <button
                type="button"
                className="mk-drawer-close-btn"
                aria-label="Close navigation menu"
                onClick={() => setMenuOpen(false)}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>

            {/* Subheader Badge */}
            <div className="mk-drawer-subhead">
              <span className="mk-drawer-badge">
                <span className="mk-drawer-dot" aria-hidden="true" />
                <span>100% CAPITAL PROTECTED · NON-CUSTODIAL</span>
              </span>
            </div>

            {/* Navigation Items */}
            <nav className="mk-drawer-links" aria-label="Mobile Navigation">
              {DRAWER_ITEMS.map((item) => {
                const isHome = item.to === '/' && location.pathname === '/';
                const isCurrent = location.pathname === item.to;
                const active = isHome || isCurrent;
                const linkClass = `mk-drawer-link ${active ? 'is-active' : ''}`;

                const inner = (
                  <>
                    <span className="mk-drawer-link-icon" aria-hidden="true">{item.icon}</span>
                    <div className="mk-drawer-link-text">
                      <span className="mk-drawer-link-label">{item.label}</span>
                      <span className="mk-drawer-link-desc">{item.desc}</span>
                    </div>
                    <span className="mk-drawer-link-arrow" aria-hidden="true">›</span>
                  </>
                );

                return item.to.startsWith('/#') ? (
                  <a
                    key={item.to}
                    href={item.to.substring(1)}
                    className={linkClass}
                    onClick={() => setMenuOpen(false)}
                  >
                    {inner}
                  </a>
                ) : (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={linkClass}
                    onClick={() => setMenuOpen(false)}
                  >
                    {inner}
                  </Link>
                );
              })}
            </nav>

            {/* Direct Support Card */}
            <div className="mk-drawer-support-card">
              <div className="mk-drawer-support-title">Private Advisory Support</div>
              <div className="mk-drawer-support-row">
                <a
                  href={`https://wa.me/${(branding.whatsapp || '').replace(/[^0-9]/g, '') || '919876543210'}?text=${encodeURIComponent(`Hello ${branding.name}, I would like to inquire about your wealth management services.`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mk-drawer-support-wa"
                >
                  <span style={{ fontSize: '17px' }}>💬</span>
                  <span>WhatsApp</span>
                  <span className="mk-drawer-wa-dot" />
                </a>
                <a
                  href={`tel:${branding.phone}`}
                  className="mk-drawer-support-tel"
                >
                  <span>📞 Call Desk</span>
                </a>
              </div>
            </div>

            {/* Drawer Actions */}
            <div className="mk-drawer-actions">
              <Link
                to="/contact"
                className="mk-drawer-cta-primary"
                onClick={() => setMenuOpen(false)}
              >
                <span>Schedule Consultation</span>
                <span className="ref-btn-arrow">→</span>
              </Link>
              <Link
                to={authed ? '/app' : '/login'}
                className="mk-drawer-cta-secondary"
                onClick={() => setMenuOpen(false)}
              >
                <span>{authed ? '⚡ Management Console' : '🔒 Trading Desk Login'}</span>
              </Link>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
