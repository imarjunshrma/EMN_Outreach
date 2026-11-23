# Installation — Ubuntu VPS (no Docker, no AWS)

Tested layout: Ubuntu 22.04 / 24.04, 2 vCPU, 4 GB RAM, 40 GB disk is enough for one agency workspace.
Everything (PostgreSQL, Redis, API, worker, web UI) runs on the same server; only Nginx listens publicly.

```
Internet ──443──> Nginx ──> 127.0.0.1:3000  Next.js web UI      (emn-web.service)
                        └─> 127.0.0.1:4000  Express API + SSE   (emn-api.service)
                                            BullMQ worker       (emn-worker.service)
                            PostgreSQL 127.0.0.1:5432 · Redis 127.0.0.1:6379
Files: /opt/emn/releases/<ts> (code) · /opt/emn/current → active release · /opt/emn/shared/.env
       /var/lib/emn/storage (uploads/exports) · /var/lib/emn/backups · /var/log/emn
```

## 1. DNS and firewall

1. Create an `A` record, e.g. `outreach.yourdomain.com` → server IP.
2. Firewall: allow 22, 80, 443 only.
   ```bash
   sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
   ```

## 2. Prepare the server (one time)

Upload `EMN-Outreach-OS-Full-Project.zip` and unpack it, then:

```bash
sudo apt-get install -y unzip && unzip EMN-Outreach-OS-Full-Project.zip && cd emn-outreach-os
sudo bash scripts/install.sh outreach.yourdomain.com
```

`install.sh` installs Node 22, PostgreSQL, Redis, Nginx and Certbot; creates the `emn` system user and
directories; creates two database roles (`emn_owner` for migrations, `emn_app` for runtime, see
`deployment/postgres/setup.sql`); password-protects Redis with `noeviction` + AOF; writes
`/opt/emn/shared/.env` (mode 600) with freshly generated database/Redis passwords, `SESSION_SECRET` and
`ENCRYPTION_KEYS`; installs the systemd units, logrotate config and the Nginx site. It is safe to re-run and
never overwrites an existing `.env`.

## 3. TLS certificate

```bash
sudo certbot certonly --nginx -d outreach.yourdomain.com
sudo ln -sf /etc/nginx/sites-available/emn.conf /etc/nginx/sites-enabled/emn.conf
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```
Certbot installs a renewal timer automatically (`systemctl list-timers | grep certbot`).

## 4. Configure `.env`

`sudo nano /opt/emn/shared/.env` — every variable is documented in `.env.example`. Usually you only add:

* `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (step 7)
* `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` (step 8), optionally `GRAPH_WEBHOOKS_ENABLED=true`
* `PUBLIC_REGISTRATION` stays `false` (invite teammates from Settings → Team).

AI keys and data-provider keys are **not** put in `.env`; you add them in the app, where they are stored
encrypted with AES-256-GCM.

**Back up `.env` securely.** Losing `ENCRYPTION_KEYS` means every stored token and API key must be re-entered.

## 5. Deploy

```bash
sudo bash scripts/deploy.sh                     # systemd (default)
# or: sudo PROCESS_MANAGER=pm2 bash scripts/deploy.sh   (after: sudo npm i -g pm2)
```

The script copies the code to a new release folder, runs `npm ci` and builds backend, worker and UI,
backs up the database (if a previous release exists), runs `prisma migrate deploy` + SQL guards + seed,
switches `/opt/emn/current`, restarts services and runs `scripts/healthcheck.sh`. If the health check
fails it switches back to the previous release automatically. Migrations are forward-only; to undo a
migration restore the pre-deploy backup (step 11).

Use **either** systemd **or** PM2, never both. For PM2: `pm2 save && pm2 startup` and disable the units
(`sudo systemctl disable --now emn-api emn-worker emn-web`).

## 6. Create the owner account

Open `https://outreach.yourdomain.com/setup` (works only while no user exists), or from the shell:

```bash
cd /opt/emn/current
sudo -u emn EMN_ADMIN_PASSWORD='a-long-passphrase' npm run create-admin -- \
  --email you@elitemedianetworks.com --name "Your Name" --workspace "Elite Media Networks"
```

Then in the app: **Settings → General** (company postal address, booking link, offer facts),
**Settings → Compliance** (review country rules), **Settings → AI** (add Anthropic/OpenAI keys),
**Settings → Integrations** (Apollo, MillionVerifier, Brave/Serper, Smartlead, booking secret),
**Domains** (add your sending domains and run the DNS check), **Email accounts** (connect mailboxes).

## 7. Google Workspace (Gmail API)

1. Google Cloud Console → new project → *APIs & Services → Library* → enable **Gmail API**.
2. *OAuth consent screen*: choose **Internal** if every mailbox you will connect is in your own Google
   Workspace organisation (no Google verification needed). **External** requires Google's verification
   for the restricted `gmail.modify` scope, including an annual third-party security assessment, before
   mailboxes outside your organisation (or more than 100 test users) can connect.
3. Scopes: `openid`, `email`, `profile`, `gmail.send`, `gmail.modify`.
4. *Credentials → Create OAuth client ID → Web application*. Authorized redirect URI:
   `https://outreach.yourdomain.com/api/v1/oauth/callback/google`
5. Put the client ID/secret in `.env`, restart: `sudo systemctl restart emn-api emn-worker`.
6. Gmail sending limits are set by Google for your Workspace plan; EMN never tries to exceed or bypass them.

## 8. Microsoft 365 (Graph)

1. Entra admin center → *App registrations → New registration*, supported account types:
   *Accounts in any organizational directory* (multi-tenant) or single tenant.
