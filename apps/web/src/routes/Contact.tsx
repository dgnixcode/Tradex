import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';
import { useBranding } from '../branding.tsx';
import { submitConsultationInquiry } from '../api.ts';

export function Contact() {
  const { branding } = useBranding();
  const [searchParams] = useSearchParams();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [capital, setCapital] = useState('₹10,00,000 – ₹25,00,000');
  const [exchange, setExchange] = useState('Personal Trading Account');
  const [method, setMethod] = useState('WhatsApp');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    const rawCapital = searchParams.get('capital');
    if (rawCapital) {
      const capNum = Number(rawCapital);
      if (!Number.isNaN(capNum)) {
        if (capNum >= 5000000) setCapital('₹50,00,000+');
        else if (capNum >= 2500000) setCapital('₹25,00,000 – ₹50,00,000');
        else if (capNum >= 1000000) setCapital('₹10,00,000 – ₹25,00,000');
        else if (capNum >= 500000) setCapital('₹5,00,000 – ₹10,00,000');
        else setCapital('₹1,00,000 – ₹5,00,000');
      }
    }
  }, [searchParams]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await submitConsultationInquiry({
        name,
        email,
        phone,
        capital,
        exchange,
        method,
        notes: notes.trim() || undefined,
      });
      setSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to submit inquiry. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="landing landing-dark">
      <MarketingHeader />

      <div className="wm-subpage-hero-wrap">
        <section className="mk-section mk-block" style={{ padding: '20px 0 10px' }}>
          <div className="section-head" style={{ maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
            <span className="kicker">Aza WealthKare Private Advisory</span>
            <h1 className="wm-subpage-title">
              Schedule Your <span className="wm-grad">Aza WealthKare Consultation</span>
            </h1>
            <p className="wm-subpage-sub">
              Connect with a senior portfolio advisor from Aza WealthKare. We will structure your non-custodial capital allocation, review your safety parameters, and guide you through secure trading account onboarding.
            </p>
          </div>
        </section>
      </div>

      <section className="mk-section mk-block" style={{ paddingTop: '40px' }}>
        <div style={{ maxWidth: '1040px', margin: '0 auto', display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: '40px' }} className="wm-contact-grid">
          
          {/* Form Card */}
          <div className="wm-pillar-card wm-subpage-content-card">
            {submitted ? (
              <div style={{ textAlign: 'center', padding: '30px 10px' }}>
                <div style={{ fontSize: '48px', marginBottom: '16px' }}>✅</div>
                <h3 style={{ fontSize: '24px', fontWeight: 800, marginBottom: '12px', color: '#0b1a30', fontFamily: "'Playfair Display', Georgia, serif" }}>
                  Consultation Request Received
                </h3>
                <p style={{ fontSize: '15px', color: '#475569', lineHeight: 1.6, maxWidth: '440px', margin: '0 auto 24px' }}>
                  Thank you, <strong>{name}</strong>. A senior portfolio manager from Aza WealthKare will reach out to you via <strong>{method}</strong> at <strong>{phone}</strong> within 2 hours.
                </p>
                <div style={{ padding: '16px', borderRadius: '8px', background: 'rgba(0, 82, 204, 0.08)', border: '1px solid rgba(0, 82, 204, 0.25)', fontSize: '13px', color: '#0052cc', textAlign: 'left' }}>
                  <strong>🔒 Security Reminder:</strong> Aza WealthKare advisors will NEVER request your exchange password, OTPs, or fund transfers. You maintain 100% custody in your personal trading account.
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
                <h3 style={{ fontSize: '20px', fontWeight: 700, margin: '0 0 20px', color: '#0b1a30', fontFamily: "'Playfair Display', Georgia, serif" }}>
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
                      fontSize: '14px',
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
                      fontSize: '14px',
                    }}
                  >
                    <option value="Personal Trading Account">Your Trading Account (Any Exchange)</option>
                    <option value="CoinDCX">CoinDCX (INR &amp; USDT)</option>
                    <option value="Binance">Binance (Global USDT)</option>
                    <option value="Other">Other Registered Exchange</option>
                    <option value="Need Guidance">I Need Help Setting Up a Trading Account</option>
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="c-method">Preferred Contact Channel</label>
                  <div style={{ display: 'flex', gap: '12px', marginTop: '6px', flexWrap: 'wrap' }}>
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
                      fontSize: '14px',
                      fontFamily: 'inherit',
                    }}
                  />
                </div>

                {error && (
                  <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.4)', color: '#f87171', fontSize: '13.5px', marginBottom: '14px' }}>
                    ⚠️ {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="btn btn-lg wm-btn-primary"
                  style={{ width: '100%', marginTop: '6px', opacity: submitting ? 0.7 : 1, cursor: submitting ? 'not-allowed' : 'pointer' }}
                >
                  {submitting ? 'Submitting Request...' : 'Request Wealth Consultation →'}
                </button>
              </form>
            )}
          </div>

          {/* Contact Details & Guarantees Column */}
          <div>
            <div className="wm-pillar-card" style={{ padding: '32px', marginBottom: '24px' }}>
              <h3 style={{ fontSize: '20px', fontWeight: 800, marginBottom: '16px', color: '#0b1a30', fontFamily: "'Playfair Display', Georgia, serif" }}>
                {branding.name} Direct Advisory Channels
              </h3>
              <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '16px', fontSize: '14px' }}>
                <li style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <span style={{ fontSize: '20px', color: '#25D366' }}>💬</span>
                  <div style={{ flex: 1 }}>
                    <strong style={{ color: '#0b1a30' }}>WhatsApp Priority Desk:</strong>
                    <div style={{ color: '#475569', marginTop: '2px' }}>
                      <a
                        href={`https://wa.me/${(branding.whatsapp || '').replace(/[^0-9]/g, '') || '919876543210'}?text=${encodeURIComponent(`Hello ${branding.name}, I would like to inquire about your wealth management services.`)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: '#059669', textDecoration: 'none', fontWeight: 600 }}
                      >
                        {branding.whatsapp || '+91 98765 43210'} ↗
                      </a>
                    </div>
                  </div>
                </li>
                <li style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <span style={{ fontSize: '20px' }}>📞</span>
                  <div style={{ flex: 1 }}>
                    <strong style={{ color: '#0b1a30' }}>Direct Advisory Line:</strong>
                    <div style={{ color: '#475569', marginTop: '2px' }}>
                      <a href={`tel:${branding.phone}`} style={{ color: '#0052cc', textDecoration: 'none', fontWeight: 600 }}>
                        {branding.phone}
                      </a>
                    </div>
                  </div>
                </li>
                <li style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <span style={{ fontSize: '20px' }}>✉️</span>
                  <div style={{ flex: 1 }}>
                    <strong style={{ color: '#0b1a30' }}>Advisory Email:</strong>
                    <div style={{ color: '#475569', marginTop: '2px' }}>
                      <a href={`mailto:${branding.email}`} style={{ color: '#0052cc', textDecoration: 'none', fontWeight: 600 }}>
                        {branding.email}
                      </a>
                    </div>
                  </div>
                </li>
                <li style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <span style={{ fontSize: '20px' }}>🏢</span>
                  <div style={{ flex: 1 }}>
                    <strong style={{ color: '#0b1a30' }}>Corporate Office:</strong>
                    <div style={{ color: '#475569', marginTop: '3px', lineHeight: 1.45, fontSize: '13.5px' }}>
                      {branding.address}
                    </div>
                  </div>
                </li>
                <li style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <span style={{ fontSize: '20px' }}>🕒</span>
                  <div style={{ flex: 1 }}>
                    <strong style={{ color: '#0b1a30' }}>Operating Hours:</strong>
                    <div style={{ color: '#475569', marginTop: '2px' }}>{branding.hours}</div>
                  </div>
                </li>
              </ul>
            </div>

            <div className="wm-pillar-card" style={{ padding: '28px', background: 'rgba(0, 82, 204, 0.04)', borderColor: 'rgba(0, 82, 204, 0.2)' }}>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px' }}>
                <span style={{ fontSize: '24px' }}>🛡️</span>
                <strong style={{ fontSize: '16.5px', color: '#0052cc' }}>
                  Our Ironclad Aza WealthKare Investor Guarantees
                </strong>
              </div>
              <ul className="wm-pillar-points" style={{ borderTop: 'none', paddingTop: 0, margin: 0 }}>
                <li>100% of your funds remain in your personal trading account</li>
                <li>Zero withdrawal authority granted to Aza WealthKare or any third party</li>
                <li>Aza WealthKare guaranteed 100% capital preservation framework</li>
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
