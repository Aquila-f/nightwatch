#!/usr/bin/env bash

set -Eeuo pipefail

control_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_dir="$(dirname -- "$control_dir")"
compose_file="$repo_dir/shop-web/compose.yaml"
health_url="http://127.0.0.1:8000/api/health"

compose() {
  docker compose -f "$compose_file" "$@"
}

cleanup_failed_restart() {
  exit_code=$?
  trap - ERR
  set +e
  compose ps >&2
  compose logs --tail=50 backend >&2
  compose down >&2
  exit "$exit_code"
}

compose down

if port_owner="$(lsof -nP -iTCP:8000 -sTCP:LISTEN)"; then
  printf 'Cannot start shop-web: port 8000 is already in use.\n%s\n' \
    "$port_owner" >&2
  exit 1
fi

trap cleanup_failed_restart ERR
compose up -d --build

health_response="$(
  curl \
    --fail-with-body \
    --silent \
    --show-error \
    --retry 20 \
    --retry-all-errors \
    --retry-delay 1 \
    --connect-timeout 2 \
    --max-time 5 \
    "$health_url"
)"

printf '%s\n' "$health_response"
compose ps
trap - ERR
