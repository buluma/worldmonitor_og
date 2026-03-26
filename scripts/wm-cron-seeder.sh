#!/bin/sh
# World Monitor - Cron Seeder Wrapper
#
# Usage:
#   */15 * * * * /path/to/worldmonitor/scripts/wm-cron-seeder.sh
#   17 */6 * * * WM_CRON_MODE=full /path/to/worldmonitor/scripts/wm-cron-seeder.sh
#
# Modes:
#   fast (default): refresh short-TTL feeds that drive self-hosted health
#   full:           run the existing all-seeder sweep

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MODE="${1:-${WM_CRON_MODE:-fast}}"
LOG_FILE="${WM_CRON_LOG_FILE:-/tmp/wm-seeders.log}"
APP_URL="${WM_APP_URL:-http://localhost:3000}"

# Cron often has a minimal PATH. Preserve whatever exists, then append common locations.
PATH_PREFIX="$HOME/.local/state/fnm_multishells/current/bin:$HOME/.fnm:$HOME/.nvm/versions/node/current/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
if [ -n "${PATH:-}" ]; then
  export PATH="$PATH:$PATH_PREFIX"
else
  export PATH="$PATH_PREFIX"
fi

export UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-http://localhost:8079}"
export UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN:-wm-local-token}"
export SEEDER_TIMEOUT_SEC="${SEEDER_TIMEOUT_SEC:-120}"
SEEDER_TIMEOUT_BIN="${SEEDER_TIMEOUT_BIN:-$(command -v timeout || command -v gtimeout || true)}"
export SEEDER_TIMEOUT_BIN

FAST_SEEDERS="
seed-market-quotes.mjs
seed-commodity-quotes.mjs
seed-crypto-quotes.mjs
seed-etf-flows.mjs
seed-stablecoin-markets.mjs
seed-earthquakes.mjs
seed-weather-alerts.mjs
seed-climate-anomalies.mjs
seed-cyber-threats.mjs
seed-unrest-events.mjs
seed-usa-spending.mjs
seed-security-advisories.mjs
seed-correlation.mjs
seed-cross-source-signals.mjs
seed-prediction-markets.mjs
seed-forecasts.mjs
"

{
  printf '[%s] wm-cron-seeder mode=%s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$MODE"
  cd "$PROJECT_DIR" || exit 1

  case "$MODE" in
    full)
      ./scripts/run-seeders.sh
      ;;
    fast)
      for seed in $FAST_SEEDERS; do
        printf '→ %s\n' "$seed"
        if [ -n "$SEEDER_TIMEOUT_BIN" ]; then
          "$SEEDER_TIMEOUT_BIN" "$SEEDER_TIMEOUT_SEC" node "scripts/$seed" || true
        else
          node "scripts/$seed" || true
        fi
      done

      # Prime local on-demand caches so Docker health stays green.
      curl -fsS "$APP_URL/api/infrastructure/v1/list-service-statuses" >/dev/null || true
      curl -fsS "$APP_URL/api/cyber/v1/list-cyber-threats" >/dev/null || true
      ;;
    *)
      printf 'Unknown mode: %s\n' "$MODE"
      exit 1
      ;;
  esac
} >> "$LOG_FILE" 2>&1
