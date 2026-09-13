#!/usr/bin/env bash
set -euo pipefail

# uv parses dotenv as data; never source a file containing credentials as shell code.
agent_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
uv_args=(run --locked --offline --directory "$agent_dir")
if [[ -f "$agent_dir/.env" ]]; then
  uv_args+=(--env-file "$agent_dir/.env")
elif [[ -f "$agent_dir/../.env" ]]; then
  uv_args+=(--env-file "$agent_dir/../.env")
fi

exec uv "${uv_args[@]}" nightwatch-agent \
  --report-schema "$agent_dir/../contracts/schemas/agent-report.schema.json" \
  "$@"
