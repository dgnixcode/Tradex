-- 003_fix_audit_partition_scope.sql
-- plan/phase-00 T00.5 (correction) · DATA-MODEL.md, 22 F5
--
-- 002 shipped `ensure_audit_partition` with an unqualified existence test:
--
--     IF EXISTS (SELECT 1 FROM pg_class WHERE relname = part) THEN
--
-- `pg_class` holds every relation in the database, so that matches a table of
-- that name in ANY schema. The function then reports "already exists" and
-- creates nothing.
--
-- Two ways that bites, and the second is the one that costs us:
--
--   1. Two schemas in one database. Found by `checks/01-db-live`, which applies
--      the migrations into a throwaway `tradex_check` schema: with
--      `public.audit_event_2026_09` already present from a real run, the
--      function created 0 of the 4 monthly partitions there, and only the
--      DEFAULT partition existed.
--
--   2. Archived partitions. This function is what the monthly scheduler calls.
--      Detaching an old partition and moving it to an `archive` schema — the
--      obvious retention strategy — leaves its name in `pg_class` forever. From
--      then on the function silently refuses to create that month again, and
--      every audit write for it lands in `audit_event_overflow`, which 002's own
--      comment calls an alarm rather than a home.
--
-- Migrations here are immutable (the runner hard-errors on a changed checksum),
-- so this replaces the function and backfills what the broken one skipped.
--
-- The fix resolves `audit_event` through `search_path` and creates the partition
-- in the SAME schema as its parent. Both halves matter: the function must work
-- in whichever schema the caller operates in, and it must not be fooled by a
-- same-named table somewhere else.

BEGIN;

CREATE OR REPLACE FUNCTION ensure_audit_partition(target date)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  start_at date := date_trunc('month', target)::date;
  end_at   date := (date_trunc('month', target) + interval '1 month')::date;
  part     text := format('audit_event_%s', to_char(start_at, 'YYYY_MM'));
  parent   oid  := to_regclass('audit_event');
  ns       text;
BEGIN
  IF parent IS NULL THEN
    RAISE EXCEPTION 'audit_event is not on search_path %', current_schemas(true);
  END IF;

  SELECT n.nspname INTO ns
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = parent;

  -- Schema-qualified, so an archived or unrelated table of the same name in
  -- another schema cannot make this return early.
  IF EXISTS (
    SELECT 1
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = part AND n.nspname = ns
  ) THEN
    RETURN format('%s.%s already exists', ns, part);
  END IF;

  EXECUTE format(
    'CREATE TABLE %I.%I PARTITION OF %I.audit_event FOR VALUES FROM (%L) TO (%L)',
    ns, part, ns, start_at, end_at
  );
  RETURN format('created %s.%s', ns, part);
END;
$$;

-- Backfill the window 002 was supposed to create. Idempotent now that the
-- existence test is correct, so this is safe on a database where 002 worked.
DO $$
DECLARE
  i integer;
BEGIN
  FOR i IN 0..3 LOOP
    PERFORM ensure_audit_partition((current_date + (i || ' months')::interval)::date);
  END LOOP;
END;
$$;

COMMIT;
