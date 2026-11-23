#!/usr/bin/env bash
# Outvexa — first-time server preparation for Ubuntu 22.04/24.04 (run as root).
# Installs Node 22, PostgreSQL, Redis, Nginx and Certbot; creates the emn user, directories,
# database roles and a shared .env with generated secrets. It does NOT deploy code — run
# scripts/deploy.sh afterwards. Safe to re-run: every step checks before changing anything.
#
# Server that already hosts other sites (CloudPanel, Plesk, a PM2 app…)? Use shared-server mode:
#   sudo EMN_SHARED_SERVER=1 bash scripts/install.sh app.example.com
# It never touches what is already there:
#   * a private Node 22 in /opt/emn/node (the system Node, and anything PM2 runs on it, keep their version)
#   * a dedicated Redis on 127.0.0.1:6380 with its own password (the existing Redis is not changed)
#   * web UI on port 3100 (3000 is often taken); API stays on 4000; both only on 127.0.0.1
#   * no Nginx/Certbot install and no Nginx site: add the site in your panel as a reverse proxy and paste the
#     config written to /opt/emn/shared/nginx-site.conf
#   * only installs packages that are missing; never upgrades or restarts ones that are already there
#   * adds a 2 GB swap file when the server has under 6 GB RAM and no swap (the UI build needs memory)
# Each part can be chosen alone: EMN_NODE=private|system, EMN_REDIS=dedicated|shared, EMN_NGINX=install|skip,
# EMN_WEB_PORT, EMN_API_PORT, EMN_REDIS_PORT, EMN_SWAP=0|1.
set -euo pipefail

DOMAIN="${1:-}"
EMN_ROOT="${EMN_ROOT:-/opt/emn}"
DATA_DIR="${EMN_DATA_DIR:-/var/lib/emn}"
LOG_DIR=/var/log/emn
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SHARED="${EMN_SHARED_SERVER:-0}"
pick() { [[ $SHARED == 1 ]] && echo "$1" || echo "$2"; }
NODE_MODE="${EMN_NODE:-$(pick private system)}"
REDIS_MODE="${EMN_REDIS:-$(pick dedicated shared)}"
NGINX_MODE="${EMN_NGINX:-$(pick skip install)}"
WEB_PORT="${EMN_WEB_PORT:-$(pick 3100 3000)}"
API_PORT="${EMN_API_PORT:-4000}"
REDIS_PORT="${EMN_REDIS_PORT:-$([[ $REDIS_MODE == dedicated ]] && echo 6380 || echo 6379)}"
SWAP_MODE="${EMN_SWAP:-$SHARED}"
NODE_DIR="$EMN_ROOT/node"

