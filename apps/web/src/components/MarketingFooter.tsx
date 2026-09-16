import { Brand } from './Brand.tsx';
import { useBranding } from '../branding.tsx';

interface FooterCol {
  readonly title: string;
  readonly links: readonly { readonly label: string; readonly href: string }[];
}

const COLUMNS: readonly FooterCol[] = [
  {
    title: 'Wealth Management',
    links: [
      { label: 'Non-Custodial Model', href: '#model' },
      { label: 'Capital Guarantee', href: '#guarantee' },
      { label: 'Profit Calculator', href: '#calculator' },
      { label: 'How It Works', href: '#how-it-works' },
    ],
  },
  {
    title: 'Exchanges & Access',
    links: [
      { label: 'CoinDCX Integration', href: '#model' },
      { label: 'Trade-Only API Keys', href: '#security' },
      { label: 'Zero Withdrawal Access', href: '#security' },
      { label: '24/7 Liquidity', href: '#faq' },
    ],
  },
  {
    title: 'Risk & Architecture',
    links: [
      { label: '12 Pre-Trade Safety Gates', href: '#security' },
      { label: 'Algorithmic Stop Loss', href: '#guarantee' },
      { label: 'Principal Protection', href: '#guarantee' },
      { label: 'Exact-Decimal Math', href: '#security' },
    ],
  },
  {
    title: 'Client Support',
    links: [
      { label: 'Frequently Asked Questions', href: '#faq' },
      { label: 'Client Portal Login', href: '/login' },
      { label: 'Security Overview', href: '#security' },
      { label: 'System Status', href: '#' },
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
            Institutional-grade crypto wealth management. Your funds remain safely inside your personal CoinDCX or exchange account at all times. Systematic algorithmic execution generating consistent 3%–5% monthly returns with 100% capital protection.
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
              <a key={l.label} href={l.href}>{l.label}</a>
            ))}
          </div>
        ))}
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
        <strong>Regulatory &amp; Non-Custodial Disclosure:</strong> {branding.name} operates as a non-custodial software and algorithmic asset management platform. We never take possession, custody, or deposit of your digital assets or fiat currency. Client funds remain exclusively in user-owned accounts on registered exchanges (such as CoinDCX). Access is restricted strictly to read and trade execution via API keys; withdrawal permissions are disabled. Past performance does not guarantee future results. Target returns of 3%–5% monthly are based on systematic quantitative risk models and disciplined stop-loss execution.
      </div>

      <div className="mk-footer-bottom">
        <span>© {COPYRIGHT_YEAR} {branding.name} · Wealth Management with Zero Custody Risk</span>
        <span className="rung-badge">100% Capital Protected · Non-Custodial</span>
      </div>
    </footer>
  );
}

const COPYRIGHT_YEAR = 2026;
