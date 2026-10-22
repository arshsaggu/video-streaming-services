#!/usr/bin/env bash
# Docker optimisation evidence: image size and build time, naive vs optimised Dockerfile.
#   cold  = docker build --no-cache (base images already pulled, so only our steps are timed)
#   warm  = rebuild after editing one source line (shows layer-cache ordering)
# Output: results/image-metrics.md
source "$(dirname "$0")/lib.sh"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
cp -r services "$WORK/"

# Pull bases first so network time doesn't pollute build timings.
for img in node:22 node:22-alpine gcr.io/distroless/nodejs22-debian12:nonroot; do
  docker pull -q "$img" >/dev/null
done

secs() { local t0; t0=$(now); "$@" >/dev/null 2>&1 || { echo "build failed: $*" >&2; exit 1; }; calc "$(now) - $t0"; }
size_mb() { calc "$(docker image inspect -f '{{.Size}}' "$1") / 1000000"; }

row() { # name tag context dockerfile [target] touchfile
  local name=$1 tag=$2 ctx=$3 df=$4 target=$5 touchf=$6 cold warm
  local tflag=(); [[ -n $target ]] && tflag=(--target "$target")
  cold=$(secs docker build --no-cache ${tflag[@]+"${tflag[@]}"} -f "$df" -t "$tag" "$ctx")
  echo "// cache-bust $(date +%s%N)" >> "$touchf"
  warm=$(secs docker build ${tflag[@]+"${tflag[@]}"} -f "$df" -t "$tag" "$ctx")
  echo "| $name | \`$tag\` | $(size_mb "$tag") | $cold | $warm | $(docker image inspect -f '{{.Config.User}}' "$tag" | sed 's/^$/root/') |"
}

{
  echo "# Image size and build time ($(date -u +%Y-%m-%dT%H:%MZ), $(uname -m))"
  echo
  echo "| Service | Image | Size (MB) | Cold build (s) | Rebuild after code edit (s) | Runs as |"
  echo "|---|---|---:|---:|---:|---|"
  S="$WORK/services"
  row "file-service (naive)"     vss-file-service:naive     "$S/file-service" "$S/file-service/Dockerfile.naive" ""        "$S/file-service/src/server.js"
  row "file-service (optimised)" vss-file-service:optimised "$S/file-service" "$S/file-service/Dockerfile"       runtime   "$S/file-service/src/server.js"
  row "upload-web (naive)"       vss-upload-web:naive       "$S"              "$S/upload-web/Dockerfile.naive"   ""        "$S/upload-web/src/app.js"
  row "upload-web (optimised)"   vss-upload-web:optimised   "$S"              "$S/upload-web/Dockerfile"         runtime   "$S/upload-web/src/app.js"
  echo
  echo "Optimised images, all services:"
  echo
  docker compose build >/dev/null 2>&1
  docker image ls --filter "reference=${REGISTRY:-ghcr.io/your-github-user}/vss-*:${TAG:-local}" --format '- {{.Repository}}:{{.Tag}} - {{.Size}}'
} | tee results/image-metrics.md