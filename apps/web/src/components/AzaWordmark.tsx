export interface AzaWordmarkProps {
  readonly size?: 'sm' | 'md' | 'lg';
  readonly showName?: boolean;
  readonly customName?: string;
  readonly className?: string;
}

/**
 * Institutional SVG Monogram for Aza WealthKare.
 * Geometric faceted 'A' chevron symbolizing compounding alpha, upward growth, and capital security.
 */
export function AzaMonogram({ size = 28, className = '' }: { readonly size?: number; readonly className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 36 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`aza-monogram ${className}`.trim()}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="aza-gem-grad" x1="2" y1="2" x2="34" y2="34" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="50%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
        <linearGradient id="aza-gold-grad" x1="10" y1="6" x2="26" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fef08a" />
          <stop offset="50%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
        <linearGradient id="aza-shield-bg" x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#064e3b" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#022c22" stopOpacity="0.8" />
        </linearGradient>
      </defs>

      {/* Hexagonal Shield Background */}
      <polygon
        points="18,3 32,9 32,27 18,33 4,27 4,9"
        fill="url(#aza-shield-bg)"
        stroke="url(#aza-gem-grad)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* Upward Delta Alpha Core (Faceted Stylized A) */}
      <path
        d="M18 7L27 24H21.5L18 16L14.5 24H9L18 7Z"
        fill="url(#aza-gem-grad)"
      />

      {/* Golden Ascending Chevron Crossbar */}
      <path
        d="M14.5 20.5L18 14.5L21.5 20.5L18 18.5L14.5 20.5Z"
        fill="url(#aza-gold-grad)"
      />

      {/* Central Growth Diamond */}
      <polygon
        points="18,22 20.5,25.5 18,27.5 15.5,25.5"
        fill="#ffffff"
        opacity="0.9"
      />
    </svg>
  );
}

/**
 * Bespoke Institutional Wordmark for Aza WealthKare.
 */
export function AzaWordmark({
  size = 'md',
  showName = true,
  customName,
  className = '',
}: AzaWordmarkProps) {
  const iconSize = size === 'sm' ? 22 : size === 'lg' ? 36 : 28;
  const nameToRender = customName ?? 'Aza WealthKare';

  // Check if name is the default or contains Aza
  const isAzaDefault = nameToRender.toLowerCase().includes('aza wealthkare');

  return (
    <span className={`aza-wordmark-wrapper aza-wordmark-${size} ${className}`.trim()}>
      <AzaMonogram size={iconSize} />

      {showName && (
        <span className="aza-wordmark-text">
          {isAzaDefault ? (
            <>
              <span className="aza-brand-primary">AZA</span>
              <span className="aza-brand-secondary">WEALTHKARE</span>
            </>
          ) : (
            <span className="aza-brand-custom">{nameToRender}</span>
          )}
        </span>
      )}
    </span>
  );
}
