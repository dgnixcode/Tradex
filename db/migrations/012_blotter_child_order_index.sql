-- 012_blotter_child_order_index.sql
-- plan/phase-12 T12.4 — the blotter reads child_order newest-first, cursor-paginated
-- on (created_at, id) within a tenant. Without a tenant + created_at index every
-- page rescans the whole table; at the 50k acceptance this is the difference
-- between a bounded keyset page and a scan. No row changes — additive only.

BEGIN;

CREATE INDEX IF NOT EXISTS child_order_tenant_created_idx
  ON child_order (tenant_id, created_at DESC, id DESC);

COMMIT;
