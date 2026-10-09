BEGIN;

CREATE TABLE research_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  request jsonb NOT NULL,
  engine text NOT NULL CHECK (engine IN ('snapshot', 'tradingagents')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  stage text NOT NULL DEFAULT 'Waiting for a research worker',
  lease_token uuid,
  lease_expires_at timestamptz,
  deadline_at timestamptz,
  report jsonb,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  CHECK ((status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND deadline_at IS NOT NULL)),
  CHECK ((status = 'completed') = (report IS NOT NULL))
);
CREATE INDEX research_job_queue ON research_job(engine, created_at, id) WHERE status = 'queued';
CREATE INDEX research_job_tenant_history ON research_job(tenant_id, created_at DESC, id DESC);
CREATE INDEX research_job_expired ON research_job(lease_expires_at) WHERE status = 'running';
CREATE UNIQUE INDEX research_job_one_running_tenant ON research_job(tenant_id) WHERE status = 'running';

-- Worker discovery contains deployment health only, never customer data.
CREATE TABLE research_worker (
  id uuid PRIMARY KEY,
  engine text NOT NULL CHECK (engine IN ('snapshot', 'tradingagents')),
  heartbeat_at timestamptz NOT NULL DEFAULT now()
);

COMMIT;
