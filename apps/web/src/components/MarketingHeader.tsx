import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth.tsx';
import { Brand } from './Brand.tsx';

interface NavLink {
  readonly href: string;
  readonly label: string;
}

const NAV: readonly NavLink[] = [
  { href: '#model', label: 'Investment Model' },
  { href: '#guarantee', label: 'Capital Guarantee' },
  { href: '#calculator', label: 'ROI Calculator' },
  { href: '#how-it-works', label: 'How It Works' },
  { href: '#security', label: 'Security' },
  { href: '#faq', label: 'FAQ' },
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
          <a key={l.href} href={l.href}>{l.label}</a>
        ))}
      </nav>

      <div className="mk-header-actions">
        {authed ? (
          <Link to="/app" className="btn btn-sm">Go to Dashboard</Link>
        ) : (
          <>
            <Link to="/login" className="btn secondary btn-sm">Client Portal</Link>
            <Link to="/login" className="btn btn-sm">Get Started</Link>
          </>
        )}
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
          <Link to={authed ? '/app' : '/login'} onClick={() => setMenuOpen(false)}>
            {authed ? 'Go to Dashboard' : 'Client Portal'}
          </Link>
        </div>
      )}
    </header>
  );
}
