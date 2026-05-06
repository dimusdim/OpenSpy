#!/usr/bin/env bash
set -euo pipefail

method="${1:-}"
path="${2:-}"
body="${3:-}"

if [[ -z "$method" || -z "$path" ]]; then
  printf '{"status":"error","error":{"code":"USAGE","message":"Usage: backend-api.sh <GET|POST|DELETE> </api/path> [json-body]"}}\n'
  exit 1
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
