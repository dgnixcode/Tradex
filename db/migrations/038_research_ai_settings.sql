BEGIN;

CREATE TABLE research_ai_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenant(id) ON DELETE RESTRICT,
  id uuid NOT NULL UNIQUE,
  provider text NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google')),
  deep_model text NOT NULL,
  quick_model text NOT NULL,
  key_ct bytea NOT NULL,
  updated_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A queued job is bound to the configuration accepted when it was submitted.
-- No credential or ciphertext is copied into a job or a report.
ALTER TABLE research_job ADD COLUMN ai_config_id uuid;

COMMIT;
