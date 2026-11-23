#!/usr/bin/env bash
# Outvexa — first-time server preparation for Ubuntu 22.04/24.04 (run as root).
# Installs Node 22, PostgreSQL, Redis, Nginx and Certbot; creates the emn user, directories,
# database roles and a shared .env with generated secrets. It does NOT deploy code — run
# scripts/deploy.sh afterwards. Safe to re-run: every step checks before changing anything.
set -euo pipefail

DOMAIN="${1:-}"
EMN_ROOT="${EMN_ROOT:-/opt/emn}"
DATA_DIR="${EMN_DATA_DIR:-/var/lib/emn}"
LOG_DIR=/var/log/emn
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo bash scripts/install.sh outreach.example.com)"
[[ -n "$DOMAIN" ]] || die "usage: sudo bash scripts/install.sh <your-domain>"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "invalid domain: $DOMAIN"
command -v apt-get >/dev/null || die "this installer supports Debian/Ubuntu only"

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg rsync postgresql postgresql-contrib redis-server nginx certbot python3-certbot-nginx openssl

if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  log "Installing Node.js 22 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

log "Creating user and directories"
id emn >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/emn --shell /usr/sbin/nologin emn
install -d -o emn -g emn -m 750 "$EMN_ROOT" "$EMN_ROOT/releases" "$EMN_ROOT/shared" "$DATA_DIR" "$DATA_DIR/storage" "$DATA_DIR/backups" "$LOG_DIR"

ENV_FILE="$EMN_ROOT/shared/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Configuring PostgreSQL roles and database"
  OWNER_PW="$(openssl rand -hex 24)"; APP_PW="$(openssl rand -hex 24)"; REDIS_PW="$(openssl rand -hex 24)"
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='emn_owner'" | grep -q 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -v owner_pw="'$OWNER_PW'" -v app_pw="'$APP_PW'" -f "$SRC_DIR/deployment/postgres/setup.sql"
  else
    die "PostgreSQL role emn_owner already exists but $ENV_FILE is missing — restore the .env or drop the roles first"
  fi

  log "Securing Redis"
  if ! grep -q '^requirepass ' /etc/redis/redis.conf; then
    sed "s/CHANGE_ME_long_random_password/$REDIS_PW/" "$SRC_DIR/deployment/redis/redis.conf.snippet" >> /etc/redis/redis.conf
    systemctl restart redis-server
  else
    REDIS_PW="$(awk '/^requirepass /{print $2}' /etc/redis/redis.conf)"
  fi

  log "Writing $ENV_FILE"
  SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  ENC_KEY="$(openssl rand -base64 32 | tr -d '\n')"
  sed -e "s#^APP_URL=.*#APP_URL=https://$DOMAIN#" \
      -e "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://emn_app:$APP_PW@127.0.0.1:5432/emn#" \
      -e "s#^DATABASE_MIGRATION_URL=.*#DATABASE_MIGRATION_URL=postgresql://emn_owner:$OWNER_PW@127.0.0.1:5432/emn#" \
      -e "s#^REDIS_URL=.*#REDIS_URL=redis://:$REDIS_PW@127.0.0.1:6379/0#" \
      -e "s#^SESSION_SECRET=.*#SESSION_SECRET=$SESSION_SECRET#" \
      -e "s#^ENCRYPTION_KEYS=.*#ENCRYPTION_KEYS=1:$ENC_KEY#" \
      -e "s#^STORAGE_ROOT=.*#STORAGE_ROOT=$DATA_DIR/storage#" \
      "$SRC_DIR/.env.example" > "$ENV_FILE"
  chown emn:emn "$ENV_FILE"; chmod 600 "$ENV_FILE"
else
  log "$ENV_FILE exists — leaving secrets untouched"
fi

log "Installing service units, logrotate and Nginx site"
install -m 644 "$SRC_DIR"/deployment/systemd/emn-*.service /etc/systemd/system/
install -m 644 "$SRC_DIR/deployment/logrotate/emn" /etc/logrotate.d/emn
sed "s/outreach.example.com/$DOMAIN/g" "$SRC_DIR/deployment/nginx/emn.conf" > /etc/nginx/sites-available/emn.conf
systemctl daemon-reload
systemctl enable emn-api emn-worker emn-web >/dev/null

if [[ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  log "No TLS certificate yet. Point DNS for $DOMAIN at this server, then run:"
  log "  sudo certbot certonly --nginx -d $DOMAIN && sudo ln -sf /etc/nginx/sites-available/emn.conf /etc/nginx/sites-enabled/emn.conf && sudo nginx -t && sudo systemctl reload nginx"
else
  ln -sf /etc/nginx/sites-available/emn.conf /etc/nginx/sites-enabled/emn.conf
  nginx -t && systemctl reload nginx
fi

log "Done. Next: review $ENV_FILE (OAuth client IDs), then: sudo bash scripts/deploy.sh"
