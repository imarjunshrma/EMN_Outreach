-- A workspace row is no longer visible when PostgreSQL executes its cascading
-- child deletes. Link the explicit purge audit event to the workspace IDs
-- captured before deletion, rather than looking the organization up from the
-- row being cascaded.
CREATE OR REPLACE FUNCTION "sequence_version_immutability_guard"() RETURNS TRIGGER AS $$
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
     AND current_setting('emn.allow_sequence_version_purge', true) = 'on'
     AND EXISTS (
       SELECT 1
       FROM "PlatformAuditEvent" e
       WHERE e.action = 'tenant.sequence_versions.purged'
         AND e."targetType" = 'organization'
         AND e."organizationId" IS NOT NULL
         AND e."targetId" = e."organizationId"::TEXT
         AND e.reason = 'Tenant data erasure'
         AND e."createdAt" >= transaction_timestamp()
         AND e.metadata->'workspaceIds' ? OLD."workspaceId"::TEXT
     ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'SequenceVersion records cannot be deleted outside an audited tenant data erasure'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;
