import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchPublicBranding } from './api.ts';

export interface PlatformBranding {
  readonly name: string;
  readonly logo: string | null;
  readonly logoType: 'image' | 'icon' | 'default';
  readonly email: string;
  readonly phone: string;
  readonly whatsapp: string;
  readonly address: string;
  readonly hours: string;
}

export interface BrandingUpdates {
  readonly name?: string;
  readonly logo?: string | null;
  readonly email?: string;
  readonly phone?: string;
  readonly whatsapp?: string;
  readonly address?: string;
  readonly hours?: string;
}

interface BrandingContextValue {
  readonly branding: PlatformBranding;
  readonly updateBranding: (updates: BrandingUpdates) => void;
  readonly resetBranding: () => void;
}

const STORAGE_KEY = 'tradex_platform_branding';
export const DEFAULT_BRAND_NAME = 'Aza WealthKare';
export const DEFAULT_EMAIL = 'support@azawealthkare.com';
export const DEFAULT_PHONE = '+91 98765 43210';
export const DEFAULT_WHATSAPP = '+91 98765 43210';
export const DEFAULT_ADDRESS = 'Level 14, Tower B, Financial District, Bandra Kurla Complex (BKC), Mumbai, Maharashtra 400051';
export const DEFAULT_HOURS = 'Monday – Saturday: 9:00 AM – 8:00 PM IST';

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
      const parsed = JSON.parse(raw) as Partial<PlatformBranding>;
      const name = typeof parsed.name === 'string' && parsed.name.trim() !== '' ? parsed.name.trim() : DEFAULT_BRAND_NAME;
      const logo = typeof parsed.logo === 'string' && parsed.logo.trim() !== '' ? parsed.logo.trim() : null;
      const email = typeof parsed.email === 'string' && parsed.email.trim() !== '' ? parsed.email.trim() : DEFAULT_EMAIL;
      const phone = typeof parsed.phone === 'string' && parsed.phone.trim() !== '' ? parsed.phone.trim() : DEFAULT_PHONE;
      const whatsapp = typeof parsed.whatsapp === 'string' && parsed.whatsapp.trim() !== '' ? parsed.whatsapp.trim() : DEFAULT_WHATSAPP;
      const address = typeof parsed.address === 'string' && parsed.address.trim() !== '' ? parsed.address.trim() : DEFAULT_ADDRESS;
      const hours = typeof parsed.hours === 'string' && parsed.hours.trim() !== '' ? parsed.hours.trim() : DEFAULT_HOURS;
      return {
        name,
        logo,
        logoType: determineLogoType(logo),
        email,
        phone,
        whatsapp,
        address,
        hours,
      };
    }
  } catch {
    // If localStorage is unavailable or corrupted, return default
  }
  return {
    name: DEFAULT_BRAND_NAME,
    logo: null,
    logoType: 'default',
    email: DEFAULT_EMAIL,
    phone: DEFAULT_PHONE,
    whatsapp: DEFAULT_WHATSAPP,
    address: DEFAULT_ADDRESS,
    hours: DEFAULT_HOURS,
  };
}

const BrandingContext = createContext<BrandingContextValue | null>(null);

export function BrandingProvider({ children }: { readonly children: ReactNode }) {
  const [branding, setBranding] = useState<PlatformBranding>(loadInitialBranding);

  // Sync to localStorage and document.title whenever state changes
  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          name: branding.name,
          logo: branding.logo,
          email: branding.email,
          phone: branding.phone,
          whatsapp: branding.whatsapp,
          address: branding.address,
          hours: branding.hours,
        })
      );
    } catch {
      // ignore storage quota or private browsing errors
    }
    if (typeof document !== 'undefined' && branding.name) {
      if (document.title.includes('·')) {
        const prefix = document.title.split('·')[0]?.trim();
        document.title = prefix ? `${prefix} · ${branding.name}` : branding.name;
      } else if (document.title.includes('-')) {
        const suffix = document.title.split('-')[1]?.trim();
        document.title = suffix ? `${branding.name} - ${suffix}` : branding.name;
      } else {
        document.title = `${branding.name} - Institutional Wealth Management`;
      }
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

  // Sync from server on initial mount
  useEffect(() => {
    let active = true;
    fetchPublicBranding()
      .then((server) => {
        if (!active) return;
        setBranding({
          name: server.name || DEFAULT_BRAND_NAME,
          logo: server.logo,
          logoType: determineLogoType(server.logo),
          email: server.email || DEFAULT_EMAIL,
          phone: server.phone || DEFAULT_PHONE,
          whatsapp: server.whatsapp || DEFAULT_WHATSAPP,
          address: server.address || DEFAULT_ADDRESS,
          hours: server.hours || DEFAULT_HOURS,
        });
      })
      .catch(() => {
        // Keep initial local state if server unreachable
      });
    return () => {
      active = false;
    };
  }, []);

  const updateBranding = (updates: BrandingUpdates) => {
    setBranding((prev) => {
      const nextName = updates.name !== undefined ? (updates.name.trim() || DEFAULT_BRAND_NAME) : prev.name;
      const nextLogo = updates.logo !== undefined ? (updates.logo && updates.logo.trim() !== '' ? updates.logo.trim() : null) : prev.logo;
      const nextEmail = updates.email !== undefined ? (updates.email.trim() || DEFAULT_EMAIL) : prev.email;
      const nextPhone = updates.phone !== undefined ? (updates.phone.trim() || DEFAULT_PHONE) : prev.phone;
      const nextWhatsapp = updates.whatsapp !== undefined ? (updates.whatsapp.trim() || DEFAULT_WHATSAPP) : prev.whatsapp;
      const nextAddress = updates.address !== undefined ? (updates.address.trim() || DEFAULT_ADDRESS) : prev.address;
      const nextHours = updates.hours !== undefined ? (updates.hours.trim() || DEFAULT_HOURS) : prev.hours;
      return {
        name: nextName,
        logo: nextLogo,
        logoType: determineLogoType(nextLogo),
        email: nextEmail,
        phone: nextPhone,
        whatsapp: nextWhatsapp,
        address: nextAddress,
        hours: nextHours,
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
      email: DEFAULT_EMAIL,
      phone: DEFAULT_PHONE,
      whatsapp: DEFAULT_WHATSAPP,
      address: DEFAULT_ADDRESS,
      hours: DEFAULT_HOURS,
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
