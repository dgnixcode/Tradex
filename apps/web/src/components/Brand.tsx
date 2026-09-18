import { Link } from 'react-router-dom';
import { useBranding, determineLogoType } from '../branding.tsx';
import { AzaWordmark } from './AzaWordmark.tsx';

interface BrandProps {
  readonly to?: string;
  readonly onClick?: () => void;
  readonly className?: string;
  readonly showName?: boolean;
  readonly customName?: string;
  readonly customLogo?: string | null;
  readonly size?: 'sm' | 'md' | 'lg';
}

export function Brand({
  to,
  onClick,
  className = '',
  showName = true,
  customName,
  customLogo,
  size = 'md',
}: BrandProps) {
  const { branding } = useBranding();

  const name = customName !== undefined ? customName : branding.name;
  const logo = customLogo !== undefined ? customLogo : branding.logo;
  const logoType = customLogo !== undefined ? determineLogoType(customLogo) : (customName !== undefined ? branding.logoType : branding.logoType);

  const hasCustomLogo = logoType !== 'default' && logo !== null && logo !== '';

  const sizeClass = size === 'sm' ? 'brand-sm' : size === 'lg' ? 'brand-lg' : '';
  const classes = `brand ${hasCustomLogo ? 'has-custom-logo' : ''} ${sizeClass} ${className}`.trim();

  const isAzaDefault = name.toLowerCase().replace(/\s+/g, '').includes('azawealthkare');

  const content = hasCustomLogo ? (
    <>
      {logoType === 'image' && (
        <img
          src={logo!}
          alt={`${name} logo`}
          className="brand-logo-img"
          onError={(e) => {
            // Fallback to hide broken image
            e.currentTarget.style.display = 'none';
          }}
        />
      )}
      {logoType === 'icon' && (
        <span className="brand-logo-icon" aria-hidden="true">
          {logo}
        </span>
      )}
      {showName && <span className="brand-name">{name}</span>}
    </>
  ) : isAzaDefault ? (
    showName ? (
      <span className="brand-official-logo">
        <img src="/images/logo-dark.png" alt="Aza WealthKare" className="brand-logo-img brand-logo-dark" />
        <img src="/images/logo-white.png" alt="Aza WealthKare" className="brand-logo-img brand-logo-white" />
      </span>
    ) : (
      <span className="brand-official-emblem">
        <img src="/images/icon.png" alt="Aza WealthKare" className="brand-emblem-img" />
      </span>
    )
  ) : (
    <AzaWordmark size={size} showName={showName} customName={name} />
  );

  if (to) {
    return (
      <Link to={to} className={classes} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <div className={classes} onClick={onClick}>
      {content}
    </div>
  );
}
