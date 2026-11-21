# Deployment and operational requirements

- PostgreSQL 16 and Redis 7 are required by the Compose deployment. Runtime credentials and migration-owner credentials are separate in the Compose service configuration.
- Run schema migrations through the dedicated migration service before API/worker startup. Do not run development migrations against production.
- API and worker readiness depends on PostgreSQL/Redis; `/healthz` is liveness and `/readyz` checks both dependencies.
- On a fresh Compose database, the init script creates the app role and demotes the bootstrap `emn_owner` from cluster superuser while keeping it as database owner. Existing initialized volumes do not rerun init scripts; the current pass did not alter or inspect them.
- Keep `SESSION_SECRET`, encryption keys, provider secrets, OAuth client secrets and database passwords out of source control and logs. Keep `.env` private; never copy production values into test configs.
- The API and worker must use the same encryption keyring, database, Redis, and queue prefix for a deployment. Separate test/staging/prod queue prefixes and Redis databases.
- Use TLS termination at the documented reverse proxy; restrict database/Redis ports to private networks. Set `TRUST_PROXY` only to match the actual proxy topology.
- Back up PostgreSQL and uploaded storage together. Test restore into an isolated target before relying on it; this pass did not perform a backup/restore test.
- Docker is unavailable in the current environment, so image builds, compose interpolation, health checks, startup dependencies and restart behavior have not been verified.
- Existing VPS/systemd/PM2 deployment options remain documented in `INSTALLATION.md` and `deployment/`. No deployment was changed or performed in this pass.
