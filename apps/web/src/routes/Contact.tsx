import { useState } from 'react';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';
import { useBranding } from '../branding.tsx';

export function Contact() {
  const { branding } = useBranding();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [capital, setCapital] = useState('₹10,00,000 – ₹25,00,000');
  const [exchange, setExchange] = useState('CoinDCX');
  const [method, setMethod] = useState('WhatsApp');
  const [notes, setNotes] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
  };

  return (
    <div className="landing landing-light">
      <MarketingHeader />

      <section className="mk-section mk-block" style={{ paddingTop: '60px', paddingBottom: '30px' }}>
        <div className="section-head" style={{ maxWidth: '780px', margin: '0 auto', textAlign: 'center' }}>
          <span className="kicker">Confidential Client Advisory</span>
          <h1 style={{ fontSize: '42px', fontWeight: 800, margin: '14px 0 20px', letterSpacing: '-0.03em' }}>
            Schedule Your Private <span className="wm-grad">Wealth Consultation</span>
          </h1>
          <p style={{ fontSize: '17px', lineHeight: 1.6, color: 'var(--text-dim)' }}>
            Connect with a senior portfolio advisor from {branding.name}. We will structure your non-custodial capital allocation, review your safety parameters, and guide you through secure CoinDCX onboarding.
          </p>
        </div>
      </section>

      <section className="mk-section mk-block" style={{ paddingTop: '10px' }}>
        <div style={{ maxWidth: '1040px', margin: '0 auto', display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: '40px' }} className="wm-contact-grid">
          
          {/* Form Card */}
          <div className="wm-pillar-card" style={{ padding: '36px' }}>
            {submitted ? (
              <div style={{ textAlign: 'center', padding: '30px 10px' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
                <h3 style={{ fontSize: '24px', fontWeight: 800, marginBottom: '12px', color: 'var(--ink)' }}>
                  Consultation Request Received
                </h3>
                <p style={{ fontSize: '15px', color: 'var(--text-dim)', lineHeight: 1.6, maxWidth: '440px', margin: '0 auto 24px' }}>
                  Thank you, <strong>{name}</strong>. A senior portfolio manager from {branding.name} will reach out to you via <strong>{method}</strong> at <strong>{phone}</strong> within 2 hours.
                </p>
                <div style={{ padding: '16px', borderRadius: '8px', background: 'rgba(22, 163, 74, 0.08)', border: '1px solid rgba(22, 163, 74, 0.25)', fontSize: '13px', color: '#15803d', textAlign: 'left' }}>
                  <strong>🔒 Security Reminder:</strong> Our advisors will NEVER request your exchange password, OTPs, or fund transfers. You maintain 100% custody in your personal CoinDCX account.
                </div>
                <button
                  type="button"
                  onClick={() => setSubmitted(false)}
                  className="btn secondary btn-sm"
                  style={{ marginTop: '24px' }}
                >
                  Submit Another Inquiry
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                <h3 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 20px', color: 'var(--ink)' }}>
                  Investor Information
                </h3>

                <div className="field">
                  <label htmlFor="c-name">Full Name</label>
                  <input
                    id="c-name"
                    type="text"
                    placeholder="e.g. Rahul Sharma"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>

                <div className="field">
                  <label htmlFor="c-email">Email Address</label>
                  <input
                    id="c-email"
                    type="email"
                    placeholder="you@domain.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>

                <div className="field">
                  <label htmlFor="c-phone">Phone / WhatsApp Number</label>
                  <input
                    id="c-phone"
                    type="tel"
                    placeholder="+91 98765 43210"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                  />
                </div>

                <div className="field">
                  <label htmlFor="c-capital">Planned Investment Capital</label>
                  <select
                    id="c-capital"
                    value={capital}
                    onChange={(e) => setCapital(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      border: '1px solid var(--line-strong)',
                      fontSize: '14px',
                      background: '#fff',
                      color: 'var(--ink)',
                    }}
                  >
                    <option value="₹1,00,000 – ₹5,00,000">₹1,00,000 – ₹5,00,000 ($1,500 – $6,000)</option>
                    <option value="₹5,00,000 – ₹10,00,000">₹5,00,000 – ₹10,00,000 ($6,000 – $12,000)</option>
                    <option value="₹10,00,000 – ₹25,00,000">₹10,00,000 – ₹25,00,000 ($12,000 – $30,000)</option>
                    <option value="₹25,00,000 – ₹50,00,000">₹25,00,000 – ₹50,00,000 ($30,000 – $60,000)</option>
                    <option value="₹50,00,000+">₹50,00,000+ ($60,000+ Institutional Allocation)</option>
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="c-exchange">Primary Exchange Account</label>
                  <select
                    id="c-exchange"
                    value={exchange}
                    onChange={(e) => setExchange(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      border: '1px solid var(--line-strong)',
                      fontSize: '14px',
                      background: '#fff',
                      color: 'var(--ink)',
                    }}
                  >
                    <option value="CoinDCX">CoinDCX (Recommended INR &amp; USDT)</option>
                    <option value="Binance">Binance (Global)</option>
                    <option value="Other">Other Tier-1 Exchange</option>
                    <option value="Need Guidance">I Need Help Opening a CoinDCX Account</option>
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="c-method">Preferred Contact Channel</label>
                  <div style={{ display: 'flex', gap: '12px', marginTop: '6px' }}>
                    {['WhatsApp', 'Phone Call', 'Google Meet'].map((m) => (
                      <label key={m} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13.5px', cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="contact-method"
                          value={m}
                          checked={method === m}
                          onChange={() => setMethod(m)}
                        />
                        {m}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="c-notes">Questions or Specific Requirements (Optional)</label>
                  <textarea
                    id="c-notes"
                    rows={3}
                    placeholder="Tell us about your portfolio goals or timeline..."
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      border: '1px solid var(--line-strong)',
                      fontSize: '14px',
                      background: '#fff',
                      fontFamily: 'inherit',
                    }}
                  />
                </div>

                <button type="submit" className="btn btn-lg wm-btn-primary" style={{ width: '100%', marginTop: '10px' }}>
                  Request Confidential Consultation →
                </button>
              </form>
            )}
          </div>

          {/* Contact Details & Guarantees Column */}
          <div>
            <div className="wm-pillar-card" style={{ padding: '32px', marginBottom: '24px' }}>
              <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px', color: 'var(--ink)' }}>
                Direct Advisory Channels
              </h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '14px' }}>
                <li style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '18px' }}>💬</span>
                  <div>
                    <strong>WhatsApp Priority Desk:</strong>
                    <div style={{ color: 'var(--text-dim)', marginTop: '2px' }}>Direct advisory line for clients</div>
                  </div>
                </li>
                <li style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '18px' }}>✉️</span>
                  <div>
                    <strong>Advisory Email:</strong>
                    <div style={{ color: 'var(--text-dim)', marginTop: '2px' }}>support@azawealthkare.com</div>
                  </div>
                </li>
                <li style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <span style={{ fontSize: '18px' }}>🕒</span>
                  <div>
                    <strong>Operating Hours:</strong>
                    <div style={{ color: 'var(--text-dim)', marginTop: '2px' }}>Monday – Saturday: 9:00 AM – 8:00 PM IST</div>
                  </div>
                </li>
              </ul>
            </div>

            <div className="wm-pillar-card" style={{ padding: '28px', background: 'rgba(22, 163, 74, 0.05)', borderColor: 'rgba(22, 163, 74, 0.25)' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px' }}>
                <span style={{ fontSize: '24px' }}>🛡️</span>
                <strong style={{ fontSize: '16px', color: '#15803d' }}>
                  Our Ironclad Investor Guarantees
                </strong>
              </div>
              <ul className="wm-pillar-points" style={{ borderTop: 'none', paddingTop: 0, margin: 0 }}>
                <li>100% of your funds remain in your personal CoinDCX account</li>
                <li>Zero withdrawal authority granted to anyone</li>
                <li>Guaranteed 100% capital preservation framework</li>
                <li>Target 3% to 5% net monthly profit compounding</li>
                <li>Instant 24/7 liquidity directly to your bank account</li>
              </ul>
            </div>
          </div>

        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
