#!/usr/bin/env bash
# Functional end-to-end test of the running stack + network isolation checks.
#   docker compose up -d --build && ./scripts/e2e.sh
source "$(dirname "$0")/lib.sh"

title "Waiting for all services to be healthy"
wait_healthy mysql auth-service file-service upload-web streaming-web
docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'

title "Functional checks (run inside the frontend network)"
node_in_net -e CHECK_ISOLATION=1 "$NODE_IMAGE" node /tests/e2e/smoke.mjs | tee results/e2e.txt

title "Host-side exposure checks"
# Ask Docker what each container publishes (a "0.0.0.0:X->Y" mapping), rather than probing
# localhost: another program on the host may legitimately be using port 8080 or 8000.
published() { docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' "$(docker compose ps -q "$1")"; }
for svc in mysql auth-service file-service; do
  pub=$(published "$svc")
  if [[ -z ${pub// /} ]]; then ok "$svc publishes no ports to the host (internal only)"
  else bad "$svc publishes: $pub"; exit 1; fi
done
for svc in upload-web streaming-web; do
  pub=$(published "$svc")
  [[ -n ${pub// /} ]] && ok "$svc publishes $pub (public entry point)" || { bad "$svc publishes nothing"; exit 1; }
done
for p in "${UPLOAD_PORT:-8081}" "${STREAM_PORT:-8082}"; do
  [[ $(code "http://localhost:$p/healthz") == 200 ]] && ok "localhost:$p answers (web app reachable)" || { bad "localhost:$p not reachable"; exit 1; }
done