log()  { printf '\033[1;34m[install]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[install] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root (sudo bash scripts/install.sh outreach.example.com)"
[[ -n "$DOMAIN" ]] || die "usage: sudo bash scripts/install.sh <your-domain>"
[[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || die "invalid domain: $DOMAIN"
command -v apt-get >/dev/null || die "this installer supports Debian/Ubuntu only"
log "Mode: node=$NODE_MODE redis=$REDIS_MODE nginx=$NGINX_MODE web=127.0.0.1:$WEB_PORT api=127.0.0.1:$API_PORT"

# Refuse ports another program already uses (Outvexa's own services may hold them on a re-run).
port_busy() { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }
ours_running() { systemctl is-active --quiet "$1" 2>/dev/null; }
port_busy "$WEB_PORT" && ! ours_running emn-web && die "port $WEB_PORT is used by another program (ss -ltnp | grep :$WEB_PORT). Pick another: EMN_WEB_PORT=3200"
port_busy "$API_PORT" && ! ours_running emn-api && die "port $API_PORT is used by another program (ss -ltnp | grep :$API_PORT). Pick another: EMN_API_PORT=4100"
if [[ $REDIS_MODE == dedicated ]]; then
  port_busy "$REDIS_PORT" && ! ours_running emn-redis && die "port $REDIS_PORT is used by another program. Pick another: EMN_REDIS_PORT=6390"
fi

log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
PKGS=(ca-certificates curl gnupg rsync xz-utils postgresql postgresql-contrib redis-server openssl)
[[ $NGINX_MODE == install ]] && PKGS+=(nginx certbot python3-certbot-nginx)
if [[ $SHARED == 1 ]]; then
  # Never upgrade or restart software other sites depend on: install only what is missing.
  MISSING=()
  for p in "${PKGS[@]}"; do dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "ok installed" || MISSING+=("$p"); done
  if ((${#MISSING[@]})); then log "Installing missing packages: ${MISSING[*]}"; apt-get install -y --no-upgrade "${MISSING[@]}"
  else log "All needed packages are already installed"; fi
else
  apt-get install -y "${PKGS[@]}"
fi
systemctl enable --now postgresql >/dev/null 2>&1 || true

if [[ $NODE_MODE == private ]]; then
  if [[ ! -x "$NODE_DIR/bin/node" ]] || (( $("$NODE_DIR/bin/node" -p 'process.versions.node.split(".")[0]') < 22 )); then
    case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported CPU $(uname -m)" ;; esac
    log "Installing a private Node.js 22 in $NODE_DIR (the system Node is not changed)"
    SUMS="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt)"
    FILE="$(awk -v a="linux-$ARCH.tar.xz" '$2 ~ a"$" {print $2}' <<<"$SUMS" | head -1)"
    [[ -n "$FILE" ]] || die "could not find the Node.js 22 download"
    TMP="$(mktemp -d)"
    curl -fsSL "https://nodejs.org/dist/latest-v22.x/$FILE" -o "$TMP/$FILE"
    (cd "$TMP" && grep " $FILE\$" <<<"$SUMS" | sha256sum -c - >/dev/null) || die "Node.js download failed its checksum"
    install -d -m 755 "$NODE_DIR"
    tar -xJf "$TMP/$FILE" -C "$NODE_DIR" --strip-components=1
    rm -rf "$TMP"
  fi
  NODE_BIN="$NODE_DIR/bin/node"
else
  if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
    log "Installing Node.js 22 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  fi
  NODE_BIN="$(command -v node)"
fi
log "Node for Outvexa: $NODE_BIN ($("$NODE_BIN" -v))"

if [[ $SWAP_MODE == 1 && -z "$(swapon --noheadings 2>/dev/null)" ]] && (( $(awk '/MemTotal/{print $2}' /proc/meminfo) < 6000000 )); then
  log "Adding a 2 GB swap file (/swapfile) so the build does not run out of memory"
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

log "Creating user and directories"
id emn >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/emn --shell /usr/sbin/nologin emn
install -d -o emn -g emn -m 750 "$EMN_ROOT" "$EMN_ROOT/releases" "$EMN_ROOT/shared" "$DATA_DIR" "$DATA_DIR/storage" "$DATA_DIR/backups" "$DATA_DIR/ai-subscriptions" "$LOG_DIR"

ENV_FILE="$EMN_ROOT/shared/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  log "Configuring PostgreSQL roles and database"
  OWNER_PW="$(openssl rand -hex 24)"; APP_PW="$(openssl rand -hex 24)"; REDIS_PW="$(openssl rand -hex 24)"
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='emn_owner'" | grep -q 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -v owner_pw="'$OWNER_PW'" -v app_pw="'$APP_PW'" < "$SRC_DIR/deployment/postgres/setup.sql"
  else
    die "PostgreSQL role emn_owner already exists but $ENV_FILE is missing — restore the .env or drop the roles first"
  fi

  if [[ $REDIS_MODE == dedicated ]]; then
    log "Creating a dedicated Redis for Outvexa on 127.0.0.1:$REDIS_PORT (the existing Redis is not changed)"
    # Own data folder, outside /var/lib/emn (which only the emn user may enter).
    install -d -o redis -g redis -m 750 /var/lib/emn-redis
    sed -e "s/CHANGE_ME_long_random_password/$REDIS_PW/" -e "s/^port .*/port $REDIS_PORT/" \
      "$SRC_DIR/deployment/redis/emn-redis.conf" > /etc/redis/emn-redis.conf
    chown redis:redis /etc/redis/emn-redis.conf; chmod 640 /etc/redis/emn-redis.conf
    install -m 644 "$SRC_DIR/deployment/systemd/emn-redis.service" /etc/systemd/system/emn-redis.service
    systemctl daemon-reload
    systemctl enable --now emn-redis >/dev/null
  else
    log "Securing Redis"
    if ! grep -q '^requirepass ' /etc/redis/redis.conf; then
      sed "s/CHANGE_ME_long_random_password/$REDIS_PW/" "$SRC_DIR/deployment/redis/redis.conf.snippet" >> /etc/redis/redis.conf
      systemctl restart redis-server
    else
      REDIS_PW="$(awk '/^requirepass /{print $2}' /etc/redis/redis.conf)"
    fi
  fi

  log "Writing $ENV_FILE"
  SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  ENC_KEY="$(openssl rand -base64 32 | tr -d '\n')"
  AI_KEY="$(openssl rand -base64 32 | tr -d '\n')"
  sed -e "s#^APP_URL=.*#APP_URL=https://$DOMAIN#" \
      -e "s#^API_PORT=.*#API_PORT=$API_PORT#" \
      -e "s#^DATABASE_URL=.*#DATABASE_URL=postgresql://emn_app:$APP_PW@127.0.0.1:5432/emn#" \
      -e "s#^DATABASE_MIGRATION_URL=.*#DATABASE_MIGRATION_URL=postgresql://emn_owner:$OWNER_PW@127.0.0.1:5432/emn#" \
      -e "s#^REDIS_URL=.*#REDIS_URL=redis://:$REDIS_PW@127.0.0.1:$REDIS_PORT/0#" \
      -e "s#^SESSION_SECRET=.*#SESSION_SECRET=$SESSION_SECRET#" \
      -e "s#^ENCRYPTION_KEYS=.*#ENCRYPTION_KEYS=1:$ENC_KEY#" \
      -e "s#^STORAGE_ROOT=.*#STORAGE_ROOT=$DATA_DIR/storage#" \
      -e "s#^AI_SUBSCRIPTION_ENCRYPTION_KEY=.*#AI_SUBSCRIPTION_ENCRYPTION_KEY=$AI_KEY#" \
      -e "s#^AI_SUBSCRIPTION_HOME=.*#AI_SUBSCRIPTION_HOME=$DATA_DIR/ai-subscriptions#" \
      "$SRC_DIR/.env.example" > "$ENV_FILE"
  chown emn:emn "$ENV_FILE"; chmod 600 "$ENV_FILE"
else
  log "$ENV_FILE exists — leaving secrets untouched"
fi

# Remember the choices for deploy.sh and healthcheck.sh.
cat > "$EMN_ROOT/shared/install.conf" <<CONF
EMN_NODE_BIN=$NODE_BIN
EMN_WEB_PORT=$WEB_PORT
EMN_API_PORT=$API_PORT
EMN_REDIS_MODE=$REDIS_MODE
EMN_NGINX_MODE=$NGINX_MODE
CONF
chmod 644 "$EMN_ROOT/shared/install.conf"

log "Installing service units and logrotate"
NODE_PATH_DIR="$(dirname "$NODE_BIN")"
REDIS_UNIT="$([[ $REDIS_MODE == dedicated ]] && echo emn-redis.service || echo redis-server.service)"
for unit in emn-api emn-worker emn-web; do
  sed -e "s#/usr/bin/node#$NODE_BIN#g" \
      -e "s#^Environment=PORT=3000#Environment=PORT=$WEB_PORT#" -e "s#-p 3000#-p $WEB_PORT#" \
      -e "s#^Environment=NODE_ENV=production\$#Environment=NODE_ENV=production\nEnvironment=PATH=$NODE_PATH_DIR:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin#" \
      -e "s#redis-server.service#$REDIS_UNIT#" \
      "$SRC_DIR/deployment/systemd/$unit.service" > "/etc/systemd/system/$unit.service"
done
install -m 644 "$SRC_DIR/deployment/logrotate/emn" /etc/logrotate.d/emn
systemctl daemon-reload
systemctl enable emn-api emn-worker emn-web >/dev/null

# A ready-to-paste Nginx config for hosting panels, written in every mode.
sed -e "s/outreach.example.com/$DOMAIN/g" -e "s/127.0.0.1:3000/127.0.0.1:$WEB_PORT/g" -e "s/127.0.0.1:4000/127.0.0.1:$API_PORT/g" \
  "$SRC_DIR/deployment/nginx/panel-site.conf" > "$EMN_ROOT/shared/nginx-site.conf"

if [[ $NGINX_MODE == skip ]]; then
  log "Nginx was not touched. In your hosting panel:"
  log "  1. add $DOMAIN as a reverse proxy to http://127.0.0.1:$WEB_PORT and issue its free SSL certificate there"
  log "  2. paste the location blocks from $EMN_ROOT/shared/nginx-site.conf into that site's Nginx (vhost) settings"
  log "Done. Next: review $ENV_FILE (OAuth client IDs, AI_SUBSCRIPTION_OWNER_EMAILS), then: sudo bash scripts/deploy.sh"
  exit 0
fi

sed -e "s/outreach.example.com/$DOMAIN/g" -e "s/127.0.0.1:3000/127.0.0.1:$WEB_PORT/g" -e "s/127.0.0.1:4000/127.0.0.1:$API_PORT/g" \
  "$SRC_DIR/deployment/nginx/emn.conf" > /etc/nginx/sites-available/emn.conf
if [[ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
  log "No TLS certificate yet. Point DNS for $DOMAIN at this server, then run:"
  log "  sudo certbot certonly --nginx -d $DOMAIN && sudo ln -sf /etc/nginx/sites-available/emn.conf /etc/nginx/sites-enabled/emn.conf && sudo nginx -t && sudo systemctl reload nginx"
else
  ln -sf /etc/nginx/sites-available/emn.conf /etc/nginx/sites-enabled/emn.conf
  nginx -t && systemctl reload nginx
fi

log "Done. Next: review $ENV_FILE (OAuth client IDs), then: sudo bash scripts/deploy.sh"
