#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
shift || true

if [[ -z "$operation" ]]; then
  printf '{"status":"error","error":{"code":"USAGE","message":"Usage: source-fetch.sh <operation> [flags]"}}\n'
  exit 1
fi

args_json="$(node -e '
const args = process.argv.slice(1);
const out = {};
for (let i = 0; i < args.length; i++) {
  const key = args[i];
  if (!key.startsWith("--")) continue;
  const name = key.slice(2).replace(/-/g, "_");
  let value = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  if (value === "true") value = true;
  if (value === "false") value = false;
  out[name] = value;
}
process.stdout.write(JSON.stringify(out));
' -- "$@")"

body="$(node -e '
const operation = process.argv[1];
const args = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify({ operation, args }));
' "$operation" "$args_json")"

exec "$(dirname "$0")/backend-api.sh" POST /api/agent-tools/source-fetch "$body"
