#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
shift || true

emit_help() {
  local topic="${1:-source-fetch}"
  node -e '
const topic = process.argv[1] || "source-fetch";
console.log(JSON.stringify({
  status: "ok",
  data: {
    topic,
    usage: "source-fetch.sh <operation> [flags]",
    purpose: "Provider capability checks and provider-side source fetches through backend-owned OpenSpy credentials.",
    common_flags: {
      "--from <iso>": "UTC start time for historical/provider windows",
      "--to <iso>": "UTC end time for historical/provider windows",
      "--date <YYYY-MM-DD>": "Daily products such as GPSJam or FIRMS",
      "--bbox <west,south,east,north>": "Bounded AOI for imagery, fires, disasters and spatial operations",
      "--limit <n>": "Provider/result limit when supported",
      "--dry-run": "Validate capability/query shape without provider fetch or persistence when supported"
    },
    examples: [
      "source-fetch.sh capabilities",
      "source-fetch.sh gpsjam-history --date 2026-04-01",
      "source-fetch.sh firms-fires --date 2026-04-01 --bbox 54,24,58.5,28.5",
      "source-fetch.sh gdacs-disasters --from 2026-04-01T00:00:00Z --to 2026-04-02T00:00:00Z --bbox 54,24,58.5,28.5",
      "source-fetch.sh copernicus-sentinel-imagery --bbox 54,24,54.2,24.2 --from 2026-05-01T00:00:00Z --to 2026-05-02T00:00:00Z --limit 1"
    ],
    notes: [
      "Call capabilities before source/storage/imagery capability claims.",
      "All outputs are JSON.",
      "Treat auth_required/planned/unsupported as current capability facts, not successful evidence."
    ]
  },
  meta: { command: "source-fetch.help" },
  warnings: []
}));
' "$topic"
}

if [[ -z "$operation" ]]; then
  emit_help source-fetch
  exit 0
fi

case "$operation" in
  help|--help|-h)
    emit_help "${1:-source-fetch}"
    exit 0
    ;;
esac

for arg in "$@"; do
  case "$arg" in
    help|--help|-h)
      emit_help "$operation"
      exit 0
      ;;
  esac
done

if [[ "$operation" == --* ]]; then
  emit_help source-fetch
  exit 0
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
