-- 002_audit_partitions.sql
-- plan/phase-00 T00.5 · DATA-MODEL.md, 22 F5
--
-- Partition maintenance for audit_event. Creates the current month plus the
-- next three, and provides a function the scheduler calls monthly.
--
-- A missing partition is an INSERT failure, which on this table means an audit
-- write fails — so the window is deliberately generous and the scheduler runs
-- this well ahead of need.

BEGIN;

CREATE OR REPLACE FUNCTION ensure_audit_partition(target date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  start_at date := date_trunc('month', target)::date;
  end_at   date := (date_trunc('month', target) + interval '1 month')::date;
  part     text := format('audit_event_%s', to_char(start_at, 'YYYY_MM'));
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
    RETURN format('%s already exists', part);
  END IF;
  EXECUTE format(
    'CREATE TABLE %I PARTITION OF audit_event FOR VALUES FROM (%L) TO (%L)',
    part, start_at, end_at
  );
  RETURN format('created %s', part);
END;
$$;

-- Pre-create the current month and the next three.
DO $$
DECLARE
  i integer;
BEGIN
  FOR i IN 0..3 LOOP
    PERFORM ensure_audit_partition((current_date + (i || ' months')::interval)::date);
  END LOOP;
END;
$$;

-- A catch-all so an audit write can never fail for want of a partition. Rows
-- landing here are an alarm, not a loss: the scheduler is behind.
CREATE TABLE IF NOT EXISTS audit_event_overflow
  PARTITION OF audit_event DEFAULT;

COMMIT;
