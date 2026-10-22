#!/usr/bin/env bash
# Shared helpers for the evidence scripts. Source it: `source "$(dirname "$0")/lib.sh"`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
mkdir -p results

UPLOAD_URL="http://localhost:${UPLOAD_PORT:-8081}"
STREAM_URL="http://localhost:${STREAM_PORT:-8082}"
NET="vss_frontend"
NODE_IMAGE="node:22-alpine"

c_bold=$'\e[1m'; c_dim=$'\e[2m'; c_red=$'\e[31m'; c_grn=$'\e[32m'; c_off=$'\e[0m'
log()   { printf '%s[%s]%s %s\n' "$c_dim" "$(date +%H:%M:%S)" "$c_off" "$*"; }
title() { printf '\n%s== %s ==%s\n' "$c_bold" "$*" "$c_off"; }
ok()    { printf '  %sOK%s   %s\n' "$c_grn" "$c_off" "$*"; }
bad()   { printf '  %sFAIL%s %s\n' "$c_red" "$c_off" "$*"; }

# Health status of one compose service: healthy | unhealthy | starting | exited | missing
health() {
  local cid
  cid=$(docker compose ps -aq "$1" 2>/dev/null | head -1)
  [[ -z $cid ]] && { echo missing; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo missing
}

wait_healthy() { # wait_healthy svc... (TIMEOUT seconds, default 180)
  local deadline=$((SECONDS + ${TIMEOUT:-180})) s
  for s in "$@"; do
    until [[ $(health "$s") == healthy ]]; do
      if ((SECONDS > deadline)); then bad "timeout waiting for $s (status: $(health "$s"))"; return 1; fi
      sleep 2
    done
  done
}

# HTTP status code of a request. Extra args are passed to curl.
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" || true; }

# Log in and print the session cookie ("vss_session=...").
login_cookie() { # base user password
  curl -s -D - -o /dev/null --max-time 10 -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
    --data "{\"username\":\"$2\",\"password\":\"$3\"}" "$1/api/login" \
    | tr -d '\r' | sed -n 's/^[Ss]et-[Cc]ookie: \(vss_session=[^;]*\).*/\1/p'
}

admin_password() { tr -d '\r\n' < secrets/admin_password.txt; }

# Run a Node script from ./tests inside the compose frontend network (no Node needed on the host).
node_in_net() {
  docker run --rm --network "$NET" \
    -v "$ROOT/tests:/tests:ro" -v "$ROOT/secrets:/secrets:ro" -v "$ROOT/results:/results" \
    -e UPLOAD_URL=http://upload-web:3000 -e STREAM_URL=http://streaming-web:3000 \
    -e ADMIN_PASSWORD_FILE=/secrets/admin_password.txt "$@"
}

# Portable helpers (Linux, macOS, Git Bash/WSL): fractional clock, float maths, sha256.
now()  { if [[ -n ${EPOCHREALTIME:-} ]]; then echo "${EPOCHREALTIME/,/.}"; else perl -MTime::HiRes=time -e 'printf "%.3f\n", time'; fi; }
calc() { awk "BEGIN { printf \"%.1f\", $* }"; }
sha256() { if command -v sha256sum >/dev/null; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi; }

# Time (seconds, 1 decimal) until a URL returns the wanted status code.
wait_for_code() { # want url [curl args...]
  local want=$1; shift
  local t0 deadline=$((SECONDS + ${TIMEOUT:-180}))
  t0=$(now)
  until [[ $(code "$@") == "$want" ]]; do
    ((SECONDS > deadline)) && { echo "timeout"; return 1; }
    sleep 0.5
  done
  calc "$(now) - $t0"
}
