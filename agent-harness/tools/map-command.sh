#!/usr/bin/env bash
set -euo pipefail

command="${1:-}"
shift || true

if [[ -z "$command" ]]; then
  printf '{"status":"error","error":{"code":"USAGE","message":"Usage: map-command.sh <command> [flags]"}}\n'
  exit 1
fi

args_json="$(node -e '
const args = process.argv.slice(1);
const out = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!key.startsWith("--")) continue;
  const name = key.slice(2).replace(/-/g, "_");
  const value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  out[name] = value;
}
process.stdout.write(JSON.stringify(out));
' -- "$@")"

body="$(node -e '
const command = process.argv[1];
const payload = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify({ command, payload }));
' "$command" "$args_json")"

exec "$(dirname "$0")/backend-api.sh" POST /api/agent-tools/map-command "$body"
