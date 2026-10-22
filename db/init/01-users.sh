#!/bin/bash
# Creates one least-privilege MySQL account per service.
# Run by the official mysql entrypoint on the first start of an empty volume
# (whether it is sourced or executed). Passwords come from Docker secrets,
# never from this file or the image.
set -eo pipefail   # no -u: this file may be sourced into the mysql entrypoint

read_secret() { tr -d '\r\n' < "/run/secrets/$1"; }

run_sql() {
  # Talks to the temporary init server over its local socket as root.
  MYSQL_PWD="$(read_secret db_root_password)" mysql --protocol=socket -uroot
}

AUTH_PW="$(read_secret db_auth_password)"
UPLOAD_PW="$(read_secret db_upload_password)"
STREAM_PW="$(read_secret db_stream_password)"

echo "[init] creating service accounts (auth_svc, upload_svc, stream_svc)"

run_sql <<-EOSQL
  CREATE USER IF NOT EXISTS 'auth_svc'@'%'   IDENTIFIED BY '${AUTH_PW}';
  CREATE USER IF NOT EXISTS 'upload_svc'@'%' IDENTIFIED BY '${UPLOAD_PW}';
  CREATE USER IF NOT EXISTS 'stream_svc'@'%' IDENTIFIED BY '${STREAM_PW}';

  -- auth service: read users, create users, update last state. No DELETE, no DDL.
  GRANT SELECT, INSERT, UPDATE ON auth.users TO 'auth_svc'@'%';

  -- upload web app: write video metadata (DELETE only for compensating a failed upload).
  GRANT SELECT, INSERT, DELETE ON media.videos TO 'upload_svc'@'%';

  -- streaming web app: read-only.
  GRANT SELECT ON media.videos TO 'stream_svc'@'%';

  FLUSH PRIVILEGES;
EOSQL

echo "[init] service accounts ready"
