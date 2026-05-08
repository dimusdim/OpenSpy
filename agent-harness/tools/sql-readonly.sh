#!/usr/bin/env bash
set -euo pipefail

sql=""
sql_file=""
sql_b64=""
reason=""
limit=""
timeout_ms=""

emit_help() {
  node -e '
console.log(JSON.stringify({
  status: "ok",
  data: {
    usage: "sql-readonly.sh --reason <text> (--sql <select> | --sql-b64 <base64>) [--limit N] [--timeout-ms N]",
    purpose: "Guarded read-only SQL fallback through the backend read-only endpoint.",
    rules: [
      "Use semantic worldview-cli commands first when they answer the question.",
      "SQL must start with SELECT or WITH and requires --reason.",
      "Do not read credential files or product transcript tables.",
      "Prefer direct --sql strings over temp files, pipes or shell-generated base64."
    ],
    examples: [
      "sql-readonly.sh --reason \"Need a direct aggregate\" --sql \"select layer_id, count(*) from core.entities group by layer_id\"",
      "sql-readonly.sh --reason \"Need vessel fixes\" --timeout-ms 30000 --sql \"select entity_id, count(*) from core.position_fixes group by entity_id limit 20\""
    ]
  },
  meta: { command: "sql-readonly.help" },
  warnings: []
}));
'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    help|--help|-h)
      emit_help
      exit 0
      ;;
    --sql)
      sql="${2:-}"
      shift 2
      ;;
    --sql-file|--file)
      sql_file="${2:-}"
      shift 2
      ;;
    --sql-b64|--sql-base64)
      sql_b64="${2:-}"
      shift 2
      ;;
    --stdin)
      sql="$(cat)"
      shift
      ;;
    --reason)
      reason="${2:-}"
      shift 2
      ;;
    --limit)
      limit="${2:-}"
      shift 2
      ;;
    --timeout-ms)
      timeout_ms="${2:-}"
      shift 2
      ;;
    *)
      printf '{"status":"error","error":{"code":"UNKNOWN_ARG","message":"Unknown argument: %s"}}\n' "$1"
      exit 1
      ;;
  esac
done

json_escape() {
  node -e 'let s=""; process.stdin.on("data", d => s += d); process.stdin.on("end", () => process.stdout.write(JSON.stringify(s)));'
}

emit_error() {
  local code="$1"
  local message="$2"
  local escaped
  escaped="$(printf '%s' "$message" | json_escape)"
  printf '{"status":"error","error":{"code":"%s","message":%s}}\n' "$code" "$escaped"
}

if [[ -n "$sql_file" ]]; then
  if [[ "$sql_file" == *".env"* || "$sql_file" == secrets/* || "$sql_file" == */secrets/* ]]; then
    emit_error "SQL_FILE_REJECTED" "SQL file path is not allowed"
    exit 1
  fi
  if [[ ! -f "$sql_file" ]]; then
    emit_error "SQL_FILE_NOT_FOUND" "SQL file does not exist"
    exit 1
  fi
  sql="$(node -e '
const fs = require("fs");
const file = process.argv[1];
const stat = fs.statSync(file);
if (stat.size > 200000) {
  console.error("SQL file is too large");
  process.exit(2);
}
process.stdout.write(fs.readFileSync(file, "utf8"));
' "$sql_file")"
fi

if [[ -n "$sql_b64" ]]; then
  sql="$(node -e '
try {
  process.stdout.write(Buffer.from(process.argv[1] || "", "base64").toString("utf8"));
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
' "$sql_b64")"
fi

if [[ -z "$sql" ]]; then
  emit_help
  exit 0
fi

if [[ -z "$reason" ]]; then
  emit_error "REASON_REQUIRED" "Read-only SQL requires --reason for auditability"
  exit 1
fi

if [[ -n "$limit" ]]; then
  if [[ ! "$limit" =~ ^[0-9]+$ ]]; then
    emit_error "BAD_LIMIT" "Limit must be an integer"
    exit 1
  fi
  if (( limit < 1 )); then
    emit_error "BAD_LIMIT" "Limit must be a positive integer"
    exit 1
  fi
fi

if [[ -n "$timeout_ms" ]]; then
  if [[ ! "$timeout_ms" =~ ^[0-9]+$ ]]; then
    emit_error "BAD_TIMEOUT" "Timeout must be an integer number of milliseconds"
    exit 1
  fi
  if (( timeout_ms < 1 )); then
    emit_error "BAD_TIMEOUT" "Timeout must be a positive integer number of milliseconds"
    exit 1
  fi
fi

trimmed="$(printf '%s' "$sql" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
trimmed="$(printf '%s' "$trimmed" | sed -E 's/;[[:space:]]*$//')"
lower="$(printf '%s' "$trimmed" | tr '[:upper:]' '[:lower:]')"

if [[ ! "$lower" =~ ^(select|with)[[:space:]] ]]; then
  emit_error "SQL_NOT_READ_ONLY" "Only SELECT or WITH ... SELECT statements are allowed"
  exit 1
fi

body="$(node -e '
const [sql, reason, limit, timeoutMs] = process.argv.slice(1);
const body = { sql, reason };
if (limit) body.limit = Number(limit);
if (timeoutMs) body.timeout_ms = Number(timeoutMs);
process.stdout.write(JSON.stringify(body));
' "$trimmed" "$reason" "$limit" "$timeout_ms")"

exec "$(dirname "$0")/backend-api.sh" POST /api/agent-tools/sql-query "$body"
