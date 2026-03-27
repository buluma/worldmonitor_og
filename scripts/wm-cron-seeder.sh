#!/bin/sh
# World Monitor - Cron Seeder Wrapper
#
# Usage:
#   */15 * * * * /path/to/worldmonitor/scripts/wm-cron-seeder.sh
#   17 */6 * * * WM_CRON_MODE=full /path/to/worldmonitor/scripts/wm-cron-seeder.sh
#
# Modes:
#   fast / frequent: refresh short-TTL feeds that drive self-hosted health
#   hourly:          medium-cost seeds that should stay warm on self-hosted installs
#   sixhourly:       heavier intelligence/reference seeds with longer intervals
#   daily:           daily refresh jobs
#   weekly:          heavy slow-moving jobs
#   full:            run the existing all-seeder sweep

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-${WM_CRON_MODE:-fast}}"
LOG_FILE="${WM_CRON_LOG_FILE:-/tmp/wm-seeders.log}"
APP_URL="${WM_APP_URL:-http://localhost:3000}"
RPC_BASE_URL="${WM_RPC_BASE_URL:-$APP_URL}"
MANIFEST_SCRIPT="$PROJECT_DIR/scripts/seed-scheduler-manifest.mjs"

# Cron often has a minimal PATH. Preserve whatever exists, then append common locations.
PATH_PREFIX="$HOME/.local/state/fnm_multishells/current/bin:$HOME/.fnm:$HOME/.nvm/versions/node/current/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
if [ -n "${PATH:-}" ]; then
  export PATH="$PATH:$PATH_PREFIX"
else
  export PATH="$PATH_PREFIX"
fi

export UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-http://localhost:8079}"
export UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN:-wm-local-token}"
RESOLVED_MODE="$(node "$MANIFEST_SCRIPT" resolve "$MODE" 2>/dev/null || printf '%s' "$MODE")"
DEFAULT_TIMEOUT_SEC="$(node "$MANIFEST_SCRIPT" timeout "$RESOLVED_MODE" 2>/dev/null || printf '120')"
export SEEDER_TIMEOUT_SEC="${SEEDER_TIMEOUT_SEC:-$DEFAULT_TIMEOUT_SEC}"
SEEDER_TIMEOUT_BIN="${SEEDER_TIMEOUT_BIN:-$(command -v timeout || command -v gtimeout || true)}"
export SEEDER_TIMEOUT_BIN

run_seed_list() {
  list="$(node "$MANIFEST_SCRIPT" seeds "$1")"
  for seed in $list; do
    printf '→ %s\n' "$seed"
    if [ -n "$SEEDER_TIMEOUT_BIN" ]; then
      "$SEEDER_TIMEOUT_BIN" "$SEEDER_TIMEOUT_SEC" node "scripts/$seed" || true
    else
      node "scripts/$seed" || true
    fi
  done
}

{
  printf '[%s] wm-cron-seeder mode=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$RESOLVED_MODE"
  cd "$PROJECT_DIR" || exit 1

  case "$RESOLVED_MODE" in
    full)
      ./scripts/run-seeders.sh
      ;;
    fast|frequent)
      run_seed_list frequent

      # Prime local on-demand caches so Docker health stays green.
      curl -fsS "$APP_URL/api/infrastructure/v1/list-service-statuses" >/dev/null || true
      curl -fsS "$APP_URL/api/cyber/v1/list-cyber-threats" >/dev/null || true
      ;;
    hourly)
      export WM_RPC_BASE_URL="$RPC_BASE_URL"
      run_seed_list hourly
      ;;
    sixhourly)
      run_seed_list sixhourly
      ;;
    daily)
      run_seed_list daily
      ;;
    weekly)
      run_seed_list weekly
      ;;
    *)
      printf 'Unknown mode: %s\n' "$RESOLVED_MODE"
      exit 1
      ;;
  esac
} >> "$LOG_FILE" 2>&1
