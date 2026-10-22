#!/usr/bin/env bash
# Generates random secrets into ./secrets/ (git-ignored). Safe to re-run: existing
# files are kept, so a running database never gets out of sync with its password.
#
#   ./scripts/init-secrets.sh            # create missing secrets
#   ./scripts/init-secrets.sh --show-admin   # also print the admin password
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p secrets
chmod 700 secrets   # only the owner can even list the directory

gen() { # alphanumeric only: safe inside SQL, URLs and env files
  local s=""
  while ((${#s} < $1)); do
    s+=$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')
  done
  printf '%s' "${s:0:$1}"
}

make_secret() {
  local name=$1 len=$2 f="secrets/$1.txt"
  if [[ -s $f ]]; then
    echo "  keep   $f"
  else
    gen "$len" >"$f"
    # Readable by the non-root container users (the bind-mounted file keeps host
    # permissions); the 700 directory still keeps other host users out.
    chmod 644 "$f"
    echo "  create $f"
  fi
}

echo "Secrets in ./secrets:"
make_secret db_root_password   32
make_secret db_auth_password   32
make_secret db_upload_password 32
make_secret db_stream_password 32
make_secret jwt_secret         64
make_secret internal_token     48
make_secret admin_password     20

if [[ ${1:-} == "--show-admin" ]]; then
  echo
  echo "Admin login:  admin / $(cat secrets/admin_password.txt)"
fi
