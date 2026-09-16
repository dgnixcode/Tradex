-- 024_consultation_inquiries.sql
-- Inbound client consultation inquiries from public marketing website (/contact).
-- Global table visible to firm desk operators.

BEGIN;

CREATE TABLE consultation_inquiry (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  email        text NOT NULL,
  phone        text NOT NULL,
  capital      text NOT NULL,
  exchange     text NOT NULL,
  method       text NOT NULL,
  notes        text,
  status       text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'onboarded', 'archived')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  contacted_at timestamptz,
  contacted_by text
);

CREATE INDEX consultation_inquiry_created_at_idx ON consultation_inquiry (created_at DESC);
CREATE INDEX consultation_inquiry_status_idx ON consultation_inquiry (status);

COMMIT;
