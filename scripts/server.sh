#!/usr/bin/env bash
# Outvexa — everyday server commands. Run from the code folder on the server (e.g. /var/www/outvexa):
#   npm run server:use-local-env   make the app read THIS folder's .env (one time)
#   npm run server:restart         restart API, worker and web (after editing .env)
#   npm run server:status          are the services running?
#   npm run server:logs            follow the logs (Ctrl+C to stop)
#   npm run server:deploy          build and release the code in this folder
#   npm run server:nginx -- outvexa.com you@example.com
#                                  publish the app on a domain: Nginx site + free SSL certificate (auto-renewing)
set -euo pipefail
EMN_ROOT="${EMN_ROOT:-/opt/emn}"
SHARED_ENV="$EMN_ROOT/shared/.env"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_ENV="$SRC_DIR/.env"
SERVICES=(emn-api emn-worker emn-web)
systemctl list-unit-files emn-redis.service >/dev/null 2>&1 && systemctl cat emn-redis >/dev/null 2>&1 && HAS_REDIS=1 || HAS_REDIS=0

log() { printf '\033[1;34m[outvexa]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[outvexa] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
need_root() { [[ $EUID -eq 0 ]] || exec sudo -E bash "$0" "$@"; }

case "${1:-}" in
  use-local-env)
    need_root "$@"
    # The services always read $SHARED_ENV; point it at this folder's .env so you edit the file here.
    if [[ -L "$SHARED_ENV" && "$(readlink -f "$SHARED_ENV")" == "$LOCAL_ENV" ]]; then log "Already using $LOCAL_ENV"; exit 0; fi
    if [[ ! -f "$LOCAL_ENV" ]]; then
      [[ -f "$SHARED_ENV" ]] || die "$SHARED_ENV not found — run scripts/install.sh first"
      cp -p "$SHARED_ENV" "$LOCAL_ENV"
      log "Copied the current settings into $LOCAL_ENV"
    else
      log "Keeping the existing $LOCAL_ENV"
    fi
    [[ -f "$SHARED_ENV" && ! -L "$SHARED_ENV" ]] && cp -p "$SHARED_ENV" "$SHARED_ENV.before-local-$(date +%Y%m%d%H%M%S)"
    chown emn:emn "$LOCAL_ENV"; chmod 600 "$LOCAL_ENV"
    ln -sfn "$LOCAL_ENV" "$SHARED_ENV"
    # The emn user must be able to reach the file (folders need "x" for others; the file itself stays private).
    d="$SRC_DIR"; while [[ "$d" != "/" ]]; do
      sudo -u emn test -x "$d" || die "the emn user cannot open $d — run: chmod o+x $d"
      d="$(dirname "$d")"; done
    sudo -u emn test -r "$LOCAL_ENV" || die "the emn user cannot read $LOCAL_ENV"
    log "Done. The app now reads $LOCAL_ENV (git never commits it: .env is in .gitignore)."
    log "Edit it with: nano $LOCAL_ENV   then: npm run server:restart"
    ;;
  restart)
    need_root "$@"
    log "Restarting ${SERVICES[*]}"
    systemctl restart "${SERVICES[@]}"
    sleep 2
    systemctl is-active "${SERVICES[@]}" | paste -sd' ' | sed 's/^/[outvexa] state: /'
    ;;
  status)
    all=("${SERVICES[@]}"); [[ $HAS_REDIS == 1 ]] && all+=(emn-redis)
    for s in "${all[@]}"; do printf '%-12s %s\n' "$s" "$(systemctl is-active "$s")"; done
    printf '%-12s %s\n' "env file" "$(readlink -f "$SHARED_ENV" 2>/dev/null || echo missing)"
    ;;
  logs)
    exec tail -n 50 -F /var/log/emn/api.log /var/log/emn/worker.log /var/log/emn/web.log
    ;;
  deploy)
    need_root "$@"
    exec bash "$SRC_DIR/scripts/deploy.sh"
    ;;
  nginx)
    need_root "$@"
    DOMAIN="${2:-}"; EMAIL="${3:-}"
    [[ "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "usage: npm run server:nginx -- <domain> <your-email>   (e.g. outvexa.com you@example.com)"
    [[ "$EMAIL" == *@* ]] || die "give an email for the SSL certificate (expiry notices): npm run server:nginx -- $DOMAIN you@example.com"
    command -v nginx >/dev/null || die "nginx is not installed"
    # shellcheck disable=SC1091
    [[ -f "$EMN_ROOT/shared/install.conf" ]] && source "$EMN_ROOT/shared/install.conf"
    WEB_PORT="${EMN_WEB_PORT:-3000}"; API_PORT="${EMN_API_PORT:-4000}"
    # Where this server's Nginx loads site files from (CloudPanel and Ubuntu both use sites-enabled/*.conf).
    SITES=/etc/nginx/sites-enabled
    grep -rqs "sites-enabled" /etc/nginx/nginx.conf || die "/etc/nginx/nginx.conf does not include $SITES — add the site by hand"
    CONF="$SITES/outvexa-$DOMAIN.conf"
    for f in "$SITES"/*.conf; do
      [[ "$f" == "$CONF" ]] && continue
      grep -qsE "server_name[^;]*[[:space:]]$DOMAIN([[:space:];])" "$f" && die "$f already serves $DOMAIN. Remove that site (or use another domain) first."
    done
    SERVER_IP="$(curl -fsS --max-time 5 https://api.ipify.org || true)"
    resolves_here() { [[ -n "$SERVER_IP" ]] && getent ahostsv4 "$1" | awk '{print $1}' | grep -qx "$SERVER_IP"; }
    resolves_here "$DOMAIN" || die "$DOMAIN does not point to this server ($SERVER_IP) yet. Add an A record and wait a few minutes (check: getent hosts $DOMAIN)."
    NAMES="$DOMAIN"; CERT_ARGS=(-d "$DOMAIN")
    if resolves_here "www.$DOMAIN"; then NAMES="$DOMAIN www.$DOMAIN"; CERT_ARGS+=(-d "www.$DOMAIN"); else log "www.$DOMAIN does not point here; continuing without www"; fi
    ACME=/var/www/letsencrypt; install -d -m 755 "$ACME"
    BACKUP=""; [[ -f "$CONF" ]] && BACKUP="$(mktemp)" && cp "$CONF" "$BACKUP"
    restore() { if [[ -n "$BACKUP" ]]; then cp "$BACKUP" "$CONF"; else rm -f "$CONF"; fi; nginx -t >/dev/null 2>&1 && systemctl reload nginx; }

    if [[ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]]; then
      log "Step 1/3: temporary HTTP site so Let's Encrypt can check the domain"
      cat > "$CONF" <<NGX
server {
    listen 80;
    listen [::]:80;
    server_name $NAMES;
    location /.well-known/acme-challenge/ { root $ACME; }
    location / { return 503; }
}
NGX
      nginx -t || { restore; die "Nginx rejected the temporary site; nothing was changed"; }
      systemctl reload nginx
      if ! command -v certbot >/dev/null; then
        log "Installing certbot (only certbot; Nginx itself is not touched)"
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-upgrade certbot
      fi
      log "Step 2/3: requesting the SSL certificate"
      certbot certonly --webroot -w "$ACME" "${CERT_ARGS[@]}" -m "$EMAIL" --agree-tos -n --deploy-hook "systemctl reload nginx" \
        || { restore; die "Let's Encrypt could not issue the certificate (see above). Your other sites were not affected."; }
    else
      log "Certificate for $DOMAIN already exists; reusing it"
    fi

    log "Step 3/3: writing $CONF"
    sed -e "s/^\(\s*\)server_name outreach.example.com;/\1server_name $NAMES;/" \
        -e "s#/etc/letsencrypt/live/outreach.example.com/#/etc/letsencrypt/live/$DOMAIN/#" \
        -e "s#root /var/www/html;#root $ACME;#" \
        -e "s/127.0.0.1:3000/127.0.0.1:$WEB_PORT/" -e "s/127.0.0.1:4000/127.0.0.1:$API_PORT/" \
        -e "s/zone=emn_/zone=outvexa_/g" \
        "$SRC_DIR/deployment/nginx/emn.conf" > "$CONF"
    nginx -t || { restore; die "Nginx rejected the site config; the previous state was restored and other sites are unaffected"; }
    systemctl reload nginx
    log "Done: https://$DOMAIN is live (certificate renews automatically). APP_URL in .env must be https://$DOMAIN"
    grep -q "^APP_URL=https://$DOMAIN\$" "$SHARED_ENV" 2>/dev/null || log "WARNING: APP_URL in .env is not https://$DOMAIN — fix it, then: npm run server:restart"
    ;;
  *)
    sed -n '2,10p' "$0"; exit 1 ;;
esac
