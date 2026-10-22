#!/usr/bin/env bash
# Failure & recovery demonstration. Disrupts three dependencies one at a time and
# records what users see and how long recovery takes. Output: results/failure-test.txt
#
#   1. MySQL stopped            -> catalogue/login return 503 with a clear message; liveness stays green;
#                                  service recovers by itself when MySQL returns (pool reconnects).
#   2. File service stopped     -> streaming/upload return 503, catalogue keeps working (graceful degradation).
#   3. Auth service process dies -> Docker's restart policy brings it back; already signed-in users keep
#                                  working meanwhile thanks to the short verify cache.
source "$(dirname "$0")/lib.sh"
exec > >(tee results/failure-test.txt) 2>&1

wait_healthy mysql auth-service file-service upload-web streaming-web

# A viewer session + a video to stream
VIEWER="fail_$(date +%s)"
curl -s -o /dev/null -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
  --data "{\"username\":\"$VIEWER\",\"password\":\"viewer-pass-1\"}" "$STREAM_URL/api/register"
COOKIE=$(login_cookie "$STREAM_URL" "$VIEWER" viewer-pass-1)
ADMIN_COOKIE=$(login_cookie "$UPLOAD_URL" admin "$(admin_password)")
head -c 65536 /dev/urandom > results/.sample.bin
printf '\x00\x00\x00\x18ftypisom\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00' | cat - results/.sample.bin > results/.sample.mp4
VID=$(curl -s -H "Cookie: $ADMIN_COOKIE" -H 'X-Requested-With: fetch' -H 'Content-Type: video/mp4' \
  -H 'X-Video-Title: failure-test' --data-binary @results/.sample.mp4 "$UPLOAD_URL/api/videos" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
[[ -n $VID ]] || { bad "could not seed a video"; exit 1; }

probe() { # label
  printf '  %-34s list=%s stream=%s login=%s upload-ready=%s | health: web=%s auth=%s files=%s mysql=%s\n' "$1" \
    "$(code -H "Cookie: $COOKIE" "$STREAM_URL/api/videos")" \
    "$(code -H "Cookie: $COOKIE" -H 'Range: bytes=0-1023' "$STREAM_URL/api/videos/$VID/stream")" \
    "$(code -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' --data '{"username":"admin","password":"wrong-password"}' "$STREAM_URL/api/login")" \
    "$(code "$UPLOAD_URL/readyz")" \
    "$(health streaming-web)" "$(health auth-service)" "$(health file-service)" "$(health mysql)"
}
echo "Legend: list/stream/login are HTTP codes seen by a signed-in viewer (login uses a wrong password, so 401 = auth healthy)."

title "Baseline"
probe "all services up"

# ------------------------------------------------------------------ 1
title "Scenario 1: MySQL unavailable"
docker compose stop mysql >/dev/null; log "mysql stopped"
sleep 3; probe "mysql down"
echo "  readiness detail: $(curl -s "$STREAM_URL/readyz")"
echo "  user-facing error: $(curl -s -H "Cookie: $COOKIE" "$STREAM_URL/api/videos")"
docker compose start mysql >/dev/null; log "mysql started"
t=$(TIMEOUT=240 wait_for_code 200 -H "Cookie: $COOKIE" "$STREAM_URL/api/videos")
ok "catalogue recovered ${t}s after 'docker compose start mysql' (no app restart needed)"
wait_healthy mysql; probe "after recovery"

# ------------------------------------------------------------------ 2
title "Scenario 2: File System Service unavailable"
docker compose stop file-service >/dev/null; log "file-service stopped"
sleep 2; probe "file-service down"
echo "  user-facing error: $(curl -s -H "Cookie: $COOKIE" -H 'Range: bytes=0-10' "$STREAM_URL/api/videos/$VID/stream")"
docker compose start file-service >/dev/null; log "file-service started"
t=$(wait_for_code 206 -H "Cookie: $COOKIE" -H 'Range: bytes=0-1023' "$STREAM_URL/api/videos/$VID/stream")
ok "streaming recovered ${t}s after restart; the video bytes survived (named volume)"
probe "after recovery"

# ------------------------------------------------------------------ 3
title "Scenario 3: Auth service process crashes"
before=$(docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q auth-service)")
docker compose exec -T auth-service python -c 'import os, signal; os.kill(1, signal.SIGTERM)' || true
log "auth-service PID 1 terminated (simulated crash)"
sleep 1; probe "auth restarting"
t=$(wait_for_code 401 -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
  --data '{"username":"admin","password":"wrong-password"}' "$STREAM_URL/api/login")
after=$(docker inspect -f '{{.RestartCount}}' "$(docker compose ps -q auth-service)")
ok "Docker restart policy restarted auth-service (RestartCount $before -> $after); logins work again after ${t}s"
wait_healthy auth-service; probe "after recovery"

title "Relevant log lines (no secrets are logged)"
docker compose logs --since 5m streaming-web auth-service 2>/dev/null \
  | grep -E '"level":"(error|warn)"|database error|unreachable|readiness failed' | tail -n 12 || true
rm -f results/.sample.bin results/.sample.mp4
