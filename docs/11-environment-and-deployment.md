# 11 — Environment and deployment

Step-by-step instructions: `../INSTALLATION.md`. This document is the reference.

## Target
One Ubuntu 22.04/24.04 VPS running Node 22, PostgreSQL 15+, Redis 7, Nginx and Certbot.
- **No Docker. No AWS.** Changed from the plan: there are no container images or S3. Process management is systemd by default, with PM2 as an alternative.
- Sizing: 2 vCPU / 4 GB RAM is enough for one agency. Move up to 4 vCPU / 8 GB if you run many mailboxes or large research batches.

## Environment variables (`.env.example` documents each)
| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | yes | `production` on servers |
| `APP_URL` | yes | Public HTTPS origin. Used for OAuth redirects, unsubscribe links and webhooks. Cookies are `Secure` when it starts with https. |
| `API_PORT` | no (4000) | API listens on 127.0.0.1:`API_PORT` |
| `TRUST_PROXY` | no (true) | Trust one proxy hop (Nginx) for client IPs |
| `LOG_LEVEL` | no (info) | pino level |
| `DATABASE_URL` | yes | Runtime role (`emn_app`) |
| `DATABASE_MIGRATION_URL` | recommended | Owner role (`emn_owner`) used by `prisma migrate deploy`, the SQL guards and backups |
| `DB_POOL_MAX` | no (10) | pg pool size per process |
| `REDIS_URL` | yes | Password-protected local Redis |
| `QUEUE_PREFIX` | no (emn) | BullMQ key prefix |
| `SESSION_SECRET` | yes | ≥32 chars, signs tokens (unsubscribe, OAuth state, tracking) |
| `ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KEY` | yes | AES-256-GCM keyring `ver:base64key[,ver:key]` |
| `STORAGE_ROOT` | no | Local file storage (default `/var/lib/emn/storage` on servers) |
| `PUBLIC_REGISTRATION` | no (false) | Open sign-up; keep false and use invitations |
| `GOOGLE_CLIENT_ID/SECRET` | for Gmail | OAuth web client |
| `MICROSOFT_CLIENT_ID/SECRET`, `MICROSOFT_TENANT` | for M365 | Entra app |
| `GRAPH_WEBHOOKS_ENABLED` | no (false) | Graph push notifications (needs public HTTPS) |
| `WORKER_CONCURRENCY_SEND` | no (4) | Parallel send jobs |
| `EMN_ENV_FILE` | no | Path of the env file to load (systemd sets `/opt/emn/shared/.env`) |

AI and data-provider keys are entered in the app and stored encrypted. They do not belong in `.env`.

## Layout on the server
```
/opt/emn/releases/<UTC timestamp>/   built code (owned by emn)
/opt/emn/current -> releases/<ts>    active release (services run from here)
/opt/emn/shared/.env                 secrets (600)
/var/lib/emn/storage                 uploads, exports
/var/lib/emn/backups                 pg_dump + storage archives
/var/log/emn/{api,worker,web}.log    logrotate daily x14
```

## Files in `deployment/`
- `nginx/emn.conf`:
  - TLS and HSTS
  - an unbuffered SSE location
  - per-IP rate limits for auth, public endpoints and the API
  - `/readyz` restricted to localhost
  - a 21 MB body limit
  - everything that isn't `/api` goes to the web UI
- `systemd/emn-{api,worker,web}.service`: hardened units (`ProtectSystem=strict`, `NoNewPrivileges` and similar). The worker gets a 90 s graceful stop.
- `pm2/ecosystem.config.cjs`: the same three processes for PM2.
- `logrotate/emn`, `postgres/setup.sql` (owner and app roles, default privileges), `redis/redis.conf.snippet`.

## Scripts
| Script | What it does | Verified in the build environment |
|---|---|---|
| `install.sh <domain>` | Packages, user, directories, DB roles, Redis password, `.env` with generated secrets, units, Nginx site | `bash -n` + shellcheck clean. Not run end-to-end: the sandbox has no systemd or apt access to a fresh VM. |
| `deploy.sh` | Release copy, `npm ci`, build, pre-migration backup, migrate + seed, symlink switch, restart, health check, automatic rollback, prune old releases | shellcheck clean. Its individual steps (build, migrate, seed, start, health check) were run manually. |
| `backup.sh` | `pg_dump -Fc` and a storage tar, 14-day retention | Run against local PostgreSQL ✔ |
| `restore.sh` | Stop services, `pg_restore --clean --single-transaction`, restore storage, start | Restored into a fresh database ✔ (migrations table and files present) |
| `healthcheck.sh` | `/readyz` (DB + Redis), the web `/login` page, worker active | Run against the compiled API and `next start` ✔ |

The Nginx config was validated with `nginx -t` (nginx 1.24) and used to proxy `/healthz`, `/login` and `/api` successfully over TLS.
