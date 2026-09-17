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
  const classes = `brand has-custom-logo ${sizeClass} ${className}`.trim();

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
