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
      "Treat auth_required/planned/unsupported as current capability facts, not successful evidence.",
      "cloudflare-outages adjusts a missing or future --to to a provider-safe UTC time before the provider request because Cloudflare Radar rejects future dateEnd values.",
      "cloudflare-outages splits requested windows longer than 24 hours into provider-safe chunks and returns one combined JSON result."
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

normalized_json="$(node -e '
const operation = process.argv[1];
const args = JSON.parse(process.argv[2]);
const warnings = [];
const normalizations = [];
if (operation === "cloudflare-outages") {
  const safeNow = new Date(Date.now() - 120000).toISOString();
  const originalTo = typeof args.to === "string" && args.to.trim() ? args.to.trim() : "";
  const parsedTo = originalTo ? Date.parse(originalTo) : NaN;
  if (!originalTo || !Number.isFinite(parsedTo) || parsedTo > Date.parse(safeNow)) {
    args.to = safeNow;
    const message = originalTo
      ? `Cloudflare Radar rejects future dateEnd values; source-fetch adjusted --to from ${originalTo} to ${safeNow}.`
      : `Cloudflare Radar rejects future dateEnd values; source-fetch set --to to ${safeNow}.`;
    warnings.push(message);
    normalizations.push({
      operation,
      field: "to",
      reason: "cloudflare_radar_dateEnd_must_be_before_now",
      original: originalTo || null,
      value: safeNow,
    });
  }
}
process.stdout.write(JSON.stringify({ args, warnings, normalizations }));
' "$operation" "$args_json")"

body="$(node -e '
const operation = process.argv[1];
const normalized = JSON.parse(process.argv[2]);
const args = normalized.args || {};
process.stdout.write(JSON.stringify({ operation, args }));
' "$operation" "$normalized_json")"

chunk_plan_json="$(node -e '
const operation = process.argv[1];
const normalized = JSON.parse(process.argv[2]);
const args = normalized.args || {};
if (operation !== "cloudflare-outages") {
  process.stdout.write(JSON.stringify({ chunked: false, chunks: [args], warnings: [], normalizations: [] }));
  process.exit(0);
}
const fromMs = Date.parse(args.from || "");
const toMs = Date.parse(args.to || "");
const maxMs = 24 * 60 * 60 * 1000;
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || toMs - fromMs <= maxMs) {
  process.stdout.write(JSON.stringify({ chunked: false, chunks: [args], warnings: [], normalizations: [] }));
  process.exit(0);
}
const chunkMs = maxMs - 1000;
const chunks = [];
for (let start = fromMs; start < toMs;) {
  const end = Math.min(start + chunkMs, toMs);
  chunks.push({
    ...args,
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
  });
  start = end;
}
process.stdout.write(JSON.stringify({
  chunked: true,
  chunks,
  warnings: [`Cloudflare Radar accepts at most 24 hours per request; source-fetch split the requested window into ${chunks.length} provider-safe chunks.`],
  normalizations: [{
    operation,
    field: "window",
    reason: "cloudflare_radar_max_window_24h",
    original: { from: args.from || null, to: args.to || null },
    chunks: chunks.map((chunk) => ({ from: chunk.from, to: chunk.to })),
  }],
}));
' "$operation" "$normalized_json")"

if [[ "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).chunked ? "1" : "0")' "$chunk_plan_json")" == "1" ]]; then
  chunk_count="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).chunks.length))' "$chunk_plan_json")"
  responses=""
  overall_status=0
  for ((idx = 0; idx < chunk_count; idx += 1)); do
    chunk_body="$(node -e '
const operation = process.argv[1];
const plan = JSON.parse(process.argv[2]);
process.stdout.write(JSON.stringify({ operation, args: plan.chunks[Number(process.argv[3])] }));
' "$operation" "$chunk_plan_json" "$idx")"
    set +e
    chunk_response="$("$(dirname "$0")/backend-api.sh" POST /api/agent-tools/source-fetch "$chunk_body")"
    chunk_status=$?
    set -e
    if (( chunk_status != 0 )); then
      overall_status=$chunk_status
    fi
    responses="${responses}${chunk_response}"$'\n'
  done

  printf '%s' "$responses" | node -e '
