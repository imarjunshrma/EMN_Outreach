-- Applied after Prisma migrations by scripts/apply-sql.ts (idempotent).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS lead_email_trgm ON "Lead" USING gin ("emailNormalized" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS lead_name_trgm ON "Lead" USING gin ((coalesce("firstName",'') || ' ' || coalesce("lastName",'')) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS company_name_trgm ON "Company" USING gin ("name" gin_trgm_ops);

-- Scheduler / sender hot paths
CREATE INDEX IF NOT EXISTS enrollment_due_idx ON "SequenceEnrollment" ("nextActionAt") WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS outbound_ready_idx ON "OutboundEmail" ("scheduledFor") WHERE status IN ('PENDING','QUEUED');

-- Audit log is append-only: block UPDATE/DELETE at the database level.
-- (Workspace deletion cascades are allowed via the session flag emn.allow_audit_delete.)
CREATE OR REPLACE FUNCTION emn_audit_immutable() RETURNS trigger AS $$
BEGIN
  IF current_setting('emn.allow_audit_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_no_update ON "AuditLog";
CREATE TRIGGER audit_no_update BEFORE UPDATE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION emn_audit_immutable();
-- Deletes are refused too, except inside a transaction that set emn.allow_audit_delete = 'on'
-- (used only by the retention job for rows older than the workspace's audit retention period).
DROP TRIGGER IF EXISTS audit_no_delete ON "AuditLog";
CREATE TRIGGER audit_no_delete BEFORE DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION emn_audit_immutable();
