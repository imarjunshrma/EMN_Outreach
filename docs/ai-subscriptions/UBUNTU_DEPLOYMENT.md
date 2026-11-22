# Personal AI subscriptions — Ubuntu deployment

Applies to the existing VM deployment (`scripts/install.sh`, `scripts/deploy.sh`, systemd units in `deployment/systemd`, or PM2). No Docker, no AWS, no proxy services. Commands assume the defaults of the existing installer: app user `emn`, release in `/opt/emn/current`, env file `/opt/emn/shared/.env`, data in `/var/lib/emn`.

> **Use rule.** Anthropic's Agent SDK documentation says third-party developers may not offer claude.ai login or rate limits to *their* users without approval. This integration is built for one person using their own subscription, and the server enforces it: only the emails in `AI_SUBSCRIPTION_OWNER_EMAILS`, who must also be SUPER_ADMIN with 2FA, can use it. Never put other people's emails there, and never expose it to customers. OpenAI documents ChatGPT-managed sign-in for automation as an advanced path for private machines and recommends API keys for general automation; keep this server private.

## 1. What runs where

| Piece | How it is installed | Where it keeps state |
|---|---|---|
| Claude Agent SDK `@anthropic-ai/claude-agent-sdk` (bundles the official Claude Code binary for linux-x64/arm64) | `npm ci` during deploy (it is a dependency) | Token encrypted in PostgreSQL (`AiSubscriptionConnection`); child-process HOME in `/var/lib/emn/ai-subscriptions/<user-id>/claude` |
| Codex SDK `@openai/codex-sdk` + official CLI `@openai/codex` | `npm ci` during deploy | Codex's own sign-in file `auth.json` in `/var/lib/emn/ai-subscriptions/<user-id>/codex/.codex` (Codex refreshes it itself) |
| Claude Code CLI for `claude setup-token` | Official installer, on any machine with a browser (your Mac is simplest) | Prints the token; stores nothing |

The API process starts the Codex sign-in and runs connection tests. The worker process runs workflow stages. Both need the same `AI_SUBSCRIPTION_HOME`.

## 2. One-time server setup

```bash
# Node 22 is already required by the app
node --version

# Private directory for subscription sessions (inside the units' ReadWritePaths=/var/lib/emn)
sudo install -d -o emn -g emn -m 700 /var/lib/emn/ai-subscriptions

# Environment (replace the email with your own login email)
KEY="$(openssl rand -base64 32)"
sudo tee -a /opt/emn/shared/.env >/dev/null <<EOF

AI_SUBSCRIPTION_OWNER_EMAILS=you@elitemedianetworks.com
AI_SUBSCRIPTION_ENCRYPTION_KEY=$KEY
AI_SUBSCRIPTION_HOME=/var/lib/emn/ai-subscriptions
EOF
unset KEY
sudo chown emn:emn /opt/emn/shared/.env && sudo chmod 600 /opt/emn/shared/.env
```

`AI_SUBSCRIPTION_ENCRYPTION_KEY` is used only for the Claude token. Back it up with the `.env`. If you lose it, reconnect Claude.

Optional, for signing Codex in from the shell (the app also ships its own `codex` in `node_modules`):

```bash
sudo npm install -g @openai/codex     # official npm package
codex --version
```

## 3. Deploy

```bash
cd /path/to/emn-outreach-os           # your checkout on the server
sudo bash scripts/deploy.sh           # npm ci (installs the SDKs), build, migrate, restart, health-check
```

This applies migration `20261121210000_ai_subscriptions_workflows`, which only adds tables and enums, and the regenerated tenant guards. The existing units need no change: `ProtectHome=true` is fine, because the subscription processes get their HOME under `/var/lib/emn`. With PM2, add the three variables to the same env file and run `pm2 startOrReload deployment/pm2/ecosystem.config.cjs --update-env`.

Check the bundled binaries on the server:

```bash
cd /opt/emn/current
sudo -u emn node -e "import('@anthropic-ai/claude-agent-sdk').then(()=>console.log('claude agent sdk ok'))"
sudo -u emn ./node_modules/.bin/codex --version
```

## 4. Make your account the owner

The owner must be a platform SUPER_ADMIN with two-factor sign-in.

```bash
cd /opt/emn/current
set -a; . /opt/emn/shared/.env; set +a
psql "${DATABASE_MIGRATION_URL:-$DATABASE_URL}" -c "UPDATE \"User\" SET \"platformRole\"='SUPER_ADMIN' WHERE email='you@elitemedianetworks.com';"
```

