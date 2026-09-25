-- 025_platform_branding.sql
-- Global company branding and public contact channels (synced to footer, contact page, WhatsApp).

BEGIN;

CREATE TABLE platform_branding (
  id         text PRIMARY KEY DEFAULT 'default',
  name       text NOT NULL DEFAULT 'Aza WealthKare',
  logo       text,
  email      text NOT NULL DEFAULT 'support@azawealthkare.com',
  phone      text NOT NULL DEFAULT '+91 98765 43210',
  whatsapp   text NOT NULL DEFAULT '+91 98765 43210',
  address    text NOT NULL DEFAULT 'Unit No-217 second Floor Tower 3 RPS 12TH Avenue Sector  27C, Main Mathura Road  Faridabad 121003',
  hours      text NOT NULL DEFAULT 'Monday – Saturday: 9:00 AM – 8:00 PM IST',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

INSERT INTO platform_branding (id, name, logo, email, phone, whatsapp, address, hours)
VALUES (
  'default',
  'Aza WealthKare',
  NULL,
  'support@azawealthkare.com',
  '+91 98765 43210',
  '+91 98765 43210',
  'Unit No-217 second Floor Tower 3 RPS 12TH Avenue Sector  27C, Main Mathura Road  Faridabad 121003',
  'Monday – Saturday: 9:00 AM – 8:00 PM IST'
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
