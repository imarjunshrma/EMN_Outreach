#!/usr/bin/env bash
# Outvexa — everyday server commands. Run from the code folder on the server (e.g. /var/www/outvexa):
#   npm run server:use-local-env   make the app read THIS folder's .env (one time)
#   npm run server:restart         restart API, worker and web (after editing .env)
#   npm run server:status          are the services running?
#   npm run server:logs            follow the logs (Ctrl+C to stop)
#   npm run server:deploy          build and release the code in this folder
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
  *)
    sed -n '2,8p' "$0"; exit 1 ;;
esac
