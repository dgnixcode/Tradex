export function HeroVisualCard() {
  return (
    <div className="hero-command-card" aria-label="Aza WealthKare Institutional Wealth Command">
      {/* Top Header Bar */}
      <div className="hero-command-topbar">
        <div className="command-topbar-left">
          <span className="command-window-dot dot-red" />
          <span className="command-window-dot dot-amber" />
          <span className="command-window-dot dot-green" />
          <span className="command-title">AZA WEALTHKARE · NON-CUSTODIAL DESK</span>
        </div>
        <div className="command-topbar-right">
          <span className="command-status-pill">
            <span className="command-live-dot" />
            <span>TRADE-ONLY API</span>
          </span>
        </div>
      </div>

      {/* Centerpiece Media Frame with Floating Trust Badges */}
      <div className="hero-command-media">
        <img
          src="/images/crypto_bull_hero.jpg"
          alt="Aza WealthKare Institutional Crypto Bull and Non-Custodial Architecture"
          className="hero-command-img"
          loading="eager"
        />

        {/* Subtle radial glare overlay */}
        <div className="hero-command-glare" />

        {/* Floating Glass Chip: Non-Custodial Security */}
        <div className="hero-float-chip chip-vault">
          <div className="float-chip-icon">🛡️</div>
          <div className="float-chip-meta">
            <span className="float-chip-title">Non-Custodial Vault</span>
            <span className="float-chip-sub">100% In Your Exchange</span>
          </div>
        </div>

        {/* Floating Glass Chip: Monthly Alpha Target */}
        <div className="hero-float-chip chip-alpha">
          <div className="float-chip-icon">📈</div>
          <div className="float-chip-meta">
            <span className="float-chip-title">+3% to +5% / mo</span>
            <span className="float-chip-sub">Compounding Target</span>
          </div>
        </div>
      </div>

      {/* Institutional Telemetry Strip */}
      <div className="hero-command-telemetry">
        <div className="command-telemetry-col">
          <span className="telemetry-col-label">CUSTODY MODEL</span>
          <span className="telemetry-col-value text-emerald">100% In Your Account</span>
          <span className="telemetry-col-sub">Zero Third-Party Risk</span>
        </div>

        <div className="command-telemetry-col">
          <span className="telemetry-col-label">WITHDRAWAL ACCESS</span>
          <span className="telemetry-col-value text-coral">0% (Technically Disabled)</span>
          <span className="telemetry-col-sub">Restricted API Keys</span>
        </div>

        <div className="command-telemetry-col">
          <span className="telemetry-col-label">SUPPORTED VENUES</span>
          <span className="telemetry-col-value text-cyan">Binance · OKX · Bybit</span>
          <span className="telemetry-col-sub">Direct Account Delegation</span>
        </div>
      </div>

      {/* Verification Guarantee Footer Bar */}
      <div className="hero-command-footer">
        <div className="command-footer-badge">
          <span className="footer-badge-icon">✓</span>
          <span className="footer-badge-text">
            <strong>Capital Protection Guarantee:</strong> Your funds never leave your personal exchange. Management is 100% non-custodial.
          </span>
        </div>
      </div>
    </div>
  );
}
