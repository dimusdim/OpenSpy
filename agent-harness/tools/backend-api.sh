#!/usr/bin/env bash
set -euo pipefail

method="${1:-}"
path="${2:-}"
body="${3:-}"

emit_help() {
  node -e '
console.log(JSON.stringify({
  status: "ok",
  data: {
    usage: "backend-api.sh <GET|POST|DELETE> </api/path> [json-body]",
    purpose: "Low-level JSON HTTP wrapper for OpenSpy backend endpoints when a semantic worldview-cli/source/map/sql wrapper does not cover the need.",
    when_to_use: [
      "Prefer worldview-cli.sh, source-fetch.sh, map-command.sh or sql-readonly.sh first.",
      "Use backend-api.sh for catalog/status endpoints, small diagnostics, or documented backend endpoints that already return JSON.",
      "Do not use it to bypass source/tool contracts or read credentials."
    ],
    response: {
      success: "Passes through backend JSON response.",
      http_error: "Returns status=error, error.code=BACKEND_HTTP_ERROR, error.http_status and backend body when available.",
      unavailable: "Returns status=error, error.code=BACKEND_UNAVAILABLE when localhost backend cannot be reached."
    },
    examples: [
      "backend-api.sh GET /api/catalog/layers",
      "backend-api.sh GET /api/agents/providers",
      "backend-api.sh POST /api/agent-tools/source-fetch \"{\\\"operation\\\":\\\"capabilities\\\",\\\"args\\\":{}}\""
    ]
  },
  meta: { command: "backend-api.help" },
  warnings: []
}));
'
}

case "$method" in
  help|--help|-h|"")
    emit_help
    exit 0
    ;;
esac

for arg in "$@"; do
  case "$arg" in
    help|--help|-h)
      emit_help
      exit 0
      ;;
  esac
done

if [[ -z "$method" || -z "$path" ]]; then
  emit_help
  exit 0
fi

api_url="${AI_WORLDVIEW_API_URL:-${API_URL:-http://127.0.0.1:3055}}"
url="${api_url%/}${path}"
headers=(-H 'Accept: application/json')
if [[ -n "${AGENT_API_TOKEN:-}" ]]; then
  headers+=(-H "X-Agent-Dev-Token: ${AGENT_API_TOKEN}")
fi

case "$method" in
  GET)
    set +e
    output="$(curl -sS -w '\n%{http_code}' "${headers[@]}" "$url" 2>&1)"
    status=$?
    set -e
    ;;
  POST|DELETE)
    set +e
    if [[ -n "$body" ]]; then
      output="$(curl -sS -w '\n%{http_code}' -X "$method" "${headers[@]}" -H 'Content-Type: application/json' --data "$body" "$url" 2>&1)"
    else
      output="$(curl -sS -w '\n%{http_code}' -X "$method" "${headers[@]}" -H 'Content-Type: application/json' "$url" 2>&1)"
    fi
    status=$?
    set -e
    ;;
  *)
    printf '{"status":"error","error":{"code":"BAD_METHOD","message":"Unsupported method"}}\n'
    exit 1
    ;;
esac

if (( status != 0 )); then
  node -e '
const message = process.argv[1] || "Backend API request failed";
console.log(JSON.stringify({
  status: "error",
  error: { code: "BACKEND_UNAVAILABLE", message },
  meta: { url: process.argv[2], method: process.argv[3] }
}));
' "$output" "$url" "$method"
  exit 1
fi

http_status="$(printf '%s' "$output" | tail -n 1)"
response_body="$(printf '%s' "$output" | sed '$d')"

if [[ ! "$http_status" =~ ^2[0-9][0-9]$ ]]; then
  node -e '
const statusCode = Number(process.argv[1] || 0);
const body = process.argv[2] || "";
let parsed = null;
try { parsed = body ? JSON.parse(body) : null; } catch {}
const message = parsed?.error?.message || parsed?.error || body || `Backend returned HTTP ${statusCode}`;
console.log(JSON.stringify({
  status: "error",
  error: {
    code: "BACKEND_HTTP_ERROR",
    message,
    http_status: statusCode
  },
  data: parsed,
  meta: { url: process.argv[3], method: process.argv[4] }
}));
' "$http_status" "$response_body" "$url" "$method"
  exit 1
fi

printf '%s\n' "$response_body"
