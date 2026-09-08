import { Link } from 'react-router-dom';
import { MarketingHeader } from '../components/MarketingHeader.tsx';
import { MarketingFooter } from '../components/MarketingFooter.tsx';

// The public landing page — an editorial LIGHT theme after the NFT-marketplace
// reference (cream base, italic-serif + bold headline, black primary button,
// stats row with dividers, a big orange panel holding the product visual, and a
// black/white pixel-square motif). The content is entirely Tradex; only the
// layout language is borrowed.
//
// It is viewable whether or not you are logged in: a signed-in visitor is NOT
// bounced to the app (that was a bug — the marketing page is a legitimate place
// to land). The header adapts instead, offering "Go to dashboard" when a session
// exists. Only /login and /signup redirect a logged-in user away, since an auth
// form is pointless once you hold a session.

// A small helper for the 3x3 pixel motif; `on` cells are filled ink/white.
function Pixels({ pattern, className }: { pattern: readonly boolean[]; className?: string }) {
  return (
    <div className={className ?? 'pixel-motif'} aria-hidden="true">
      {pattern.map((on, i) => <i key={i} className={on ? 'on' : ''} />)}
    </div>
  );
}
const MOTIF = [true, true, false, false, true, true, true, false, false];

export function Landing() {
  return (
    <div className="landing landing-light">
      <MarketingHeader />

      {/* -------------------------------------------------- editorial hero */}
      <section className="lite-hero">
        <div className="lite-left">
          <Pixels pattern={MOTIF} />
          <h1 className="lite-h1">
            <span className="serif">One Order</span><br />
            <span className="serif">Across</span> Every<br />
            <span className="accent">Account.</span>
          </h1>
          <p className="lite-sub">
            Connect all your exchange accounts and trade them as one. Every leg is sized
            per account, checked against twelve gates, and previewed before a rupee moves.
          </p>
          <div className="lite-cta">
            <Link to="/login" className="btn btn-lg">Get started</Link>
            <a href="#how" className="lite-learn">Learn more →</a>
          </div>

          <div className="lite-stats">
            <div className="lite-stat"><div className="n">12</div><div className="l">Gates per account</div></div>
            <div className="lite-stat"><div className="n">100%</div><div className="l">Preview matches plan</div></div>
            <div className="lite-stat"><div className="n">0</div><div className="l">Float-point money</div></div>
          </div>
        </div>

        {/* the orange panel + floating product card */}
        <div className="lite-right">
          <div className="lite-panel">
            <span className="fc-mini">Momentum desk · 4 accounts</span>
            <Pixels pattern={MOTIF} className="pixel-motif pixel-corner" />
            <div className="float-card" aria-hidden="true">
              <div className="fc-head">
                <span className="fc-title">Preview · BTC buy · 20%</span>
                <span className="fc-tag">dry-run</span>
              </div>
              <div className="float-row"><span className="k">Account A · ₹1,00,000</span><span className="pill ok">planned</span></div>
              <div className="float-row"><span className="k">Account B · ₹5,00,000</span><span className="pill ok">planned</span></div>
              <div className="float-row"><span className="k">Account C · ₹40,000</span><span className="pill ok">planned</span></div>
              <div className="float-row"><span className="k">Account D · ₹8,000</span><span className="pill skip">skipped</span></div>
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- how it works */}
      <section id="how" className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">How it works</span>
          <h2>From one intent to N checked orders</h2>
          <p>You describe the trade once. Tradex sizes and validates it per account, then shows you every leg before anything is committed.</p>
        </div>
        <div className="steps">
          <div className="step">
            <h3>Describe the trade</h3>
            <p>Pick a group, an asset and a side. Size by percentage, quote amount, quantity, or sell-all — the basis is named inline so 20% is never ambiguous.</p>
          </div>
          <div className="step">
            <h3>Preview per account</h3>
            <p>Each account is priced against the live order book and run through twelve gates. Legs that can&rsquo;t trade are skipped with a numbered reason, not failed silently.</p>
          </div>
          <div className="step">
            <h3>Confirm what you saw</h3>
            <p>The confirmation table is exactly what was planned, row for row. A countdown keeps prices fresh; you approve, and the plan is recorded.</p>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- features */}
      <section id="features" className="mk-section mk-block">
        <div className="section-head">
          <span className="kicker">Built for many accounts</span>
          <h2>Everything scales per account</h2>
          <p>The hard part of trading many accounts isn&rsquo;t the order — it&rsquo;s that every account is different. Tradex treats that as the default.</p>
        </div>
        <div className="features">
          <div className="feature">
            <div className="feature-icon">⚡</div>
            <h3>One trade, many accounts</h3>
            <p>A group trade fans out across every enabled account. A 20% buy is 20% of <em>each</em> account&rsquo;s capital — not a flat amount split awkwardly.</p>
          </div>
          <div className="feature">
            <div className="feature-icon">🛡️</div>
            <h3>Checked before it moves money</h3>
            <p>Twelve gates run per account — balances, caps, market rules, spread. A leg that can&rsquo;t trade is skipped cleanly instead of failing halfway.</p>
          </div>
          <div className="feature">
            <div className="feature-icon">👁️</div>
            <h3>Preview, then confirm</h3>
            <p>Every trade is priced from the live order book and shown per account before commit. What you approve is exactly what was planned.</p>
          </div>
          <div className="feature">
            <div className="feature-icon">🎯</div>
            <h3>Exact money, always</h3>
            <p>Quantities and balances are computed in exact decimal — never floating point — so a paisa never goes missing between the plan and the fill.</p>
          </div>
          <div className="feature">
            <div className="feature-icon">🔀</div>
            <h3>INR and USDT, per account</h3>
            <p>The same asset resolves to whichever market an account can actually fund, preferring the one that avoids order-time tax where it applies.</p>
          </div>
          <div className="feature">
            <div className="feature-icon">🔐</div>
            <h3>Keys stay sealed</h3>
            <p>API keys are encrypted per credential and never leave the signing boundary. The trading desk never holds your plaintext secret.</p>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- safety band */}
      <section id="safety" className="mk-section mk-block">
        <div className="band">
          <div className="section-head" style={{ marginBottom: 32 }}>
            <span className="kicker">Safety first</span>
            <h2>Real money deserves a rehearsal</h2>
            <p>Tradex currently runs in dry-run mode: the full pipeline executes and records exactly what <em>would</em> be sent, without sending it. The send path is built last, on purpose.</p>
          </div>
          <div className="stats">
            <div className="stat"><div className="num">12</div><div className="lbl">gates per account</div></div>
            <div className="stat"><div className="num">0</div><div className="lbl">floating-point money</div></div>
            <div className="stat"><div className="num">1</div><div className="lbl">order-book read per market</div></div>
            <div className="stat"><div className="num">100%</div><div className="lbl">preview matches plan</div></div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------- closing CTA */}
      <section className="mk-section mk-block">
        <div className="cta-final">
          <h2>Ready to see it plan a trade?</h2>
          <p>Log in to your desk, pick a group, and preview a fan-out across every account in seconds.</p>
          <Link to="/login" className="btn btn-lg">Get started</Link>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}
