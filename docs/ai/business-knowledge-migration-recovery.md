# Business knowledge migration recovery

`20261124130000_emn_business_knowledge` adds the business service/proof lifecycle and campaign selection tables, immutable snapshot attribution, tenant-composite foreign keys, and database triggers for workspace-consistent campaign snapshots and approved service selection. It marks active legacy `OutreachExample` rows human-approved only when a human `createdById` is present, recording that creator and creation timestamp as the review provenance. Active rows without a recorded creator remain unapproved. It has no safe inverse SQL because reversing it would discard service definitions, provenance, reviews, and feedback links.

The JSON snapshot triggers complement, but do not replace, application checks: they validate embedded workspace IDs at insert/update time; runtime code checks current service/proof revocation and expiry before campaign generation. The migration must be applied and exercised against an isolated database before it is treated as operationally verified.

Before applying it to any local database, make a custom-format backup and verify the target database name and host. Prefer a throwaway database for the first apply:

```sh
pg_dump --format=custom --no-owner --dbname="$LOCAL_DATABASE_URL" --file="/private/tmp/outvexa-before-business-knowledge.dump"
createdb --maintenance-db="$LOCAL_DATABASE_URL" emn_business_knowledge_verify
```

Set `DATABASE_URL` and `DATABASE_MIGRATION_URL` to that newly created local verification database, then run `npm run db:migrate`. Validate Prisma access and application integration there before applying to the intended local development database.

If migration or verification fails, keep the affected database intact for diagnosis. Restore the pre-migration dump into a **new, empty database** and point the local app at that restored copy; do not use `pg_restore --clean` against the source. Example:

```sh
createdb --maintenance-db="$LOCAL_DATABASE_URL" emn_business_knowledge_recovery
pg_restore --no-owner --no-privileges --exit-on-error \
  --dbname="${LOCAL_DATABASE_URL%/*}/emn_business_knowledge_recovery" \
  /private/tmp/outvexa-before-business-knowledge.dump
```

This is a forward-only migration/recovery-by-restore policy. The repository restore script replaces its configured database and is destructive; do not use it for this drill without independently validating its target.
