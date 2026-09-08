import { Link } from 'react-router-dom';

// Reusable marketing footer. Columns of links plus the brand blurb and the
// rung-0 note — the same honesty the app header carries, so a visitor learns
// before signing in that the platform currently previews and dry-runs trades.
// Links that have no destination yet point at section anchors or '#', to be
// wired as those pages exist.

interface FooterCol {
  readonly title: string;
  readonly links: readonly { readonly label: string; readonly href: string }[];
}

const COLUMNS: readonly FooterCol[] = [
  {
    title: 'Product',
    links: [
      { label: 'How it works', href: '#how' },
      { label: 'Features', href: '#features' },
      { label: 'Safety', href: '#safety' },
    ],
  },
  {
    title: 'Platform',
    links: [
      { label: 'Multi-account trading', href: '#features' },
      { label: 'Exact-money engine', href: '#safety' },
      { label: 'Order preview', href: '#how' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'About', href: '#' },
      { label: 'Contact', href: '#' },
      { label: 'Status', href: '#' },
    ],
  },
];

export function MarketingFooter() {
  return (
    <footer className="mk-footer">
      <div className="mk-footer-inner">
        <div className="mk-footer-brand">
          <Link to="/" className="brand">Tradex</Link>
          <p>
            One order across every connected exchange account — sized per account,
            checked before it goes out, reconciled after.
          </p>
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
      <div className="mk-footer-bottom">
        <span>© {COPYRIGHT_YEAR} Tradex · Multi-account trading, unified</span>
        <span className="rung-badge">preview &amp; dry-run</span>
      </div>
    </footer>
  );
}

// A fixed year rather than a runtime new Date(): the build is deterministic and
// the footer year is not worth a clock read that would differ between renders.
const COPYRIGHT_YEAR = 2026;