const fs = require("fs");
const operation = process.argv[1];
const normalized = JSON.parse(process.argv[2]);
const plan = JSON.parse(process.argv[3]);
const lines = fs.readFileSync(0, "utf8").split(/\n/).map((line) => line.trim()).filter(Boolean);
const parsed = [];
const errors = [];
for (const line of lines) {
  try {
    const item = JSON.parse(line);
    parsed.push(item);
    if (item.status === "error") errors.push(item);
  } catch {
    errors.push({ status: "error", error: { code: "BAD_CHUNK_RESPONSE", message: line } });
  }
}
const baseWarnings = [
  ...(Array.isArray(normalized.warnings) ? normalized.warnings : []),
  ...(Array.isArray(plan.warnings) ? plan.warnings : []),
];
const responseWarnings = parsed.flatMap((item) => Array.isArray(item.warnings) ? item.warnings : []);
const normalizations = [
  ...(Array.isArray(normalized.normalizations) ? normalized.normalizations : []),
  ...(Array.isArray(plan.normalizations) ? plan.normalizations : []),
];
const firstOk = parsed.find((item) => item.status !== "error") || parsed[0] || {};
const chunks = parsed.map((item, index) => ({
  index,
  from: plan.chunks[index]?.from || null,
  to: plan.chunks[index]?.to || null,
  status: item.status || "unknown",
  count: Number(item.data?.count || 0),
  rawCount: Number(item.data?.rawCount || 0),
  rawPages: Number(item.data?.rawPages || 0),
  error: item.status === "error" ? item.error || item.data?.error || null : null,
}));
const output = errors.length > 0
  ? {
      status: "error",
      error: {
        code: "CLOUDFLARE_CHUNK_FETCH_FAILED",
        message: `${errors.length} of ${parsed.length} Cloudflare chunks failed.`,
      },
      data: { operation, chunks },
    }
  : {
      status: "ok",
      data: {
        operation,
        source: firstOk.data?.source || "cloudflare",
        from: plan.chunks[0]?.from || null,
        to: plan.chunks[plan.chunks.length - 1]?.to || null,
        count: chunks.reduce((sum, chunk) => sum + chunk.count, 0),
        rawCount: chunks.reduce((sum, chunk) => sum + chunk.rawCount, 0),
        rawPages: chunks.reduce((sum, chunk) => sum + chunk.rawPages, 0),
        chunks,
      },
      meta: {
        executed: true,
        persisted: firstOk.meta?.persisted ?? true,
        chunked: true,
        chunk_count: plan.chunks.length,
        tool_normalizations: normalizations,
      },
    };
const warnings = [...baseWarnings, ...responseWarnings];
if (warnings.length > 0) output.warnings = warnings;
if (output.status === "error" && normalizations.length > 0) {
  output.meta = { ...(output.meta || {}), tool_normalizations: normalizations };
}
process.stdout.write(JSON.stringify(output) + "\n");
' "$operation" "$normalized_json" "$chunk_plan_json"
  exit "$overall_status"
fi

set +e
response="$("$(dirname "$0")/backend-api.sh" POST /api/agent-tools/source-fetch "$body")"
status=$?
set -e

printf '%s\n' "$response" | node -e '
const fs = require("fs");
const normalized = JSON.parse(process.argv[1]);
const input = fs.readFileSync(0, "utf8").trim();
if (!input) process.exit(0);
let parsed = null;
try {
  parsed = JSON.parse(input);
} catch {
  process.stdout.write(input + "\n");
  process.exit(0);
}
const warnings = Array.isArray(normalized.warnings) ? normalized.warnings : [];
const normalizations = Array.isArray(normalized.normalizations) ? normalized.normalizations : [];
if (warnings.length > 0) {
  parsed.warnings = [...warnings, ...(Array.isArray(parsed.warnings) ? parsed.warnings : [])];
}
if (normalizations.length > 0) {
  parsed.meta = {
    ...(parsed.meta && typeof parsed.meta === "object" ? parsed.meta : {}),
    tool_normalizations: normalizations,
  };
}
process.stdout.write(JSON.stringify(parsed) + "\n");
' "$normalized_json"
exit "$status"
