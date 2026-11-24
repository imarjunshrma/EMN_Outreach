-- SequenceVersion rows are created only as part of campaign approval. There is
-- no draft SequenceVersion lifecycle in the application, so each row is frozen
-- at insertion. Normal updates and deletes (including parent cascades) are
-- rejected. Tenant erasure is the only delete exception and requires both a
-- transaction-local opt-in and a matching platform audit record.

CREATE OR REPLACE FUNCTION "sequence_version_immutability_guard"() RETURNS TRIGGER AS $$
DECLARE
  purge_org_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM "Campaign" c
      WHERE c.id = NEW."campaignId"
        AND c."workspaceId" = NEW."workspaceId"
        AND c.status = 'APPROVED'
        AND c."approvedContentHash" = NEW."contentHash"
    ) THEN
      RAISE EXCEPTION 'SequenceVersion can only be created for the currently approved campaign snapshot in the same workspace'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'SequenceVersion records are immutable; approve a new campaign version instead'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE'
     AND current_setting('emn.allow_sequence_version_purge', true) = 'on' THEN
    SELECT w."organizationId" INTO purge_org_id
    FROM "Workspace" w
    WHERE w.id = OLD."workspaceId";

    IF purge_org_id IS NOT NULL AND EXISTS (
      SELECT 1
      FROM "PlatformAuditEvent" e
      WHERE e."organizationId" = purge_org_id
        AND e.action = 'tenant.sequence_versions.purged'
        AND e."targetId" = purge_org_id::TEXT
        AND e.reason = 'Tenant data erasure'
        AND e."createdAt" >= transaction_timestamp()
    ) THEN
      RETURN OLD;
    END IF;
  END IF;

  RAISE EXCEPTION 'SequenceVersion records cannot be deleted outside an audited tenant data erasure'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "SequenceVersion_immutability_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "SequenceVersion"
FOR EACH ROW EXECUTE FUNCTION "sequence_version_immutability_guard"();
