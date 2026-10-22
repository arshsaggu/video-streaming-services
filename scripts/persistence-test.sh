#!/usr/bin/env bash
# Persistence proof: upload a video, destroy and recreate the stateful containers
# (mysql + file-service), and show the user account, metadata and exact bytes survive.
# Output: results/persistence-test.txt
source "$(dirname "$0")/lib.sh"
exec > >(tee results/persistence-test.txt) 2>&1
wait_healthy mysql auth-service file-service upload-web streaming-web

USER_NAME="persist_$(date +%s)"
title "1. Create state"
ADMIN_COOKIE=$(login_cookie "$UPLOAD_URL" admin "$(admin_password)")
curl -s -o /dev/null -H "Cookie: $ADMIN_COOKIE" -H 'Content-Type: application/json' -H 'X-Requested-With: fetch' \
  --data "{\"username\":\"$USER_NAME\",\"password\":\"persist-pass-1\",\"role\":\"uploader\"}" "$UPLOAD_URL/api/admin/users"
COOKIE=$(login_cookie "$UPLOAD_URL" "$USER_NAME" persist-pass-1)
{ printf '\x00\x00\x00\x18ftypisom\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00'; head -c 1048576 /dev/urandom; } > results/.persist.mp4
SHA_BEFORE=$(sha256 < results/.persist.mp4)
VID=$(curl -s -H "Cookie: $COOKIE" -H 'X-Requested-With: fetch' -H 'Content-Type: video/mp4' \
  -H 'X-Video-Title: persistence-test' --data-binary @results/.persist.mp4 "$UPLOAD_URL/api/videos" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
echo "  user=$USER_NAME  video=$VID  sha256=$SHA_BEFORE"
echo "  container ids before: mysql=$(docker compose ps -q mysql | cut -c1-12) file-service=$(docker compose ps -q file-service | cut -c1-12)"

title "2. Destroy and recreate the stateful containers"
docker compose rm --stop --force mysql file-service
docker compose up -d mysql file-service
wait_healthy mysql file-service auth-service upload-web streaming-web
echo "  container ids after:  mysql=$(docker compose ps -q mysql | cut -c1-12) file-service=$(docker compose ps -q file-service | cut -c1-12)"

title "3. Verify"
COOKIE=$(login_cookie "$STREAM_URL" "$USER_NAME" persist-pass-1)
[[ -n $COOKIE ]] && ok "user account survived (login works)" || bad "login failed"
curl -s -H "Cookie: $COOKIE" "$STREAM_URL/api/videos/$VID" | grep -q '"persistence-test"' \
  && ok "video metadata survived (MySQL volume vss_mysql-data)" || bad "metadata missing"
SHA_AFTER=$(curl -s -H "Cookie: $COOKIE" "$STREAM_URL/api/videos/$VID/stream" | sha256)
[[ $SHA_AFTER == "$SHA_BEFORE" ]] && ok "video bytes identical after recreation (volume vss_video-data), sha256=$SHA_AFTER" \
  || bad "bytes differ: $SHA_AFTER"

title "Volumes"
docker volume ls --filter name=vss_ --format 'table {{.Name}}\t{{.Driver}}'
rm -f results/.persist.mp4
