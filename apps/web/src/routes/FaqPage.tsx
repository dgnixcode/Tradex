import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';
import { useBranding } from '../branding.tsx';

interface CategoryFaq {
  readonly category: string;
  readonly items: readonly { readonly q: string; readonly a: string }[];
}

const FAQ_SECTIONS: readonly CategoryFaq[] = [
  {
    category: 'Custody, Safety & CoinDCX',
    items: [
      {
        q: 'Can anyone withdraw or transfer money from my account?',
        a: 'No, absolutely not. When connecting your account, withdrawal permissions are permanently disabled. We only receive execution rights to buy and sell on your behalf. Even our own administrators cannot transfer a single rupee or coin out of your account.',
      },
      {
        q: 'Why do you use CoinDCX instead of holding client funds?',
        a: 'We believe holding client funds creates unnecessary counterparty risk. By keeping your capital in your personal CoinDCX wallet, you benefit from exchange-grade cold storage, two-factor authentication, and direct bank settlement.',
      },
      {
        q: 'Can I withdraw my money or stop trading anytime?',
        a: 'Yes, 100%. Because your funds never leave your personal exchange account, you retain total liquidity. You can withdraw your profits to your linked bank account or stop management at any second.',
      },
    ],
  },
  {
    category: 'Returns & Profit Compounding',
    items: [
      {
        q: 'How is the 3%–5% monthly profit generated?',
        a: 'Our quantitative desk executes systematic, disciplined trading across low-risk market spreads, delta-hedging, and trend momentum. By employing rigorous 1:2+ risk-to-reward ratios and automated trailing stop-losses, we capture steady monthly returns while capping downside risk.',
      },
      {
        q: 'Where do the trading profits go?',
        a: 'All profits settle immediately and directly into your personal CoinDCX balance in real-time. You can view every fill, profit, and position in your CoinDCX mobile app 24/7.',
      },
      {
        q: 'What is the compounding effect over a year?',
        a: 'At a steady 4% monthly return, compounding your profits over 12 months produces an effective annual yield of ~60.1% APY without ever exposing your principal to unhedged risk.',
      },
    ],
  },
  {
    category: 'Capital Protection & Risk Management',
    items: [
      {
        q: 'How does the 100% Capital Safety Guarantee work?',
        a: 'We operate under a strict capital preservation mandate. Every managed position is bracketed by automated downside stop-losses and strict portfolio drawdown caps. Our proprietary risk containment architecture prevents catastrophic drops and preserves your initial principal.',
      },
      {
        q: 'What happens during sudden market crashes?',
        a: 'Our 12 automated pre-trade safety gates monitor live exchange spreads and depth. If market conditions become disorderly, trailing circuit breakers automatically de-escalate positions to cash (INR/USDT) to insulate client capital.',
      },
    ],
  },
  {
    category: 'Onboarding & Getting Started',
    items: [
      {
        q: 'What is the minimum capital required to get started?',
        a: 'You can begin with as little as ₹50,000 (or $500 USDT) in your personal exchange account. For optimal position sizing and multi-leg risk diversification, accounts of ₹1 Lakh to ₹50 Lakhs+ are recommended.',
      },
      {
        q: 'How do I start with Aza WealthKare?',
        a: 'Simply fill out our consultation inquiry form. Our senior wealth manager will connect with you via WhatsApp or phone, structure your risk parameters, and guide you through secure trade-only onboarding.',
      },
    ],
  },
];

export function FaqPage() {
  const { branding } = useBranding();
  const [openIndex, setOpenIndex] = useState<string>('0-0');

  const toggle = (key: string) => {
    setOpenIndex(openIndex === key ? '' : key);
  };

  return (
    <div className="landing landing-dark">
      <MarketingHeader />

      <div className="wm-subpage-hero-wrap">
        <section className="mk-section mk-block" style={{ padding: '20px 0 10px' }}>
          <div className="section-head" style={{ maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
            <span className="kicker">{branding.name} Knowledge Base</span>
            <h1 style={{ fontSize: '44px', fontWeight: 850, margin: '14px 0 20px', letterSpacing: '-0.03em', color: '#ffffff' }}>
              Frequently Asked <span className="wm-grad">Questions</span>
            </h1>
            <p style={{ fontSize: '17px', lineHeight: 1.6, color: '#94a3b8' }}>
              Transparent answers about our non-custodial crypto wealth management, capital protection covenants, and client onboarding.
            </p>
          </div>
        </section>
      </div>

      <section className="mk-section mk-block" style={{ paddingTop: '40px' }}>
        <div style={{ maxWidth: '880px', margin: '0 auto' }}>
          {FAQ_SECTIONS.map((sec, secIdx) => (
            <div key={sec.category} style={{ marginBottom: '40px' }}>
              <h2 style={{ fontSize: '22px', fontWeight: 800, color: '#ffffff', marginBottom: '16px', paddingBottom: '8px', borderBottom: '1px solid rgba(255, 255, 255, 0.08)' }}>
                {sec.category}
              </h2>

              <div className="wm-faq-wrap" style={{ margin: 0 }}>
                {sec.items.map((item, itemIdx) => {
                  const key = `${secIdx}-${itemIdx}`;
                  const isOpen = openIndex === key;

                  return (
                    <div
                      key={item.q}
                      className={`wm-faq-item ${isOpen ? 'open' : ''}`}
                      onClick={() => toggle(key)}
                    >
                      <div className="wm-faq-question">
                        <span>{item.q}</span>
                        <span className="wm-faq-icon">{isOpen ? '−' : '+'}</span>
                      </div>
                      {isOpen && (
                        <div className="wm-faq-answer">
                          <p>{item.a}</p>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Need more help */}
          <div className="wm-final-cta-wrap" style={{ marginTop: '50px' }}>
            <h2 style={{ fontSize: '32px', fontWeight: 850, margin: '0 0 14px' }}>
              Have a Specific Question for Our Desk?
            </h2>
            <p style={{ color: '#94a3b8', marginBottom: '28px', fontSize: '15.5px' }}>
              Our senior portfolio advisors are available for one-on-one portfolio discussions.
            </p>
            <Link to="/contact" className="btn btn-lg wm-btn-primary" style={{ textDecoration: 'none' }}>
              Contact Our Advisory Team →
            </Link>
          </div>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