Then sign in to the app and turn on two-factor sign-in under **My account → Security**. Until you do, the subscription screens stay hidden.

## 5. Connect Claude (your subscription)

On your Mac (or any machine with a browser):

```bash
curl -fsSL https://claude.ai/install.sh | bash   # official installer, if Claude Code is not installed
claude --version
claude setup-token
```

Approve access in the browser with the Claude account that has the subscription, and copy the printed token (`sk-ant-oat…`). In the app go to **Settings → AI providers → Claude — My Subscription**, paste the token and press **Connect Claude**. The server encrypts it and runs one tiny test request. The token is valid for about a year. When it expires or is revoked, the card shows **Sign-in expired** and Claude stages pause; repeat this section to reconnect.

## 6. Connect Codex (your ChatGPT subscription)

1. In your ChatGPT security settings, turn on device code sign-in for Codex (one time).
2. **Settings → AI providers → Codex — My ChatGPT Subscription → Connect Codex.** The server runs the official `codex login --device-auth` and shows a link and a one-time code (valid 15 minutes).
3. Open the link, sign in to ChatGPT, enter the code. The card switches to **Connected**.

If device sign-in can't be used, sign in from the server shell. The exact command, including your folder, is on the Codex card under "Sign in from the server shell":

```bash
sudo -u emn env CODEX_HOME=/var/lib/emn/ai-subscriptions/<your-user-id>/codex/.codex \
  HOME=/var/lib/emn/ai-subscriptions/<your-user-id>/codex codex login --device-auth
sudo -u emn env CODEX_HOME=/var/lib/emn/ai-subscriptions/<your-user-id>/codex/.codex codex login status   # → Logged in using ChatGPT
```

Then press **Test connection** on the card. If Codex reports a sign-in method other than ChatGPT, for example an API key, the app refuses to use it.

## 7. Test

```bash
# Services up
systemctl status emn-api emn-worker --no-pager
curl -fsS http://127.0.0.1:4000/readyz
# Worker picked up the AI queues
grep -E "EMN worker started|AI workflow runs recovered" /var/log/emn/worker.log | tail -3
```

In the app:

1. On both cards, press **Test connection**. Both should pass.
2. Open a lead, go to **Generate emails → Generate with Claude**, and watch the stage chips. The results show research and three variants.
3. Open **Settings → AI providers → AI queue** to see counts, the execution log and any paused runs.

## 8. Restart and recovery

```bash
sudo systemctl restart emn-worker emn-api
```

- **Sign-ins survive restarts.** The Claude token is in the database. The Codex sign-in is Codex's `auth.json` under `/var/lib/emn/ai-subscriptions`, which deploys don't touch.
- **Graceful stop.** The worker drains active jobs for up to 60 seconds (`TimeoutStopSec=90`). A stage still running after that is re-queued once when the worker starts again ("AI workflow runs recovered after restart"). Each stage has a one-time token, so it never runs twice.
- **Usage limits.** Runs pause with "Claude usage limit reached — workflow paused." or "Codex usage limit reached — workflow paused." They resume only when you press **Retry now**, choose another provider for that stage, or tick **Resume automatically when the limit resets**. Limits are rechecked every 5 minutes.

## 9. Permissions and security checklist

```bash
sudo chown -R emn:emn /var/lib/emn/ai-subscriptions
sudo chmod -R go-rwx /var/lib/emn/ai-subscriptions
sudo ls -la /var/lib/emn/ai-subscriptions
```

- `auth.json` contains Codex access tokens. Codex manages that file and refreshes it in place, so it is protected by file permissions (0700 directory, owned by `emn`) rather than application encryption. Keep it out of shared backups. `scripts/backup.sh` does not include it; if it's lost, reconnect.
- Credentials never go to the browser or the logs. Error messages are scrubbed of tokens before they're stored.
- Connect, disconnect, workflow changes, playbook saves and stage-provider overrides are recorded in the platform audit trail.
- To revoke everything, press **Disconnect** on both cards. For Claude, also revoke the token from your Claude account if it might have leaked.

## 10. Not verified in this build

The build environment had no Claude or ChatGPT account and no Ubuntu systemd host. These still need to be checked on your server:

- A real `claude setup-token` token and a real Codex device sign-in.
- Real usage-limit responses.
- The bundled binaries running under the hardened systemd units.

Section 7 is the test.