2. Redirect URI (Web): `https://outreach.yourdomain.com/api/v1/oauth/callback/microsoft`
3. *API permissions → Microsoft Graph → Delegated*: `User.Read`, `Mail.ReadWrite`, `Mail.Send`,
   `offline_access`, `openid`, `profile`, `email`. If your tenant restricts user consent, an admin must
   **Grant admin consent**. For other organisations' tenants, publisher verification is recommended.
4. *Certificates & secrets → New client secret*; copy the value into `MICROSOFT_CLIENT_SECRET`
   (secrets expire — note the date). Set `MICROSOFT_TENANT=common` (multi-tenant) or your tenant ID.
5. Optional push sync: `GRAPH_WEBHOOKS_ENABLED=true` (requires the public HTTPS `APP_URL`). Polling every
   2 minutes always runs regardless.
6. Accounts bought through a reseller (e.g. GoDaddy-managed Microsoft 365) sometimes block app consent
   or SMTP AUTH; if consent fails, the tenant admin has to allow it — EMN cannot work around that.

## 9. SMTP / IMAP mailboxes

Email accounts → *Connect SMTP/IMAP*: host/port/user/app password for both. Use this only where the
provider permits SMTP sending for your use case. The connection is tested before saving.

## 10. Operations

| Task | Command |
|---|---|
| Status | `systemctl status emn-api emn-worker emn-web` |
| Logs | `tail -f /var/log/emn/{api,worker,web}.log` (rotated daily, 14 kept) |
| Health | `bash /opt/emn/current/scripts/healthcheck.sh` |
| Restart | `sudo systemctl restart emn-api emn-worker emn-web` |
| Upgrade | unpack the new zip, `cd emn-outreach-os && sudo bash scripts/deploy.sh` |
| Job monitor / errors | in the app: Settings → Jobs, Settings → Logs |
| Forgotten password | `cd /opt/emn/current && sudo -u emn npm run reset-password -- --email user@company.com` (revokes their sessions) |
| Rotate encryption key | add `2:<new key>` to `ENCRYPTION_KEYS`, set `ENCRYPTION_ACTIVE_KEY=2`, restart; new writes use key 2, old values still decrypt. Keep old keys until all secrets were re-saved. |

## 11. Backups and restore

```bash
# nightly backup (DB + storage), keep 14 days
echo '15 2 * * * root bash /opt/emn/current/scripts/backup.sh >> /var/log/emn/backup.log 2>&1' | sudo tee /etc/cron.d/emn-backup
# copy /var/lib/emn/backups off the server regularly (rsync/rclone to another host)

# restore (stops services, replaces data, starts services)
sudo bash /opt/emn/current/scripts/restore.sh /var/lib/emn/backups/emn-db-<stamp>.dump /var/lib/emn/backups/emn-storage-<stamp>.tar.gz
```
Test a restore at least once on a spare database before you need it.

## 12. Troubleshooting

* **`/readyz` fails** — check `DATABASE_URL`/`REDIS_URL` in `.env`, `systemctl status postgresql redis-server`.
* **OAuth "redirect_uri_mismatch"** — the redirect URI must match `APP_URL` exactly (https, no trailing slash).
* **Mailbox shows NEEDS_REAUTH** — the token was revoked or the password changed; click *Reconnect*.
* **Campaign auto-paused** — open the campaign log: content changed after approval, bounce-rate threshold,
  or a disconnected mailbox. Fix the cause, re-approve if needed, resume.
* **Realtime updates missing** — the SSE location in the Nginx config must keep `proxy_buffering off`.

## Installing on a server that already hosts other sites (CloudPanel, Plesk, a PM2 app)

Use shared-server mode. It leaves everything that is already there alone:

```bash
sudo EMN_SHARED_SERVER=1 bash scripts/install.sh outvexa.com
```

| | Normal install | Shared-server mode |
|---|---|---|
| Node.js | Upgrades the system Node to 22 | Private Node 22 in `/opt/emn/node`; the system Node (and PM2 apps) keep theirs |
| Redis | Adds a password to the system Redis | Its own Redis on `127.0.0.1:6380` (`emn-redis` service); the existing Redis is untouched |
| Ports | web 3000, API 4000 | web **3100**, API 4000 (change with `EMN_WEB_PORT` / `EMN_API_PORT`); refuses ports already in use |
| Nginx / SSL | Installs Nginx + Certbot and writes a site | Touches neither: you add the site in your panel |
| Packages | `apt-get install` (may upgrade) | Installs only missing packages; never upgrades or restarts existing ones |
| Swap | — | Adds a 2 GB swap file if RAM < 6 GB and there is none (the UI build needs memory) |

Then, in **CloudPanel**:
1. **Sites → Add Site → Create a Reverse Proxy**: domain `outvexa.com`, reverse proxy URL `http://127.0.0.1:3100`.
2. Open the site → **SSL/TLS → Actions → New Let's Encrypt Certificate** (add `www.outvexa.com` too).
3. Open the site → **Vhost**: inside the `server { … 443 … }` block, paste the contents of `/opt/emn/shared/nginx-site.conf`
   **above** the existing `location / {` block, then **Save**. This sends `/api` to the API and keeps live updates unbuffered.

Deploy with `sudo bash scripts/deploy.sh` as usual (it reads the choices from `/opt/emn/shared/install.conf`).
Outvexa runs under systemd as the `emn` user (`emn-api`, `emn-worker`, `emn-web`, `emn-redis`); the PM2 apps keep running as before.
