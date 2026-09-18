import { Link } from 'react-router-dom';
import { Brand } from './Brand.tsx';
import { useBranding } from '../branding.tsx';

interface FooterCol {
  readonly title: string;
  readonly links: readonly { readonly label: string; readonly to: string }[];
}

const COLUMNS: readonly FooterCol[] = [
  {
    title: 'Wealth Management',
    links: [
      { label: 'Investment Model', to: '/model' },
      { label: 'Capital Guarantee', to: '/guarantee' },
      { label: 'ROI Calculator', to: '/#calculator' },
      { label: 'How It Works', to: '/model' },
    ],
  },
  {
    title: 'Our Firm',
    links: [
      { label: 'About Us', to: '/about' },
      { label: 'Schedule Consultation', to: '/contact' },
      { label: 'Frequently Asked Questions', to: '/faq' },
      { label: 'Contact Advisors', to: '/contact' },
    ],
  },
  {
    title: 'Safety & Custody',
    links: [
      { label: 'Non-Custodial Architecture', to: '/model' },
      { label: 'Zero Withdrawal Rights', to: '/guarantee' },
      { label: '12 Pre-Trade Safety Gates', to: '/guarantee' },
      { label: '24/7 Instant Liquidity', to: '/faq' },
    ],
  },
  {
    title: 'Internal Access',
    links: [
      { label: 'Trading Desk Portal (Staff)', to: '/login' },
      { label: 'System Status', to: '#' },
    ],
  },
];

export function MarketingFooter() {
  const { branding } = useBranding();

  return (
    <footer className="mk-footer">
      <div className="mk-footer-inner">
        <div className="mk-footer-brand">
          <Brand to="/" />
          <p>
            Aza WealthKare delivers institutional-grade crypto wealth management. Your funds remain safely inside your personal trading account at all times. Systematic algorithmic execution generating consistent 3%–5% monthly returns with 100% capital protection.
          </p>
          <div style={{ marginTop: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <span className="pill ok" style={{ fontSize: '11px' }}>🛡️ Non-Custodial</span>
            <span className="pill ok" style={{ fontSize: '11px' }}>🔒 Zero Withdrawal Rights</span>
            <span className="pill ok" style={{ fontSize: '11px' }}>📈 3%–5% Monthly Target</span>
          </div>
        </div>

        {COLUMNS.map((col) => (
          <div key={col.title} className="mk-footer-col">
            <h4>{col.title}</h4>
            {col.links.map((l) => (
              l.to.startsWith('/#') ? (
                <a key={l.label} href={l.to.substring(1)}>{l.label}</a>
              ) : l.to.startsWith('#') ? (
                <a key={l.label} href={l.to}>{l.label}</a>
              ) : (
                <Link key={l.label} to={l.to}>{l.label}</Link>
              )
            ))}
          </div>
        ))}
      </div>

      {/* Direct Contact & Office Details Strip */}
      <div className="mk-footer-contact-strip">
        <div className="mk-footer-contact-item">
          <span style={{ fontSize: '16px', color: '#25D366' }}>💬</span>
          <span style={{ color: '#94a3b8' }}>WhatsApp:</span>
          <a
            href={`https://wa.me/${(branding.whatsapp || '').replace(/[^0-9]/g, '') || '919876543210'}?text=${encodeURIComponent(`Hello ${branding.name}, I would like to inquire about your wealth management services.`)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: '#34d399', textDecoration: 'none', fontWeight: 600 }}
          >
            {branding.whatsapp}
          </a>
        </div>

        <div className="mk-footer-contact-item">
          <span style={{ fontSize: '15px' }}>📞</span>
          <span style={{ color: '#94a3b8' }}>Desk:</span>
          <a href={`tel:${branding.phone}`} style={{ color: '#e2e8f0', textDecoration: 'none', fontWeight: 500 }}>
            {branding.phone}
          </a>
        </div>

        <div className="mk-footer-contact-item">
          <span style={{ fontSize: '15px' }}>✉️</span>
          <span style={{ color: '#94a3b8' }}>Email:</span>
          <a href={`mailto:${branding.email}`} style={{ color: '#e2e8f0', textDecoration: 'none', fontWeight: 500 }}>
            {branding.email}
          </a>
        </div>

        <div className="mk-footer-contact-item" style={{ maxWidth: '420px' }}>
          <span style={{ fontSize: '15px' }}>🏢</span>
          <span style={{ color: '#94a3b8' }}>Office:</span>
          <span style={{ color: '#e2e8f0', opacity: 0.95 }}>{branding.address}</span>
        </div>
      </div>

      <div className="mk-footer-disclaimer" style={{
        maxWidth: '1200px',
        margin: '36px auto 0',
        padding: '20px 24px',
        borderTop: '1px solid var(--line)',
        fontSize: '12px',
        lineHeight: '1.6',
        color: 'var(--muted)',
      }}>
        <strong>Regulatory &amp; Non-Custodial Disclosure:</strong> {branding.name} operates as a non-custodial software and algorithmic wealth management provider. We never take possession, custody, or deposit of your digital assets or fiat currency. Client funds remain exclusively in user-owned accounts on registered exchanges. Access is restricted strictly to trade execution; withdrawal permissions are disabled. Past performance does not guarantee future results. Target returns of 3%–5% monthly are based on systematic quantitative risk models and disciplined stop-loss execution.
      </div>

      <div className="mk-footer-bottom">
        <span>© {COPYRIGHT_YEAR} {branding.name} · Wealth Management with Zero Custody Risk</span>
        <span className="rung-badge">100% Capital Protected · Non-Custodial</span>
      </div>
    </footer>
  );
}

const COPYRIGHT_YEAR = 2026;
