import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { Brand } from './Brand.tsx';

interface NavLink {
  readonly to: string;
  readonly label: string;
}

const NAV: readonly NavLink[] = [
  { to: '/about', label: 'About Us' },
  { to: '/model', label: 'Investment Model' },
  { to: '/guarantee', label: 'Capital Guarantee' },
  { to: '/#calculator', label: 'ROI Calculator' },
  { to: '/faq', label: 'FAQ' },
  { to: '/contact', label: 'Contact Us' },
];

export function MarketingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { state } = useAuth();
  const authed = state.status === 'authenticated';

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`mk-header${scrolled ? ' scrolled' : ''}`}>
      <Brand to="/" />

      <nav className="mk-nav" aria-label="Primary">
        {NAV.map((l) => (
          l.to.startsWith('/#') ? (
            <a key={l.to} href={l.to.substring(1)}>{l.label}</a>
          ) : (
            <Link key={l.to} to={l.to}>{l.label}</Link>
          )
        ))}
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
              title="Internal Company Access Only"
            >
              Operator
            </Link>
            <Link to="/contact" className="btn btn-sm wm-btn-primary mk-header-consult-btn">
              Book Consultation
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
        <>
          <div
            className="mk-menu-scrim"
            onClick={() => setMenuOpen(false)}
            aria-hidden="true"
          />
          <div className="mk-mobile-menu">
            <div className="mk-mobile-menu-links">
              {NAV.map((l) => (
                l.to.startsWith('/#') ? (
                  <a key={l.to} href={l.to.substring(1)} onClick={() => setMenuOpen(false)}>
                    {l.label}
                  </a>
                ) : (
                  <Link key={l.to} to={l.to} onClick={() => setMenuOpen(false)}>
                    {l.label}
                  </Link>
                )
              ))}
            </div>

            <div className="mk-mobile-menu-actions">
              <Link
                to="/contact"
                className="btn wm-btn-primary mk-mobile-cta"
                onClick={() => setMenuOpen(false)}
              >
                Book Consultation →
              </Link>
              <Link
                to={authed ? '/app' : '/login'}
                className="mk-mobile-op-link"
                onClick={() => setMenuOpen(false)}
              >
                {authed ? '⚡ Management Console' : '🔒 Operator Portal Login'}
              </Link>
            </div>
          </div>
        </>
      )}
    </header>
  );
}
