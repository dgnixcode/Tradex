export interface AzaWordmarkProps {
  readonly size?: 'sm' | 'md' | 'lg';
  readonly showName?: boolean;
  readonly customName?: string;
  readonly className?: string;
}

/**
 * Institutional SVG Monogram for Aza WealthKare.
 * Pure geometric faceted 'A' chevron with golden ascending delta trajectory.
 * Clean transparent background with no dark cubes or dots.
 */
export function AzaMonogram({ size = 36, className = '' }: { readonly size?: number; readonly className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`aza-monogram ${className}`.trim()}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="aza-gem-grad" x1="4" y1="4" x2="36" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="50%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#059669" />
        </linearGradient>
        <linearGradient id="aza-gold-grad" x1="12" y1="18" x2="28" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#fef08a" />
          <stop offset="50%" stopColor="#f59e0b" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
      </defs>

      {/* Stylized Ascending Geometric 'A' Wings */}
      <path
        d="M20 4L5 35H12L20 18L28 35H35L20 4Z"
        fill="url(#aza-gem-grad)"
      />

      {/* Dynamic Golden Ascending Delta Crossbar */}
      <path
        d="M13 26L20 17.5L27 26L20 23.5L13 26Z"
        fill="url(#aza-gold-grad)"
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
  // Bigger, more prominent icon sizing
  const iconSize = size === 'sm' ? 28 : size === 'lg' ? 48 : 36;
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
