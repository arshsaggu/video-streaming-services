#!/usr/bin/env bash
# Repeatable load test with before/after comparison of the performance improvements.
#
#   baseline  : AUTH_CACHE_TTL_MS=0     HTTP_KEEPALIVE=false
#   cache     : AUTH_CACHE_TTL_MS=30000 HTTP_KEEPALIVE=false   (improvement 1: token-verify cache)
#   keepalive : AUTH_CACHE_TTL_MS=30000 HTTP_KEEPALIVE=true    (improvement 2: connection reuse)
#   workers1  : like keepalive but AUTH_WORKERS=1             (optional: shows the gunicorn worker effect)
#
# Same seed data, same k6 script, same VU profile for every run. One change per step.
# Env: VUS (50), DURATION (40s), THINK (0.2 s; 0 = saturation test), RUNS ("baseline cache keepalive")
# Output: results/k6-<run>.json, results/stats-<run>.csv, results/perf-summary.md
source "$(dirname "$0")/lib.sh"

VUS=${VUS:-50}
DURATION=${DURATION:-40s}
RUNS=${RUNS:-"baseline cache keepalive"}

config_for() {
  case $1 in
    baseline)  echo "AUTH_CACHE_TTL_MS=0 HTTP_KEEPALIVE=false AUTH_WORKERS=2" ;;
    cache)     echo "AUTH_CACHE_TTL_MS=30000 HTTP_KEEPALIVE=false AUTH_WORKERS=2" ;;
    keepalive) echo "AUTH_CACHE_TTL_MS=30000 HTTP_KEEPALIVE=true AUTH_WORKERS=2" ;;
    workers1)  echo "AUTH_CACHE_TTL_MS=30000 HTTP_KEEPALIVE=true AUTH_WORKERS=1" ;;
    *) echo "unknown run $1" >&2; exit 1 ;;
  esac
}

title "Seeding test data"
wait_healthy mysql auth-service file-service upload-web streaming-web
node_in_net -e K6_USER=loadtest -e K6_PASSWORD=loadtest-pass-123 "$NODE_IMAGE" node /tests/load/seed.mjs

for run in $RUNS; do
  title "Run: $run  ($(config_for "$run"))"
  env $(config_for "$run") docker compose up -d --no-build auth-service upload-web streaming-web >/dev/null
  wait_healthy auth-service upload-web streaming-web
  sleep 3

  : > "results/stats-$run.csv"
  ( while :; do
      docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' >> "results/stats-$run.csv" 2>/dev/null
    done ) &
  sampler=$!

  docker compose --profile loadtest run --rm -e VUS="$VUS" -e DURATION="$DURATION" -e THINK="${THINK:-0.2}" \
    --entrypoint k6 k6 run --quiet --summary-export="/results/k6-$run.json" /scripts/stream.js || true

  kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null || true
done

title "Restoring default configuration"
docker compose up -d --no-build auth-service upload-web streaming-web >/dev/null

title "Summary"
{
  echo "# Load test results ($(date -u +%Y-%m-%dT%H:%MZ))"
  echo
  echo "k6, ${VUS} virtual users, 10 s ramp-up + ${DURATION} steady + 5 s ramp-down. Each iteration: catalogue page + one 256 KB video range."
  echo
  docker run --rm -v "$ROOT/tests:/tests:ro" -v "$ROOT/results:/results" "$NODE_IMAGE" \
    node /tests/load/summarize.mjs /results $RUNS
} | tee results/perf-summary.md
