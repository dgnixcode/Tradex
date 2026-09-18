import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { Brand } from './Brand.tsx';

interface NavLink {
  readonly to: string;
  readonly label: string;
}

const NAV: readonly NavLink[] = [
  { to: '/', label: 'Home' },
  { to: '/about', label: 'About' },
  { to: '/model', label: 'Our Services' },
  { to: '/guarantee', label: 'Digital Assets' },
  { to: '/#calculator', label: 'Insights' },
  { to: '/contact', label: 'Contact' },
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
        {NAV.map((l) => {
          const isHome = l.to === '/' && typeof window !== 'undefined' && (window.location.pathname === '/' || window.location.pathname === '');
          const linkClass = `mk-nav-link ${isHome ? 'is-active' : ''}`;
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
                {authed ? '⚡ Management Console' : '🔒 Trading Desk Login'}
              </Link>
            </div>
          </div>
        </>
      )}
    </header>
  );
}
