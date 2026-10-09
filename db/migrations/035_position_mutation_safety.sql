BEGIN;

ALTER TABLE child_order ADD COLUMN send_started_at timestamptz;
ALTER TABLE algo_strategy ADD COLUMN execution_token uuid;
ALTER TABLE algo_strategy ADD COLUMN execution_started_at timestamptz;

-- A receipt is committed BEFORE a direct position mutation reaches the venue.
-- An interrupted/unknown mutation is never automatically re-sent.
CREATE TABLE position_mutation (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  request_id uuid NOT NULL,
  account_id uuid NOT NULL,
  pair text NOT NULL,
  operation text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('sending', 'completed', 'needs_review')),
  result_json text,
  risk_margin_inr_minor numeric(38,0) CHECK (risk_margin_inr_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (tenant_id, request_id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES exchange_account(tenant_id, id)
);
CREATE INDEX position_mutation_unresolved ON position_mutation(account_id, pair)
  WHERE status <> 'completed';

ALTER TABLE child_order ADD COLUMN position_mutation_request_id uuid;
ALTER TABLE child_order ADD CONSTRAINT child_order_mutation_receipt_fk
  FOREIGN KEY (tenant_id, position_mutation_request_id) REFERENCES position_mutation(tenant_id, request_id);
CREATE UNIQUE INDEX child_order_mutation_receipt_unique ON child_order(tenant_id, position_mutation_request_id);

COMMIT;
