#!/bin/sh
# Run all seed scripts against the local Redis REST proxy.
# Usage: ./scripts/run-seeders.sh
#
# Requires the worldmonitor stack to be running (uvx podman-compose up -d).
# The Redis REST proxy listens on localhost:8079 by default.

UPSTASH_REDIS_REST_URL="${UPSTASH_REDIS_REST_URL:-http://localhost:8079}"
UPSTASH_REDIS_REST_TOKEN="${UPSTASH_REDIS_REST_TOKEN:-wm-local-token}"
export UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN

SEEDER_TIMEOUT_BIN="${SEEDER_TIMEOUT_BIN:-$(command -v timeout || command -v gtimeout || true)}"
SEEDER_TIMEOUT_SEC="${SEEDER_TIMEOUT_SEC:-180}"
export SEEDER_TIMEOUT_BIN SEEDER_TIMEOUT_SEC

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source API keys from docker-compose.override.yml if present.
# These keys are configured for the container but seeders run on the host.
OVERRIDE="$PROJECT_DIR/docker-compose.override.yml"
if [ -f "$OVERRIDE" ]; then
  _env_tmp=$(mktemp)
  grep -E '^\s+[A-Z_]+:' "$OVERRIDE" \
    | grep -v '#' \
    | sed 's/^\s*//' \
    | sed 's/: */=/' \
    | sed "s/[\"']//g" \
    | grep -E '^(NASA_FIRMS|GROQ|AISSTREAM|FRED|FINNHUB|EIA|ACLED_ACCESS_TOKEN|ACLED_EMAIL|ACLED_PASSWORD|CLOUDFLARE|AVIATIONSTACK|OPENROUTER_API_KEY|LLM_API_URL|LLM_API_KEY|LLM_MODEL|OLLAMA_API_URL|OLLAMA_MODEL)' \
    | sed 's/^/export /' > "$_env_tmp"
  . "$_env_tmp"
  rm -f "$_env_tmp"
fi
ok=0 fail=0 skip=0

for f in "$SCRIPT_DIR"/seed-*.mjs; do
  name="$(basename "$f")"
  printf "→ %s ... " "$name"

  args="$f"
  case "$name" in
    seed-consumer-prices.mjs)
      args="$f --force"
      ;;
  esac

  if [ -n "$SEEDER_TIMEOUT_BIN" ]; then
    # shellcheck disable=SC2086
    output=$("$SEEDER_TIMEOUT_BIN" "$SEEDER_TIMEOUT_SEC" node $args 2>&1)
    rc=$?
  else
    # shellcheck disable=SC2086
    output=$(node $args 2>&1)
    rc=$?
  fi

  last=$(echo "$output" | tail -1)

  if [ $rc -eq 124 ]; then
    printf "FAIL (timed out after %ss)\n" "$SEEDER_TIMEOUT_SEC"
    fail=$((fail + 1))
  elif echo "$last" | grep -Eqi "skip|not set|missing.*key|not found|no write"; then
    printf "SKIP (%s)\n" "$last"
    skip=$((skip + 1))
  elif echo "$last" | grep -Eqi "failed gracefully|fatal|error"; then
    printf "FAIL (%s)\n" "$last"
    fail=$((fail + 1))
  elif [ $rc -eq 0 ]; then
    printf "OK\n"
    ok=$((ok + 1))
  else
    printf "FAIL (%s)\n" "$last"
    fail=$((fail + 1))
  fi
done

echo ""
echo "Done: $ok ok, $skip skipped, $fail failed"
