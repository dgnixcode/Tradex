import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface PlatformBranding {
  readonly name: string;
  readonly logo: string | null;
  readonly logoType: 'image' | 'icon' | 'default';
}

interface BrandingContextValue {
  readonly branding: PlatformBranding;
  readonly updateBranding: (updates: { name?: string; logo?: string | null }) => void;
  readonly resetBranding: () => void;
}

const STORAGE_KEY = 'tradex_platform_branding';
export const DEFAULT_BRAND_NAME = 'Tradex';

export function determineLogoType(logo: string | null): 'image' | 'icon' | 'default' {
  if (!logo || logo.trim() === '') return 'default';
  const trimmed = logo.trim();
  if (
    trimmed.startsWith('data:image/') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('/') ||
    trimmed.startsWith('blob:')
  ) {
    return 'image';
  }
  return 'icon';
}

function loadInitialBranding(): PlatformBranding {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { name?: string; logo?: string | null };
      const name = typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : DEFAULT_BRAND_NAME;
      const logo = typeof parsed.logo === 'string' && parsed.logo.trim() !== '' ? parsed.logo.trim() : null;
      return {
        name,
        logo,
        logoType: determineLogoType(logo),
      };
    }
  } catch {
    // If localStorage is unavailable or corrupted, return default
  }
  return {
    name: DEFAULT_BRAND_NAME,
    logo: null,
    logoType: 'default',
  };
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

export function BrandingProvider({ children }: { readonly children: ReactNode }) {
  const [branding, setBranding] = useState<PlatformBranding>(loadInitialBranding);

  // Sync to localStorage whenever state changes
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ name: branding.name, logo: branding.logo })
      );
    } catch {
      // ignore storage quota or private browsing errors
    }
  }, [branding]);

  // Sync across tabs
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setBranding(loadInitialBranding());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const updateBranding = (updates: { name?: string; logo?: string | null }) => {
    setBranding((prev) => {
      const nextName = updates.name !== undefined ? (updates.name.trim() || DEFAULT_BRAND_NAME) : prev.name;
      const nextLogo = updates.logo !== undefined ? (updates.logo && updates.logo.trim() !== '' ? updates.logo.trim() : null) : prev.logo;
      return {
        name: nextName,
        logo: nextLogo,
        logoType: determineLogoType(nextLogo),
      };
    });
  };

  const resetBranding = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setBranding({
      name: DEFAULT_BRAND_NAME,
      logo: null,
      logoType: 'default',
    });
  };

  const value = useMemo(() => ({ branding, updateBranding, resetBranding }), [branding]);

  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): BrandingContextValue {
  const ctx = useContext(BrandingContext);
  if (!ctx) {
    throw new Error('useBranding must be used within a BrandingProvider');
  }
  return ctx;
}
