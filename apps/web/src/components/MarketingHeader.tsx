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
          <Link to="/app" className="btn btn-sm">Management Console</Link>
        ) : (
          <>
            <Link to="/login" className="btn secondary btn-sm" title="Internal Company Access Only" style={{ fontSize: '12px', padding: '6px 12px', color: 'var(--muted)' }}>
              Operator Portal
            </Link>
            <Link to="/contact" className="btn btn-sm wm-btn-primary">
              Book Consultation
            </Link>
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
            l.to.startsWith('/#') ? (
              <a key={l.to} href={l.to.substring(1)} onClick={() => setMenuOpen(false)}>{l.label}</a>
            ) : (
              <Link key={l.to} to={l.to} onClick={() => setMenuOpen(false)}>{l.label}</Link>
            )
          ))}
          <Link to="/contact" onClick={() => setMenuOpen(false)}>Book Consultation</Link>
          <Link to={authed ? '/app' : '/login'} onClick={() => setMenuOpen(false)} style={{ fontSize: '13px', color: 'var(--muted)' }}>
            {authed ? 'Management Console' : 'Operator Portal'}
          </Link>
        </div>
      )}
    </header>
  );
}
