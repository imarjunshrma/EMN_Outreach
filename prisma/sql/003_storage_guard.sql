-- StoredObject rows must belong to the same organization as their workspace (defence in depth for
-- storage accounting). Idempotent: re-applied by `npm run db:migrate`.
CREATE OR REPLACE FUNCTION emn_stored_object_org() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE org uuid;
BEGIN
  SELECT "organizationId" INTO org FROM "Workspace" WHERE id = NEW."workspaceId";
  IF org IS NULL OR org <> NEW."organizationId" THEN
    RAISE EXCEPTION 'tenant guard: StoredObject organization does not match its workspace' USING ERRCODE = '23514';
  END IF;
  IF NEW."bytes" < 0 THEN
    RAISE EXCEPTION 'StoredObject bytes cannot be negative' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS emn_stored_object_org ON "StoredObject";
CREATE TRIGGER emn_stored_object_org BEFORE INSERT OR UPDATE ON "StoredObject" FOR EACH ROW EXECUTE FUNCTION emn_stored_object_org();
