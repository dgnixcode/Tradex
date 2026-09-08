import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.tsx';

// Reusable marketing header, shared by the landing page and any future public
// page. It is distinct from the authenticated panel's header (App.tsx): this one
// carries section-anchor navigation and a login CTA, not a logout button. It
// gains a hairline border only once the page scrolls, so the hero sits flush
// against a borderless bar and the chrome appears as you move down.

interface NavLink {
  readonly href: string;
  readonly label: string;
}

const NAV: readonly NavLink[] = [
  { href: '#how', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#safety', label: 'Safety' },
];

export function MarketingHeader() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { state } = useAuth();
  // A signed-in visitor is welcome on the marketing page; the header just offers
  // the way back into the app instead of a login prompt.
  const authed = state.status === 'authenticated';
  const cta = authed ? { to: '/app', label: 'Go to dashboard' } : { to: '/login', label: 'Log in' };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header className={`mk-header${scrolled ? ' scrolled' : ''}`}>
      <Link to="/" className="brand">Tradex</Link>

      <nav className="mk-nav" aria-label="Primary">
        {NAV.map((l) => (
          <a key={l.href} href={l.href}>{l.label}</a>
        ))}
      </nav>

      <div className="mk-header-actions">
        <Link to={cta.to} className="btn secondary btn-sm">{cta.label}</Link>
        <button
          className="mk-menu-btn"
          aria-label="Toggle menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            {menuOpen
              ? <path d="M6 6l12 12M6 18L18 6" strokeLinecap="round" />
              : <><path d="M4 7h16" strokeLinecap="round" /><path d="M4 12h16" strokeLinecap="round" /><path d="M4 17h16" strokeLinecap="round" /></>}
          </svg>
        </button>
      </div>

      {menuOpen && (
        <div className="mk-mobile-menu">
          {NAV.map((l) => (
            <a key={l.href} href={l.href} onClick={() => setMenuOpen(false)}>{l.label}</a>
          ))}
          <Link to={cta.to} onClick={() => setMenuOpen(false)}>{cta.label}</Link>
        </div>
      )}
    </header>
  );
}
