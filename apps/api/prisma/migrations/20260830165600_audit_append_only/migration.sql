-- Enforces append-only at the database level, not just in application code.
--
-- A trigger is used rather than REVOKE UPDATE/DELETE because in this MVP's single-role setup
-- the same Postgres role runs migrations and serves the app; a table's OWNER role bypasses
-- REVOKE'd privileges on its own table, so REVOKE alone would not actually stop it. A
-- BEFORE UPDATE/DELETE trigger fires unconditionally regardless of who owns the table, so it
-- is the trigger, not the grant, that makes this a hard guarantee.
--
-- Production deployments should layer REVOKE on top of this by running the app under a
-- separate, least-privilege role (SELECT/INSERT only on audit_logs) that is NOT the
-- migration/owner role -- defense in depth, not a replacement for the trigger.

CREATE OR REPLACE FUNCTION crop_audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW
  EXECUTE FUNCTION crop_audit_logs_immutable();
