# Deployment and recovery guide — v1.4.0

Two supported topologies: **systemd/PM2 on a VM** (`scripts/install.sh`, `scripts/deploy.sh`, `deployment/systemd`, `deployment/pm2`, `deployment/nginx`) and **Docker Compose** (`docker-compose.yml`, `deployment/docker`). Both run the same processes: API, worker, web (Next.js), PostgreSQL 16, Redis 7.

## 1. Deploy

1. Copy `.env.example` to the server's `.env` (VM: `/opt/emn/shared/.env`). Generate keys with `node scripts/gen-keys.mjs`. Never commit `.env`.
2. Required in production: `NODE_ENV=production`, `DATABASE_URL` (runtime role), `DATABASE_MIGRATION_URL` (owner role), `REDIS_URL`, `ENCRYPTION_KEYS`, `SESSION_SECRET`, `APP_URL`, `SYSTEM_SMTP_URL`, payment keys if billing is on. Leave `PLATFORM_MFA_REQUIRED` unset: setting it to `false` is ignored when `NODE_ENV=production`, so staff 2FA is always enforced there.
3. Optional v1.4 settings: `METRICS_TOKEN` (enables `/metrics`), `MAX_ORGS_PER_USER` (default 5), `JOB_TIMEOUT_MS`.
4. VM: `bash scripts/deploy.sh` (build, migrate, restart). Compose: `docker compose --profile tools run --rm migrate` then `docker compose up -d`.

## 2. Migrations

- `npm run db:migrate` runs `prisma migrate deploy` then the SQL guard files in `prisma/sql/` (tenant triggers, `003_storage_guard.sql`).
- All v1.4 changes are additive (`20261121150000_v1_4_billing_storage_trials`). No column is dropped or rewritten.
- Run migrations with the **owner** role only; the app runs with the **runtime** role.

## 3. Least-privilege database roles

- Compose: `deployment/docker/postgres-init/001-runtime-role.sh` creates `emn_app` (runtime, CONNECT only plus grants applied by the migrate step) and strips superuser powers from the owner `emn_owner`. `Dockerfile.migrate` runs migrations as the owner.
- VM: `deployment/postgres/setup.sql` creates the equivalent roles.
- The runtime role cannot alter schema, disable triggers, or create roles.

## 4. Health, readiness and metrics

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /healthz` | Liveness | Always `{ok:true}` if the process runs |
| `GET /readyz` | Readiness | Checks DB and Redis; returns `ok`/`error` per check, never error text |
| `GET /metrics` | Prometheus text | 404 unless `METRICS_TOKEN` is set; requires `Authorization: Bearer <token>` |

`scripts/healthcheck.sh` probes these for cron or uptime monitors.

## 5. Recommended alerts

- `/readyz` not ok for 2 minutes.
- Queue backlog growing for 15 minutes or dead-letter count increasing (`/platform/operations`).
- Webhook failures (`BillingEvent` with errors) or reconciliation drift reported by `billing.reconcile`.
- 5xx rate above 1% for 5 minutes (from the reverse proxy logs).
- Disk usage on storage root above 80%; backup job not producing a file in 26 hours.

## 6. Backup and restore

- Backup: `scripts/backup.sh` (cron daily) dumps PostgreSQL in custom format and tars local storage, keeping 14 days. Back up `.env` (holds `ENCRYPTION_KEYS`) separately and securely — without it stored credentials cannot be decrypted.
- Restore: `scripts/restore.sh` (destructive; only onto a target you intend to replace).
- **Restore drill (non-destructive):** `SOURCE_DATABASE_URL=<url> bash scripts/restore-drill.sh` dumps the source, restores into a new temporary database `emn_restore_drill_<ts>`, compares row counts for every table, checks migration status, and drops the temporary database.
- Drill result in the build VM (2026-11-21, source `emn_dev`): dump 308 KB, 96 tables, all row counts identical, migrations up to date, drill DB dropped. This is a development-database drill, not a production one.

## 7. Redis and object storage recovery

- Redis holds queues, rate limits and caches; no system of record. On loss, restart Redis; scheduled jobs are re-registered by the worker at start. In-flight jobs may need `/platform/operations` → retry.
- Local object storage is restored from the storage tarball. After any restore run the storage reconcile job (scheduled daily at 00:37, or trigger by restarting the worker) so `StoredObject` accounting matches disk.

## 8. Rollback

1. Re-deploy the previous release directory (VM keeps releases under `/opt/emn/releases`) or the previous image tag.
2. v1.4 migrations are additive, so v1.3 code runs against a v1.4 schema; do not roll back the schema.
3. If data was damaged, restore from the last backup into a new database, verify with the drill script's comparison, then switch `DATABASE_URL`.

## 9. Incident response (short form)

1. Declare, assign one lead, open a timeline.
2. Contain: suspend affected organizations from the platform console, rotate leaked keys (add a new key to `ENCRYPTION_KEYS` and point `ENCRYPTION_ACTIVE_KEY` at it; old keys stay listed so existing data still decrypts), revoke sessions by disabling users.
3. Investigate with the platform audit trail and support-access log (both append-only).
4. Recover per sections 6–8.
5. Notify affected customers as required by your legal obligations; write a postmortem.

## 10. Not verified

No staging or production infrastructure was available. Deployment scripts were exercised only in the build VM; Compose files were not run in this pass.
